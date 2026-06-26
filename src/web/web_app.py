import platform
import os

IS_WINDOWS = platform.system().lower() == 'windows'
IS_MACOS = platform.system().lower() == 'darwin'

# macOS + pywebview 时跳过 gevent patch，避免与 Cocoa 运行循环冲突
# 也跳过 PyInstaller 分析阶段（避免 monkey.patch_all 破坏模块分析）
if not IS_WINDOWS and not (IS_MACOS and os.environ.get('USE_PYWEBVIEW') == '1') and 'PYINSTALLER_CONFIGDIR' not in os.environ:
    from gevent import monkey
    monkey.patch_all()

from flask import Flask, request, jsonify, Response, send_file, send_from_directory, abort
from flask_socketio import SocketIO, emit
import asyncio
import sys
if sys.platform == 'win32':
    try:
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    except Exception:
        pass
import threading
import json
import base64
import uuid
import logging
import warnings
import subprocess
import shutil
import re
import time
import webbrowser
import concurrent.futures
import tempfile
import mimetypes
import hashlib
import shlex
import requests as http_requests
import urllib3
from urllib3.exceptions import InsecureRequestWarning
from http.cookies import SimpleCookie
from datetime import datetime
from pathlib import Path
from urllib.parse import parse_qsl, quote, urlencode, urlparse, urlunparse

# 配置日志
logging.basicConfig(level=logging.DEBUG if os.environ.get('DEBUG_MODE', '').lower() in ('true', '1') else logging.INFO,
                    format='[%(levelname)s] %(message)s')
logger = logging.getLogger('web_app')
logging.getLogger('werkzeug').setLevel(logging.WARNING)
logging.getLogger('urllib3.connectionpool').setLevel(logging.WARNING)
urllib3.disable_warnings(InsecureRequestWarning)
warnings.filterwarnings('ignore', category=InsecureRequestWarning)
socketio_debug = os.environ.get('DEBUG_MODE', '').lower() in ('true', '1', 'yes')

ALLOWED_MEDIA_HOST_SUFFIXES = (
    'douyin.com',
    'douyinvod.com',
    'douyinpic.com',
    'douyinstatic.com',
    'byteimg.com',
    'ixigua.com',
    'amemv.com',
    'snssdk.com',
    'pstatp.com',
)
COOKIE_MEDIA_HOST_SUFFIXES = (
    'douyin.com',
    'amemv.com',
    'snssdk.com',
)
MEDIA_PROXY_INITIAL_VIDEO_RANGE = 'bytes=0-1048575'
MEDIA_PROXY_MAX_RANGE_BYTES = 4 * 1024 * 1024
MEDIA_PROXY_MAX_RETRIES = 3
MEDIA_PROXY_REDIRECT_CACHE_MAX_SIZE = 256
DOWNLOAD_TASK_HISTORY_MAX_SIZE = 200
LATEST_RELEASE_API_URL = 'https://api.github.com/repos/anYuJia/better-douyin/releases/latest'
LATEST_RELEASE_PAGE_URL = 'https://github.com/anYuJia/better-douyin/releases/latest'
UPDATER_METADATA_URL = 'https://github.com/anYuJia/better-douyin/releases/latest/download/latest.json'
UPDATER_PUBLIC_KEY = (
    'dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEQ4N0YyNERCNDcxNjlGRgpS'
    'V1QvYVhHMFRmS0hEZmpYNEdhWEFnUExoU1dqUHFiYXhnU2UzWm1Rblo5UUc4MnM0cE13RXFiNAo='
)
MEDIA_PROXY_REDIRECT_CACHE = {}


def _cap_media_range_header(range_header: str, requested_media_type: str) -> str:
    if requested_media_type not in ('audio', 'video') or not range_header:
        return range_header
    text = str(range_header).strip()
    if not text.startswith('bytes=') or ',' in text:
        return range_header
    start_text, _, end_text = text[6:].partition('-')
    if not start_text.strip():
        return range_header
    try:
        start = int(start_text.strip())
    except (TypeError, ValueError):
        return range_header
    if start < 0:
        return range_header
    capped_end = start + MEDIA_PROXY_MAX_RANGE_BYTES - 1
    if end_text.strip():
        try:
            end = min(int(end_text.strip()), capped_end)
        except (TypeError, ValueError):
            end = capped_end
    else:
        end = capped_end
    if end < start:
        return range_header
    capped = f'bytes={start}-{end}'
    return range_header if capped == text else capped

# 添加项目根目录到Python路径
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src.config.config import Config, get_resource_path
from src.api.api import DouyinAPI
from src.api.native_cookie_login import (
    NativeCookieLoginSession,
    apply_cookie_to_window,
    create_native_douyin_window,
    create_login_window,
    destroy_window_safely,
    extract_current_user_profile_entries,
    extract_relation_signer_entries,
    has_login_cookie,
    inject_relation_signer_probe,
    is_native_cookie_login_available,
    normalize_cookie_entries,
    relation_signer_ready,
    relation_signer_ready_for_uid,
    relation_signer_has_ticket_guard,
    serialize_cookie_entries,
)
from src.api import douyin_im_proto
from src.downloader.downloader import DouyinDownloader, build_download_name, build_download_title
from src.utils.download_history_index import (
    get_download_history_items,
    invalidate_download_history_cache,
    move_download_history_entries,
    rebuild_download_history_index,
    remove_download_history_entries,
    upsert_download_history_entries,
)
from src.user.user_manager import DouyinUserManager

# 移除增强下载器支持
ENHANCED_DOWNLOADER_AVAILABLE = False
EnhancedDouyinDownloader = None
_native_verify_window = None
_native_verify_window_session = None
VERIFY_COOKIE_SYNC_TIMEOUT = 10 * 60

app = Flask(__name__, static_folder=None)
app.config['SECRET_KEY'] = 'better_douyin_secret_key'
app.config['SEND_FILE_MAX_AGE_DEFAULT'] = 0  # 禁用静态文件缓存
# macOS + pywebview 时 gevent 未 patch，必须用 threading 模式
if IS_WINDOWS or (IS_MACOS and os.environ.get('USE_PYWEBVIEW') == '1'):
    socketio_async_mode = 'threading'
else:
    socketio_async_mode = 'gevent'
# 修改SocketIO初始化，添加更多选项
socketio = SocketIO(
    app, 
    cors_allowed_origins="*",
    async_mode=socketio_async_mode,
    logger=socketio_debug,
    engineio_logger=socketio_debug,
    ping_timeout=60,  # 增加ping超时时间
    ping_interval=25  # 增加ping间隔
)

# 全局变量
api = None
downloader = None
user_manager = None
download_tasks = {} # 用于存储任务状态和元数据（同步Dict）

# 主进程退出事件（Flask 子进程通过此事件通知主进程关闭）
_main_process_exit_event = None

# 更新辅助函数已抽离到 src/web/updater.py
from src.web import updater

def set_main_process_exit_event(event) -> None:
    global _main_process_exit_event
    _main_process_exit_event = event
    updater.set_main_process_exit_event(event)

updater.setup_updater(
    logger=logger,
    Config=Config,
    http_requests=http_requests,
    socketio=socketio,
    is_windows=IS_WINDOWS,
    is_macos=IS_MACOS,
    latest_release_api_url=LATEST_RELEASE_API_URL,
    updater_metadata_url=UPDATER_METADATA_URL,
    updater_public_key=UPDATER_PUBLIC_KEY,
    latest_release_page_url=LATEST_RELEASE_PAGE_URL,
    main_process_exit_event=_main_process_exit_event,
)

active_tasks = {} # 用于存储活跃的 asyncio.Future 和 asyncio.Event
# download_tasks / active_tasks 同时被 Flask 路由线程和 asyncio 协程（run_coroutine_threadsafe 提交到独立事件循环线程）访问，
# 需要锁保护迭代与读-改-写场景，避免 'dictionary changed size during iteration' 和 KeyError。
_download_tasks_lock = threading.Lock()

TERMINAL_TASK_STATUSES = {'completed', 'failed', 'error', 'cancelled', 'canceled'}


class ThreadPauseEvent:
    """Thread-compatible pause guard backed by an asyncio.Event."""

    def __init__(self, event):
        self.event = event

    def is_set(self):
        return self.event.is_set()

    def wait_while_set(self, cancel_event=None, interval=0.2):
        while self.event.is_set() and not (cancel_event and cancel_event.is_set()):
            time.sleep(interval)


@app.route('/favicon.ico')
def favicon():
    """Serve favicon to avoid noisy 404s in browsers."""
    return send_frontend_asset('favicon.svg', 'image/svg+xml')


@app.route('/favicon.svg')
def favicon_svg():
    return send_frontend_asset('favicon.svg', 'image/svg+xml')


@app.route('/animated_icon.svg')
def animated_icon():
    return send_frontend_asset('animated_icon.svg', 'image/svg+xml')


@app.route('/socket.io.min.js')
def socket_io_client():
    return send_frontend_asset('socket.io.min.js', 'application/javascript')


@app.route('/default-avatar.svg')
def default_avatar():
    return send_frontend_asset('default-avatar.svg', 'image/svg+xml')


@app.route('/assets/<path:filename>')
def react_assets(filename: str):
    react_assets_dir = get_react_dist_dir() / 'assets'
    if not react_assets_dir.exists():
        abort(404)
    return send_from_directory(react_assets_dir, filename, max_age=86400)


@app.route('/default-cover.svg')
def default_cover():
    return send_frontend_asset('default-cover.svg', 'image/svg+xml')


@app.route('/qq-group.jpg')
def qq_group():
    return send_frontend_asset('qq-group.jpg', 'image/jpeg')

# 全局 Loop 处理
_global_loop = None
_loop_thread = None


def get_react_dist_dir() -> Path:
    return Path(get_resource_path('src/web/react_dist')).resolve()


def get_frontend_public_dir() -> Path:
    return Path(get_resource_path('frontend/public')).resolve()


def find_frontend_asset(filename: str) -> Path | None:
    for directory in (get_react_dist_dir(), get_frontend_public_dir()):
        candidate = directory / filename
        if candidate.exists() and candidate.is_file():
            return candidate
    return None


def send_frontend_asset(filename: str, mimetype: str):
    asset = find_frontend_asset(filename)
    if asset is None:
        abort(404)
    return send_file(asset, mimetype=mimetype, max_age=86400)


def has_react_frontend() -> bool:
    react_index = get_react_dist_dir() / 'index.html'
    return react_index.exists() and react_index.is_file()


def get_download_root() -> Path:
    """返回实际下载根目录。"""
    return Path(Config.DOWNLOAD_DIR).resolve()


def get_all_download_roots() -> list[Path]:
    """返回当前及历史下载目录列表。"""
    roots = []
    seen = set()

    for raw_path in [Config.DOWNLOAD_DIR, *getattr(Config, 'HISTORY_DIRS', [])]:
        if not raw_path:
            continue
        path = Path(raw_path).resolve()
        key = str(path).lower()
        if key in seen:
            continue
        seen.add(key)
        roots.append(path)

    return roots


def get_root_for_path(candidate: Path) -> Path | None:
    """返回某个下载文件所属的根目录。"""
    for root in get_all_download_roots():
        if _is_subpath(candidate, root):
            return root
    return None


def _is_subpath(candidate: Path, root: Path) -> bool:
    try:
        candidate.resolve().relative_to(root.resolve())
        return True
    except ValueError:
        return False


def _safe_history_path(raw_path: str) -> Path:
    if not raw_path:
        raise ValueError('路径不能为空')

    candidate = Path(raw_path).expanduser().resolve()
    roots = get_all_download_roots()
    if not any(_is_subpath(candidate, root) for root in roots):
        raise ValueError('目标路径不在下载目录范围内')
    return candidate


LOCAL_MEDIA_EXTENSIONS = {
    '.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi', '.flv',
    '.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif', '.heic', '.heif',
    '.mp3', '.m4a', '.aac', '.wav', '.flac', '.ogg',
}


def _guess_local_media_mimetype(path: Path) -> str:
    guessed, _ = mimetypes.guess_type(str(path))
    if guessed:
        return guessed

    suffix = path.suffix.lower()
    if suffix in ('.mp4', '.m4v'):
        return 'video/mp4'
    if suffix == '.mov':
        return 'video/quicktime'
    if suffix == '.webm':
        return 'video/webm'
    if suffix in ('.jpg', '.jpeg'):
        return 'image/jpeg'
    if suffix == '.png':
        return 'image/png'
    if suffix == '.webp':
        return 'image/webp'
    if suffix == '.gif':
        return 'image/gif'
    if suffix in ('.mp3',):
        return 'audio/mpeg'
    if suffix in ('.m4a', '.aac'):
        return 'audio/aac'
    return 'application/octet-stream'


def _guess_image_content_type_from_bytes(data: bytes) -> str:
    if data.startswith(b'\xff\xd8\xff'):
        return 'image/jpeg'
    if data.startswith(b'\x89PNG\r\n\x1a\n'):
        return 'image/png'
    if data.startswith(b'RIFF') and data[8:12] == b'WEBP':
        return 'image/webp'
    if data.startswith(b'GIF87a') or data.startswith(b'GIF89a'):
        return 'image/gif'
    return 'application/octet-stream'


def build_download_history() -> list[dict]:
    return get_download_history_items()


def _download_history_media_kind(item: dict) -> str:
    raw_type = str(item.get('media_type') or item.get('file_type') or '').strip().lower().lstrip('.')
    if raw_type in ('video', 'image', 'audio'):
        return raw_type

    extension = str(item.get('extension') or raw_type or '').strip().lower().lstrip('.')
    if not extension and item.get('path'):
        extension = Path(str(item.get('path'))).suffix.lower().lstrip('.')

    if extension in ('mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi', 'flv'):
        return 'video'
    if extension in ('jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'heic', 'heif'):
        return 'image'
    if extension in ('mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg'):
        return 'audio'
    return 'media'


def _download_history_timestamp(item: dict) -> int:
    try:
        return int(item.get('timestamp') or item.get('modified_at') or item.get('create_time') or 0)
    except (TypeError, ValueError):
        return 0


def _download_history_size(item: dict) -> int:
    try:
        return int(item.get('size') or item.get('file_size') or 0)
    except (TypeError, ValueError):
        return 0


def _download_history_matches_query(item: dict, query: str) -> bool:
    if not query:
        return True

    fields = (
        item.get('name'),
        item.get('filename'),
        item.get('title'),
        item.get('desc'),
        item.get('author'),
        item.get('author_id'),
        item.get('aweme_id'),
        item.get('id'),
        item.get('path'),
        item.get('relative_path'),
        item.get('root_path'),
        item.get('extension'),
        item.get('media_type'),
        item.get('file_type'),
    )
    return any(query in str(value).lower() for value in fields if value)


def _request_non_negative_int(name: str) -> int | None:
    raw_value = request.args.get(name)
    if raw_value in (None, ''):
        return None
    try:
        return max(0, int(raw_value))
    except (TypeError, ValueError):
        return None


def _request_json() -> dict:
    payload = request.get_json(silent=True)
    return payload if isinstance(payload, dict) else {}


def _coerce_int(value, default: int = 0, min_value: int | None = None, max_value: int | None = None) -> int:
    try:
        result = int(value)
    except (TypeError, ValueError):
        result = default

    if min_value is not None:
        result = max(min_value, result)
    if max_value is not None:
        result = min(max_value, result)
    return result


def _coerce_bool(value, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in ('1', 'true', 'yes', 'on'):
            return True
        if normalized in ('0', 'false', 'no', 'off', ''):
            return False
    return default


def _count_value(value, default: int = 0) -> int:
    if isinstance(value, bool):
        return default
    if isinstance(value, (int, float)):
        return max(0, int(round(value)))
    if isinstance(value, str):
        text = value.strip().replace(',', '')
        if not text:
            return default
        multiplier = 1
        suffix = text[-1].lower()
        if suffix in ('w', '万'):
            multiplier = 10000
            text = text[:-1]
        elif suffix in ('k', '千'):
            multiplier = 1000
            text = text[:-1]
        try:
            return max(0, int(round(float(text) * multiplier)))
        except ValueError:
            return default
    return default


def _first_count(sources: list[dict], keys: tuple[str, ...]) -> int:
    for source in sources:
        if not isinstance(source, dict):
            continue
        for key in keys:
            value = source.get(key)
            count = _count_value(value, -1)
            if count >= 0:
                return count
    return 0


def _search_user_payload(user_info: dict, item: dict | None = None) -> dict:
    item = item if isinstance(item, dict) else {}
    user_info = user_info if isinstance(user_info, dict) else {}
    sources = [
        user_info,
        user_info.get('stats') or {},
        user_info.get('card_info') or {},
        user_info.get('extra') or {},
        item,
        item.get('stats') or {},
        item.get('card_info') or {},
        item.get('user_info') or {},
    ]
    return {
        'uid': user_info.get('uid', ''),
        'nickname': user_info.get('nickname', ''),
        'unique_id': user_info.get('unique_id', ''),
        'follower_count': _first_count(sources, ('follower_count', 'follower_count_str', 'follower_count_text', 'fans_count', 'fans_count_str', 'fans_count_text')),
        'following_count': _first_count(sources, ('following_count', 'following_count_str', 'following_count_text', 'follow_count', 'follow_count_str', 'follow_count_text')),
        'total_favorited': _first_count(sources, ('total_favorited', 'total_favorited_str', 'total_favorited_text', 'favorited_count', 'favorited_count_str', 'like_count', 'like_count_str')),
        'aweme_count': _first_count(sources, ('aweme_count', 'aweme_count_str', 'aweme_count_text', 'work_count', 'work_count_str', 'works_count', 'works_count_str', 'video_count', 'video_count_str')),
        'favoriting_count': _first_count(sources, ('favoriting_count', 'favoriting_count_str', 'favoriting_count_text')),
        'signature': user_info.get('signature', ''),
        'sec_uid': user_info.get('sec_uid', ''),
        'avatar_thumb': _avatar_url(user_info, 'avatar_thumb', 'avatar_100x100', 'avatar_168x168', 'avatar_medium', 'avatar_300x300', 'avatar_larger'),
        'avatar_medium': _avatar_url(user_info, 'avatar_medium', 'avatar_168x168', 'avatar_300x300', 'avatar_larger', 'avatar_thumb', 'avatar_100x100'),
        'avatar_larger': _avatar_url(user_info, 'avatar_larger', 'avatar_300x300', 'avatar_medium', 'avatar_168x168', 'avatar_thumb', 'avatar_100x100'),
        'is_follow': bool(user_info.get('is_follow', False)) or bool(user_info.get('follow_status', 0)),
        'follow_status': _count_value(user_info.get('follow_status'), 0),
        'verify_status': _count_value(user_info.get('verify_status'), 0),
    }


def _user_detail_payload(user_info: dict, fallback_sec_uid: str = '', fallback_nickname: str = '') -> dict:
    payload = _search_user_payload(user_info)
    payload['uid'] = (user_info or {}).get('uid', '')
    payload['sec_uid'] = payload.get('sec_uid') or fallback_sec_uid
    payload['nickname'] = payload.get('nickname') or fallback_nickname
    payload['avatar_thumb'] = payload.get('avatar_thumb') or _avatar_url(user_info or {}, 'avatar_thumb', 'avatar_100x100', 'avatar_168x168', 'avatar_medium', 'avatar_300x300', 'avatar_larger')
    payload['avatar_medium'] = payload.get('avatar_medium') or _avatar_url(user_info or {}, 'avatar_medium', 'avatar_168x168', 'avatar_300x300', 'avatar_larger', 'avatar_thumb', 'avatar_100x100')
    payload['avatar_larger'] = payload.get('avatar_larger') or _avatar_url(user_info or {}, 'avatar_larger', 'avatar_300x300', 'avatar_medium', 'avatar_168x168', 'avatar_thumb', 'avatar_100x100')
    return payload


def _filter_download_history_items(items: list[dict]) -> tuple[list[dict], int, int, dict | None]:
    query = str(request.args.get('query') or '').strip().lower()
    media_type = str(request.args.get('media_type') or request.args.get('mediaType') or 'all').strip().lower()
    sort_by = str(request.args.get('sort_by') or request.args.get('sortBy') or 'date_desc').strip()

    filtered = [
        dict(item)
        for item in items
        if _download_history_matches_query(item, query)
        and (media_type == 'all' or _download_history_media_kind(item) == media_type)
    ]

    if sort_by == 'date_asc':
        filtered.sort(key=_download_history_timestamp)
    elif sort_by == 'size_desc':
        filtered.sort(key=_download_history_size, reverse=True)
    elif sort_by == 'size_asc':
        filtered.sort(key=_download_history_size)
    else:
        filtered.sort(key=_download_history_timestamp, reverse=True)

    total = len(filtered)
    total_size = sum(_download_history_size(item) for item in filtered)
    latest = dict(filtered[0]) if filtered else None

    offset = _request_non_negative_int('offset') or 0
    limit = _request_non_negative_int('limit')
    paged = filtered[offset:]
    if limit is not None:
        paged = paged[:limit]

    return paged, total, total_size, latest


def move_directory_contents(source_dir: Path, target_dir: Path) -> int:
    """将源目录中的内容合并移动到目标目录。"""
    moved_count = 0
    if not source_dir.exists() or not source_dir.is_dir():
        return moved_count

    target_dir.mkdir(parents=True, exist_ok=True)

    for child in source_dir.iterdir():
        destination = target_dir / child.name
        if destination.exists():
            if child.is_dir() and destination.is_dir():
                moved_count += move_directory_contents(child, destination)
                try:
                    child.rmdir()
                except OSError:
                    pass
                continue

            stem = destination.stem
            suffix = destination.suffix
            counter = 1
            while destination.exists():
                destination = target_dir / f"{stem}_{counter}{suffix}"
                counter += 1

        shutil.move(str(child), str(destination))
        moved_count += 1

    return moved_count


def _unique_destination_path(destination: Path) -> Path:
    if not destination.exists():
        return destination

    stem = destination.stem
    suffix = destination.suffix
    counter = 1
    candidate = destination
    while candidate.exists():
        candidate = destination.parent / f"{stem}_{counter}{suffix}"
        counter += 1
    return candidate


def _cleanup_empty_parent_dirs(path: Path, stop_root: Path) -> None:
    """Remove empty parent directories without crossing the owning download root."""
    try:
        parent = path.parent.resolve()
        stop_root = stop_root.resolve()
    except Exception:
        return

    while parent != stop_root and _is_subpath(parent, stop_root) and parent.exists():
        try:
            next(parent.iterdir())
            break
        except StopIteration:
            parent.rmdir()
            parent = parent.parent
        except OSError:
            break


def safe_get_url(obj, default=''):
    """安全地从常见抖音媒体字段中获取 URL，避免索引越界"""
    if not obj:
        return default
    if isinstance(obj, str):
        return obj.strip() or default
    if isinstance(obj, (list, tuple)):
        for item in obj:
            url = safe_get_url(item, '')
            if url:
                return url
        return default
    if not isinstance(obj, dict):
        return default
    for key in (
        'url_list',
        'urlList',
        'large_url_list',
        'origin_url_list',
        'medium_url_list',
        'thumb_url_list',
    ):
        url = safe_get_url(obj.get(key), '')
        if url:
            return url
    for key in ('url', 'uri', 'download_url', 'src'):
        value = obj.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return default


def _format_comment_item(item: dict) -> dict:
    user = item.get('user') or {}
    sticker = item.get('sticker') or {}
    sticker_url = safe_get_url(sticker.get('static_url') or {}) or safe_get_url(sticker.get('animate_url') or {})
    return {
        'cid': item.get('cid', ''),
        'text': item.get('text', ''),
        'create_time': item.get('create_time', 0),
        'user': {
            'uid': user.get('uid', ''),
            'nickname': user.get('nickname', ''),
            'avatar_thumb': safe_get_url(user.get('avatar_thumb') or {}),
            'sec_uid': user.get('sec_uid', ''),
        },
        'digg_count': item.get('digg_count', 0),
        'user_digged': item.get('user_digged', 0),
        'reply_comment_total': item.get('reply_comment_total', 0),
        'sub_comments': None,
        'status': item.get('status', 0),
        'ip_label': item.get('ip_label', ''),
        'sticker_url': sticker_url,
    }


def _avatar_url(user_info: dict, *keys: str) -> str:
    if not isinstance(user_info, dict):
        return ''
    for key in keys:
        url = safe_get_url(user_info.get(key), '')
        if url:
            return url
    return ''


def _api_message(payload, fallback='请求失败'):
    if isinstance(payload, dict):
        for key in ('message', 'status_msg'):
            value = payload.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
    return fallback


def _media_first_url(value):
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, dict):
        url_list = value.get('url_list')
        if isinstance(url_list, list):
            for item in url_list:
                if isinstance(item, str) and item.strip():
                    return item.strip()
        for key in (
            'main_url',
            'backup_url',
            'fallback_url',
            'play_addr',
            'play_url',
            'download_addr',
            'download_url',
            'url',
            'uri',
        ):
            url = _media_first_url(value.get(key))
            if key == 'uri' and not url.lower().startswith(('http://', 'https://')):
                continue
            if url:
                return url
    if isinstance(value, list):
        for item in value:
            url = _media_first_url(item)
            if url:
                return url
    return ''


def _clean_no_watermark_url(url):
    cleaned = str(url or '').strip()
    if not cleaned:
        return ''
    cleaned = cleaned.replace('playwm', 'play')
    try:
        parsed = urlparse(cleaned)
        query = dict(parse_qsl(parsed.query, keep_blank_values=True))
        if 'watermark' in query:
            query['watermark'] = '0'
        return urlunparse(parsed._replace(query=urlencode(query, doseq=True)))
    except Exception:
        return cleaned.replace('watermark=1', 'watermark=0')


def _looks_watermarked_url(url):
    text = str(url or '').lower()
    return 'watermark=1' in text or 'playwm' in text or 'logo_name=' in text


def _select_recommended_video_url(video_data, fallback=''):
    video_data = video_data or {}
    try:
        if user_manager:
            selected_url = user_manager._select_video_url(video_data)
            if selected_url:
                return selected_url
    except Exception:
        pass

    candidates = []

    def push_candidate(url, metric):
        normalized_url = _media_first_url(url)
        if normalized_url and not is_dash_video_only_url(normalized_url):
            candidates.append((metric, normalized_url))

    def metric(bit_rate):
        if not isinstance(bit_rate, dict):
            return 0
        for key in ('data_size', 'bit_rate', 'quality_type'):
            try:
                value = int(bit_rate.get(key) or 0)
            except (TypeError, ValueError):
                value = 0
            if value > 0:
                return value
        try:
            width = int(bit_rate.get('width') or 0)
            height = int(bit_rate.get('height') or 0)
        except (TypeError, ValueError):
            return 0
        return width * height if width > 0 and height > 0 else 0

    for bit_rate in video_data.get('bit_rate') or []:
        item_metric = metric(bit_rate)
        push_candidate((bit_rate or {}).get('play_addr'), 9_000_000 + item_metric)
        push_candidate((bit_rate or {}).get('play_addr_h264'), 8_000_000 + item_metric)

    push_candidate(fallback, 7_000_000)
    push_candidate(video_data.get('play_addr_h264'), 6_000_000)
    push_candidate(video_data.get('play_addr'), 5_000_000)
    push_candidate(video_data.get('play_addr_lowbr'), 1_000_000)
    push_candidate(video_data.get('download_addr'), 500_000)

    selected = ''
    for _, url in sorted(candidates, key=lambda item: item[0], reverse=True):
        if not _looks_watermarked_url(url):
            selected = url
            break
    if not selected and candidates:
        selected = max(candidates, key=lambda item: item[0])[1]
    return _clean_no_watermark_url(selected)


def _select_dash_video_url(video_data):
    """优先选择推荐流里的 h264 DASH 分片源，用于播放器 seek。"""
    video_data = video_data or {}
    for bit_rate in video_data.get('bit_rate') or []:
        if not isinstance(bit_rate, dict):
            continue
        if str(bit_rate.get('format') or '').lower() != 'dash':
            continue
        if bool(bit_rate.get('is_h265')):
            continue
        urls = ((bit_rate.get('play_addr') or {}).get('url_list') or [])
        if not isinstance(urls, list):
            continue
        for url in urls:
            url = str(url or '').strip()
            if url and 'media-video-avc1' in url:
                return url
        for url in urls:
            url = str(url or '').strip()
            if url:
                return url
    return ''


def _select_dash_audio_url(video_data):
    """选择与 DASH 视频配套的音频源。"""
    video_data = video_data or {}
    for audio_rate in video_data.get('bit_rate_audio') or []:
        if not isinstance(audio_rate, dict):
            continue
        audio_meta = audio_rate.get('audio_meta') or {}
        url = _media_first_url(audio_meta.get('url_list'))
        if url:
            return url
    return ''


def _verify_error_response(payload, fallback='需要完成抖音验证', verify_url=None):
    payload_dict = payload if isinstance(payload, dict) else {}
    if Config.COOKIE:
        login_status = _verify_native_cookie_login(Config.COOKIE)
        if not login_status.get('success'):
            if login_status.get('need_verify'):
                return {
                    'success': False,
                    'need_verify': True,
                    'verify_url': verify_url or payload_dict.get('_verify_url') or 'https://www.douyin.com/',
                    'message': _api_message(login_status, fallback),
                }
            return _login_error_response(login_status)

    message = _api_message(payload, fallback)
    return {
        'success': False,
        'need_verify': True,
        'verify_url': verify_url or payload_dict.get('_verify_url') or 'https://www.douyin.com/',
        'message': message,
    }


def _verify_error_response_without_login_check(payload, fallback='需要完成抖音验证', verify_url=None):
    payload_dict = payload if isinstance(payload, dict) else {}
    return {
        'success': False,
        'need_verify': True,
        'verify_url': verify_url or payload_dict.get('_verify_url') or 'https://www.douyin.com/',
        'message': _api_message(payload, fallback),
    }


def _login_error_response(payload, fallback='登录态已失效，请重新登录获取 Cookie'):
    return {
        'success': False,
        'need_login': True,
        'message': _api_message(payload, fallback),
    }


def _feature_login_error_response(feature: str):
    return {
        'success': False,
        'need_login': True,
        'message': f'请登录后获取{feature}',
    }


def _cookie_aware_error_response(payload, fallback='请求失败，请检查 Cookie 或稍后重试'):
    if Config.COOKIE:
        login_status = _verify_native_cookie_login(Config.COOKIE)
        if not login_status.get('success'):
            if login_status.get('need_verify'):
                return _verify_error_response(login_status, fallback)
            return _login_error_response(login_status)

    return {
        'success': False,
        'message': _api_message(payload, fallback),
    }


def _verify_or_request_error_response(payload, fallback='请求失败，请稍后重试', verify_url=None):
    """只有 Cookie 校验也确认需要验证时才弹验证窗口，避免普通接口失败误触发验证。"""
    payload_dict = payload if isinstance(payload, dict) else {}
    if Config.COOKIE:
        login_status = _verify_native_cookie_login(Config.COOKIE)
        if login_status.get('success'):
            return {
                'success': False,
                'message': _api_message(payload_dict, fallback),
            }
        if login_status.get('need_verify'):
            return {
                'success': False,
                'need_verify': True,
                'verify_url': verify_url or payload_dict.get('_verify_url') or 'https://www.douyin.com/',
                'message': _api_message(login_status, '需要完成验证后重试'),
            }
        return _login_error_response(login_status)

    return _verify_error_response(payload_dict, fallback, verify_url)


def infer_media_type_from_url(url, fallback_type='video'):
    """根据 URL 粗略推断媒体类型，用于兼容旧前端传入的字符串数组。"""
    normalized_fallback = fallback_type if fallback_type in ('video', 'image', 'live_photo') else 'video'
    if not isinstance(url, str) or not url:
        return normalized_fallback

    clean_url = url.split('?', 1)[0].lower()
    if clean_url.endswith(('.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.heic', '.heif')):
        return 'image'
    if clean_url.endswith(('.mp4', '.mov', '.m4v', '.webm')):
        return 'video'
    return normalized_fallback


def normalize_media_urls(media_urls, raw_media_type='video'):
    """统一媒体数据结构为 [{'url': str, 'type': str}]。"""
    if not isinstance(media_urls, list):
        raise ValueError(f"媒体URL格式错误: {type(media_urls)}")

    fallback_type = raw_media_type if raw_media_type in ('video', 'image', 'live_photo') else 'video'
    normalized_urls = []

    for item in media_urls:
        if isinstance(item, dict):
            url = str(item.get('url', '')).strip()
            if not url:
                continue
            normalized_urls.append({
                'url': url,
                'type': item.get('type') or infer_media_type_from_url(url, fallback_type)
            })
            continue

        if isinstance(item, str):
            url = item.strip()
            if not url:
                continue
            normalized_urls.append({
                'url': url,
                'type': infer_media_type_from_url(url, fallback_type)
            })
            continue

        logger.warning(f"跳过不支持的媒体URL项: {item}")

    return normalized_urls


def clean_video_download_url(url: str) -> str:
    return (
        str(url or '').strip()
        .replace('watermark=1', 'watermark=0')
        .replace('playwm', 'play')
    )


def is_watermark_video_url(url: str) -> bool:
    normalized_url = str(url or '').strip().lower()
    return bool(
        normalized_url
        and (
            'playwm' in normalized_url
            or 'watermark=1' in normalized_url
            or '/aweme/v1/playwm' in normalized_url
        )
    )


def is_dash_video_only_url(url: str) -> bool:
    normalized_url = str(url or '').strip().lower()
    return 'media-video' in normalized_url or 'media_video' in normalized_url


def normalize_download_media_urls(media_urls, raw_media_type='video'):
    normalized_urls = normalize_media_urls(media_urls, raw_media_type) if media_urls else []
    cleaned_urls = []
    seen = set()

    for item in normalized_urls:
        url = item.get('url', '')
        media_type = item.get('type') or infer_media_type_from_url(url, raw_media_type)
        if media_type == 'video':
            url = clean_video_download_url(url)
            if is_watermark_video_url(url) or is_dash_video_only_url(url):
                continue
        if not url or (media_type, url) in seen:
            continue
        seen.add((media_type, url))
        cleaned_urls.append({'url': url, 'type': media_type})

    return cleaned_urls


def is_allowed_media_url(url: str) -> bool:
    """只允许代理明确属于抖音/字节媒体域名的 http(s) URL。"""
    try:
        parsed = urlparse((url or '').strip())
    except Exception:
        return False

    if parsed.scheme not in ('http', 'https') or not parsed.hostname:
        return False

    hostname = parsed.hostname.lower().rstrip('.')
    return any(hostname == suffix or hostname.endswith(f'.{suffix}') for suffix in ALLOWED_MEDIA_HOST_SUFFIXES)


def should_forward_douyin_cookie(url: str) -> bool:
    """只向登录相关域名转发账号 Cookie。"""
    try:
        hostname = (urlparse((url or '').strip()).hostname or '').lower().rstrip('.')
    except Exception:
        return False
    return any(hostname == suffix or hostname.endswith(f'.{suffix}') for suffix in COOKIE_MEDIA_HOST_SUFFIXES)


def _media_url_label(raw_url: str) -> str:
    """日志里只保留媒体域名和路径，避免刷出签名参数。"""
    try:
        parsed = urlparse((raw_url or '').strip())
        if parsed.netloc:
            return f'{parsed.netloc}{parsed.path}'[:160]
    except Exception:
        pass
    return str(raw_url or '')[:80]


def _allowed_media_request_origin() -> tuple[bool, str | None]:
    origin = (request.headers.get('Origin') or '').strip()
    if not origin or origin == 'null':
        return True, None

    try:
        parsed = urlparse(origin)
    except Exception:
        return False, None

    hostname = (parsed.hostname or '').lower().rstrip('.')
    if parsed.scheme not in ('http', 'https') or not hostname:
        return False, None

    request_host = (request.host or '').split(':', 1)[0].lower().rstrip('.')
    allowed_hosts = {'127.0.0.1', 'localhost', 'tauri.localhost'}
    if request_host:
        allowed_hosts.add(request_host)

    if hostname in allowed_hosts:
        return True, origin

    return False, None


def _resolve_media_redirect_target(current_url: str, location: str) -> str | None:
    if not location:
        return None
    try:
        return http_requests.compat.urljoin(current_url, location)
    except Exception:
        return None


def _remember_media_redirect(cache_key: str | None, target_url: str) -> None:
    if not cache_key or not target_url:
        return
    if cache_key in MEDIA_PROXY_REDIRECT_CACHE:
        MEDIA_PROXY_REDIRECT_CACHE.pop(cache_key, None)
    elif len(MEDIA_PROXY_REDIRECT_CACHE) >= MEDIA_PROXY_REDIRECT_CACHE_MAX_SIZE:
        oldest_key = next(iter(MEDIA_PROXY_REDIRECT_CACHE), None)
        if oldest_key is not None:
            MEDIA_PROXY_REDIRECT_CACHE.pop(oldest_key, None)
    MEDIA_PROXY_REDIRECT_CACHE[cache_key] = target_url




def get_or_create_loop():
    global _global_loop, _loop_thread
    if _global_loop is None:
        _global_loop = asyncio.new_event_loop()
        def _run_loop():
            try:
                asyncio.set_event_loop(_global_loop)
            except Exception:
                pass
            _global_loop.run_forever()
        _loop_thread = threading.Thread(target=_run_loop, daemon=True)
        _loop_thread.start()
        logger.info("Global asyncio loop started in background thread")
    return _global_loop

def run_async(coro, timeout: float | None = 120):
    """在全局循环中运行异步任务并等待结果。"""
    loop = get_or_create_loop()
    future = asyncio.run_coroutine_threadsafe(coro, loop)
    try:
        return future.result(timeout=timeout)
    except concurrent.futures.TimeoutError as exc:
        future.cancel()
        raise TimeoutError(f'异步任务执行超时（{timeout}s）') from exc

class WebDownloadProgress:
    """Web下载进度回调"""
    def __init__(self, task_id, socketio, desc=None):
        self.task_id = task_id
        self.socketio = socketio
        self.total_files = 0
        self.completed_files = 0
        self.desc = desc
        self.display_name = '下载任务'
        if desc and desc.strip():
            self.display_name = ' '.join(str(desc).split()).strip()
    
    def set_total_files(self, total):
        self.total_files = total
        self.emit_progress()
    
    def file_completed(self, filename):
        self.completed_files += 1
        self.emit_progress()
        self.socketio.emit('download_log', {
            'task_id': self.task_id,
            'message': f'下载完成: {filename}',
            'timestamp': datetime.now().strftime('%H:%M:%S')
        })
    
    def emit_progress(self):
        progress = (self.completed_files / self.total_files * 100) if self.total_files > 0 else 0
        self.socketio.emit('download_progress', {
            'task_id': self.task_id,
            'progress': progress,
            'completed': self.completed_files,
            'total': self.total_files,
            'desc': self.desc,
            'display_name': self.display_name
        })


def _task_sort_timestamp(task: dict) -> float:
    for key in ('end_time', 'start_time'):
        value = task.get(key)
        if isinstance(value, datetime):
            return value.timestamp()
        try:
            return float(value)
        except (TypeError, ValueError):
            continue
    return 0.0


def _prune_download_tasks() -> None:
    with _download_tasks_lock:
        overflow = len(download_tasks) - DOWNLOAD_TASK_HISTORY_MAX_SIZE
        if overflow <= 0:
            return

        removable = [
            (task_id, task)
            for task_id, task in download_tasks.items()
            if task_id not in active_tasks
            and str(task.get('status') or '').lower() in TERMINAL_TASK_STATUSES
        ]
        removable.sort(key=lambda item: _task_sort_timestamp(item[1]))

        for task_id, _ in removable[:overflow]:
            download_tasks.pop(task_id, None)


def _store_download_task(task_id: str, task: dict) -> None:
    with _download_tasks_lock:
        download_tasks[task_id] = task
    _prune_download_tasks()


def _set_task_status(task_id: str, status: str, **extra) -> None:
    """原子地更新某任务的状态及附加字段，避免读-改-写期间被并发 pop。"""
    with _download_tasks_lock:
        task = download_tasks.get(task_id)
        if task is None:
            return
        task['status'] = status
        for key, value in extra.items():
            task[key] = value


def _update_task_fields(task_id: str, **fields) -> None:
    with _download_tasks_lock:
        task = download_tasks.get(task_id)
        if task is not None:
            task.update(fields)


def _get_task(task_id: str):
    with _download_tasks_lock:
        task = download_tasks.get(task_id)
        return dict(task) if task is not None else None


def _list_download_tasks():
    with _download_tasks_lock:
        return [(tid, dict(task)) for tid, task in download_tasks.items()]


def init_app():
    """初始化应用"""
    global api, downloader, user_manager
    try:
        Config.init()
        cookie = Config.COOKIE if Config.COOKIE else ''
        api = DouyinAPI(cookie)
        
        # 使用标准下载器
        downloader = DouyinDownloader(api, socketio=socketio)
        logger.info("Web服务使用标准下载器")
        
        # 传递socketio对象给用户管理器
        user_manager = DouyinUserManager(api, downloader, socketio=socketio,cookie=cookie)
        
        # 启动全局 Loop
        get_or_create_loop()
        
        logger.info("Web应用初始化完成")
    except Exception as e:
        logger.error(f"Web应用初始化失败: {str(e)}")


@app.route('/')
def index():
    """主页"""
    react_index = get_react_dist_dir() / 'index.html'
    if react_index.exists():
        return send_file(react_index)
    logger.error("React frontend build not found at %s", react_index)
    return Response(
        """
        <!doctype html>
        <html lang="zh-CN">
          <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <title>better-douyin</title>
            <style>
              body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0b0b11; color: #f5f5f7; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
              main { width: min(680px, calc(100vw - 40px)); border: 1px solid rgba(255,255,255,.12); border-radius: 18px; padding: 24px; background: rgba(255,255,255,.05); box-shadow: 0 20px 60px rgba(0,0,0,.35); }
              h1 { margin: 0 0 12px; font-size: 20px; }
              p { margin: 0 0 14px; color: #b8b8c5; line-height: 1.7; }
              code { display: inline-block; padding: 3px 7px; border-radius: 8px; background: rgba(255,255,255,.08); color: #fff; }
            </style>
          </head>
          <body>
            <main>
              <h1>React 前端尚未构建</h1>
              <p>Python 版现在只使用 React 前端。请先在项目根目录执行：</p>
              <p><code>cd frontend &amp;&amp; npm install &amp;&amp; npm run build</code></p>
              <p>构建完成后重新启动应用。</p>
            </main>
          </body>
        </html>
        """,
        status=503,
        mimetype='text/html',
    )


# 配置与好友聊天状态路由已抽离到 src/web/config_routes.py
from src.web.config_routes import config_bp, setup_config_routes

setup_config_routes(
    logger=logger,
    Config=Config,
    request_json=_request_json,
    coerce_int=_coerce_int,
    get_download_root=get_download_root,
    get_all_download_roots=get_all_download_roots,
    get_current_app_version=updater.get_current_app_version,
    init_app=init_app,
    move_directory_contents=move_directory_contents,
)
app.register_blueprint(config_bp)

# 更新检查与目录选择路由已抽离到 src/web/update_routes.py
from src.web.update_routes import update_routes_bp, setup_update_routes

setup_update_routes(
    logger=logger,
    Config=Config,
    is_windows=IS_WINDOWS,
    is_macos=IS_MACOS,
    latest_release_page_url=LATEST_RELEASE_PAGE_URL,
    get_current_app_version=updater.get_current_app_version,
)
app.register_blueprint(update_routes_bp)


# 账号管理路由已抽离到 src/web/accounts.py
from src.web.accounts import accounts_bp, setup_accounts

setup_accounts(
    Config=Config,
    request_json=_request_json,
    init_app=init_app,
)
app.register_blueprint(accounts_bp)



# 下载历史相关路由已抽离到 src/web/download_history.py
from src.web.download_history import download_history_bp, setup_download_history

setup_download_history(
    logger=logger,
    Config=Config,
    is_windows=IS_WINDOWS,
    request_json=_request_json,
    get_download_root=get_download_root,
    get_all_download_roots=get_all_download_roots,
    get_root_for_path=get_root_for_path,
    safe_history_path=_safe_history_path,
    filter_download_history_items=_filter_download_history_items,
    get_download_history_items=get_download_history_items,
    guess_local_media_mimetype=_guess_local_media_mimetype,
    cleanup_empty_parent_dirs=_cleanup_empty_parent_dirs,
    unique_destination_path=_unique_destination_path,
    local_media_extensions=LOCAL_MEDIA_EXTENSIONS,
)
app.register_blueprint(download_history_bp)

# 媒体代理相关路由已抽离到 src/web/media_proxy.py
# setup_media_proxy 调用移到文件末尾，确保所有 helper 已定义
from src.web.media_proxy import media_proxy_bp, setup_media_proxy
app.register_blueprint(media_proxy_bp)

@app.route('/api/verify_page')
def verify_page():
    """返回一个验证页面，用iframe嵌入抖音来完成滑块验证"""
    return '''<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>抖音验证</title>
<style>
body{margin:0;background:#0a0a0f;color:#fff;font-family:'Outfit',sans-serif;display:flex;flex-direction:column;height:100vh}
.header{padding:16px 24px;background:rgba(255,255,255,0.03);border-bottom:1px solid rgba(255,255,255,0.06);display:flex;align-items:center;justify-content:space-between}
.header h3{margin:0;font-size:1.1rem}
.header .hint{color:#8b8b9e;font-size:0.82rem}
iframe{flex:1;border:none;width:100%}
.btn-done{background:#FE2C55;color:#fff;border:none;padding:10px 28px;border-radius:10px;font-size:0.9rem;cursor:pointer;font-weight:500}
.btn-done:hover{background:#ff4d73}
</style></head><body>
<div class="header">
    <div>
        <h3>请完成滑块验证</h3>
        <div class="hint">在下方页面完成验证后点击"验证完成"</div>
    </div>
    <button class="btn-done" onclick="window.close()">验证完成</button>
</div>
<iframe src="https://www.douyin.com/"></iframe>
</body></html>'''


def _start_native_verify_cookie_sync(window):
    """持续读取验证窗口 Cookie，滑块验证写入新 Cookie 后同步到后端请求层。"""
    global _native_verify_window_session

    if not window:
        return

    active_session = _native_verify_window_session
    if active_session and active_session.is_active() and active_session.window is window:
        return
    if active_session and active_session.is_active():
        active_session.close()

    session = NativeCookieLoginSession(window=window)
    session.last_cookie_value = Config.COOKIE or ''
    session.last_core_cookie_signature = _core_login_cookie_signature(Config.COOKIE or '')
    _native_verify_window_session = session

    def finish() -> None:
        global _native_verify_window_session
        session.finished_event.set()
        if _native_verify_window_session is session:
            _native_verify_window_session = None

    def poll_verify_window_cookies() -> None:
        try:
            if not session.window.events.loaded.wait(45):
                logger.debug('验证窗口加载超时，停止 Cookie 同步')
                return

            while True:
                if session.cancel_event.is_set() or session.window.events.closed.is_set():
                    return
                if time.monotonic() - session.created_at >= VERIFY_COOKIE_SYNC_TIMEOUT:
                    logger.debug('验证窗口 Cookie 同步超时，停止监听')
                    return

                try:
                    raw_cookies = session.window.get_cookies() or []
                except Exception as error:
                    logger.debug('读取验证窗口 Cookie 失败: %s', error)
                    time.sleep(1)
                    continue

                entries = normalize_cookie_entries(raw_cookies)
                if not has_login_cookie(entries):
                    time.sleep(1)
                    continue

                cookie_string = serialize_cookie_entries(entries)
                if not cookie_string:
                    time.sleep(1)
                    continue

                core_signature = _core_login_cookie_signature(cookie_string)
                current_config_signature = _core_login_cookie_signature(Config.COOKIE or '')
                if not core_signature:
                    time.sleep(1)
                    continue

                if (
                    core_signature == getattr(session, 'last_core_cookie_signature', ())
                    or core_signature == current_config_signature
                ):
                    time.sleep(1)
                    continue

                session.last_cookie_value = cookie_string
                session.last_core_cookie_signature = core_signature
                _save_cookie_login_success(cookie_string)
                logger.info('验证窗口 Cookie 已同步到后端')
                time.sleep(2)
        finally:
            finish()

    threading.Thread(target=poll_verify_window_cookies, daemon=True).start()

@app.route('/api/open_verify_browser', methods=['POST'])
def open_verify_browser():
    """打开抖音验证页面，只使用应用内 pywebview 窗口并注入当前 Cookie。"""
    global _native_verify_window

    try:
        data = _request_json()
        target_url = (data.get('target_url') or '').strip() or 'https://www.douyin.com/'

        if not is_native_cookie_login_available():
            import webbrowser
            webbrowser.open(target_url)
            return jsonify({
                'success': True,
                'message': '已在系统浏览器中打开验证页面，请完成验证',
                'open_url': target_url,
            })

        if _native_verify_window and not _native_verify_window.events.closed.is_set():
            try:
                _native_verify_window.load_url(target_url)
                if Config.COOKIE:
                    apply_cookie_to_window(
                        _native_verify_window,
                        Config.COOKIE,
                        reload_after_apply=True,
                        force=True,
                        post_load_delay=0.8,
                    )
                _start_native_verify_cookie_sync(_native_verify_window)
                _native_verify_window.show()
                return jsonify({'success': True, 'message': '验证窗口已打开，请完成验证', 'open_url': target_url})
            except Exception:
                _native_verify_window = None

        verify_window = create_native_douyin_window('抖音验证', target_url, width=1100, height=750)
        _native_verify_window = verify_window
        if Config.COOKIE:
            apply_cookie_to_window(
                verify_window,
                Config.COOKIE,
                reload_after_apply=True,
                force=True,
                post_load_delay=0.2,
            )
        _start_native_verify_cookie_sync(verify_window)
        return jsonify({'success': True, 'message': '已打开验证窗口，请完成验证', 'open_url': target_url})

    except Exception as e:
        logger.error(f"打开验证窗口失败：{str(e)}")
        return jsonify({'success': False, 'message': f'无法打开验证窗口：{str(e)}'}), 500

# 用户数据查询路由已抽离到 src/web/user_queries.py
# setup_user_queries 调用移到文件末尾，确保所有 helper 已定义
from src.web.user_queries import user_queries_bp, setup_user_queries
app.register_blueprint(user_queries_bp)



# 好友 IM 私信路由已抽离到 src/web/friend_im.py
from src.web.friend_im import friend_im_bp, setup_friend_im
from src.web import im_listener

im_listener.setup_im_listener(
    logger=logger,
    Config=Config,
    socketio=socketio,
    run_async=run_async,
    api_message=_api_message,
)

setup_friend_im(
    logger=logger,
    Config=Config,
    request_json=_request_json,
    coerce_int=_coerce_int,
    run_async=run_async,
    api_message=_api_message,
    ensure_im_message_listener=im_listener.ensure_im_message_listener,
    sanitize_sec_user_ids=im_listener.sanitize_sec_user_ids,
    save_im_friend_cache=im_listener.save_im_friend_cache,
    collect_sec_uid_records=im_listener.collect_sec_uid_records,
)
app.register_blueprint(friend_im_bp)

# 下载相关路由已抽离到 src/web/downloads_routes.py
from src.web.downloads_routes import downloads_bp, setup_downloads_routes

setup_downloads_routes(
    logger=logger,
    Config=Config,
    socketio=socketio,
    request_json=_request_json,
    coerce_int=_coerce_int,
    run_async=run_async,
    api_message=_api_message,
    verify_error_response=_verify_error_response,
    login_error_response=_login_error_response,
    normalize_download_media_urls=normalize_download_media_urls,
    build_download_title=build_download_title,
    build_download_name=build_download_name,
    get_or_create_loop=get_or_create_loop,
    thread_pause_event_cls=ThreadPauseEvent,
    store_download_task=_store_download_task,
    set_task_status=_set_task_status,
    update_task_fields=_update_task_fields,
    get_task=_get_task,
    active_tasks=active_tasks,
    download_tasks_lock=_download_tasks_lock,
)
app.register_blueprint(downloads_bp)

# 视频操作路由已抽离到 src/web/video_actions.py
from src.web.video_actions import video_actions_bp, setup_video_actions

setup_video_actions(
    logger=logger,
    request_json=_request_json,
    run_async=run_async,
    api_message=_api_message,
    coerce_bool=_coerce_bool,
    verify_error_response=_verify_error_response,
    login_error_response=_login_error_response,
)
app.register_blueprint(video_actions_bp)

# 评论相关路由已抽离到 src/web/comments.py
from src.web.comments import comments_bp, setup_comments

setup_comments(
    logger=logger,
    request_json=_request_json,
    coerce_int=_coerce_int,
    run_async=run_async,
    api_message=_api_message,
    verify_error_response=_verify_error_response,
    login_error_response=_login_error_response,
    format_comment_item=_format_comment_item,
)
app.register_blueprint(comments_bp)

@app.route('/api/verify_cookie', methods=['GET'])
def verify_cookie():
    """校验当前保存的 Cookie 是否可用。"""
    cookie = (Config.COOKIE or '').strip()
    if not cookie:
        return jsonify({
            'valid': False,
            'user_name': None,
            'user_id': None,
            'sec_uid': None,
            'expires_at': None,
            'message': '未配置 Cookie',
        })

    result = _verify_native_cookie_login(cookie)
    if result.get('success'):
        return jsonify({
            'valid': True,
            'user_name': result.get('nickname') or None,
            'user_id': result.get('user_id') or result.get('sec_uid') or None,
            'sec_uid': result.get('sec_uid') or None,
            'avatar_thumb': result.get('avatar_thumb') or None,
            'avatar_medium': result.get('avatar_medium') or None,
            'avatar_larger': result.get('avatar_larger') or None,
            'expires_at': None,
            'message': 'Cookie 可用',
        })

    return jsonify({
        'valid': False,
        'user_name': None,
        'user_id': None,
        'sec_uid': None,
        'expires_at': None,
        'need_login': bool(result.get('need_login')),
        'need_verify': bool(result.get('need_verify')),
        'message': result.get('message') or 'Cookie 不可用',
    })

@app.route('/api/tasks', methods=['GET'])
def get_tasks():
    """获取下载任务列表"""
    _prune_download_tasks()
    normalized_tasks = {}
    for task_id, task in _list_download_tasks():
        normalized = dict(task)
        if 'start_time' in normalized and isinstance(normalized['start_time'], datetime):
            normalized['start_time'] = int(normalized['start_time'].timestamp() * 1000)
        if 'end_time' in normalized and isinstance(normalized['end_time'], datetime):
            normalized['end_time'] = int(normalized['end_time'].timestamp() * 1000)
        normalized.setdefault('id', task_id)
        if normalized.get('isBatch') or normalized.get('total_videos') is not None:
            normalized.setdefault('title', normalized.get('display_name') or normalized.get('filename') or '批量下载')
            normalized.setdefault('filename', normalized.get('title'))
            normalized.setdefault('progress', normalized.get('overall_progress', 0))
            normalized.setdefault('total_files', normalized.get('total_videos'))
            normalized.setdefault('completed_files', normalized.get('processed') or normalized.get('current_downloaded') or 0)
        normalized_tasks[task_id] = normalized

    return jsonify({
        'success': True,
        'tasks': normalized_tasks
    })

@socketio.on('connect')
def handle_connect():
    """客户端连接"""
    logger.debug("客户端已连接")
    im_listener.ensure_im_message_listener()
    emit('connected', {'message': '连接成功'})

@socketio.on('disconnect')
def handle_disconnect():
    """客户端断开连接"""
    logger.debug("客户端已断开连接")

@socketio.on('test_connection')
def handle_test_connection(data):
    """测试WebSocket连接"""
    logger.debug(f"收到测试连接请求: {data}")
    # 直接向发送请求的客户端回复
    emit('test_response', {'message': '连接测试成功', 'received': data})
    # 同时广播一条消息给所有客户端
    socketio.emit('broadcast_message', {'message': '服务器广播测试消息', 'time': datetime.now().strftime('%H:%M:%S')})

# ═══════════════════════════════════════════════
# COOKIE 浏览器登录（已抽离到 src/web/cookie_login.py）
# ═══════════════════════════════════════════════
from src.web.cookie_login import (
    cookie_login_bp,
    setup_cookie_login,
    _verify_native_cookie_login,
    _cookie_verify_cache,
    _core_login_cookie_signature,
    _save_cookie_login_success,
)

setup_cookie_login(
    socketio=socketio,
    logger=logger,
    Config=Config,
    DouyinAPI=DouyinAPI,
    run_async=run_async,
    init_app=init_app,
    stop_im_message_listener=im_listener.stop_im_message_listener,
    ensure_im_message_listener=im_listener.ensure_im_message_listener,
    api_message=_api_message,
    avatar_url=_avatar_url,
    request_json=_request_json,
    coerce_int=_coerce_int,
)
app.register_blueprint(cookie_login_bp)

def _extract_music_url(music_data):
    """从音乐数据中提取播放地址"""
    play_url = music_data.get('play_url') or {}
    if isinstance(play_url, dict):
        url_list = play_url.get('url_list', [])
        if url_list:
            return url_list[0]
        uri = play_url.get('uri', '')
        if isinstance(uri, str) and uri.startswith('http'):
            return uri

    music_file = music_data.get('music_file') or {}
    if isinstance(music_file, dict):
        url_list = music_file.get('url_list', [])
        if url_list:
            return url_list[0]

    for key in ('play_url', 'src_url', 'mp3_url', 'music_file'):
        val = music_data.get(key, '')
        if isinstance(val, str) and val.startswith('http'):
            return val
    return ''


def _normalize_duration_seconds(value):
    """将抖音接口里的时长统一转换为秒。"""
    try:
        duration_value = float(value or 0)
    except (TypeError, ValueError):
        return 0

    if duration_value <= 0:
        return 0

    # 抖音不同接口里的 duration 单位并不统一：
    # - video.duration 常见为 1/100000 秒
    # - music.duration 常见为 1/100 秒
    # - 少量场景会直接返回毫秒或秒
    if duration_value >= 100000:
        return max(1, round(duration_value / 100000))
    if duration_value >= 1000:
        return max(1, round(duration_value / 1000))
    if duration_value >= 100:
        return max(1, round(duration_value / 100))

    return max(1, round(duration_value))


def _raw_duration_value(value):
    try:
        duration_value = float(value or 0)
    except (TypeError, ValueError):
        return 0
    return int(round(duration_value)) if duration_value > 0 else 0


def _extract_post_status(post):
    status = (post or {}).get('status') or {}
    return {
        'is_delete': bool(status.get('is_delete', False)),
        'private_status': _coerce_int(status.get('private_status'), 0, 0),
        'review_status': _coerce_int(status.get('review_status'), 0, 0),
        'with_goods': bool(status.get('with_goods', False)),
        'is_prohibited': bool(status.get('is_prohibited', False)),
    }


def _extract_music_info(music_data):
    """提取统一的音乐信息结构。"""
    if not isinstance(music_data, dict):
        return {
            'title': '',
            'author': '',
            'play_url': '',
            'duration': 0,
        }

    return {
        'title': music_data.get('title', '') or '',
        'author': music_data.get('author', '') or music_data.get('owner_nickname', '') or '',
        'play_url': _extract_music_url(music_data),
        'duration': _normalize_duration_seconds(music_data.get('duration', 0)),
    }


def _sanitize_download_filename(name: str, default: str = '背景音乐') -> str:
    raw_name = (name or '').strip()
    sanitized = re.sub(r'[\\/:*?"<>|]', '_', raw_name)
    sanitized = ' '.join(sanitized.split()).strip(' .')
    sanitized = sanitized[:Config.MAX_FILENAME_LENGTH]
    return sanitized or default


def _guess_audio_extension(url: str, content_type: str) -> str:
    normalized_url = (url or '').lower()
    normalized_type = (content_type or '').lower()

    if '.m4a' in normalized_url or 'audio/mp4' in normalized_type or 'audio/x-m4a' in normalized_type:
        return '.m4a'
    if '.aac' in normalized_url or 'audio/aac' in normalized_type:
        return '.aac'
    if '.wav' in normalized_url or 'audio/wav' in normalized_type:
        return '.wav'
    if '.ogg' in normalized_url or 'audio/ogg' in normalized_type:
        return '.ogg'

    return '.mp3'


def _guess_audio_content_type(url: str, content_type: str = '') -> str:
    normalized_type = (content_type or '').lower()
    if normalized_type and normalized_type != 'application/octet-stream':
        return normalized_type.split(';', 1)[0].strip()

    extension = _guess_audio_extension(url, normalized_type)
    return {
        '.m4a': 'audio/mp4',
        '.aac': 'audio/aac',
        '.wav': 'audio/wav',
        '.ogg': 'audio/ogg',
    }.get(extension, 'audio/mpeg')


def _build_content_disposition(filename: str, disposition_type: str = 'attachment') -> str | None:
    if not filename:
        return None

    ascii_filename = re.sub(r'[^\x20-\x7E]', '_', filename) or 'download.bin'
    return f"{disposition_type}; filename=\"{ascii_filename}\"; filename*=UTF-8''{quote(filename)}"


@app.route('/api/recommended_feed', methods=['POST'])
def get_recommended_feed():
    """获取推荐视频流 - 直接调用 DouyinAPI，不使用子进程"""
    try:
        data = _request_json()
        count = _coerce_int(data.get('count'), 20, 1, 100)
        cursor = _coerce_int(data.get('cursor'), 0, 0)
        feed_type = str(data.get('feed_type') or data.get('feedType') or 'featured').strip().lower()
        if feed_type in ('recommend', 'tab', 'home', 'feed'):
            feed_type = 'recommended'
        if feed_type not in ('featured', 'recommended'):
            feed_type = 'featured'

        # 获取当前配置的 cookie（推荐流可以不带 cookie 获取通用推荐）
        cookie = Config.COOKIE if Config.COOKIE else ''

        if not api:
            return jsonify({
                'success': False,
                'message': '服务未初始化'
            })

        # 直接调用 DouyinAPI，与其他接口保持一致
        logger.debug(f"[推荐视频] 请求 {count} 个视频, feed_type={feed_type}, cursor={cursor}")

        async def fetch_recommended():
            resp, success = await api.get_recommended_feed(count, cursor, feed_type)
            return resp, success

        resp, success = run_async(fetch_recommended())

        if isinstance(resp, dict) and resp.get('_need_verify'):
            return jsonify(_verify_error_response(resp, '获取推荐视频失败，请完成验证后重试'))
        if isinstance(resp, dict) and resp.get('_need_login'):
            return jsonify(_login_error_response(resp))

        if not success or not resp.get('aweme_list'):
            logger.error(f"获取推荐视频失败: {resp}")
            return jsonify({
                'success': False,
                'message': _api_message(resp, '获取推荐视频失败，请稍后重试')
            })

        aweme_list = resp.get('aweme_list', [])
        logger.debug(f"[推荐视频] API 返回 {len(aweme_list)} 个视频")

        # 格式化视频信息
        videos = []
        skipped_count = 0
        for aweme in aweme_list:
            try:
                # 提取视频播放地址
                video_data = aweme.get('video') or {}
                if not isinstance(video_data, dict):
                    skipped_count += 1
                    logger.debug(f"跳过视频 {aweme.get('aweme_id')}: 缺少视频信息")
                    continue
                play_addr = _media_first_url(video_data.get('play_addr'))
                selected_video_url = _select_recommended_video_url(video_data, play_addr)
                dash_video_url = _select_dash_video_url(video_data)
                dash_audio_url = _select_dash_audio_url(video_data)

                # 跳过没有播放地址的视频
                if not selected_video_url:
                    skipped_count += 1
                    logger.debug(f"跳过视频 {aweme.get('aweme_id')}: 无播放地址")
                    continue

                # 提取封面
                cover = _media_first_url(video_data.get('cover'))

                if not cover:
                    skipped_count += 1
                    logger.debug(f"跳过视频 {aweme.get('aweme_id')}: 无封面")
                    continue

                # 提取动态封面
                dynamic_cover = _media_first_url(video_data.get('dynamic_cover'))
                origin_cover = _media_first_url(video_data.get('origin_cover')) or cover
                play_addr_h264 = _media_first_url(video_data.get('play_addr_h264'))
                play_addr_lowbr = _media_first_url(video_data.get('play_addr_lowbr'))
                download_addr = _media_first_url(video_data.get('download_addr'))

                # 提取作者头像
                author_data = aweme.get('author', {})
                avatar_thumb = _media_first_url(author_data.get('avatar_thumb'))
                music_info = _extract_music_info(aweme.get('music') or {})

                author_key = (
                    author_data.get('sec_uid')
                    or author_data.get('uid')
                    or author_data.get('unique_id')
                    or author_data.get('nickname')
                    or ''
                )
                if not aweme.get('aweme_id') or not author_key:
                    skipped_count += 1
                    logger.debug(f"跳过视频 {aweme.get('aweme_id')}: 缺少作品或作者信息")
                    continue

                video_info = {
                    'aweme_id': aweme.get('aweme_id', ''),
                    'desc': aweme.get('desc', ''),
                    'create_time': aweme.get('create_time', 0),
                    'media_type': 'video',
                    'raw_media_type': 'video',
                    'media_urls': [{'type': 'video', 'url': selected_video_url}],
                    'bgm_url': dash_audio_url or music_info.get('play_url', ''),
                    'cover_url': cover,
                    'author': {
                        'uid': author_data.get('uid', ''),
                        'nickname': author_data.get('nickname', ''),
                        'avatar_thumb': avatar_thumb,
                        'sec_uid': author_data.get('sec_uid', ''),
                    },
                    'statistics': {
                        'digg_count': (aweme.get('statistics') or {}).get('digg_count', 0),
                        'comment_count': (aweme.get('statistics') or {}).get('comment_count', 0),
                        'share_count': (aweme.get('statistics') or {}).get('share_count', 0),
                        'play_count': (aweme.get('statistics') or {}).get('play_count', 0),
                        'collect_count': (aweme.get('statistics') or {}).get('collect_count', 0),
                    },
                    'status': _extract_post_status(aweme),
                    'video': {
                        'cover': cover,
                        'dynamic_cover': dynamic_cover,
                        'origin_cover': origin_cover or cover,
                        'play_addr': selected_video_url,
                        'dash_addr': dash_video_url,
                        'audio_addr': dash_audio_url,
                        'preview_addr': _media_first_url(video_data.get('preview_addr')) or selected_video_url,
                        'play_addr_h264': play_addr_h264,
                        'play_addr_lowbr': play_addr_lowbr,
                        'download_addr': download_addr,
                        'width': video_data.get('width', 0),
                        'height': video_data.get('height', 0),
                        'duration': _raw_duration_value(video_data.get('duration', 0)),
                        'duration_unit': 'milliseconds',
                        'ratio': video_data.get('ratio', ''),
                        'bit_rate': video_data.get('bit_rate') or [],
                    },
                    'music': {
                        **music_info,
                        'cover': _media_first_url((aweme.get('music') or {}).get('cover_large')),
                    }
                }

                videos.append(video_info)
            except Exception as e:
                import traceback
                logger.error(f"解析视频信息失败: {e}")
                logger.error(traceback.format_exc())
                continue

        logger.debug(f"[推荐视频] 返回 {len(videos)} 个有效视频, 跳过 {skipped_count} 个无效视频")

        has_more = resp.get('has_more', False)
        has_more_bool = has_more == 1 or has_more is True
        next_cursor = (
            resp.get('cursor')
            or resp.get('max_cursor')
            or resp.get('min_cursor')
            or (cursor + 1 if has_more_bool else cursor)
        )

        return jsonify({
            'success': True,
            'videos': videos,
            'cursor': next_cursor,
            'has_more': has_more_bool,
            'count': len(videos),
            'feed_type': feed_type,
        })

    except Exception as e:
        logger.exception(f"获取推荐视频异常: {e}")
        return jsonify({
            'success': False,
            'message': f'获取失败: {str(e)}'
        })


# 添加一个定时发送心跳的函数
def send_heartbeat():
    """定时发送心跳消息"""
    logger.debug("发送WebSocket心跳消息")
    socketio.emit('heartbeat', {'timestamp': datetime.now().strftime('%H:%M:%S')})
    


def start_server(port=None):
    """启动Flask/SocketIO服务（在后台线程中调用）"""
    import os

    logger.info("启动抖音下载器Web服务...")
    logger.info(f"SocketIO async_mode: {socketio.async_mode}")

    if port is None:
        port = int(os.environ.get('PORT', 5001))
    host = (os.environ.get('HOST') or '127.0.0.1').strip() or '127.0.0.1'

    # 初始化应用
    init_app()

    run_kwargs = {
        'app': app,
        'host': host,
        'port': port,
        'debug': False
    }
    if socketio.async_mode == 'threading':
        run_kwargs['allow_unsafe_werkzeug'] = True

    if host in ('0.0.0.0', '::'):
        logger.warning("Web服务已暴露到局域网/公网，请自行处理访问控制与 Cookie 风险")
    logger.info(f"Web服务开始监听: {host}:{port}")
    socketio.run(**run_kwargs)


def main():
    """启动Web服务（兼容旧版命令行启动方式）"""
    import os
    import webbrowser
    import threading
    import time

    port = int(os.environ.get('PORT', 5001))
    url = f"http://localhost:{port}"

    # 在后台线程启动服务
    server_thread = threading.Thread(target=start_server, kwargs={'port': port}, daemon=True)
    server_thread.start()

    # 等待服务就绪
    time.sleep(1.5)
    try:
        webbrowser.open(url)
        logger.info(f"已自动打开浏览器: {url}")
    except Exception as e:
        logger.warning(f"自动打开浏览器失败: {str(e)}")

    # 阻塞主线程，等待服务线程结束
    server_thread.join()


# 模块加载完成后注入媒体代理模块的依赖（部分 helper 定义在文件后段）
setup_media_proxy(
    logger=logger,
    sanitize_download_filename=_sanitize_download_filename,
    allowed_media_request_origin=_allowed_media_request_origin,
    is_allowed_media_url=is_allowed_media_url,
    cap_media_range_header=_cap_media_range_header,
    media_proxy_redirect_cache=MEDIA_PROXY_REDIRECT_CACHE,
    media_proxy_max_retries=MEDIA_PROXY_MAX_RETRIES,
    media_url_label=_media_url_label,
    should_forward_douyin_cookie=should_forward_douyin_cookie,
    resolve_media_redirect_target=_resolve_media_redirect_target,
    remember_media_redirect=_remember_media_redirect,
    guess_audio_content_type=_guess_audio_content_type,
    build_content_disposition=_build_content_disposition,
    guess_image_content_type_from_bytes=_guess_image_content_type_from_bytes,
    guess_audio_extension=_guess_audio_extension,
)

# 用户数据查询模块的依赖（部分 helper 定义在文件后段）
setup_user_queries(
    logger=logger,
    Config=Config,
    request_json=_request_json,
    coerce_int=_coerce_int,
    run_async=run_async,
    api_message=_api_message,
    verify_error_response=_verify_error_response,
    login_error_response=_login_error_response,
    verify_error_response_without_login_check=_verify_error_response_without_login_check,
    verify_or_request_error_response=_verify_or_request_error_response,
    feature_login_error_response=_feature_login_error_response,
    search_user_payload=_search_user_payload,
    user_detail_payload=_user_detail_payload,
    safe_get_url=safe_get_url,
    extract_music_info=_extract_music_info,
    raw_duration_value=_raw_duration_value,
)


if __name__ == '__main__':
    main()
