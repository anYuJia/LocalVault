import platform
import os

IS_WINDOWS = platform.system().lower() == 'windows'
IS_MACOS = platform.system().lower() == 'darwin'

# macOS + pywebview 时跳过 gevent patch，避免与 Cocoa 运行循环冲突
if not IS_WINDOWS and not (IS_MACOS and os.environ.get('USE_PYWEBVIEW') == '1'):
    from gevent import monkey
    monkey.patch_all()

from flask import Flask, request, jsonify, Response, send_file, send_from_directory, abort
from flask_socketio import SocketIO, emit
import asyncio
import threading
import sys
import json
import base64
import uuid
import logging
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
from datetime import datetime
from pathlib import Path
from urllib.parse import parse_qsl, quote, urlencode, urlparse, urlunparse

# 配置日志
logging.basicConfig(level=logging.DEBUG if os.environ.get('DEBUG_MODE', '').lower() in ('true', '1') else logging.INFO,
                    format='[%(levelname)s] %(message)s')
logger = logging.getLogger('web_app')
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
active_tasks = {} # 用于存储活跃的 asyncio.Future 和 asyncio.Event
_im_message_ws = None
_im_message_thread = None
_im_message_stop_event = threading.Event()
_im_message_lock = threading.Lock()

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
        'is_follow': bool(user_info.get('is_follow', False)),
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
        for key in ('main_url', 'backup_url', 'fallback_url', 'play_addr', 'play_url', 'download_addr', 'url'):
            url = _media_first_url(value.get(key))
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
    candidates = []

    def push_candidate(url, metric):
        normalized_url = _media_first_url(url)
        if normalized_url:
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


def normalize_download_media_urls(media_urls, raw_media_type='video'):
    normalized_urls = normalize_media_urls(media_urls, raw_media_type) if media_urls else []
    cleaned_urls = []
    seen = set()

    for item in normalized_urls:
        url = item.get('url', '')
        media_type = item.get('type') or infer_media_type_from_url(url, raw_media_type)
        if media_type == 'video':
            url = clean_video_download_url(url)
            if is_watermark_video_url(url):
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


def _normalize_version_text(version: str) -> str:
    return str(version or '').strip().lstrip('vV')


def _parse_version_parts(version: str) -> tuple[int, ...]:
    parts = [int(part) for part in re.findall(r'\d+', _normalize_version_text(version))]
    return tuple(parts) if parts else (0,)


def _is_newer_version(latest_version: str, current_version: str) -> bool:
    latest = _parse_version_parts(latest_version)
    current = _parse_version_parts(current_version)
    max_len = max(len(latest), len(current))
    latest += (0,) * (max_len - len(latest))
    current += (0,) * (max_len - len(current))
    return latest > current


def _get_current_app_version() -> str:
    env_version = _normalize_version_text(os.environ.get('APP_VERSION') or os.environ.get('GITHUB_REF_NAME') or '')
    if env_version:
        return env_version

    config_version = _normalize_version_text(getattr(Config, 'APP_VERSION', ''))
    if config_version:
        return config_version

    try:
        result = subprocess.run(
            ['git', 'describe', '--tags', '--always', '--dirty'],
            capture_output=True,
            text=True,
            timeout=5,
            cwd=str(Path(__file__).resolve().parents[2]),
        )
        if result.returncode == 0 and result.stdout.strip():
            return _normalize_version_text(result.stdout.strip())
    except Exception:
        pass

    return '0.0.13'


def _fetch_latest_release() -> dict:
    response = http_requests.get(
        LATEST_RELEASE_API_URL,
        headers={
            'Accept': 'application/vnd.github+json',
            'User-Agent': f'better-douyin/{_get_current_app_version()}',
        },
        timeout=(5, 15),
    )
    response.raise_for_status()
    payload = response.json()
    if not isinstance(payload, dict):
        raise ValueError('GitHub release payload invalid')
    return payload


def _fetch_updater_metadata() -> dict | None:
    try:
        response = http_requests.get(
            UPDATER_METADATA_URL,
            headers={
                'Accept': 'application/json',
                'User-Agent': f'better-douyin/{_get_current_app_version()}',
            },
            timeout=(5, 15),
        )
        if response.status_code == 404:
            return None
        response.raise_for_status()
        payload = response.json()
        return payload if isinstance(payload, dict) else None
    except Exception as exc:
        logger.debug(f"读取更新签名元数据失败，回退到 GitHub Release API: {exc}")
        return None


def _normalize_update_notes(notes: str) -> str:
    text = str(notes or '').strip()
    if not text:
        return ''
    for pattern in (r'\n##\s*下载建议\b', r'\n##\s*Download\b'):
        match = re.search(pattern, text, flags=re.IGNORECASE)
        if match:
            text = text[:match.start()].strip()
            break
    return text


def _linux_package_family() -> str:
    """Best-effort Linux package family detection for release asset selection."""
    os_release = Path('/etc/os-release')
    if not os_release.exists():
        return 'generic'

    try:
        text = os_release.read_text(encoding='utf-8', errors='ignore').lower()
    except Exception:
        return 'generic'

    if any(token in text for token in ('id_like=debian', 'id=debian', 'id=ubuntu', 'id=linuxmint')):
        return 'deb'
    if any(token in text for token in ('id_like="rhel fedora"', 'id_like=fedora', 'id=fedora', 'id=rhel', 'id=centos', 'id=opensuse', 'id=sles')):
        return 'rpm'
    return 'generic'


def _platform_update_targets() -> list[tuple[str, bool]]:
    machine = platform.machine().lower()
    if IS_WINDOWS:
        return [
            ('windows-x86_64', False),
            ('windows-x86_64-nsis', False),
            ('windows-x86_64-portable', True),
        ]
    if IS_MACOS:
        if 'arm' in machine or 'aarch64' in machine:
            return [
                ('darwin-aarch64', False),
                ('darwin-aarch64-portable', True),
            ]
        return [
            ('darwin-x86_64', False),
            ('darwin-x86_64-portable', True),
        ]

    package_family = _linux_package_family()
    if package_family == 'deb':
        return [
            ('linux-x86_64-deb', False),
            ('linux-x86_64', True),
            ('linux-x86_64-tar', True),
            ('linux-x86_64-rpm', False),
        ]
    if package_family == 'rpm':
        return [
            ('linux-x86_64-rpm', False),
            ('linux-x86_64', True),
            ('linux-x86_64-tar', True),
            ('linux-x86_64-deb', False),
        ]
    return [
        ('linux-x86_64', True),
        ('linux-x86_64-tar', True),
        ('linux-x86_64-deb', False),
        ('linux-x86_64-rpm', False),
    ]


def _infer_update_install_mode(asset_name: str, portable: bool) -> str:
    name = asset_name.lower()
    if portable:
        return 'portable'
    if name.endswith('.dmg'):
        return 'dmg'
    if name.endswith('.exe'):
        return 'installer'
    if name.endswith('.deb'):
        return 'deb'
    if name.endswith('.rpm'):
        return 'rpm'
    if name.endswith('.appimage'):
        return 'appimage'
    return 'download'


def _metadata_asset_payload(metadata: dict | None) -> dict | None:
    if not metadata:
        return None
    platforms = metadata.get('platforms') if isinstance(metadata.get('platforms'), dict) else {}
    for target, portable in _platform_update_targets():
        item = platforms.get(target)
        if not isinstance(item, dict) or not item.get('url'):
            continue
        url = str(item.get('url') or '')
        name = Path(urlparse(url).path).name
        if not name:
            continue
        return {
            'name': name,
            'url': url,
            'size': int(item.get('size') or 0),
            'digest': str(item.get('digest') or ''),
            'signature': str(item.get('signature') or ''),
            'portable': portable,
            'install_mode': _infer_update_install_mode(name, portable),
            'source': 'metadata',
        }
    return None


def _release_asset_payload(asset: dict | None, portable: bool = False, fallback_url: str = '') -> dict:
    if not asset:
        return {
            'name': '',
            'url': fallback_url,
            'size': 0,
            'portable': portable,
            'install_mode': 'browser',
        }

    name = str(asset.get('name') or '')
    return {
        'name': name,
        'url': str(asset.get('browser_download_url') or fallback_url),
        'size': int(asset.get('size') or 0),
        'digest': str(asset.get('digest') or ''),
        'signature': str(asset.get('signature') or ''),
        'portable': portable,
        'install_mode': _infer_update_install_mode(name, portable),
        'source': 'release',
    }


def _select_release_asset_info(release: dict) -> dict:
    assets = release.get('assets') or []
    machine = platform.machine().lower()

    preferred_suffixes: list[tuple[str, bool]] = []
    if IS_WINDOWS:
        preferred_suffixes = [
            ('windows-x64-installer.exe', False),
            ('windows-x64-portable.zip', True),
            ('windows-x64-onefile.exe', True),
        ]
    elif IS_MACOS:
        if 'arm' in machine or 'aarch64' in machine:
            preferred_suffixes = [
                ('macos-arm64.dmg', False),
                ('macos-arm64-portable.zip', True),
            ]
        else:
            preferred_suffixes = [
                ('macos-x64.dmg', False),
                ('macos-intel.dmg', False),
                ('macos-x64-portable.zip', True),
                ('macos-intel-portable.zip', True),
            ]
    else:
        package_family = _linux_package_family()
        if package_family == 'deb':
            preferred_suffixes = [
                ('linux-x64.deb', False),
                ('linux-x64.appimage', True),
                ('linux-x64.tar.gz', True),
                ('linux-x64.rpm', False),
            ]
        elif package_family == 'rpm':
            preferred_suffixes = [
                ('linux-x64.rpm', False),
                ('linux-x64.appimage', True),
                ('linux-x64.tar.gz', True),
                ('linux-x64.deb', False),
            ]
        else:
            preferred_suffixes = [
                ('linux-x64.appimage', True),
                ('linux-x64.tar.gz', True),
                ('linux-x64.deb', False),
                ('linux-x64.rpm', False),
            ]

    normalized_assets = [
        {
            'name': str(asset.get('name') or ''),
            'name_lower': str(asset.get('name') or '').lower(),
            'url': str(asset.get('browser_download_url') or ''),
            'raw': asset,
        }
        for asset in assets
        if asset.get('browser_download_url')
    ]

    for suffix, portable in preferred_suffixes:
        for asset in normalized_assets:
            if asset['name_lower'].endswith(suffix):
                return _release_asset_payload(asset['raw'], portable)

    for asset in normalized_assets:
        name = asset['name_lower']
        if IS_WINDOWS and name.endswith('.exe'):
            return _release_asset_payload(asset['raw'], 'portable' in name or 'onefile' in name)
        if IS_MACOS and (name.endswith('.dmg') or name.endswith('.zip')):
            return _release_asset_payload(asset['raw'], 'portable' in name)
        if not IS_WINDOWS and not IS_MACOS and (name.endswith('.tar.gz') or name.endswith('.appimage') or name.endswith('.deb') or name.endswith('.rpm')):
            return _release_asset_payload(asset['raw'], name.endswith('.tar.gz') or name.endswith('.appimage'))

    return _release_asset_payload(None, False, str(release.get('html_url') or LATEST_RELEASE_PAGE_URL))


def _select_release_asset(release: dict) -> tuple[str, bool]:
    asset = _select_release_asset_info(release)
    return str(asset.get('url') or ''), bool(asset.get('portable'))


def _select_update_asset(release: dict | None = None, metadata: dict | None = None) -> dict:
    signed_asset = _metadata_asset_payload(metadata)
    if signed_asset:
        return signed_asset
    if release is None:
        release = _fetch_latest_release()
    return _select_release_asset_info(release)


def _safe_update_filename(asset_name: str, release_version: str, download_url: str) -> str:
    filename = asset_name.strip()
    if not filename:
        filename = Path(urlparse(download_url).path).name
    if not filename:
        filename = f'better-douyin-v{release_version}'

    filename = re.sub(r'[^A-Za-z0-9._() -]+', '_', filename).strip(' ._')
    return filename or f'better-douyin-v{release_version}'


def _get_update_download_dir() -> Path:
    candidates = [
        Path.home() / 'Downloads' / 'better-douyin Updates',
        Path(tempfile.gettempdir()) / 'better-douyin-updates',
    ]

    for candidate in candidates:
        try:
            candidate.mkdir(parents=True, exist_ok=True)
            probe = candidate / '.write-test'
            probe.write_text('', encoding='utf-8')
            probe.unlink(missing_ok=True)
            return candidate
        except Exception:
            continue

    fallback = Path(tempfile.gettempdir())
    fallback.mkdir(parents=True, exist_ok=True)
    return fallback


def _emit_update_event(event: str, payload: dict) -> None:
    try:
        socketio.emit(event, payload)
    except Exception as exc:
        logger.debug(f"发送更新事件失败 {event}: {exc}")


def _decode_tauri_public_key() -> tuple[bytes, bytes]:
    decoded = base64.b64decode(UPDATER_PUBLIC_KEY).decode('utf-8')
    lines = [line.strip() for line in decoded.splitlines() if line.strip()]
    if len(lines) < 2:
        raise ValueError('更新公钥格式无效')
    raw = base64.b64decode(lines[1])
    if len(raw) != 42 or raw[:2] != b'Ed':
        raise ValueError('更新公钥不是受支持的 Ed25519 minisign 公钥')
    return raw[2:10], raw[10:]


def _decode_tauri_signature(signature_text: str) -> tuple[bytes, bytes]:
    text = str(signature_text or '').strip()
    if not text:
        raise ValueError('更新包缺少签名信息')

    try:
        decoded_text = base64.b64decode(text, validate=True).decode('utf-8')
    except Exception:
        decoded_text = text

    lines = [line.strip() for line in decoded_text.splitlines() if line.strip()]
    if len(lines) < 2:
        raise ValueError('更新包签名格式无效')
    raw = base64.b64decode(lines[1])
    if len(raw) != 74 or raw[:2] != b'ED':
        raise ValueError('更新包签名不是受支持的 Ed25519 minisign 签名')
    return raw[2:10], raw[10:]


def _verify_update_signature(file_path: Path, signature_text: str) -> None:
    expected_key_id, public_key = _decode_tauri_public_key()
    signature_key_id, signature = _decode_tauri_signature(signature_text)
    if signature_key_id != expected_key_id:
        raise ValueError('更新包签名密钥不匹配')

    try:
        from nacl.signing import VerifyKey
        from nacl.exceptions import BadSignatureError
    except Exception as exc:
        raise RuntimeError('缺少 PyNaCl，无法验证更新包签名') from exc

    try:
        digest = hashlib.blake2b(file_path.read_bytes(), digest_size=64).digest()
        VerifyKey(public_key).verify(digest, signature)
    except BadSignatureError as exc:
        raise ValueError('更新包签名校验失败，请稍后重试') from exc


def _download_update_asset(
    download_url: str,
    asset_name: str,
    release_version: str,
    expected_digest: str = '',
    expected_signature: str = '',
) -> Path:
    if not download_url:
        raise ValueError('没有可下载的更新资源')

    filename = _safe_update_filename(asset_name, release_version, download_url)
    destination = _get_update_download_dir() / filename
    partial = destination.with_suffix(destination.suffix + '.part')

    headers = {
        'Accept': 'application/octet-stream',
        'User-Agent': f'better-douyin/{_get_current_app_version()}',
    }
    downloaded = 0
    last_emit = 0.0
    sha256 = hashlib.sha256()

    _emit_update_event('update_download_progress', {
        'progress': 0,
        'downloaded': 0,
        'total': 0,
        'asset_name': filename,
    })

    with http_requests.get(download_url, headers=headers, stream=True, timeout=(10, 60)) as response:
        response.raise_for_status()
        total = int(response.headers.get('Content-Length') or 0)

        with partial.open('wb') as fh:
            for chunk in response.iter_content(chunk_size=1024 * 256):
                if not chunk:
                    continue
                fh.write(chunk)
                sha256.update(chunk)
                downloaded += len(chunk)

                now = time.monotonic()
                if total > 0:
                    progress = min(99.0, downloaded * 100 / total)
                else:
                    progress = 0

                if now - last_emit >= 0.25 or (total > 0 and progress >= 99):
                    _emit_update_event('update_download_progress', {
                        'progress': progress,
                        'downloaded': downloaded,
                        'total': total,
                        'asset_name': filename,
                    })
                    last_emit = now

    os.replace(partial, destination)

    normalized_digest = expected_digest.strip().lower()
    if normalized_digest.startswith('sha256:'):
        expected_sha256 = normalized_digest.split(':', 1)[1]
        actual_sha256 = sha256.hexdigest()
        if actual_sha256.lower() != expected_sha256:
            try:
                destination.unlink(missing_ok=True)
            except Exception:
                pass
            raise ValueError('更新包校验失败，请稍后重试')

    if expected_signature:
        try:
            _verify_update_signature(destination, expected_signature)
        except Exception:
            try:
                destination.unlink(missing_ok=True)
            except Exception:
                pass
            raise

    if destination.suffix.lower() == '.appimage':
        try:
            destination.chmod(destination.stat().st_mode | 0o755)
        except Exception:
            pass

    _emit_update_event('update_download_progress', {
        'progress': 100,
        'downloaded': downloaded,
        'total': downloaded,
        'asset_name': filename,
    })
    return destination


def _ps_quote(value: str | Path) -> str:
    return "'" + str(value).replace("'", "''") + "'"


def _current_app_paths() -> dict:
    executable = Path(sys.executable).resolve()
    target_root = executable.parent
    launch_target = executable
    app_bundle = None

    if IS_MACOS:
        app_bundle = next((parent for parent in executable.parents if parent.suffix == '.app'), None)
        if app_bundle:
            target_root = app_bundle
            launch_target = app_bundle

    return {
        'executable': executable,
        'target_root': target_root,
        'launch_target': launch_target,
        'app_bundle': app_bundle,
    }


def _write_update_script(name: str, content: str, suffix: str) -> Path:
    update_dir = _get_update_download_dir()
    script_path = update_dir / f'{name}-{uuid.uuid4().hex}{suffix}'
    script_path.write_text(content, encoding='utf-8')
    if not IS_WINDOWS:
        try:
            script_path.chmod(script_path.stat().st_mode | 0o755)
        except Exception:
            pass
    return script_path


def _stage_windows_update(file_path: Path, install_mode: str, paths: dict) -> None:
    log_path = _get_update_download_dir() / 'update-helper.log'
    stage_dir = Path(tempfile.gettempdir()) / f'better-douyin-update-{uuid.uuid4().hex}'
    current_pid = os.getpid()
    target_root = paths['target_root']
    target_exe = paths['executable']
    package = file_path

    script = f"""$ErrorActionPreference = 'Stop'
$pidToWait = {current_pid}
$package = {_ps_quote(package)}
$targetRoot = {_ps_quote(target_root)}
$targetExe = {_ps_quote(target_exe)}
$stage = {_ps_quote(stage_dir)}
$log = {_ps_quote(log_path)}
function Write-UpdateLog($message) {{
  try {{ Add-Content -LiteralPath $log -Value ("[{0}] {1}" -f (Get-Date -Format s), $message) }} catch {{}}
}}
try {{
  Write-UpdateLog "waiting for app process $pidToWait"
  Wait-Process -Id $pidToWait -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 800

  if ($package.ToLower().EndsWith('.zip')) {{
    Write-UpdateLog "extracting portable update"
    if (Test-Path -LiteralPath $stage) {{
      Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
    }}
    New-Item -ItemType Directory -Path $stage -Force | Out-Null
    Expand-Archive -LiteralPath $package -DestinationPath $stage -Force
    $exeName = Split-Path -Leaf $targetExe
    $sourceExe = Get-ChildItem -LiteralPath $stage -Recurse -Filter $exeName -File | Select-Object -First 1
    if (-not $sourceExe) {{ throw "Cannot find updated executable: $exeName" }}
    $sourceRoot = Split-Path -Parent $sourceExe.FullName
    Write-UpdateLog "copying portable update from $sourceRoot to $targetRoot"
    robocopy $sourceRoot $targetRoot /E /R:3 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) {{ throw "robocopy failed with code $LASTEXITCODE" }}
  }} elseif ($package.ToLower().EndsWith('.exe')) {{
    Write-UpdateLog "running installer silently"
    $args = @('/S', "/D=$targetRoot")
    Start-Process -FilePath $package -ArgumentList $args -Verb RunAs -Wait
  }} else {{
    throw "Unsupported Windows update package: $package"
  }}

  Write-UpdateLog "starting updated app"
  Start-Process -FilePath $targetExe -WorkingDirectory $targetRoot
}} catch {{
  Write-UpdateLog $_.Exception.ToString()
  try {{ Start-Process -FilePath $package }} catch {{}}
}} finally {{
  try {{
    if (Test-Path -LiteralPath $stage) {{
      Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
    }}
    Remove-Item -LiteralPath $MyInvocation.MyCommand.Path -Force -ErrorAction SilentlyContinue
  }} catch {{}}
}}
"""
    script_path = _write_update_script('windows-update-helper', script, '.ps1')
    subprocess.Popen(
        [
            'powershell.exe',
            '-NoProfile',
            '-ExecutionPolicy',
            'Bypass',
            '-WindowStyle',
            'Hidden',
            '-File',
            str(script_path),
        ],
        close_fds=True,
    )


def _stage_macos_update(file_path: Path, install_mode: str, paths: dict) -> None:
    if not paths.get('app_bundle'):
        raise RuntimeError('无法确定当前 .app 位置')

    current_pid = os.getpid()
    target_app = paths['app_bundle']
    package = file_path
    stage_dir = Path(tempfile.gettempdir()) / f'better-douyin-update-{uuid.uuid4().hex}'
    log_path = _get_update_download_dir() / 'update-helper.log'

    script = f"""#!/usr/bin/env bash
set -euo pipefail
pid={current_pid}
package={shlex.quote(str(package))}
target_app={shlex.quote(str(target_app))}
stage={shlex.quote(str(stage_dir))}
log={shlex.quote(str(log_path))}
mount_dir=""
log_msg() {{
  printf '[%s] %s\\n' "$(date '+%Y-%m-%dT%H:%M:%S')" "$1" >> "$log" 2>/dev/null || true
}}
cleanup() {{
  if [ -n "$mount_dir" ]; then
    /usr/bin/hdiutil detach "$mount_dir" -quiet >/dev/null 2>&1 || true
  fi
  rm -rf "$stage" "$0" 2>/dev/null || true
}}
trap cleanup EXIT
while kill -0 "$pid" >/dev/null 2>&1; do
  sleep 0.5
done
sleep 0.8
mkdir -p "$stage"
source_app=""
case "$package" in
  *.dmg)
    log_msg "mounting dmg"
    mount_dir="$(/usr/bin/hdiutil attach -nobrowse -readonly "$package" | awk '/\\/Volumes\\// {{print substr($0, index($0, "/Volumes/")); exit}}')"
    source_app="$(find "$mount_dir" -maxdepth 2 -name '*.app' -type d | head -n 1)"
    ;;
  *.zip)
    log_msg "extracting zip"
    /usr/bin/ditto -x -k "$package" "$stage"
    source_app="$(find "$stage" -maxdepth 4 -name '*.app' -type d | head -n 1)"
    ;;
  *)
    log_msg "unsupported package: $package"
    /usr/bin/open "$package" >/dev/null 2>&1 || true
    exit 0
    ;;
esac
if [ -z "$source_app" ]; then
  log_msg "cannot find app bundle in update package"
  /usr/bin/open "$package" >/dev/null 2>&1 || true
  exit 1
fi
tmp_target="${{target_app}}.updating"
old_target="${{target_app}}.old"
rm -rf "$tmp_target" "$old_target"
log_msg "copying app bundle"
/usr/bin/ditto "$source_app" "$tmp_target"
if [ -d "$target_app" ]; then
  mv "$target_app" "$old_target"
fi
mv "$tmp_target" "$target_app"
rm -rf "$old_target"
log_msg "starting updated app"
/usr/bin/open -n "$target_app"
"""
    script_path = _write_update_script('macos-update-helper', script, '.sh')
    subprocess.Popen(['/bin/bash', str(script_path)], close_fds=True)


def _stage_linux_update(file_path: Path, install_mode: str, paths: dict) -> None:
    current_pid = os.getpid()
    target_root = paths['target_root']
    target_exe = paths['executable']
    package = file_path
    stage_dir = Path(tempfile.gettempdir()) / f'better-douyin-update-{uuid.uuid4().hex}'
    log_path = _get_update_download_dir() / 'update-helper.log'

    script = f"""#!/usr/bin/env bash
set -euo pipefail
pid={current_pid}
package={shlex.quote(str(package))}
target_root={shlex.quote(str(target_root))}
target_exe={shlex.quote(str(target_exe))}
stage={shlex.quote(str(stage_dir))}
log={shlex.quote(str(log_path))}
log_msg() {{
  printf '[%s] %s\\n' "$(date '+%Y-%m-%dT%H:%M:%S')" "$1" >> "$log" 2>/dev/null || true
}}
cleanup() {{
  rm -rf "$stage" "$0" 2>/dev/null || true
}}
trap cleanup EXIT
while kill -0 "$pid" >/dev/null 2>&1; do
  sleep 0.5
done
sleep 0.8
case "$package" in
  *.tar.gz)
    mkdir -p "$stage"
    tar -xzf "$package" -C "$stage"
    exe_name="$(basename "$target_exe")"
    source_exe="$(find "$stage" -type f -name "$exe_name" | head -n 1)"
    if [ -z "$source_exe" ]; then
      log_msg "cannot find updated executable"
      xdg-open "$package" >/dev/null 2>&1 || true
      exit 1
    fi
    source_root="$(dirname "$source_exe")"
    cp -a "$source_root"/. "$target_root"/
    ;;
  *.deb)
    if command -v pkexec >/dev/null 2>&1; then
      pkexec dpkg -i "$package"
    else
      xdg-open "$package" >/dev/null 2>&1 || true
      exit 1
    fi
    ;;
  *.rpm)
    if command -v pkexec >/dev/null 2>&1; then
      pkexec rpm -Uvh "$package"
    else
      xdg-open "$package" >/dev/null 2>&1 || true
      exit 1
    fi
    ;;
  *)
    xdg-open "$package" >/dev/null 2>&1 || true
    exit 0
    ;;
esac
nohup "$target_exe" >/dev/null 2>&1 &
"""
    script_path = _write_update_script('linux-update-helper', script, '.sh')
    subprocess.Popen(['/bin/sh', str(script_path)], close_fds=True)


def _stage_self_update(file_path: Path, install_mode: str) -> dict:
    if not getattr(sys, 'frozen', False):
        raise RuntimeError('源码运行模式不支持自动安装更新')

    paths = _current_app_paths()
    if IS_WINDOWS:
        _stage_windows_update(file_path, install_mode, paths)
    elif IS_MACOS:
        _stage_macos_update(file_path, install_mode, paths)
    else:
        _stage_linux_update(file_path, install_mode, paths)

    return {
        'success': True,
        'restart_required': False,
        'auto_relaunch': True,
        'message': '更新已下载，应用即将关闭并自动安装重启',
    }


def _schedule_app_exit_for_update() -> None:
    def exit_app() -> None:
        try:
            socketio.stop()
        except Exception:
            pass
        os._exit(0)

    threading.Timer(1.2, exit_app).start()


def _open_update_file(file_path: Path, install_mode: str) -> bool:
    if not file_path.exists():
        return False

    target = file_path
    if install_mode == 'portable' and file_path.suffix.lower() not in ('.exe', '.appimage'):
        target = file_path.parent

    return _open_external_target(str(target))


def _update_download_message(file_path: Path, install_mode: str, opened: bool) -> str:
    location = str(file_path)
    if install_mode in ('installer', 'dmg', 'deb', 'rpm'):
        if opened:
            return '更新包已下载并打开，请按系统提示完成安装'
        return f'更新包已下载到 {location}，请手动打开安装'
    if install_mode == 'appimage':
        if opened:
            return '新版 AppImage 已下载并打开'
        return f'新版 AppImage 已下载到 {location}'
    if opened:
        return '便携版更新包已下载，已打开所在文件夹'
    return f'便携版更新包已下载到 {location}'


def _open_external_target(target: str) -> bool:
    if not target:
        return False

    try:
        if IS_WINDOWS:
            os.startfile(target)
        elif sys.platform == 'darwin':
            subprocess.Popen(['open', target])
        else:
            subprocess.Popen(['xdg-open', target])
        return True
    except Exception:
        try:
            return bool(webbrowser.open(target))
        except Exception:
            return False


def get_or_create_loop():
    global _global_loop, _loop_thread
    if _global_loop is None:
        _global_loop = asyncio.new_event_loop()
        _loop_thread = threading.Thread(target=_global_loop.run_forever, daemon=True)
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
    download_tasks[task_id] = task
    _prune_download_tasks()


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


def _dialog_cancelled(result: subprocess.CompletedProcess[str]) -> bool:
    stdout = (result.stdout or "").strip()
    stderr = (result.stderr or "").strip().lower()
    if stdout:
        return False
    if not stderr and result.returncode in (0, 1):
        return True
    return any(token in stderr for token in ("cancel", "canceled", "cancelled", "user canceled", "user cancelled"))


def _dialog_error_message(result: subprocess.CompletedProcess[str], fallback: str) -> str:
    stderr = (result.stderr or "").strip()
    return stderr or fallback


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


@app.route('/api/config', methods=['GET'])
def get_config():
    """获取配置信息"""
    return jsonify({
        'cookie_set': bool(Config.COOKIE),
        'download_dir': Config.BASE_DIR,
        'download_root': str(get_download_root()),
        'download_roots': [str(root) for root in get_all_download_roots()],
        'cookie_preview': f"{Config.COOKIE[:12]}..." if Config.COOKIE else '',
        'download_quality': getattr(Config, 'DOWNLOAD_QUALITY', 'auto'),
        'max_concurrent': getattr(Config, 'MAX_CONCURRENT', 3),
        'filename_template': getattr(Config, 'FILENAME_TEMPLATE', '{title}'),
        'folder_name_template': getattr(Config, 'FOLDER_NAME_TEMPLATE', '{author}'),
        'auto_create_folder': getattr(Config, 'AUTO_CREATE_FOLDER', True),
        'im_friend_sec_user_ids': getattr(Config, 'IM_FRIEND_SEC_USER_IDS', []),
        'im_friend_include_all_users': getattr(Config, 'IM_FRIEND_INCLUDE_ALL_USERS', False),
        'im_friend_refresh_interval_seconds': getattr(Config, 'IM_FRIEND_REFRESH_INTERVAL_SECONDS', 5),
        'app_version': _get_current_app_version(),
    })

def _friend_chat_state_path() -> Path:
    return Path(Config.CONFIG_FILE).with_name('friend_chat_state.json')


def _sanitize_friend_chat_message(value):
    if not isinstance(value, dict):
        return None
    text = str(value.get('text') or '').strip()
    if not text:
        return None
    try:
        created_at = int(float(value.get('createdAt') or value.get('created_at') or 0))
    except Exception:
        created_at = 0
    if created_at <= 0:
        return None
    direction = str(value.get('direction') or '').strip()
    if direction not in ('in', 'out'):
        direction = 'out'
    status = str(value.get('status') or '').strip()
    if status not in ('pending', 'sent', 'error'):
        status = 'sent'
    return {
        'id': str(value.get('id') or f'message-{created_at}')[:160],
        'text': text[:1000],
        'createdAt': created_at,
        'status': status,
        'direction': direction,
        'senderUid': str(value.get('senderUid') or value.get('sender_uid') or '')[:80],
    }


def _sanitize_friend_chat_state(value):
    if not isinstance(value, dict):
        return {'summaries': {}, 'unreadCounts': {}}
    raw_summaries = value.get('summaries') if isinstance(value.get('summaries'), dict) else {}
    raw_unread = value.get('unreadCounts') if isinstance(value.get('unreadCounts'), dict) else {}
    summaries = {}
    unread_counts = {}
    for raw_sec_uid, raw_summary in raw_summaries.items():
        sec_uid = str(raw_sec_uid or '').strip()
        if not sec_uid or len(sec_uid) > 220 or not isinstance(raw_summary, dict):
            continue
        latest_message = _sanitize_friend_chat_message(raw_summary.get('latestMessage'))
        try:
            latest_at = int(float(raw_summary.get('latestMessageAt') or 0))
        except Exception:
            latest_at = 0
        try:
            unread_count = max(0, min(999, int(float(raw_summary.get('unreadCount') or 0))))
        except Exception:
            unread_count = 0
        if latest_message:
            latest_at = max(latest_at, int(latest_message.get('createdAt') or 0))
        if latest_at <= 0 and unread_count <= 0:
            continue
        summaries[sec_uid] = {
            'latestMessage': latest_message,
            'latestMessageAt': latest_at,
            'unreadCount': unread_count,
        }
        if unread_count > 0:
            unread_counts[sec_uid] = unread_count
    for raw_sec_uid, raw_count in raw_unread.items():
        sec_uid = str(raw_sec_uid or '').strip()
        if not sec_uid or len(sec_uid) > 220:
            continue
        try:
            count = max(0, min(999, int(float(raw_count or 0))))
        except Exception:
            count = 0
        if count > 0:
            unread_counts[sec_uid] = count
            if sec_uid in summaries:
                summaries[sec_uid]['unreadCount'] = max(int(summaries[sec_uid].get('unreadCount') or 0), count)
    return {
        'summaries': summaries,
        'unreadCounts': unread_counts,
    }


@app.route('/api/friend_chat_state', methods=['GET'])
def get_friend_chat_state():
    try:
        state_path = _friend_chat_state_path()
        if not state_path.exists():
            return jsonify({'success': True, 'summaries': {}, 'unreadCounts': {}})
        with open(state_path, 'r', encoding='utf-8') as state_file:
            state = _sanitize_friend_chat_state(json.load(state_file))
        return jsonify({'success': True, **state})
    except Exception as error:
        logger.warning('读取好友聊天状态失败: %s', error)
        return jsonify({'success': True, 'summaries': {}, 'unreadCounts': {}})


@app.route('/api/friend_chat_state', methods=['POST'])
def save_friend_chat_state():
    try:
        state = _sanitize_friend_chat_state(_request_json())
        state_path = _friend_chat_state_path()
        state_path.parent.mkdir(parents=True, exist_ok=True)
        temp_path = state_path.with_suffix(f'{state_path.suffix}.tmp')
        with open(temp_path, 'w', encoding='utf-8') as state_file:
            json.dump(state, state_file, ensure_ascii=False, indent=2)
            state_file.write('\n')
        os.replace(temp_path, state_path)
        return jsonify({'success': True})
    except Exception as error:
        logger.warning('保存好友聊天状态失败: %s', error)
        return jsonify({'success': False, 'message': f'保存好友聊天状态失败: {str(error)}'}), 500

@app.route('/api/config', methods=['POST'])
def set_config():
    """设置配置"""
    global api, downloader, user_manager
    try:
        data = _request_json()
        previous_download_dir = str(get_download_root())
        previous_all_roots = [str(root) for root in get_all_download_roots()]
        
        if 'cookie' in data:
            Config.COOKIE = data['cookie'].replace('\n', '').replace('\r', '').strip()
        if 'download_dir' in data:
            Config.BASE_DIR = data['download_dir']
            Config.DOWNLOAD_DIR = Config.BASE_DIR
        if 'download_quality' in data:
            Config.DOWNLOAD_QUALITY = str(data.get('download_quality') or 'auto')
        if 'max_concurrent' in data:
            Config.MAX_CONCURRENT = _coerce_int(data.get('max_concurrent'), 3, 1, 10)
        if 'filename_template' in data:
            Config.FILENAME_TEMPLATE = Config.normalize_filename_template(
                data.get('filename_template'),
                '{title}',
            )
        if 'folder_name_template' in data:
            Config.FOLDER_NAME_TEMPLATE = Config.normalize_filename_template(
                data.get('folder_name_template'),
                '{author}',
            )
        if 'auto_create_folder' in data:
            Config.AUTO_CREATE_FOLDER = bool(data.get('auto_create_folder'))
        if 'im_friend_sec_user_ids' in data:
            Config.IM_FRIEND_SEC_USER_IDS = Config.normalize_sec_user_ids(data.get('im_friend_sec_user_ids'))
        if 'im_friend_include_all_users' in data:
            Config.IM_FRIEND_INCLUDE_ALL_USERS = bool(data.get('im_friend_include_all_users'))
        if 'im_friend_refresh_interval_seconds' in data:
            Config.IM_FRIEND_REFRESH_INTERVAL_SECONDS = _coerce_int(
                data.get('im_friend_refresh_interval_seconds'),
                5,
                1,
                3600,
            )

        move_existing_files = bool(data.get('move_existing_files'))
        history_dirs = list(getattr(Config, 'HISTORY_DIRS', []))
        new_download_dir = str(get_download_root())

        if previous_download_dir.lower() != new_download_dir.lower():
            if move_existing_files:
                moved_count = 0
                for old_root in previous_all_roots:
                    if os.path.abspath(old_root).lower() == os.path.abspath(new_download_dir).lower():
                        continue
                    moved_count += move_directory_contents(Path(old_root), Path(new_download_dir))

                history_dirs = [
                    path for path in history_dirs
                    if os.path.abspath(path).lower() not in {
                        os.path.abspath(root).lower() for root in previous_all_roots
                    }
                ]
            else:
                moved_count = 0
                history_dirs.extend(previous_all_roots)
        else:
            moved_count = 0

        Config.HISTORY_DIRS = Config.normalize_history_dirs(history_dirs)
        Config.save_config(
            Config.COOKIE,
            Config.BASE_DIR,
            Config.HISTORY_DIRS,
            download_quality=Config.DOWNLOAD_QUALITY,
            max_concurrent=Config.MAX_CONCURRENT,
            filename_template=Config.FILENAME_TEMPLATE,
            folder_name_template=Config.FOLDER_NAME_TEMPLATE,
            auto_create_folder=Config.AUTO_CREATE_FOLDER,
            im_friend_sec_user_ids=Config.IM_FRIEND_SEC_USER_IDS,
            im_friend_include_all_users=Config.IM_FRIEND_INCLUDE_ALL_USERS,
            im_friend_refresh_interval_seconds=Config.IM_FRIEND_REFRESH_INTERVAL_SECONDS,
        )

        if previous_download_dir.lower() != new_download_dir.lower():
            rebuild_download_history_index()
        else:
            invalidate_download_history_cache(drop_disk=False)
        
        # 重新初始化API和下载器
        init_app()
        
        return jsonify({
            'success': True,
            'message': '配置保存成功',
            'moved_count': moved_count,
            'download_root': str(get_download_root()),
            'download_roots': [str(root) for root in get_all_download_roots()],
            'download_quality': Config.DOWNLOAD_QUALITY,
            'max_concurrent': Config.MAX_CONCURRENT,
            'filename_template': Config.FILENAME_TEMPLATE,
            'folder_name_template': Config.FOLDER_NAME_TEMPLATE,
            'auto_create_folder': Config.AUTO_CREATE_FOLDER,
            'im_friend_sec_user_ids': Config.IM_FRIEND_SEC_USER_IDS,
            'im_friend_include_all_users': Config.IM_FRIEND_INCLUDE_ALL_USERS,
            'im_friend_refresh_interval_seconds': Config.IM_FRIEND_REFRESH_INTERVAL_SECONDS,
        })
    except Exception as e:
        return jsonify({'success': False, 'message': f'配置保存失败: {str(e)}'}), 500


@app.route('/api/get_app_version', methods=['GET'])
def get_app_version():
    """返回当前应用版本。"""
    return jsonify(_get_current_app_version())


@app.route('/api/check_update', methods=['GET'])
def check_update():
    """检查 GitHub Releases 上是否有新版本。"""
    current_version = _get_current_app_version()

    try:
        metadata = _fetch_updater_metadata()
        release = None if metadata else _fetch_latest_release()
        latest_version = _normalize_version_text(
            (metadata or {}).get('version') or
            (release or {}).get('tag_name') or
            (release or {}).get('name') or
            ''
        )
        has_update = bool(latest_version) and _is_newer_version(latest_version, current_version)
        asset = _select_update_asset(release, metadata)

        return jsonify({
            'success': True,
            'has_update': has_update,
            'current_version': current_version,
            'version': latest_version or current_version,
            'notes': _normalize_update_notes((metadata or {}).get('notes') or (release or {}).get('body')) or '暂无更新说明',
            'html_url': (release or {}).get('html_url') or LATEST_RELEASE_PAGE_URL,
            'download_url': asset.get('url'),
            'asset_name': asset.get('name'),
            'asset_size': asset.get('size'),
            'portable': asset.get('portable'),
            'install_mode': asset.get('install_mode'),
            'signed': bool(asset.get('signature')),
        })
    except Exception as e:
        logger.error(f"检查更新失败: {e}")
        return jsonify({
            'success': False,
            'has_update': False,
            'current_version': current_version,
            'message': f'检查更新失败: {str(e)}'
        })


@app.route('/api/download_update', methods=['GET'])
def download_update():
    """在应用内下载对应平台的发布资源，并打开安装包或所在目录。"""
    try:
        metadata = _fetch_updater_metadata()
        release = None if metadata else _fetch_latest_release()
        current_version = _get_current_app_version()
        latest_version = _normalize_version_text(
            (metadata or {}).get('version') or
            (release or {}).get('tag_name') or
            (release or {}).get('name') or
            _get_current_app_version()
        )
        if latest_version and not _is_newer_version(latest_version, current_version):
            return jsonify({
                'success': False,
                'message': '当前已是最新版本'
            }), 409

        asset = _select_update_asset(release, metadata)
        download_url = str(asset.get('url') or '')

        if not download_url or asset.get('install_mode') == 'browser':
            target_url = download_url or str((release or {}).get('html_url') or LATEST_RELEASE_PAGE_URL)
            if not _open_external_target(target_url):
                return jsonify({
                    'success': False,
                    'message': '无法打开下载页面，请手动前往 Releases 页面'
                }), 500
            return jsonify({
                'success': True,
                'mode': 'browser',
                'restart_required': False,
                'download_url': target_url,
                'message': '未找到匹配安装包，已打开 Releases 页面'
            })

        file_path = _download_update_asset(
            download_url,
            str(asset.get('name') or ''),
            latest_version,
            str(asset.get('digest') or ''),
            str(asset.get('signature') or ''),
        )
        install_mode = str(asset.get('install_mode') or 'download')

        try:
            staged = _stage_self_update(file_path, install_mode)
            _schedule_app_exit_for_update()
            return jsonify({
                'success': True,
                'mode': 'auto_install',
                'portable': bool(asset.get('portable')),
                'install_mode': install_mode,
                'restart_required': staged.get('restart_required', False),
                'auto_relaunch': True,
                'download_url': download_url,
                'file_path': str(file_path),
                'message': staged.get('message') or '更新已下载，应用即将关闭并自动安装重启',
            })
        except Exception as install_error:
            logger.warning(f"自动安装更新不可用，回退为打开更新包: {install_error}")

        opened = _open_update_file(file_path, install_mode)

        _emit_update_event('update_download_finished', {
            'file_path': str(file_path),
            'install_mode': install_mode,
            'opened': opened,
            'restart_required': False,
            'message': _update_download_message(file_path, install_mode, opened),
        })

        return jsonify({
            'success': True,
            'mode': 'download',
            'portable': bool(asset.get('portable')),
            'install_mode': install_mode,
            'restart_required': False,
            'download_url': download_url,
            'file_path': str(file_path),
            'message': _update_download_message(file_path, install_mode, opened),
        })
    except Exception as e:
        _emit_update_event('update_download_error', {'message': str(e)})
        logger.error(f"打开更新下载失败: {e}")
        return jsonify({'success': False, 'message': f'更新下载失败: {str(e)}'}), 500


@app.route('/api/restart_app', methods=['GET'])
def restart_app():
    """重启当前打包应用。源码模式下保留兼容返回。"""
    if getattr(sys, 'frozen', False):
        executable = Path(sys.executable)

        def relaunch() -> None:
            try:
                if IS_MACOS:
                    app_bundle = next((parent for parent in executable.parents if parent.suffix == '.app'), None)
                    if app_bundle:
                        subprocess.Popen(['open', '-n', str(app_bundle)])
                    else:
                        subprocess.Popen([str(executable)], cwd=str(executable.parent))
                else:
                    subprocess.Popen([str(executable)], cwd=str(executable.parent), close_fds=True)
            finally:
                os._exit(0)

        threading.Timer(0.5, relaunch).start()
        return jsonify({
            'success': True,
            'message': '应用正在重启'
        })

    return jsonify({
        'success': False,
        'message': '源码运行模式不支持自动重启'
    }), 501


@app.route('/api/select_directory', methods=['POST'])
def select_directory():
    """打开系统文件夹选择器，返回用户选择的路径"""
    try:
        initial_dir = Config.BASE_DIR or os.path.expanduser('~')

        if IS_WINDOWS:
            initial_dir_ps = str(initial_dir).replace("'", "''")
            script = f'''
            Add-Type -AssemblyName System.Windows.Forms
            [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
            $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
            $dialog.Description = "选择下载目录"
            $dialog.SelectedPath = '{initial_dir_ps}'
            $dialog.ShowNewFolderButton = $true
            if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {{
                Write-Output $dialog.SelectedPath
            }}
            '''
            result = subprocess.run(
                ['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
                capture_output=True,
                text=True,
                timeout=120,
            )
            directory = result.stdout.strip()

            if directory:
                return jsonify({'success': True, 'path': directory})
            if _dialog_cancelled(result):
                return jsonify({'success': False, 'message': '用户取消选择'})
            raise RuntimeError(_dialog_error_message(result, '选择目录失败'))

        if not IS_MACOS:
            if shutil.which('zenity'):
                result = subprocess.run(
                    ['zenity', '--file-selection', '--directory', '--filename', str(initial_dir)],
                    capture_output=True,
                    text=True,
                    timeout=120,
                )
                if result.returncode == 0 and result.stdout.strip():
                    return jsonify({'success': True, 'path': result.stdout.strip()})
                if _dialog_cancelled(result):
                    return jsonify({'success': False, 'message': '用户取消选择'})
                raise RuntimeError(_dialog_error_message(result, '选择目录失败'))

            if shutil.which('kdialog'):
                result = subprocess.run(
                    ['kdialog', '--getexistingdirectory', str(initial_dir)],
                    capture_output=True,
                    text=True,
                    timeout=120,
                )
                if result.returncode == 0 and result.stdout.strip():
                    return jsonify({'success': True, 'path': result.stdout.strip()})
                if _dialog_cancelled(result):
                    return jsonify({'success': False, 'message': '用户取消选择'})
                raise RuntimeError(_dialog_error_message(result, '选择目录失败'))

            return jsonify({'success': False, 'message': '当前系统缺少目录选择器，请安装 zenity 或 kdialog'})

        initial_dir_json = json.dumps(str(initial_dir))
        script = f'''
        tell application "System Events"
            activate
            set selected_folder to choose folder with prompt "选择下载目录:" default location POSIX file {initial_dir_json}
            return POSIX path of selected_folder
        end tell
        '''

        result = subprocess.run(
            ['osascript', '-e', script],
            capture_output=True,
            text=True,
            timeout=60
        )

        if result.returncode == 0 and result.stdout.strip():
            directory = result.stdout.strip()
            return jsonify({'success': True, 'path': directory})
        if _dialog_cancelled(result):
            return jsonify({'success': False, 'message': '用户取消选择'})
        raise RuntimeError(_dialog_error_message(result, '选择目录失败'))
    except subprocess.TimeoutExpired:
        logger.warning("选择目录超时")
        return jsonify({'success': False, 'message': '选择目录超时，请重试'}), 504
    except Exception as e:
        logger.exception("选择目录失败")
        return jsonify({'success': False, 'message': f'选择失败：{str(e)}'}), 500


@app.route('/api/download_history', methods=['GET'])
def get_download_history():
    """获取下载历史文件列表。"""
    try:
        force_refresh = str(request.args.get('refresh', '')).lower() in ('1', 'true', 'yes')
        items, total, total_size, latest = _filter_download_history_items(
            get_download_history_items(force_refresh=force_refresh)
        )
        root = get_download_root()
        return jsonify({
            'success': True,
            'download_root': str(root),
            'download_roots': [str(item) for item in get_all_download_roots()],
            'base_dir': Config.BASE_DIR,
            'items': items,
            'total': total,
            'total_size': total_size,
            'latest': latest,
        })
    except Exception as e:
        logger.error(f"获取下载历史失败: {str(e)}")
        return jsonify({'success': False, 'message': f'获取下载历史失败: {str(e)}'}), 500


@app.route('/api/local-media')
def local_media():
    """安全读取下载目录内的本地媒体，用于 pywebview 中显示缩略图/视频首帧。"""
    try:
        file_path = _safe_history_path(request.args.get('path', ''))
        if not file_path.exists() or not file_path.is_file():
            return 'File not found', 404
        if file_path.suffix.lower() not in LOCAL_MEDIA_EXTENSIONS:
            return 'Unsupported media type', 415

        mimetype = _guess_local_media_mimetype(file_path)
        response = send_file(
            file_path,
            mimetype=mimetype,
            conditional=True,
            etag=True,
            last_modified=file_path.stat().st_mtime,
            max_age=3600,
        )
        response.headers['Accept-Ranges'] = 'bytes'
        response.headers['Cache-Control'] = 'private, max-age=3600'
        return response
    except ValueError as error:
        return str(error), 400
    except Exception as e:
        logger.error(f"读取本地媒体失败: {str(e)}")
        return 'Local media error', 500


def _write_text_to_clipboard(text: str) -> None:
    if IS_WINDOWS:
        subprocess.run(['clip'], input=text, text=True, check=True, timeout=5)
        return

    if sys.platform == 'darwin':
        subprocess.run(['pbcopy'], input=text, text=True, check=True, timeout=5)
        return

    linux_commands = [
        ['wl-copy'],
        ['xclip', '-selection', 'clipboard'],
        ['xsel', '--clipboard', '--input'],
    ]
    for command in linux_commands:
        if shutil.which(command[0]):
            subprocess.run(command, input=text, text=True, check=True, timeout=5)
            return

    raise RuntimeError('当前系统缺少可用的剪贴板工具')


@app.route('/api/clipboard/write', methods=['POST'])
def write_clipboard_text():
    """写入系统剪贴板，供嵌入 WebView 和普通浏览器兜底使用。"""
    try:
        data = _request_json()
        text = str(data.get('text') or '')
        if not text:
            return jsonify({'success': False, 'message': '复制内容不能为空'}), 400

        _write_text_to_clipboard(text)
        return jsonify({'success': True})
    except Exception as e:
        logger.error(f"写入剪贴板失败: {str(e)}")
        return jsonify({'success': False, 'message': f'写入剪贴板失败: {str(e)}'}), 500


@app.route('/api/download_history/open', methods=['POST'])
def open_download_history_file():
    """打开下载文件。"""
    try:
        data = _request_json()
        file_path = _safe_history_path(data.get('path', ''))
        if not file_path.exists() or not file_path.is_file():
            return jsonify({'success': False, 'message': '文件不存在'}), 404

        if IS_WINDOWS:
            os.startfile(str(file_path))
        elif sys.platform == 'darwin':
            subprocess.Popen(['open', str(file_path)])
        else:
            subprocess.Popen(['xdg-open', str(file_path)])

        return jsonify({'success': True})
    except Exception as e:
        logger.error(f"打开下载文件失败: {str(e)}")
        return jsonify({'success': False, 'message': f'打开下载文件失败: {str(e)}'}), 500


@app.route('/api/download_history/open_location', methods=['POST'])
def open_download_history_location():
    """打开文件所在目录。"""
    try:
        data = _request_json()
        file_path = _safe_history_path(data.get('path', ''))
        if not file_path.exists():
            return jsonify({'success': False, 'message': '文件不存在'}), 404

        open_dir = file_path if file_path.is_dir() else file_path.parent

        if IS_WINDOWS:
            if file_path.is_dir():
                subprocess.Popen(['explorer.exe', os.path.normpath(str(open_dir))])
            else:
                normalized_path = os.path.normpath(str(file_path))
                subprocess.Popen(['explorer.exe', '/select,', normalized_path])
        elif sys.platform == 'darwin':
            if file_path.is_dir():
                subprocess.Popen(['open', str(open_dir)])
            else:
                subprocess.Popen(['open', '-R', str(file_path)])
        else:
            subprocess.Popen(['xdg-open', str(open_dir)])

        return jsonify({'success': True})
    except Exception as e:
        logger.error(f"打开文件位置失败: {str(e)}")
        return jsonify({'success': False, 'message': f'打开文件位置失败: {str(e)}'}), 500


@app.route('/api/download_history/open_directory', methods=['POST'])
def open_download_history_directory():
    """打开当前下载目录。"""
    try:
        download_root = get_download_root()
        download_root.mkdir(parents=True, exist_ok=True)

        if IS_WINDOWS:
            os.startfile(str(download_root))
        elif sys.platform == 'darwin':
            subprocess.Popen(['open', str(download_root)])
        else:
            subprocess.Popen(['xdg-open', str(download_root)])

        return jsonify({'success': True, 'path': str(download_root)})
    except Exception as e:
        logger.error(f"打开下载目录失败: {str(e)}")
        return jsonify({'success': False, 'message': f'打开下载目录失败: {str(e)}'}), 500


@app.route('/api/download_history/delete', methods=['POST'])
def delete_download_history_files():
    """删除下载文件，支持批量。"""
    try:
        data = _request_json()
        raw_paths = data.get('paths') or []
        if not isinstance(raw_paths, list) or not raw_paths:
            return jsonify({'success': False, 'message': '请选择至少一个文件'}), 400

        deleted = []
        missing = []

        for raw_path in raw_paths:
            try:
                file_path = _safe_history_path(str(raw_path))
            except ValueError:
                missing.append(str(raw_path))
                continue

            if not file_path.exists() or not file_path.is_file():
                missing.append(str(file_path))
                continue

            root = get_root_for_path(file_path)
            if root is None:
                missing.append(str(file_path))
                continue

            file_path.unlink()
            deleted.append(str(file_path))
            _cleanup_empty_parent_dirs(file_path, root)

        return jsonify({
            'success': True,
            'deleted_count': len(deleted),
            'missing_count': len(missing),
            'deleted': deleted,
            'missing': missing
        })
    except Exception as e:
        logger.error(f"删除下载文件失败: {str(e)}")
        return jsonify({'success': False, 'message': f'删除下载文件失败: {str(e)}'}), 500
    finally:
        if 'deleted' in locals() and deleted:
            remove_download_history_entries(deleted)


@app.route('/api/download_history/move_selected', methods=['POST'])
def move_selected_download_history_files():
    """将选中的下载文件迁移到新的下载目录。"""
    try:
        data = _request_json()
        raw_paths = data.get('paths') or []
        target_dir_raw = (data.get('target_dir') or '').strip()

        if not isinstance(raw_paths, list) or not raw_paths:
            return jsonify({'success': False, 'message': '请选择至少一个文件'}), 400
        if not target_dir_raw:
            return jsonify({'success': False, 'message': '目标目录不能为空'}), 400

        target_dir = Path(target_dir_raw).expanduser().resolve()
        target_dir.mkdir(parents=True, exist_ok=True)

        moved = []
        missing = []
        moved_map = {}

        for raw_path in raw_paths:
            try:
                file_path = _safe_history_path(str(raw_path))
            except ValueError:
                missing.append(str(raw_path))
                continue

            if not file_path.exists() or not file_path.is_file():
                missing.append(str(file_path))
                continue

            root = get_root_for_path(file_path)
            if root is None:
                missing.append(str(file_path))
                continue

            relative_path = file_path.relative_to(root)
            destination = _unique_destination_path(target_dir / relative_path)
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(file_path), str(destination))
            moved.append(str(destination))
            moved_map[str(file_path)] = str(destination)
            _cleanup_empty_parent_dirs(file_path, root)

        Config.HISTORY_DIRS = Config.normalize_history_dirs([
            *getattr(Config, 'HISTORY_DIRS', []),
            str(target_dir)
        ])
        Config.save_config(
            Config.COOKIE,
            Config.BASE_DIR,
            Config.HISTORY_DIRS,
            download_quality=Config.DOWNLOAD_QUALITY,
            max_concurrent=Config.MAX_CONCURRENT,
        )
        move_download_history_entries(moved_map)

        return jsonify({
            'success': True,
            'moved_count': len(moved),
            'missing_count': len(missing),
            'moved': moved,
            'missing': missing,
            'download_root': str(get_download_root()),
            'download_roots': [str(root) for root in get_all_download_roots()]
        })
    except Exception as e:
        logger.error(f"迁移选中文件失败: {str(e)}")
        return jsonify({'success': False, 'message': f'迁移选中文件失败: {str(e)}'}), 500
@app.route('/api/media/proxy')
def media_proxy():
    """代理抖音媒体资源，限制来源并安全处理重定向。"""

    url = request.args.get('url', '').strip()
    requested_filename = _sanitize_download_filename(request.args.get('filename', '').strip(), default='')
    requested_media_type = request.args.get('media_type', '').strip().lower()
    image_skey = request.args.get('skey', '').strip()
    allow_origin, origin_value = _allowed_media_request_origin()

    if not allow_origin:
        return 'Forbidden', 403
    if not is_allowed_media_url(url):
        return 'Invalid URL', 400

    request_range = request.headers.get('Range')
    request_range_str = request_range or ''
    should_seed_video_range = False
    upstream_range_value = _cap_media_range_header(request_range, requested_media_type)
    cache_key = url if '/aweme/v1/play/' in url else None
    upstream_url = MEDIA_PROXY_REDIRECT_CACHE.get(cache_key, url) if cache_key else url

    retry_count = 0
    redirect_hops = 0
    start_time = time.time()
    resp = None

    try:
        while True:
            if not is_allowed_media_url(upstream_url):
                if cache_key:
                    MEDIA_PROXY_REDIRECT_CACHE.pop(cache_key, None)
                return 'Invalid URL', 400

            headers = {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
                'Referer': 'https://www.douyin.com/',
                'Accept': '*/*',
                'Accept-Encoding': 'identity;q=1, *;q=0',
            }

            if api and api.cookie and should_forward_douyin_cookie(upstream_url):
                headers['Cookie'] = api.cookie
            if upstream_range_value:
                headers['Range'] = upstream_range_value

            try:
                resp = http_requests.get(
                    upstream_url,
                    headers=headers,
                    stream=True,
                    timeout=(6, 8) if requested_media_type == 'image' else (10, 45),
                    allow_redirects=False,
                )
            except Exception as e:
                if retry_count < MEDIA_PROXY_MAX_RETRIES:
                    retry_count += 1
                    logger.warning(
                        '[media_proxy] 网络错误，准备重试 %s/%s: %s',
                        retry_count,
                        MEDIA_PROXY_MAX_RETRIES,
                        e,
                    )
                    time.sleep(0.5 * retry_count)
                    continue

                if cache_key:
                    MEDIA_PROXY_REDIRECT_CACHE.pop(cache_key, None)
                logger.error(
                    '[media_proxy] 请求失败, elapsed=%sms seeded_range=%s range="%s" url=%s error=%s',
                    int((time.time() - start_time) * 1000),
                    should_seed_video_range,
                    request_range_str,
                    upstream_url[:120],
                    e,
                )
                return 'Proxy error', 502

            if 300 <= resp.status_code < 400:
                location = resp.headers.get('Location', '')
                next_url = _resolve_media_redirect_target(resp.url, location)
                resp.close()

                if not location or redirect_hops >= 4 or not next_url or not is_allowed_media_url(next_url):
                    if cache_key:
                        MEDIA_PROXY_REDIRECT_CACHE.pop(cache_key, None)
                    return 'Invalid redirect URL', 400

                redirect_hops += 1
                upstream_url = next_url
                continue

            if 500 <= resp.status_code < 600 and retry_count < MEDIA_PROXY_MAX_RETRIES:
                retry_count += 1
                logger.warning(
                    '[media_proxy] 上游服务错误，准备重试 %s/%s: status=%s url=%s',
                    retry_count,
                    MEDIA_PROXY_MAX_RETRIES,
                    resp.status_code,
                    upstream_url[:120],
                )
                resp.close()
                time.sleep(0.5 * retry_count)
                continue

            break

        if cache_key and upstream_url != url:
            _remember_media_redirect(cache_key, upstream_url)

        logger.info(
            '[media_proxy] 上游响应耗时 %.2fs, status=%s, seeded_range=%s, range="%s", url=%s',
            time.time() - start_time,
            resp.status_code,
            should_seed_video_range,
            request_range_str,
            upstream_url[:120],
        )

        resp_headers = {}
        for key in ['Content-Type', 'Content-Range', 'Accept-Ranges']:
            if key in resp.headers:
                resp_headers[key] = resp.headers[key]

        upstream_content_type = resp.headers.get('Content-Type', '')
        normalized_content_type = upstream_content_type.split(';', 1)[0].strip().lower() if upstream_content_type else ''
        content_length = resp.headers.get('Content-Length', '')
        if content_length:
            resp_headers['Content-Length'] = content_length

        inferred_name = requested_filename or upstream_url
        if requested_media_type == 'audio':
            resp_headers['Content-Type'] = _guess_audio_content_type(inferred_name, normalized_content_type)
        elif not normalized_content_type or normalized_content_type == 'application/octet-stream':
            if '.mp4' in upstream_url or '/play/' in upstream_url or requested_media_type == 'video':
                resp_headers['Content-Type'] = 'video/mp4'
            elif '.jpg' in upstream_url or '.jpeg' in upstream_url:
                resp_headers['Content-Type'] = 'image/jpeg'
            elif '.png' in upstream_url:
                resp_headers['Content-Type'] = 'image/png'
            elif '.webp' in upstream_url:
                resp_headers['Content-Type'] = 'image/webp'

        if requested_media_type in ('audio', 'video') and 'Accept-Ranges' not in resp_headers:
            resp_headers['Accept-Ranges'] = 'bytes'

        content_disposition = _build_content_disposition(requested_filename, 'inline')
        if content_disposition:
            resp_headers['Content-Disposition'] = content_disposition

        resp_headers['Access-Control-Allow-Origin'] = origin_value or '*'
        resp_headers['Cache-Control'] = 'public, max-age=3600'

        if requested_media_type == 'image' and image_skey:
            try:
                from cryptography.hazmat.primitives.ciphers.aead import AESGCM
                encrypted = resp.content
                resp.close()
                key = bytes.fromhex(image_skey)
                if len(key) != 32 or len(encrypted) <= 28:
                    raise ValueError('invalid encrypted image payload')
                decrypted = AESGCM(key).decrypt(encrypted[:12], encrypted[12:], None)
                decrypted_headers = {
                    'Content-Type': _guess_image_content_type_from_bytes(decrypted),
                    'Content-Length': str(len(decrypted)),
                    'Access-Control-Allow-Origin': origin_value or '*',
                    'Cache-Control': 'public, max-age=3600',
                }
                if content_disposition:
                    decrypted_headers['Content-Disposition'] = content_disposition
                return Response(decrypted, status=resp.status_code, headers=decrypted_headers)
            except Exception as decrypt_error:
                logger.warning(
                    '[media_proxy] 图片解密失败，将返回原始响应: url=%s error=%s',
                    upstream_url[:120],
                    decrypt_error,
                )

        def generate():
            total = 0
            stream_start = time.time()
            try:
                for chunk in resp.iter_content(chunk_size=65536):
                    if chunk:
                        total += len(chunk)
                        yield chunk
            finally:
                try:
                    resp.close()
                except Exception:
                    pass
                logger.info(
                    '[media_proxy] 传输完成, 共 %.2fMB, 耗时 %.2fs, url=%s',
                    total / 1048576,
                    time.time() - stream_start,
                    upstream_url[:120],
                )

        return Response(generate(), status=resp.status_code, headers=resp_headers)

    except Exception as e:
        logger.error(f"[media_proxy] Proxy error: {e}")
        if resp is not None:
            try:
                resp.close()
            except Exception:
                pass
        return f'Proxy error: {str(e)}', 502


@app.route('/api/debug/seek')
def debug_seek():
    logger.info(
        '[player_seek] phase=%s target=%s before=%s after=%s duration=%s ready_state=%s network_state=%s paused=%s src=%s',
        request.args.get('phase', ''),
        request.args.get('target', ''),
        request.args.get('before', ''),
        request.args.get('after', ''),
        request.args.get('duration', ''),
        request.args.get('ready_state', ''),
        request.args.get('network_state', ''),
        request.args.get('paused', ''),
        request.args.get('src', '')[:160],
    )
    return 'ok'


@app.route('/api/download_music')
def download_music():
    """代理下载音乐，并显式设置文件名。"""
    url = request.args.get('url', '').strip()
    requested_filename = request.args.get('filename', '').strip()
    allow_origin, origin_value = _allowed_media_request_origin()

    if not allow_origin:
        return 'Forbidden', 403
    if not is_allowed_media_url(url):
        return 'Invalid URL', 400

    resp = None
    try:
        upstream_url = url
        redirect_hops = 0
        while True:
            if not is_allowed_media_url(upstream_url):
                return 'Invalid URL', 400

            headers = {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
                'Referer': 'https://www.douyin.com/',
                'Accept': '*/*',
                'Accept-Encoding': 'identity;q=1, *;q=0',
            }

            if api and api.cookie and should_forward_douyin_cookie(upstream_url):
                headers['Cookie'] = api.cookie

            resp = http_requests.get(
                upstream_url,
                headers=headers,
                stream=True,
                timeout=(10, 120),
                allow_redirects=False,
            )

            if 300 <= resp.status_code < 400:
                location = resp.headers.get('Location', '')
                next_url = _resolve_media_redirect_target(resp.url, location)
                resp.close()
                resp = None

                if not location or redirect_hops >= 4 or not next_url or not is_allowed_media_url(next_url):
                    return 'Invalid redirect URL', 400

                redirect_hops += 1
                upstream_url = next_url
                continue

            resp.raise_for_status()
            break

        content_type = (resp.headers.get('Content-Type') or 'audio/mpeg').split(';', 1)[0].strip()
        filename = _sanitize_download_filename(requested_filename)
        extension = _guess_audio_extension(upstream_url, content_type)
        if not filename.lower().endswith(('.mp3', '.m4a', '.aac', '.wav', '.ogg')):
            filename = f'{filename}{extension}'

        resp_headers = {
            'Content-Type': _guess_audio_content_type(filename or upstream_url, content_type),
            'Access-Control-Allow-Origin': origin_value or '*',
            'Cache-Control': 'no-store'
        }

        content_disposition = _build_content_disposition(filename, 'attachment')
        if content_disposition:
            resp_headers['Content-Disposition'] = content_disposition

        if 'Content-Length' in resp.headers:
            resp_headers['Content-Length'] = resp.headers['Content-Length']
        if 'Accept-Ranges' in resp.headers:
            resp_headers['Accept-Ranges'] = resp.headers['Accept-Ranges']
        else:
            resp_headers['Accept-Ranges'] = 'bytes'

        def generate():
            try:
                for chunk in resp.iter_content(chunk_size=65536):
                    if chunk:
                        yield chunk
            finally:
                try:
                    resp.close()
                except Exception:
                    pass

        return Response(generate(), status=resp.status_code, headers=resp_headers)

    except Exception as e:
        logger.error(f"音乐下载代理失败: {e}")
        if resp is not None:
            try:
                resp.close()
            except Exception:
                pass
        return f'Download error: {str(e)}', 502

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

                if cookie_string in (session.last_cookie_value, Config.COOKIE or ''):
                    time.sleep(1)
                    continue

                session.last_cookie_value = cookie_string
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
            return jsonify({
                'success': False,
                'message': '当前不是桌面 pywebview 模式，无法打开带 Cookie 的应用内验证窗口。请通过发行版或 python main.py 启动后重试。',
                'open_url': target_url,
            }), 400

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

@app.route('/api/search_user', methods=['POST'])
def search_user():
    """搜索用户"""
    try:
        data = _request_json()
        keyword = data.get('keyword', '').strip()
        
        if not keyword:
            return jsonify({'success': False, 'message': '请输入搜索关键词'}), 400
        
        if not user_manager:
            return jsonify({'success': False, 'message': '请先设置Cookie'}), 400
        
        # 使用全局 run_async 运行异步任务
        users = run_async(user_manager.search_user(keyword))

        if users is None:
            return jsonify({'success': False, 'message': '未找到用户'})

        # 检测验证码
        if isinstance(users, dict) and users.get('_need_verify'):
            return jsonify(_verify_error_response(users, '需要完成滑块验证'))
        if isinstance(users, dict) and users.get('_need_login'):
            return jsonify(_login_error_response(users))
        
        if isinstance(users, dict):  # 单个用户
            return jsonify({
                'success': True,
                'type': 'single',
                'user': _search_user_payload(users)
            })
        else:  # 多个用户
            user_list = []
            for user in users:
                user_info = user['user_info']
                user_list.append(_search_user_payload(user_info, user))
            
            return jsonify({
                'success': True,
                'type': 'multiple',
                'users': user_list
            })
    
    except Exception as e:
        return jsonify({'success': False, 'message': f'搜索失败: {str(e)}'}), 500

@app.route('/api/user_detail', methods=['POST'])
def get_user_detail():
    """获取用户详情"""
    try:
        data = _request_json()
        sec_uid = data.get('sec_uid', '').strip()
        fallback_nickname = (data.get('nickname') or '').strip()
        
        if not sec_uid:
            return jsonify({'success': False, 'message': '用户ID不能为空'}), 400
        
        if not user_manager:
            return jsonify({'success': False, 'message': '请先设置Cookie'}), 400
        
        # 使用全局 run_async 运行异步任务
        user_detail = run_async(user_manager.get_user_detail(sec_uid))

        if isinstance(user_detail, dict) and user_detail.get('_need_verify'):
            return jsonify(_verify_or_request_error_response(
                user_detail,
                '获取用户详情失败，抖音用户接口暂时拒绝请求，请稍后重试',
            ))
        if isinstance(user_detail, dict) and (user_detail.get('_need_login') or user_detail.get('_error')):
            if user_detail.get('_need_login'):
                return jsonify(_login_error_response(user_detail))
            return jsonify({
                'success': True,
                'detail_unavailable': True,
                'message': user_detail.get('message') or '用户详情暂不可用',
                'user': {
                    'nickname': fallback_nickname,
                    'unique_id': '',
                    'follower_count': 0,
                    'following_count': 0,
                    'total_favorited': 0,
                    'aweme_count': 0,
                    'signature': '',
                    'sec_uid': sec_uid,
                    'avatar_thumb': '',
                    'avatar_larger': '',
                }
            })
        
        if not user_detail:
            return jsonify({
                'success': True,
                'detail_unavailable': True,
                'message': '用户详情暂不可用',
                'user': {
                    'nickname': fallback_nickname,
                    'unique_id': '',
                    'follower_count': 0,
                    'following_count': 0,
                    'total_favorited': 0,
                    'aweme_count': 0,
                    'signature': '',
                    'sec_uid': sec_uid,
                    'avatar_thumb': '',
                    'avatar_larger': '',
                }
            })
        
        return jsonify({
            'success': True,
            'user': _user_detail_payload(user_detail, sec_uid, fallback_nickname)
        })
    
    except Exception as e:
        return jsonify({
            'success': True,
            'detail_unavailable': True,
            'message': f'用户详情暂不可用: {str(e)}',
            'user': {
                'nickname': fallback_nickname if 'fallback_nickname' in locals() else '',
                'unique_id': '',
                'follower_count': 0,
                'following_count': 0,
                'total_favorited': 0,
                'aweme_count': 0,
                'signature': '',
                'sec_uid': sec_uid if 'sec_uid' in locals() else '',
                'avatar_thumb': '',
                'avatar_larger': '',
            }
        })

@app.route('/api/get_liked_videos', methods=['POST'])
def get_liked_videos_api():
    """获取点赞视频列表"""
    try:
        data = _request_json()
        count = _coerce_int(data.get('count'), 20, 1, 100)
        cursor = _coerce_int(data.get('cursor') or data.get('max_cursor'), 0, 0)
        if not user_manager:
            return jsonify({'success': False, 'message': '请先设置Cookie'}), 400
        result = run_async(user_manager.get_liked_videos(count, cursor, include_pagination=True))
        if isinstance(result, dict):
            if result.get('_need_verify'):
                return jsonify(_verify_error_response_without_login_check(result, '获取点赞视频失败，请完成验证后重试'))
            if result.get('_need_login'):
                return jsonify(_verify_error_response_without_login_check(result, '获取点赞视频失败，请完成验证后重试'))
            if 'data' in result:
                videos = result.get('data') or []
                if not videos and cursor <= 0:
                    return jsonify({
                        'success': False,
                        'need_verify': True,
                        'verify_url': 'https://www.douyin.com/',
                        'message': '获取点赞视频失败。该接口需要登录态，请确认Cookie有效且包含完整的登录信息。如果Cookie已过期请重新获取。',
                    })
                return jsonify({
                    'success': True,
                    'data': videos,
                    'count': len(videos),
                    'cursor': result.get('cursor') or 0,
                    'has_more': bool(result.get('has_more')),
                })
            return jsonify({
                'success': False,
                'message': _api_message(result, '获取点赞视频失败，请检查 Cookie 或稍后重试'),
            })
        videos = result or []
        if not videos and cursor <= 0:
            return jsonify({
                'success': False,
                'need_verify': True,
                'verify_url': 'https://www.douyin.com/',
                'message': '获取点赞视频失败。该接口需要登录态，请确认Cookie有效且包含完整的登录信息。如果Cookie已过期请重新获取。',
            })
        return jsonify({
            'success': True,
            'data': videos,
            'count': len(videos),
            'cursor': 0,
            'has_more': False,
        })
    except Exception as e:
        return jsonify({'success': False, 'message': f'获取点赞视频失败: {str(e)}'}), 500

@app.route('/api/get_liked_authors', methods=['POST'])
def get_liked_authors_api():
    """获取点赞作者列表"""
    try:
        data = _request_json()
        count = _coerce_int(data.get('count'), 20, 1, 100)

        if not user_manager:
            return jsonify({'success': False, 'message': '请先设置Cookie'}), 400

        authors = run_async(user_manager.get_liked_authors(count))

        if isinstance(authors, dict):
            if authors.get('_need_verify'):
                return jsonify(_verify_error_response(authors, '获取点赞作者失败，请完成验证后重试'))
            if authors.get('_need_login'):
                return jsonify(_login_error_response(authors))
            return jsonify({
                'success': False,
                'message': _api_message(authors, '获取点赞作者失败，请检查 Cookie 或稍后重试'),
            })

        if not authors:
            login_status = _verify_native_cookie_login(Config.COOKIE or '')
            if not login_status.get('success'):
                return jsonify(_login_error_response(login_status))
            return jsonify({
                'success': False,
                'need_verify': True,
                'verify_url': 'https://www.douyin.com/',
                'message': '获取点赞作者失败。该接口需要登录态，请确认Cookie有效且包含完整的登录信息。',
            })
        
        return jsonify({
            'success': True, 
            'data': authors,
            'count': len(authors)
        })
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)}), 500

@app.route('/api/get_collected_videos', methods=['POST'])
def get_collected_videos_api():
    """获取收藏视频列表"""
    try:
        data = _request_json()
        count = _coerce_int(data.get('count'), 20, 1, 100)
        cursor = _coerce_int(data.get('cursor'), 0, 0)
        if not user_manager:
            return jsonify({'success': False, 'message': '请先设置Cookie'}), 400

        result = run_async(user_manager.get_collected_videos(count, cursor))
        if isinstance(result, dict):
            if result.get('_need_verify'):
                return jsonify(_verify_error_response_without_login_check(result, '获取收藏视频失败，请完成验证后重试'))
            if result.get('_need_login'):
                return jsonify(_verify_error_response_without_login_check(result, '获取收藏视频失败，请完成验证后重试'))
            if 'data' in result:
                videos = result.get('data') or []
                return jsonify({
                    'success': True,
                    'data': videos,
                    'count': len(videos),
                    'cursor': result.get('cursor') or 0,
                    'has_more': bool(result.get('has_more')),
                })
            return jsonify({
                'success': False,
                'message': _api_message(result, '获取收藏视频失败，请检查 Cookie 或稍后重试'),
            })
        return jsonify({'success': False, 'message': '获取收藏视频失败'}), 500
    except Exception as e:
        return jsonify({'success': False, 'message': f'获取收藏视频失败: {str(e)}'}), 500

@app.route('/api/get_collected_mixes', methods=['POST'])
def get_collected_mixes_api():
    """获取收藏合集列表"""
    try:
        data = _request_json()
        count = _coerce_int(data.get('count'), 20, 1, 100)
        cursor = _coerce_int(data.get('cursor'), 0, 0)
        if not user_manager:
            return jsonify({'success': False, 'message': '请先设置Cookie'}), 400

        result = run_async(user_manager.get_collected_mixes(count, cursor))
        if isinstance(result, dict):
            if result.get('_need_verify'):
                return jsonify(_verify_error_response_without_login_check(result, '获取收藏合集失败，请完成验证后重试'))
            if result.get('_need_login'):
                return jsonify(_verify_error_response_without_login_check(result, '获取收藏合集失败，请完成验证后重试'))
            if 'data' in result:
                mixes = result.get('data') or []
                return jsonify({
                    'success': True,
                    'data': mixes,
                    'count': len(mixes),
                    'cursor': result.get('cursor') or 0,
                    'has_more': bool(result.get('has_more')),
                })
            return jsonify({
                'success': False,
                'message': _api_message(result, '获取收藏合集失败，请检查 Cookie 或稍后重试'),
            })
        return jsonify({'success': False, 'message': '获取收藏合集失败'}), 500
    except Exception as e:
        return jsonify({'success': False, 'message': f'获取收藏合集失败: {str(e)}'}), 500

@app.route('/api/get_mix_videos', methods=['POST'])
def get_mix_videos_api():
    """获取收藏合集内的视频列表"""
    try:
        data = _request_json()
        series_id = (data.get('series_id') or data.get('seriesId') or '').strip()
        count = _coerce_int(data.get('count'), 20, 1, 100)
        cursor = _coerce_int(data.get('cursor'), 0, 0)
        if not series_id:
            return jsonify({'success': False, 'message': '合集ID不能为空'}), 400
        if not user_manager:
            return jsonify({'success': False, 'message': '请先设置Cookie'}), 400

        result = run_async(user_manager.get_mix_videos(series_id, count, cursor))
        if isinstance(result, dict):
            if result.get('_need_verify'):
                return jsonify(_verify_error_response(result, '获取合集视频失败，请完成验证后重试'))
            if result.get('_need_login'):
                return jsonify(_login_error_response(result))
            if 'data' in result:
                videos = result.get('data') or []
                return jsonify({
                    'success': True,
                    'data': videos,
                    'count': len(videos),
                    'cursor': result.get('cursor') or 0,
                    'has_more': bool(result.get('has_more')),
                })
            return jsonify({
                'success': False,
                'message': _api_message(result, '获取合集视频失败，请检查 Cookie 或稍后重试'),
            })
        return jsonify({'success': False, 'message': '获取合集视频失败'}), 500
    except Exception as e:
        return jsonify({'success': False, 'message': f'获取合集视频失败: {str(e)}'}), 500

def _sanitize_sec_user_ids(values):
    if not isinstance(values, list):
        return []
    result = []
    seen = set()
    for item in values:
        value = str(item or '').strip()
        if not value or not value.startswith('MS4w') or value in seen:
            continue
        seen.add(value)
        result.append(value)
    return result

def _collect_sec_uid_records(value):
    records = []
    seen = set()

    def visit(item):
        if isinstance(item, list):
            for child in item:
                visit(child)
            return
        if not isinstance(item, dict):
            return
        sec_uid = str(item.get('sec_uid') or item.get('sec_user_id') or '').strip()
        if sec_uid and sec_uid not in seen:
            seen.add(sec_uid)
            records.append(item)
        for child in item.values():
            if isinstance(child, (dict, list)):
                visit(child)

    visit(value)
    return records

def _save_im_friend_cache(sec_user_ids=None):
    if sec_user_ids is not None:
        Config.IM_FRIEND_SEC_USER_IDS = Config.normalize_sec_user_ids(sec_user_ids)
    Config.save_config(
        Config.COOKIE,
        Config.BASE_DIR,
        Config.HISTORY_DIRS,
        download_quality=Config.DOWNLOAD_QUALITY,
        max_concurrent=Config.MAX_CONCURRENT,
        filename_template=Config.FILENAME_TEMPLATE,
        folder_name_template=Config.FOLDER_NAME_TEMPLATE,
        auto_create_folder=Config.AUTO_CREATE_FOLDER,
        im_friend_sec_user_ids=Config.IM_FRIEND_SEC_USER_IDS,
        im_friend_include_all_users=Config.IM_FRIEND_INCLUDE_ALL_USERS,
        im_friend_refresh_interval_seconds=Config.IM_FRIEND_REFRESH_INTERVAL_SECONDS,
    )


def _im_cookie_dict(cookie: str) -> dict:
    result = {}
    for item in str(cookie or '').split(';'):
        if '=' in item:
            key, value = item.strip().split('=', 1)
            if key:
                result[key] = value
    return result


def _extract_text_message(message: dict) -> str:
    content = str((message or {}).get('content') or '')
    if not content:
        return ''
    try:
        parsed = json.loads(content)
        if isinstance(parsed, dict):
            return str(parsed.get('text') or '')
    except Exception:
        pass
    return content


def _emit_im_message(response: dict) -> None:
    sent = douyin_im_proto.sent_message(response)
    if not sent:
        return
    try:
        content = _extract_text_message({'content': sent.content})
        payload = {
            'conversation_id': sent.conversation_id,
            'conversation_short_id': sent.conversation_short_id,
            'conversation_type': sent.conversation_type,
            'server_message_id': sent.server_message_id,
            'index_in_conversation': sent.index_in_conversation,
            'sender_uid': str(sent.sender or ''),
            'content': content,
            'raw_content': sent.content,
            'created_at': int(time.time() * 1000),
        }
        logger.info(
            'Douyin IM websocket message: conversation=%s sender=%s message_id=%s text_len=%s',
            payload['conversation_id'],
            payload['sender_uid'],
            payload['server_message_id'],
            len(content),
        )
        socketio.emit('im_message', payload)
    except Exception as error:
        logger.warning('解析 IM WebSocket 消息失败: %s', error)


def _stop_im_message_listener() -> None:
    global _im_message_ws
    _im_message_stop_event.set()
    ws = _im_message_ws
    _im_message_ws = None
    if ws is not None:
        try:
            ws.close()
        except Exception:
            pass


def _ensure_im_message_listener() -> None:
    global _im_message_thread
    if not api or not Config.COOKIE:
        return
    with _im_message_lock:
        if _im_message_thread and _im_message_thread.is_alive():
            return
        _im_message_stop_event.clear()
        _im_message_thread = threading.Thread(target=_run_im_message_listener, daemon=True)
        _im_message_thread.start()


def _run_im_message_listener() -> None:
    global _im_message_ws
    try:
        try:
            import websocket
        except Exception:
            logger.warning('未安装 websocket-client，无法接收 IM 消息')
            socketio.emit('im_status', {'connected': False, 'message': '缺少 websocket-client，无法接收私信'})
            return
        import ssl

        cookie_dict = _im_cookie_dict(Config.COOKIE)
        sessionid = cookie_dict.get('sessionid') or cookie_dict.get('sessionid_ss') or ''
        if not sessionid:
            logger.info('IM WebSocket 未启动：Cookie 缺少 sessionid')
            return

        device_id, success, response = run_async(api.get_im_device_id(), timeout=30)
        if not success or not device_id:
            logger.warning('IM WebSocket 获取 device_id 失败: %s', _api_message(response, '未知错误') if isinstance(response, dict) else response)
            return

        app_key = 'e1bd35ec9db7b8d846de66ed140b1ad9'
        fp_id = '9'
        access_key = hashlib.md5(f'{fp_id}{app_key}{device_id}f8a69f1719916z'.encode('utf-8')).hexdigest()
        params = urlencode({
            'aid': '6383',
            'device_platform': 'douyin_pc',
            'fpid': fp_id,
            'device_id': device_id,
            'token': sessionid,
            'access_key': access_key,
        })
        url = f'wss://frontier-im.douyin.com/ws/v2?{params}'

        def on_open(ws):
            logger.info('Douyin IM WebSocket 已连接')
            socketio.emit('im_status', {'connected': True, 'message': '私信接收已连接'})

        def on_message(ws, message):
            try:
                data = message if isinstance(message, bytes) else bytes(message or b'')
                frame = douyin_im_proto.parse_push_frame(data)
                response_data = frame.get('response')
                if isinstance(response_data, dict):
                    _emit_im_message(response_data)
                elif frame.get('payload_type') == 'text/json':
                    logger.debug('Douyin IM WebSocket JSON: %s', frame.get('payload'))
            except Exception as error:
                logger.warning('处理 IM WebSocket 消息失败: %s', error)

        def on_error(ws, error):
            logger.warning('Douyin IM WebSocket 错误: %s', error)
            socketio.emit('im_status', {'connected': False, 'message': f'私信接收连接错误: {error}'})

        def on_close(ws, close_status_code, close_msg):
            logger.info('Douyin IM WebSocket 已关闭: status=%s msg=%s', close_status_code, close_msg)
            socketio.emit('im_status', {'connected': False, 'message': '私信接收已断开'})

        _im_message_ws = websocket.WebSocketApp(
            url,
            header={
                'Pragma': 'no-cache',
                'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6',
                'User-Agent': getattr(api, 'common_headers', {}).get('User-Agent', ''),
                'Cache-Control': 'no-cache',
                'Sec-WebSocket-Protocol': 'binary, base64, pbbp2',
                'Sec-WebSocket-Extensions': 'permessage-deflate; client_max_window_bits',
            },
            cookie=Config.COOKIE,
            on_open=on_open,
            on_message=on_message,
            on_error=on_error,
            on_close=on_close,
        )
        _im_message_ws.run_forever(
            origin='https://www.douyin.com',
            sslopt={'cert_reqs': ssl.CERT_NONE, 'check_hostname': False},
        )
    except Exception as error:
        logger.warning('IM WebSocket 监听线程退出: %s', error)
    finally:
        _im_message_ws = None

@app.route('/api/get_friend_online_status', methods=['POST'])
def get_friend_online_status_api():
    """获取 IM 好友资料与在线状态。"""
    try:
        data = _request_json()
        _ensure_im_message_listener()
        provided_ids = data.get('sec_user_ids') or data.get('secUserIds') or []
        conv_ids = data.get('conv_ids') or data.get('convIds') or []
        sec_user_ids = _sanitize_sec_user_ids(provided_ids)
        has_provided_ids = bool(sec_user_ids)

        if has_provided_ids:
            merged = Config.normalize_sec_user_ids([*getattr(Config, 'IM_FRIEND_SEC_USER_IDS', []), *sec_user_ids])
            if merged != getattr(Config, 'IM_FRIEND_SEC_USER_IDS', []):
                _save_im_friend_cache(merged)

        if not sec_user_ids:
            sec_user_ids = Config.normalize_sec_user_ids(getattr(Config, 'IM_FRIEND_SEC_USER_IDS', []))

        if not api:
            return jsonify({'success': False, 'need_login': True, 'message': '请先设置 Cookie'})

        fetched_ids, auto_success, auto_response = run_async(
            api.get_im_spotlight_relation_sec_user_ids(
                500,
                bool(getattr(Config, 'IM_FRIEND_INCLUDE_ALL_USERS', False)),
            )
        )
        if auto_success:
            sec_user_ids = Config.normalize_sec_user_ids(fetched_ids)
            if sec_user_ids != getattr(Config, 'IM_FRIEND_SEC_USER_IDS', []):
                _save_im_friend_cache(sec_user_ids)
        elif not sec_user_ids:
            return jsonify({
                'success': False,
                'message': _api_message(auto_response, '没有获取到 IM 好友关系；Cookie 可用，但 spotlight relation 没有返回可用 sec_user_id。'),
            })

        if not sec_user_ids:
            return jsonify({
                'success': False,
                'message': '没有获取到 IM 好友关系；Cookie 可用，但 spotlight relation 没有返回可用 sec_user_id。',
            })

        user_info_data = []
        active_status_data = []
        user_info_extra = None
        active_status_extra = None
        conv_ids = [str(value).strip() for value in conv_ids if str(value).strip()] if isinstance(conv_ids, list) else []

        for index in range(0, len(sec_user_ids), 20):
            chunk = sec_user_ids[index:index + 20]
            user_info, user_success = run_async(api.get_im_user_info(chunk))
            if not user_success:
                return jsonify({
                    'success': False,
                    'message': _api_message(user_info, '获取好友资料失败'),
                    'need_login': bool(isinstance(user_info, dict) and user_info.get('_need_login')),
                    'need_verify': bool(isinstance(user_info, dict) and user_info.get('_need_verify')),
                    'verify_url': user_info.get('_verify_url') if isinstance(user_info, dict) else None,
                })
            if user_info_extra is None and isinstance(user_info, dict):
                user_info_extra = user_info.get('extra')
            user_info_data.extend(_collect_sec_uid_records(user_info))

            active_status, active_success = run_async(api.get_im_user_active_status(chunk, conv_ids))
            if not active_success:
                return jsonify({
                    'success': False,
                    'message': _api_message(active_status, '获取好友在线状态失败'),
                    'need_login': bool(isinstance(active_status, dict) and active_status.get('_need_login')),
                    'need_verify': bool(isinstance(active_status, dict) and active_status.get('_need_verify')),
                    'verify_url': active_status.get('_verify_url') if isinstance(active_status, dict) else None,
                })
            if active_status_extra is None and isinstance(active_status, dict):
                active_status_extra = active_status.get('extra')
            active_status_data.extend(_collect_sec_uid_records(active_status))

        return jsonify({
            'success': True,
            'message': '获取好友在线状态成功',
            'sec_user_ids': sec_user_ids,
            'user_info': {
                'data': user_info_data,
                'extra': user_info_extra,
            },
            'active_status': {
                'data': active_status_data,
                'extra': active_status_extra,
            },
        })
    except Exception as e:
        return jsonify({'success': False, 'message': f'获取好友在线状态失败: {str(e)}'}), 500

@app.route('/api/get_share_friends', methods=['POST'])
def get_share_friends_api():
    """获取视频分享面板可展示的好友列表。"""
    try:
        if not api:
            return jsonify({'success': False, 'need_login': True, 'message': '请先设置 Cookie'})

        data = _request_json()
        count = _coerce_int(data.get('count'), 50, 1, 100)
        result, success = run_async(api.get_im_share_friends(count))
        if not success:
            return jsonify({
                'success': False,
                'message': _api_message(result, '获取分享好友失败'),
                'need_login': bool(isinstance(result, dict) and result.get('_need_login')),
                'need_verify': bool(isinstance(result, dict) and result.get('_need_verify')),
                'verify_url': result.get('_verify_url') if isinstance(result, dict) else None,
            })

        friends = result.get('friends') if isinstance(result, dict) else []
        return jsonify({
            'success': True,
            'message': result.get('message') if isinstance(result, dict) else '获取分享好友成功',
            'friends': friends if isinstance(friends, list) else [],
            'count': len(friends) if isinstance(friends, list) else 0,
            'has_more': bool(result.get('has_more')) if isinstance(result, dict) else False,
        })
    except Exception as e:
        return jsonify({'success': False, 'message': f'获取分享好友失败: {str(e)}'}), 500

@app.route('/api/send_friend_message', methods=['POST'])
def send_friend_message_api():
    """发送文本私信。"""
    try:
        _ensure_im_message_listener()
        data = _request_json()
        to_user_id = data.get('to_user_id') or data.get('toUserId') or data.get('uid') or ''
        content = str(data.get('content') or data.get('message') or '').strip()
        if not str(to_user_id).strip():
            return jsonify({'success': False, 'message': '缺少好友数字 uid，无法发送私信'}), 400
        if not content:
            return jsonify({'success': False, 'message': '消息内容不能为空'}), 400
        if not api:
            return jsonify({'success': False, 'need_login': True, 'message': '请先设置 Cookie'})

        result, success = run_async(api.send_im_text_message(to_user_id, content), timeout=60)
        return jsonify({
            'success': bool(success),
            **(result if isinstance(result, dict) else {'message': str(result)}),
        })
    except Exception as e:
        return jsonify({'success': False, 'message': f'发送私信失败: {str(e)}'}), 500

@app.route('/api/send_friend_image_message', methods=['POST'])
def send_friend_image_message_api():
    """发送图片私信。"""
    try:
        _ensure_im_message_listener()
        data = _request_json()
        to_user_id = data.get('to_user_id') or data.get('toUserId') or data.get('uid') or ''
        image_data_url = str(data.get('image_data_url') or data.get('imageDataUrl') or '').strip()
        if not str(to_user_id).strip():
            return jsonify({'success': False, 'message': '缺少好友数字 uid，无法发送图片'}), 400
        if not image_data_url:
            return jsonify({'success': False, 'message': '图片内容不能为空'}), 400
        if len(image_data_url) > 12 * 1024 * 1024:
            return jsonify({'success': False, 'message': '图片太大，请选择 12MB 以内的图片'}), 400
        if not api:
            return jsonify({'success': False, 'need_login': True, 'message': '请先设置 Cookie'})

        result, success = run_async(
            api.send_im_image_message(
                to_user_id,
                image_data_url,
                data.get('width') or 0,
                data.get('height') or 0,
                str(data.get('file_name') or data.get('fileName') or ''),
                str(data.get('mime_type') or data.get('mimeType') or ''),
            ),
            timeout=60,
        )
        return jsonify({
            'success': bool(success),
            **(result if isinstance(result, dict) else {'message': str(result)}),
        })
    except Exception as e:
        return jsonify({'success': False, 'message': f'发送图片私信失败: {str(e)}'}), 500

@app.route('/api/send_friend_video_share', methods=['POST'])
def send_friend_video_share_api():
    """发送视频分享卡片私信。"""
    try:
        _ensure_im_message_listener()
        data = _request_json()
        to_user_id = data.get('to_user_id') or data.get('toUserId') or data.get('uid') or ''
        video = data.get('video') if isinstance(data.get('video'), dict) else data
        if not str(to_user_id).strip():
            return jsonify({'success': False, 'message': '缺少好友数字 uid，无法分享视频'}), 400
        if not isinstance(video, dict) or not str(video.get('aweme_id') or video.get('itemId') or '').strip():
            return jsonify({'success': False, 'message': '缺少作品信息，无法分享视频'}), 400
        if not api:
            return jsonify({'success': False, 'need_login': True, 'message': '请先设置 Cookie'})

        result, success = run_async(api.send_im_video_share_message(to_user_id, video), timeout=60)
        return jsonify({
            'success': bool(success),
            **(result if isinstance(result, dict) else {'message': str(result)}),
        })
    except Exception as e:
        return jsonify({'success': False, 'message': f'分享视频失败: {str(e)}'}), 500

@app.route('/api/get_friend_message_history', methods=['POST'])
def get_friend_message_history_api():
    """获取最近的 IM 历史消息。"""
    try:
        data = _request_json()
        cursor = _coerce_int(data.get('cursor'), 0, 0)
        to_user_id = data.get('to_user_id') or data.get('toUserId') or data.get('uid') or None
        conversation_id = data.get('conversation_id') or data.get('conversationId') or None
        conversation_short_id = _coerce_int(data.get('conversation_short_id') or data.get('conversationShortId'), 0, 0)
        conversation_type = _coerce_int(data.get('conversation_type') or data.get('conversationType'), 1, 1)
        if not api:
            return jsonify({'success': False, 'need_login': True, 'message': '请先设置 Cookie'})
        result, success = run_async(
            api.get_im_history_messages(
                cursor=cursor,
                to_user_id=to_user_id,
                conversation_id=conversation_id,
                conversation_short_id=conversation_short_id,
                conversation_type=conversation_type,
            ),
            timeout=60,
        )
        if isinstance(result, dict):
            logger.info(
                "friend message history: cursor=%s to_user_id_present=%s conversation_id_present=%s messages=%s next_cursor=%s has_more=%s",
                cursor,
                bool(to_user_id),
                bool(conversation_id),
                len(result.get('messages') or []) if isinstance(result.get('messages'), list) else 0,
                result.get('next_cursor'),
                result.get('has_more'),
            )
        return jsonify({
            'success': bool(success),
            **(result if isinstance(result, dict) else {'message': str(result)}),
        })
    except Exception as e:
        return jsonify({'success': False, 'message': f'获取历史消息失败: {str(e)}'}), 500

@app.route('/api/user_videos', methods=['POST'])
def get_user_videos():
    """获取用户视频列表（支持分页渐进加载）"""
    try:
        data = _request_json()
        sec_uid = data.get('sec_uid', '').strip()
        cursor = _coerce_int(data.get('cursor'), 0, 0)  # 分页游标
        count = _coerce_int(data.get('count'), 18, 1, 100)   # 每页数量

        if not sec_uid:
            return jsonify({'success': False, 'message': '用户ID不能为空'}), 400

        if not user_manager:
            return jsonify({'success': False, 'message': '请先设置Cookie'}), 400

        def run_get_page():
            params = {
                "publish_video_strategy_type": 2,
                "max_cursor": cursor,
                "sec_user_id": sec_uid,
                "locate_query": False,
                'show_live_replay_strategy': 1,
                'need_time_list': 0,
                'time_list_query': 0,
                'whale_cut_token': '',
                'count': count
            }
            return run_async(
                user_manager.api.common_request('/aweme/v1/web/aweme/post/', params, {}, skip_sign=True)
            )

        resp, succ = run_get_page()

        # 检测验证码
        if isinstance(resp, dict) and resp.get('_need_verify'):
            return jsonify(_verify_or_request_error_response(
                resp,
                '获取作品列表失败，抖音作品接口暂时拒绝请求，请稍后重试',
            ))
        if isinstance(resp, dict) and resp.get('_need_login'):
            return jsonify(_login_error_response(resp))

        if not succ:
            return jsonify({
                'success': False,
                'message': _api_message(resp, '获取作品列表失败，请检查 Cookie 或稍后重试'),
            })

        if not resp.get('aweme_list'):
            return jsonify({
                'success': True,
                'videos': [],
                'has_more': False,
                'cursor': 0,
                'total_count': 0
            })

        videos = resp.get('aweme_list', [])
        has_more = resp.get('has_more', 0) == 1
        next_cursor = resp.get('max_cursor', 0)

        video_list = []
        for video in videos:
            aweme_id = video.get('aweme_id')
            if not aweme_id:
                continue
            cover_url = ""
            if video.get('video') and video['video'].get('cover'):
                cover_url = safe_get_url(video['video']['cover'])
            elif video.get('images'):
                cover_url = safe_get_url(video['images'][0])
            media_type, media_urls = user_manager.get_media_info(video)
            video_data = video.get('video') or {}
            play_addr = safe_get_url(video_data.get('play_addr'))
            selected_video_url = user_manager._select_video_url(video_data) or play_addr
            play_addr_h264 = safe_get_url(video_data.get('play_addr_h264'))
            play_addr_lowbr = safe_get_url(video_data.get('play_addr_lowbr'))
            download_addr = safe_get_url(video_data.get('download_addr'))
            dynamic_cover = safe_get_url(video_data.get('dynamic_cover')) or cover_url
            origin_cover = safe_get_url(video_data.get('origin_cover')) or cover_url

            music_info = _extract_music_info(video.get('music') or {})
            bgm_url = music_info['play_url']
            if video.get('music') and os.environ.get('DEBUG_MODE', '').lower() in ('true', '1', 'yes'):
                logger.debug(f"Music 数据结构：{json.dumps(video.get('music'), ensure_ascii=False)[:500]}")
            if not bgm_url and video.get('video') and video['video'].get('play_addr'):
                # 如果没有独立音乐，使用视频的播放地址作为 BGM
                bgm_url = safe_get_url(video['video']['play_addr'])

            video_list.append({
                'aweme_id': aweme_id,
                'desc': video.get('desc', ''),
                'create_time': video.get('create_time', 0),
                'duration': _raw_duration_value((video.get('video') or {}).get('duration', 0)),
                'duration_unit': 'milliseconds',
                'digg_count': video.get('statistics', {}).get('digg_count', 0),
                'comment_count': video.get('statistics', {}).get('comment_count', 0),
                'share_count': video.get('statistics', {}).get('share_count', 0),
                'cover_url': cover_url,
                'media_type': media_type,
                'raw_media_type': media_type,
                'media_urls': media_urls,
                'bgm_url': bgm_url,
                'images': video.get('images') or [],
                'live_photos': video.get('live_photos') or video.get('live_photo_urls') or [],
                'music': music_info,
                'music_title': music_info['title'],
                'music_author': music_info['author'],
                'music_url': music_info['play_url'],
                'music_duration': music_info['duration'],
                'video': {
                    'cover': cover_url,
                    'dynamic_cover': dynamic_cover,
                    'origin_cover': origin_cover,
                    'preview_addr': selected_video_url or play_addr_lowbr or play_addr_h264 or (media_urls[0].get('url') if media_urls else ''),
                    'play_addr': selected_video_url or (media_urls[0].get('url') if media_urls else ''),
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
                'author': {
                    'nickname': video.get('author', {}).get('nickname', ''),
                    'avatar_thumb': safe_get_url(video.get('author', {}).get('avatar_thumb', {})),
                    'sec_uid': video.get('author', {}).get('sec_uid', '')
                }
            })

        return jsonify({
            'success': True,
            'videos': video_list,
            'has_more': has_more,
            'cursor': next_cursor,
            'total_count': len(video_list)
        })
    except Exception as e:
        logger.error(f" 获取用户视频列表失败: {str(e)}")
        return jsonify({'success': False, 'message': f'获取用户视频列表失败: {str(e)}'}), 500
                
@app.route('/api/download_single_video', methods=['POST'])
def download_single_video():
    """下载单个作品（视频、图集或Live Photo）"""
    try:
        data = _request_json()
        aweme_id = data.get('aweme_id', '').strip()
        video_desc = data.get('desc', '未知作品')
        media_urls = data.get('media_urls', [])
        raw_media_type = data.get('raw_media_type', 'video')
        author_name = data.get('author_name', '未知作者')

        if not aweme_id:
            return jsonify({'success': False, 'message': '作品ID不能为空'}), 400

        if not user_manager or not downloader:
            return jsonify({'success': False, 'message': '服务未完全初始化'}), 500

        media_urls = normalize_download_media_urls(media_urls, raw_media_type)
        video_fallback_urls = []

        should_refresh_video_media = (
            raw_media_type == 'video'
            or (
                raw_media_type not in ('image', 'live_photo', 'mixed')
                and any(item.get('type') == 'video' for item in media_urls)
            )
            or not media_urls
        )

        if should_refresh_video_media and aweme_id:
            detail = run_async(user_manager.get_video_detail(aweme_id))
            if isinstance(detail, dict) and detail.get('_need_verify'):
                return jsonify(_verify_error_response(detail, '需要完成滑块验证'))
            if isinstance(detail, dict) and detail.get('_need_login'):
                return jsonify(_login_error_response(detail))

            if detail:
                detail_media_type = detail.get('raw_media_type') or detail.get('media_type') or raw_media_type
                detail_media_urls = normalize_download_media_urls(detail.get('media_urls', []), detail_media_type)
                if detail_media_urls:
                    media_urls = detail_media_urls
                    raw_media_type = detail_media_type
                    video_desc = detail.get('desc') or video_desc
                    author_name = detail.get('author', {}).get('nickname') or author_name
                    video_fallback_urls = user_manager.get_video_download_urls((detail.get('video') or {}))

        if not media_urls:
            return jsonify({'success': False, 'message': '没有可用的媒体URL'}), 400

        task_id = str(uuid.uuid4())

        # 在全局 Loop 中运行下载任务
        async def do_single_download():
            try:
                logger.debug(f" 开始下载任务: {task_id}")
                logger.debug(f" 作品ID: {aweme_id}")
                logger.debug(f" 媒体类型: {raw_media_type}")
                logger.debug(f" 媒体URL数量: {len(media_urls)}")
                logger.debug(f" 媒体URLs: {media_urls}")
                
                download_title = build_download_title(
                    video_desc,
                    aweme_id,
                    author=author_name,
                    media_type=raw_media_type,
                )

                # 发送下载开始事件
                try:
                    logger.debug(f" 发送WebSocket下载开始事件: task_id={task_id}")
                    # 修复变量作用域问题，确保在使用urls前已定义
                    media_count = len(media_urls)
                    socketio.emit('download_started', {
                        'task_id': task_id, 
                        'desc': video_desc,
                        'type': 'single_video',
                        'aweme_id': aweme_id,
                        'media_type': raw_media_type,
                        'media_count': media_count
                    })
                    logger.debug(f" WebSocket事件已发送")
                except Exception as e:
                    logger.error(f" 发送WebSocket事件失败: {str(e)}")
                
                # 发送进度更新 - 开始
                display_name = download_title or "下载任务"
                socketio.emit('download_progress', {
                    'task_id': task_id,
                    'progress': 0,
                    'completed': 0,
                    'total': len(media_urls),
                    'status': 'starting',
                    'desc': video_desc,
                    'display_name': display_name
                })
                
                # 提取URL列表，处理不同的数据格式
                urls = media_urls
                
                logger.debug(f" 提取的URL列表: {urls}")
                
                if not urls:
                    raise ValueError("没有有效的媒体URL")
                
                # 使用配置的目录模板和文件模板生成下载路径
                file_path = build_download_name(author_name, video_desc, aweme_id, media_type=raw_media_type)
                logger.debug(f" 文件路径: {file_path}")
                
                # 统一下载处理，不再区分媒体类型
                logger.debug(f" 开始统一下载: {len(urls)} 个文件")
                socketio.emit('download_progress', {
                    'task_id': task_id,
                    'progress': 10,
                    'completed': 0,
                    'total': len(urls),
                    'status': 'downloading',
                    'desc': video_desc,
                    'display_name': display_name
                })
                socketio.emit('download_log', {
                    'task_id': task_id,
                    'message': f'正在下载媒体文件: {len(urls)} 个文件',
                    'timestamp': datetime.now().strftime('%H:%M:%S')
                })
                
                success = False
                failed_files = []
                
                try:
                    # 统一下载处理，直接传入urls参数
                    logger.debug(f" 开始下载: {len(urls)} 个文件")
                    if len(urls) == 1 and urls[0].get('type') == 'video':
                        success = await asyncio.to_thread(
                            downloader.download_video,
                            urls[0]['url'],
                            file_path,
                            aweme_id,
                            None,
                            socketio,
                            task_id,
                            None,
                            None,
                            False,
                            fallback_urls=video_fallback_urls,
                        )
                    else:
                        success = await asyncio.to_thread(
                            downloader.download_media_group,
                            urls,
                            file_path,
                            aweme_id,
                            socketio,
                            task_id,
                            None,
                            None,
                            None,
                            False,
                        )
                    
                    if success:
                        socketio.emit('download_progress', {
                            'task_id': task_id,
                            'progress': 100,
                            'completed': len(urls),
                            'total': len(urls),
                            'status': 'completed',
                            'desc': video_desc,
                            'display_name': display_name
                        })
                        socketio.emit('download_log', {
                            'task_id': task_id,
                            'message': f'✅ 下载完成: {len(urls)} 个文件',
                            'timestamp': datetime.now().strftime('%H:%M:%S')
                        })
                    else:
                        raise Exception('下载失败')
                        
                except Exception as e:
                    success = False
                    logger.error(f" 下载失败: {str(e)}")
                    if 'progress' not in locals() or 'download_progress' not in str(e):
                        socketio.emit('download_progress', {
                            'task_id': task_id,
                            'progress': 0,
                            'completed': 0,
                            'total': len(urls),
                            'status': 'failed',
                            'desc': video_desc,
                            'display_name': display_name
                        })
                        socketio.emit('download_log', {
                            'task_id': task_id,
                            'message': f'❌ 下载失败: {str(e)}',
                            'timestamp': datetime.now().strftime('%H:%M:%S')
                        })
                    raise e

                logger.debug(f" 下载任务完成，结果: {success}")
                
                # 发送最终完成事件（统一处理）
                if success:
                    socketio.emit('download_completed', {
                        'task_id': task_id, 
                        'message': f'下载成功: {video_desc}',
                        'aweme_id': aweme_id,
                        'media_type': raw_media_type,
                        'file_count': len(media_urls)
                    })
                    logger.debug(f" 发送下载完成事件: task_id={task_id}")
                else:
                    raise Exception('下载失败')

            except Exception as e:
                error_msg = f"下载失败: {str(e)}"
                logger.error(f" {error_msg}")
                socketio.emit('download_failed', {'task_id': task_id, 'error': error_msg})
            finally:
                pass

        loop = get_or_create_loop()
        asyncio.run_coroutine_threadsafe(do_single_download(), loop)

        return jsonify({'success': True, 'task_id': task_id, 'message': '下载任务已启动'})

    except Exception as e:
        return jsonify({'success': False, 'message': f'下载启动失败: {str(e)}'}), 500



@app.route('/api/download_user_video', methods=['POST'])
def download_user_video():
    """通过sec_uid下载用户所有视频，支持WebSocket进度反馈"""
    logger.debug("Received download_user_video request")
    try:
        data = _request_json()
        sec_uid = data.get('sec_uid')
        nickname = data.get('nickname', '')  # 前端传来，跳过详情接口
        aweme_count = _coerce_int(data.get('aweme_count'), 0, 0) # 获取作品总数

        if not sec_uid:
            return jsonify({'success': False, 'message': 'sec_uid参数不能为空'}), 400
        
        if not user_manager:
            return jsonify({'success': False, 'message': '请先设置Cookie'}), 400
        
        # 生成任务ID
        task_id = str(uuid.uuid4())
        cancel_event = asyncio.Event()
        pause_event = asyncio.Event()  # 暂停事件，默认不暂停

        display_name = f'{nickname or "用户"} 全部作品'
        _store_download_task(task_id, {
            'status': 'running',
            'sec_uid': sec_uid,
            'nickname': nickname,
            'title': display_name,
            'filename': display_name,
            'display_name': display_name,
            'isBatch': True,
            'total_videos': aweme_count,
            'current_downloaded': 0,
            'processed': 0,
            'progress': 0,
            'overall_progress': 0,
            'start_time': datetime.now()
        })
        
        # 在全局 Loop 中运行异步下载协程
        async def do_download_task():
            try:
                # 使用前端传来的nickname，不再调用get_user_detail

                _nickname = nickname if nickname else 'unknown'
                
                # 发送开始信号
                socketio.emit('download_started', {
                    'task_id': task_id,
                    'user': _nickname,
                    'nickname': _nickname,
                    'sec_uid': sec_uid,
                    'total_videos': aweme_count,
                    'message': f'开始下载 {_nickname} 的 {aweme_count} 个作品'
                })
                
                # 增量下载队列
                download_queue = asyncio.Queue()
                fetching_done = asyncio.Event()
                total_discovered = [0]
                total_processed = [0] # 包含已跳过的
                total_succeeded = [0]
                total_skipped = [0]
                total_failed = [0]
                total_videos = aweme_count # 初始总量
                consumer_count = max(1, int(getattr(Config, 'MAX_CONCURRENT', 3) or 1))
                pause_control = ThreadPauseEvent(pause_event)
                batch_started_at = time.monotonic()

                def update_task_snapshot(**fields):
                    snapshot = download_tasks.get(task_id)
                    if snapshot is not None:
                        snapshot.update(fields)

                def emit_batch_progress(**payload):
                    socketio.emit('user_video_download_progress', payload)
                    update_task_snapshot(
                        status=payload.get('status') or download_tasks.get(task_id, {}).get('status', 'running'),
                        progress=payload.get('overall_progress'),
                        overall_progress=payload.get('overall_progress'),
                        processed=payload.get('processed') if payload.get('processed') is not None else payload.get('current_downloaded'),
                        current_downloaded=payload.get('current_downloaded'),
                        total_videos=payload.get('total_videos'),
                        skipped=payload.get('skipped'),
                        failed=payload.get('failed'),
                        succeeded=payload.get('succeeded'),
                        eta_seconds=payload.get('eta_seconds'),
                        current_name=payload.get('message'),
                    )

                def estimate_batch_eta(processed_count, total_count):
                    if processed_count <= 0 or total_count <= 0 or processed_count >= total_count:
                        return None
                    elapsed = max(time.monotonic() - batch_started_at, 0.001)
                    return int(max(1, ((total_count - processed_count) * elapsed) / processed_count))
                
                # 发送初始总量信息
                if total_videos > 0:
                    socketio.emit('download_info', {
                        'task_id': task_id,
                        'total_videos': total_videos,
                        'current_downloaded': 0,
                        'processed': 0,
                        'overall_progress': 0,
                        'remaining': total_videos,
                        'message': f'准备开始下载，共发现 {total_videos} 个作品'
                    })

                def on_batch(batch):
                    if cancel_event.is_set():
                        return
                    for post in batch:
                        if user_manager.downloader._is_aweme_downloaded(post['aweme_id']):
                            total_processed[0] += 1
                            total_skipped[0] += 1
                            # 发送跳过进度更新
                            overall_progress = int((total_processed[0] / max(total_videos, total_processed[0], 1)) * 100)
                            emit_batch_progress(**{
                                'task_id': task_id,
                                'total_videos': max(total_videos, total_processed[0]),
                                'current_downloaded': total_processed[0],
                                'processed': total_processed[0],
                                'skipped': total_skipped[0],
                                'failed': total_failed[0],
                                'remaining': max(total_videos - total_processed[0], 0),
                                'overall_progress': overall_progress,
                                'message': f'跳过已下载: {post.get("desc", post["aweme_id"])[:10]}...',
                                'type': 'progress'
                            })
                        else:
                            download_queue.put_nowait(post)
                            total_discovered[0] += 1
                    
                    # 更新总量感
                    current_total = max(total_videos, total_processed[0] + download_queue.qsize())
                    socketio.emit('download_info', {
                        'task_id': task_id,
                        'total_videos': current_total,
                        'current_downloaded': total_processed[0],
                        'processed': total_processed[0],
                        'skipped': total_skipped[0],
                        'failed': total_failed[0],
                        'overall_progress': int((total_processed[0] / max(total_videos, current_total, 1)) * 100),
                        'remaining': current_total - total_processed[0],
                        'message': f'正在抓取作品列表... 已发现 {total_discovered[0]} 个新作品'
                    })

                async def downloader_consumer():
                    while not (fetching_done.is_set() and download_queue.empty()):
                        # 检查取消
                        if cancel_event.is_set():
                            logger.info(f"Task {task_id} consumer cancelled")
                            # 清空队列
                            while not download_queue.empty():
                                try:
                                    download_queue.get_nowait()
                                except:
                                    break
                            break

                        # 检查暂停 - 如果暂停事件被设置，则等待恢复
                        if pause_event.is_set():
                            # 发送暂停状态
                            socketio.emit('user_video_download_progress', {
                                'task_id': task_id,
                                'message': '已暂停',
                                'type': 'info'
                            })
                            # 等待 pause_event 被清除（恢复）
                            while pause_event.is_set() and not cancel_event.is_set():
                                await asyncio.sleep(0.5)

                        try:
                            # 等待队列中的新作品
                            post = await asyncio.wait_for(download_queue.get(), timeout=1.0)
                        except asyncio.TimeoutError:
                            continue

                        # 检查取消信号（开始下载前）
                        if cancel_event.is_set():
                            logger.info(f"Task {task_id} cancelled before download")
                            break

                        aweme_id = post['aweme_id']
                        media_type, urls = user_manager.get_media_info(post)
                        name = build_download_name(_nickname, post.get('desc', ''), aweme_id, media_type=media_type)

                        def current_total_count():
                            return max(total_videos, total_discovered[0] + total_skipped[0], total_processed[0] + download_queue.qsize())

                        def emit_current_video_progress(current_progress=0, status='downloading', message=None, current_downloaded=None,
                                                        completed_files=0, total_files=1, speed_bps=None, eta_seconds=None,
                                                        file_index=1, file_total=1, bytes_downloaded=0, bytes_total=0):
                            processed_count = total_processed[0] if current_downloaded is None else current_downloaded
                            current_total = current_total_count()
                            progress_ratio = max(0, min(current_progress, 100)) / 100
                            current_weight = progress_ratio if status not in ('completed', 'failed') else 0
                            overall_progress = int(((processed_count + current_weight) / max(current_total, 1)) * 100)

                            emit_batch_progress(**{
                                'task_id': task_id,
                                'total_videos': current_total,
                                'current_downloaded': processed_count,
                                'processed': processed_count,
                                'skipped': total_skipped[0],
                                'failed': total_failed[0],
                                'remaining': max(current_total - processed_count, 0),
                                'overall_progress': min(100, max(0, overall_progress)),
                                'current_progress': max(0, min(current_progress, 100)),
                                'eta_seconds': estimate_batch_eta(processed_count, current_total),
                                'message': message or f'正在下载: {desc}',
                                'type': 'progress',
                                'current_video': {
                                    'aweme_id': aweme_id,
                                    'desc': desc,
                                    'status': status,
                                    'progress': max(0, min(current_progress, 100)),
                                    'completed_files': completed_files,
                                    'total_files': total_files,
                                    'file_index': file_index,
                                    'file_total': file_total,
                                    'speed_bps': speed_bps,
                                    'eta_seconds': eta_seconds,
                                    'bytes_downloaded': bytes_downloaded,
                                    'bytes_total': bytes_total
                                }
                            })
                        
                        # 发送进度预览
                        emit_current_video_progress(
                            current_progress=0,
                            status='starting',
                            message=f'正在下载: {desc}',
                            current_downloaded=total_processed[0],
                            completed_files=0,
                            total_files=1,
                            file_index=1,
                            file_total=1
                        )
                        
                        # 执行下载
                        try:
                            if not urls:
                                total_failed[0] += 1
                                total_processed[0] += 1
                                current_total = current_total_count()
                                overall_progress = int((total_processed[0] / max(total_videos, current_total, 1)) * 100)
                                emit_batch_progress(**{
                                    'task_id': task_id,
                                    'total_videos': current_total,
                                    'current_downloaded': total_processed[0],
                                    'processed': total_processed[0],
                                    'succeeded': total_succeeded[0],
                                    'skipped': total_skipped[0],
                                    'failed': total_failed[0],
                                    'remaining': max(current_total - total_processed[0], 0),
                                    'overall_progress': min(100, max(0, overall_progress)),
                                    'eta_seconds': estimate_batch_eta(total_processed[0], current_total),
                                    'message': f'无可下载媒体: {desc}',
                                    'type': 'progress'
                                })
                                continue

                            success = False
                            def progress_callback(progress_data):
                                pause_control.wait_while_set(cancel_event)
                                if cancel_event.is_set():
                                    raise RuntimeError('下载已取消')
                                emit_current_video_progress(
                                    current_progress=progress_data.get('progress', 0),
                                    status=progress_data.get('status', 'downloading'),
                                    message=f'正在下载: {desc}',
                                    current_downloaded=total_processed[0],
                                    completed_files=progress_data.get('completed', 0),
                                    total_files=progress_data.get('total', len(urls) if urls else 1),
                                    speed_bps=progress_data.get('speed_bps'),
                                    eta_seconds=progress_data.get('eta_seconds'),
                                    file_index=progress_data.get('file_index', 1),
                                    file_total=progress_data.get('file_total', len(urls) if urls else 1),
                                    bytes_downloaded=progress_data.get('bytes_downloaded', 0),
                                    bytes_total=progress_data.get('bytes_total', 0)
                                )

                            if media_type == 'video' and len(urls) == 1:
                                fallback_urls = user_manager.get_video_download_urls((post.get('video') or {}))
                                success = await asyncio.to_thread(
                                    user_manager.downloader.download_video,
                                    urls[0]['url'],
                                    name,
                                    aweme_id,
                                    cancel_event,
                                    None,
                                    None,
                                    progress_callback,
                                    pause_control,
                                    fallback_urls=fallback_urls,
                                )
                            else:
                                success = await asyncio.to_thread(
                                    user_manager.downloader.download_media_group,
                                    urls,
                                    name,
                                    aweme_id,
                                    None,
                                    None,
                                    cancel_event,
                                    progress_callback,
                                    pause_control,
                                )

                            if success:
                                total_succeeded[0] += 1
                                total_processed[0] += 1
                                socketio.emit('download_success', {'task_id': task_id, 'message': f'作品 {desc} 下载完成'})
                                emit_current_video_progress(
                                    current_progress=100,
                                    status='completed',
                                    message=f'完成处理: {desc}',
                                    current_downloaded=total_processed[0],
                                    completed_files=len(urls),
                                    total_files=len(urls),
                                    file_index=len(urls),
                                    file_total=len(urls),
                                    eta_seconds=0
                                )
                            else:
                                total_failed[0] += 1
                                total_processed[0] += 1

                            # 检查取消状态
                            if cancel_event.is_set():
                                logger.info(f"下载被用户取消: {task_id}")
                                break
                        except Exception as e:
                            total_failed[0] += 1
                            total_processed[0] += 1
                            logger.error(f"Download error for {aweme_id}: {e}")
                            
                        # 更新总进度
                        current_total = current_total_count()
                        overall_progress = int((total_processed[0] / max(total_videos, current_total, 1)) * 100)
                        emit_batch_progress(**{
                            'task_id': task_id,
                            'total_videos': current_total,
                            'current_downloaded': total_processed[0],
                            'processed': total_processed[0],
                            'succeeded': total_succeeded[0],
                            'skipped': total_skipped[0],
                            'failed': total_failed[0],
                            'remaining': max(current_total - total_processed[0], 0),
                            'overall_progress': overall_progress,
                            'eta_seconds': estimate_batch_eta(total_processed[0], current_total),
                            'message': f'完成处理: {desc}',
                            'type': 'progress'
                        })

                # 获取视频抓取任务（需要能响应取消）
                fetch_coro = user_manager.get_user_videos(sec_uid, limit=1000, on_batch=on_batch)
                fetch_task = asyncio.create_task(fetch_coro)
                consume_tasks = [
                    asyncio.create_task(downloader_consumer())
                    for _ in range(consumer_count)
                ]
                
                # 循环检查取消
                while not fetch_task.done():
                    if cancel_event.is_set():
                        fetch_task.cancel()
                        break
                    await asyncio.sleep(0.5)
                
                fetching_done.set()
                await asyncio.gather(*consume_tasks, return_exceptions=True)
                fetch_result = None
                if fetch_task.done() and not fetch_task.cancelled():
                    fetch_result = fetch_task.result()
                if isinstance(fetch_result, dict):
                    raise Exception(_api_message(fetch_result, '获取用户作品失败，请检查 Cookie 或稍后重试'))
                
                if cancel_event.is_set():
                    download_tasks[task_id]['status'] = 'cancelled'
                    socketio.emit('download_cancelled', {'task_id': task_id, 'message': '下载任务已取消'})
                else:
                    download_tasks[task_id]['status'] = 'completed'
                    download_tasks[task_id]['end_time'] = datetime.now()
                    socketio.emit('download_completed', {
                        'task_id': task_id,
                        'message': f'用户 {_nickname} 的作品全部处理完成',
                        'total_videos': max(total_videos, total_processed[0]),
                        'current_downloaded': total_processed[0],
                        'processed': total_processed[0],
                        'completed': total_processed[0],
                        'succeeded': total_succeeded[0],
                        'skipped': total_skipped[0],
                        'failed': total_failed[0],
                        'remaining': 0
                    })
            except asyncio.CancelledError:
                download_tasks[task_id]['status'] = 'cancelled'
                socketio.emit('download_cancelled', {'task_id': task_id, 'message': '下载任务已取消'})
            except Exception as e:
                logger.error(f"Task {task_id} error: {e}")
                download_tasks[task_id]['status'] = 'failed'
                socketio.emit('download_failed', {'task_id': task_id, 'message': f'任务出错: {str(e)}'})
            finally:
                if task_id in active_tasks:
                    del active_tasks[task_id]

        # 启动任务
        loop = get_or_create_loop()
        future = asyncio.run_coroutine_threadsafe(do_download_task(), loop)
        active_tasks[task_id] = {
            "future": future,
            "event": cancel_event,
            "pause_event": pause_event
        }
        
        return jsonify({
            'success': True,
            'task_id': task_id,
            'message': '用户视频下载任务已开始',
            'nickname': nickname,
            'total_videos': aweme_count
        })
    
    except Exception as e:
        return jsonify({'success': False, 'message': f'下载失败: {str(e)}'}), 500

@app.route('/api/cancel_download', methods=['POST'])
def cancel_download():
    """按任务ID取消下载"""
    data = _request_json()
    task_id = data.get('task_id')
    logger.info(f"Request to cancel task: {task_id}")
    
    if task_id in active_tasks:
        info = active_tasks[task_id]
        # 设置取消事件
        info["event"].set()
        if task_id in download_tasks:
            download_tasks[task_id]['status'] = 'cancelled'
        return jsonify({'success': True, 'message': '正在取消任务...'})
    
    if task_id in download_tasks:
        download_tasks[task_id]['status'] = 'cancelled'
        return jsonify({'success': True, 'message': '任务已标记为取消'})
        
    return jsonify({'success': False, 'message': '未找到活跃任务'})

@app.route('/api/pause_download', methods=['POST'])
def pause_download():
    """按任务ID暂停下载"""
    data = _request_json()
    task_id = data.get('task_id')
    logger.info(f"Request to pause task: {task_id}")

    if task_id in active_tasks:
        info = active_tasks[task_id]
        if 'pause_event' in info:
            info['pause_event'].set()  # 设置暂停事件
            if task_id in download_tasks:
                download_tasks[task_id]['status'] = 'paused'
            socketio.emit('user_video_download_progress', {
                'task_id': task_id,
                'status': 'paused',
                'message': '已暂停',
                'type': 'info'
            })
            return jsonify({'success': True, 'message': '任务已暂停'})
        else:
            return jsonify({'success': False, 'message': '该任务不支持暂停'})

    return jsonify({'success': False, 'message': '未找到活跃任务'})

@app.route('/api/resume_download', methods=['POST'])
def resume_download():
    """按任务ID恢复下载"""
    data = _request_json()
    task_id = data.get('task_id')
    logger.info(f"Request to resume task: {task_id}")

    if task_id in active_tasks:
        info = active_tasks[task_id]
        if 'pause_event' in info:
            info['pause_event'].clear()  # 清除暂停事件
            if task_id in download_tasks:
                download_tasks[task_id]['status'] = 'running'
            socketio.emit('user_video_download_progress', {
                'task_id': task_id,
                'status': 'downloading',
                'message': '继续下载',
                'type': 'info'
            })
            return jsonify({'success': True, 'message': '任务已恢复'})
        else:
            return jsonify({'success': False, 'message': '该任务不支持恢复'})

    return jsonify({'success': False, 'message': '未找到活跃任务'})

@app.route('/api/download_liked', methods=['POST'])
def download_liked():
    """下载点赞视频"""
    try:
        data = _request_json()
        count = _coerce_int(data.get('count'), 20, 1, 100)
        if not Config.COOKIE:
            return jsonify({'success': False, 'message': '下载点赞视频需要设置Cookie'}), 400
        
        if not user_manager:
            return jsonify({'success': False, 'message': '请先初始化'}), 400
        
        # 生成任务ID
        task_id = str(uuid.uuid4())
        _store_download_task(task_id, {
            'status': 'running',
            'type': 'liked_videos',
            'start_time': datetime.now()
        })
        
        # 在全局 Loop 中运行异步下载协程
        async def do_download_liked():
            try:
                socketio.emit('download_started', {
                    'task_id': task_id,
                    'type': 'liked_videos'
                })
                
                completed = await user_manager.download_liked_videos(count)
                
                download_tasks[task_id]['status'] = 'completed'
                download_tasks[task_id]['end_time'] = datetime.now()
                
                socketio.emit('download_completed', {
                    'task_id': task_id,
                    'message': f'点赞视频下载完成，共处理 {completed} 个作品'
                })
            except Exception as e:
                logger.error(f"Download liked error: {e}")
                download_tasks[task_id]['status'] = 'failed'
                socketio.emit('download_failed', {'task_id': task_id, 'message': f'任务出错: {str(e)}'})

        loop = get_or_create_loop()
        asyncio.run_coroutine_threadsafe(do_download_liked(), loop)
        
        return jsonify({
            'success': True,
            'task_id': task_id,
            'message': '点赞视频下载任务已开始'
        })
    
    except Exception as e:
        return jsonify({'success': False, 'message': f'下载失败: {str(e)}'}), 500

@app.route('/api/video_detail', methods=['POST'])
def get_video_detail():
    """获取视频详情"""
    try:
        data = _request_json()
        aweme_id = data.get('aweme_id', '').strip()

        if not aweme_id:
            return jsonify({'success': False, 'message': '视频ID不能为空'}), 400

        if not user_manager:
            return jsonify({'success': False, 'message': '请先设置Cookie'}), 400

        video_detail = run_async(user_manager.get_video_detail(aweme_id))

        if isinstance(video_detail, dict) and video_detail.get('_need_verify'):
            return jsonify(_verify_error_response(video_detail, '需要完成滑块验证'))
        if isinstance(video_detail, dict) and video_detail.get('_need_login'):
            return jsonify(_login_error_response(video_detail))

        if not video_detail:
            logger.warning(f"视频详情为空，可能是视频不存在或 API 限流：aweme_id={aweme_id}")
            return jsonify({
                'success': False,
                'message': '获取视频详情失败，可能是视频不存在或抖音 API 限流，请尝试其他视频或重新登录'
            }), 404

        return jsonify({
            'success': True,
            'video': video_detail
        })
    except Exception as e:
        logger.error(f'获取视频详情异常: {str(e)}', exc_info=True)
        return jsonify({'success': False, 'message': f'获取视频详情失败: {str(e)}'}), 500

@app.route('/api/video_like', methods=['POST'])
def set_video_liked_api():
    """点赞或取消点赞作品"""
    try:
        data = _request_json()
        aweme_id = str(data.get('aweme_id') or '').strip()
        liked = _coerce_bool(data.get('liked'), False)

        if not aweme_id:
            return jsonify({'success': False, 'message': '作品ID不能为空'}), 400
        if not user_manager:
            return jsonify({'success': False, 'message': '请先设置Cookie'}), 400

        result = run_async(user_manager.set_video_liked(aweme_id, liked))
        if isinstance(result, dict):
            if result.get('_security_blocked'):
                return jsonify({
                    'success': False,
                    'security_blocked': True,
                    'message': _api_message(result, '点赞被抖音安全校验拒绝，请稍后重试'),
                })
            if result.get('_need_verify'):
                return jsonify(_verify_error_response(result, '点赞失败，请完成验证后重试'))
            if result.get('_need_login'):
                return jsonify(_login_error_response(result))
            if result.get('_error') or result.get('status_code', 0) not in (0, None):
                return jsonify({
                    'success': False,
                    'message': _api_message(result, '点赞失败，请检查 Cookie 或稍后重试'),
                })

        return jsonify({
            'success': True,
            'aweme_id': aweme_id,
            'is_liked': result.get('is_liked', liked) if isinstance(result, dict) else liked,
            'raw': result.get('raw') if isinstance(result, dict) else None,
            'message': result.get('message') if isinstance(result, dict) else ('点赞成功' if liked else '已取消点赞'),
        })
    except Exception as e:
        logger.error(f'设置点赞状态异常: {str(e)}', exc_info=True)
        return jsonify({'success': False, 'message': f'点赞失败: {str(e)}'}), 500

@app.route('/api/video_collect', methods=['POST'])
def set_video_collected_api():
    """收藏或取消收藏作品"""
    try:
        data = _request_json()
        aweme_id = str(data.get('aweme_id') or '').strip()
        collected = _coerce_bool(data.get('collected'), False)

        if not aweme_id:
            return jsonify({'success': False, 'message': '作品ID不能为空'}), 400
        if not user_manager:
            return jsonify({'success': False, 'message': '请先设置Cookie'}), 400

        result = run_async(user_manager.set_video_collected(aweme_id, collected))
        if isinstance(result, dict):
            if result.get('_security_blocked'):
                return jsonify({
                    'success': False,
                    'security_blocked': True,
                    'message': _api_message(result, '收藏被抖音安全校验拒绝，请稍后重试'),
                })
            if result.get('_need_verify'):
                return jsonify(_verify_error_response(result, '收藏失败，请完成验证后重试'))
            if result.get('_need_login'):
                return jsonify(_login_error_response(result))
            if result.get('_error') or result.get('status_code', 0) not in (0, None):
                return jsonify({
                    'success': False,
                    'message': _api_message(result, '收藏失败，请检查 Cookie 或稍后重试'),
                })

        return jsonify({
            'success': True,
            'aweme_id': aweme_id,
            'is_collected': collected,
            'message': '收藏成功' if collected else '已取消收藏',
        })
    except Exception as e:
        logger.error(f'设置收藏状态异常: {str(e)}', exc_info=True)
        return jsonify({'success': False, 'message': f'收藏失败: {str(e)}'}), 500

@app.route('/api/parse_link', methods=['POST'])
def parse_link():
    """解析抖音链接"""
    try:
        data = _request_json()
        link = data.get('link', '').strip()
        
        if not link:
            return jsonify({'success': False, 'message': '链接不能为空'}), 400
        
        if not user_manager:
            return jsonify({'success': False, 'message': '请先设置Cookie'}), 400
        
        def run_parse_link():
            # 解析链接获取视频信息
            video_info = run_async(user_manager.parse_share_link(link))
            if not video_info:
                return None, None
            
            # 获取作者的详细信息
            author_sec_uid = video_info.get('author', {}).get('sec_uid', '')
            user_detail = None
            if author_sec_uid:
                user_detail = run_async(user_manager.get_user_detail(author_sec_uid))
                if isinstance(user_detail, dict) and (user_detail.get('_need_verify') or user_detail.get('_need_login')):
                    return video_info, user_detail
                if user_detail:
                    user_detail = {
                        'nickname': user_detail.get('nickname', ''),
                        'unique_id': user_detail.get('unique_id', ''),
                        'follower_count': user_detail.get('follower_count', 0),
                        'following_count': user_detail.get('following_count', 0),
                        'total_favorited': user_detail.get('total_favorited', 0),
                        'aweme_count': user_detail.get('aweme_count', 0),
                        'signature': user_detail.get('signature', ''),
                        'sec_uid': user_detail.get('sec_uid', ''),
                        'avatar_thumb': user_detail.get('avatar_thumb', {}).get('url_list', [''])[0] if user_detail.get('avatar_thumb') else '',
                        'avatar_larger': user_detail.get('avatar_larger', {}).get('url_list', [''])[0] if user_detail.get('avatar_larger') else ''
                    }
            return video_info, user_detail
        
        video_info, user_detail = run_parse_link()

        if isinstance(video_info, dict) and video_info.get('_need_verify'):
            return jsonify(_verify_error_response(video_info, '需要完成滑块验证'))
        if isinstance(video_info, dict) and video_info.get('_need_login'):
            return jsonify(_login_error_response(video_info))
        if isinstance(user_detail, dict) and user_detail.get('_need_verify'):
            return jsonify(_verify_error_response(user_detail, '解析链接失败，请完成验证后重试'))
        if isinstance(user_detail, dict) and user_detail.get('_need_login'):
            return jsonify(_login_error_response(user_detail))
        
        if video_info:
            # 格式化视频数据
            formatted_video = {
                'author': video_info.get('author', {}),
                'aweme_id': video_info.get('aweme_id', ''),
                'comment_count': video_info.get('comment_count', 0),
                'cover_url': video_info.get('cover_url', ''),
                'create_time': video_info.get('create_time', 0),
                'desc': video_info.get('desc', ''),
                'digg_count': video_info.get('digg_count', 0),
                'duration': video_info.get('duration', 0),
                'duration_unit': video_info.get('duration_unit', 'milliseconds'),
                'media_type': video_info.get('media_type', ''),
                'raw_media_type': video_info.get('raw_media_type', video_info.get('media_type', '')),
                'media_urls': video_info.get('media_urls', []),
                'share_count': video_info.get('share_count', 0)
            }
            
            # 返回包含作者详细信息和作品信息的数据结构
            response_data = {
                'success': True,
                'type': 'link_parse',
                'video': formatted_video,  # 单个视频信息
                'videos': [formatted_video]  # 兼容原有格式
            }
            
            # 如果获取到作者详细信息，添加到响应中
            if user_detail:
                response_data['user'] = user_detail
            
            return jsonify(response_data)
        else:
            return jsonify({'success': False, 'message': '解析链接失败，请检查链接是否有效'}), 404
    
    except Exception as e:
        return jsonify({'success': False, 'message': f'解析链接失败: {str(e)}'}), 500

@app.route('/api/download_liked_authors', methods=['POST'])
def download_liked_authors():
    """下载点赞作者作品"""
    try:
        data = _request_json()
        count = _coerce_int(data.get('count'), 20, 1, 100)
        selected_sec_uids = data.get('selected_sec_uids') or data.get('sec_uids') or []
        if not Config.COOKIE:
            return jsonify({'success': False, 'message': '下载点赞作者作品需要设置Cookie'}), 400
        
        if not user_manager:
            return jsonify({'success': False, 'message': '请先初始化'}), 400
        
        # 生成任务ID
        task_id = str(uuid.uuid4())
        _store_download_task(task_id, {
            'status': 'running',
            'type': 'liked_authors',
            'start_time': datetime.now()
        })
        
        # 在全局 Loop 中运行异步下载协程
        async def do_download_liked_authors():
            try:
                socketio.emit('download_started', {
                    'task_id': task_id,
                    'type': 'liked_authors'
                })
                
                completed = await user_manager.download_liked_authors(count=count, selected_sec_uids=selected_sec_uids)
                
                download_tasks[task_id]['status'] = 'completed'
                download_tasks[task_id]['end_time'] = datetime.now()
                
                socketio.emit('download_completed', {
                    'task_id': task_id,
                    'message': f'点赞作者作品下载完成，共处理 {completed} 个作者'
                })
            except Exception as e:
                logger.error(f"Download liked authors error: {e}")
                download_tasks[task_id]['status'] = 'failed'
                socketio.emit('download_failed', {'task_id': task_id, 'message': f'任务出错: {str(e)}'})

        loop = get_or_create_loop()
        asyncio.run_coroutine_threadsafe(do_download_liked_authors(), loop)
        
        return jsonify({
            'success': True,
            'task_id': task_id,
            'message': '点赞作者作品下载任务已开始'
        })
    
    except Exception as e:
        return jsonify({'success': False, 'message': f'下载失败: {str(e)}'}), 500


@app.route('/api/get_comments', methods=['POST'])
def get_comments():
    """获取视频评论列表。"""
    try:
        data = _request_json()
        aweme_id = str(data.get('aweme_id') or '').strip()
        count = _coerce_int(data.get('count'), 20, 1, 100)
        cursor = _coerce_int(data.get('cursor'), 0, 0)

        if not aweme_id:
            return jsonify({'success': False, 'message': '视频ID不能为空'}), 400

        if not api:
            return jsonify({'success': False, 'message': '服务未初始化'}), 400

        resp, success = run_async(api.get_comments(aweme_id, count, cursor))

        if isinstance(resp, dict) and resp.get('_need_verify'):
            return jsonify(_verify_error_response(
                resp,
                '获取评论失败，请完成验证后重试',
                verify_url=f'https://www.douyin.com/video/{aweme_id}',
            ))
        if isinstance(resp, dict) and resp.get('_need_login'):
            return jsonify(_login_error_response(resp))

        if not success:
            return jsonify({
                'success': False,
                'message': _api_message(resp, '获取评论失败，请稍后重试'),
            })

        data_block = resp.get('data') if isinstance(resp.get('data'), dict) else resp
        raw_comments = data_block.get('comments') or []
        comments = [_format_comment_item(item) for item in raw_comments if isinstance(item, dict)]

        has_more = data_block.get('has_more', False)
        return jsonify({
            'success': True,
            'comments': comments,
            'cursor': data_block.get('cursor', 0),
            'has_more': has_more == 1 or has_more is True,
            'total': data_block.get('total', 0),
        })

    except Exception as e:
        logger.exception(f"获取评论失败: {e}")
        return jsonify({'success': False, 'message': f'获取评论失败: {str(e)}'}), 500


@app.route('/api/get_comment_replies', methods=['POST'])
def get_comment_replies():
    """获取评论的二级回复列表。"""
    try:
        data = _request_json()
        aweme_id = str(data.get('aweme_id') or '').strip()
        comment_id = str(data.get('comment_id') or '').strip()
        count = _coerce_int(data.get('count'), 6, 1, 50)
        cursor = _coerce_int(data.get('cursor'), 0, 0)

        if not aweme_id:
            return jsonify({'success': False, 'message': '视频ID不能为空'}), 400
        if not comment_id:
            return jsonify({'success': False, 'message': '评论ID不能为空'}), 400
        if not api:
            return jsonify({'success': False, 'message': '服务未初始化'}), 400

        resp, success = run_async(api.get_comment_replies(aweme_id, comment_id, count, cursor))

        if isinstance(resp, dict) and resp.get('_need_verify'):
            return jsonify(_verify_error_response(
                resp,
                '获取评论回复失败，请完成验证后重试',
                verify_url=f'https://www.douyin.com/video/{aweme_id}',
            ))
        if isinstance(resp, dict) and resp.get('_need_login'):
            return jsonify(_login_error_response(resp))

        if not success:
            return jsonify({
                'success': False,
                'message': _api_message(resp, '获取评论回复失败，请稍后重试'),
            })

        data_block = resp.get('data') if isinstance(resp.get('data'), dict) else resp
        raw_comments = data_block.get('comments') or data_block.get('reply_comments') or []
        has_more = data_block.get('has_more', False)
        return jsonify({
            'success': True,
            'comments': [_format_comment_item(item) for item in raw_comments if isinstance(item, dict)],
            'cursor': data_block.get('cursor', 0),
            'has_more': has_more == 1 or has_more is True,
            'total': data_block.get('total', 0),
        })

    except Exception as e:
        logger.exception(f"获取评论回复失败: {e}")
        return jsonify({'success': False, 'message': f'获取评论回复失败: {str(e)}'}), 500


@app.route('/api/comment_digg', methods=['POST'])
def comment_digg():
    """点赞或取消点赞评论。"""
    try:
        data = _request_json()
        aweme_id = str(data.get('aweme_id') or '').strip()
        comment_id = str(data.get('comment_id') or '').strip()
        raw_liked = data.get('liked')
        liked = str(raw_liked).strip().lower() in ('1', 'true', 'yes', 'on') if isinstance(raw_liked, str) else bool(raw_liked)
        level = _coerce_int(data.get('level'), 1, 1, 2)

        if not aweme_id:
            return jsonify({'success': False, 'message': '视频ID不能为空'}), 400
        if not comment_id:
            return jsonify({'success': False, 'message': '评论ID不能为空'}), 400
        if not api:
            return jsonify({'success': False, 'message': '服务未初始化'}), 400

        resp, success = run_async(api.set_comment_liked(aweme_id, comment_id, liked, level))

        if isinstance(resp, dict) and resp.get('_need_verify'):
            return jsonify(_verify_error_response(
                resp,
                '评论点赞失败，请完成验证后重试',
                verify_url=f'https://www.douyin.com/video/{aweme_id}',
            ))
        if isinstance(resp, dict) and resp.get('_need_login'):
            return jsonify(_login_error_response(resp))

        if not success:
            return jsonify({
                'success': False,
                'message': _api_message(resp, '评论点赞失败，请稍后重试'),
                'security_blocked': bool(isinstance(resp, dict) and resp.get('_security_blocked')),
            })

        return jsonify({
            'success': True,
            'aweme_id': aweme_id,
            'cid': comment_id,
            'user_digged': 1 if liked else 0,
            'raw': resp,
            'message': '评论点赞成功' if liked else '已取消评论点赞',
        })

    except Exception as e:
        logger.exception(f"评论点赞失败: {e}")
        return jsonify({'success': False, 'message': f'评论点赞失败: {str(e)}'}), 500


@app.route('/api/comment_publish', methods=['POST'])
def comment_publish():
    """发布一级评论或回复评论。"""
    try:
        data = _request_json()
        aweme_id = str(data.get('aweme_id') or '').strip()
        text = str(data.get('text') or '').strip()
        reply_id = str(data.get('reply_id') or '').strip()
        reply_to_reply_id = str(data.get('reply_to_reply_id') or '').strip()

        if not aweme_id:
            return jsonify({'success': False, 'message': '视频ID不能为空'}), 400
        if not text:
            return jsonify({'success': False, 'message': '评论内容不能为空'}), 400
        if not api:
            return jsonify({'success': False, 'message': '服务未初始化'}), 400

        resp, success = run_async(api.publish_comment(aweme_id, text, reply_id, reply_to_reply_id))

        if isinstance(resp, dict) and resp.get('_need_verify'):
            return jsonify(_verify_error_response(
                resp,
                '发表评论失败，请完成验证后重试',
                verify_url=f'https://www.douyin.com/video/{aweme_id}',
            ))
        if isinstance(resp, dict) and resp.get('_need_login'):
            return jsonify(_login_error_response(resp))

        if not success:
            logger.warning("发表评论失败，抖音响应: %s", resp)
            return jsonify({
                'success': False,
                'message': _api_message(resp, '发表评论失败，请稍后重试'),
            })

        raw_comment = resp.get('comment') if isinstance(resp, dict) else None
        return jsonify({
            'success': True,
            'aweme_id': aweme_id,
            'comment': _format_comment_item(raw_comment) if isinstance(raw_comment, dict) else None,
            'raw': resp,
            'message': '评论已发布',
        })

    except Exception as e:
        logger.exception(f"发表评论失败: {e}")
        return jsonify({'success': False, 'message': f'发表评论失败: {str(e)}'}), 500


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
    for task_id, task in download_tasks.items():
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
    _ensure_im_message_listener()
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
# COOKIE 浏览器登录
# ═══════════════════════════════════════════════
_native_cookie_login_session = None  # 当前正在运行的原生登录窗口会话


def _emit_cookie_login_status(event: str, message: str, cookie_set: bool = False) -> None:
    socketio.emit('cookie_login_status', {
        'event': event,
        'message': message,
        'cookie_set': cookie_set,
    })


def _verify_native_cookie_login(cookie: str) -> dict:
    try:
        cookie_names = set()
        passport_auth_status = ''
        for item in cookie.split(';'):
            if '=' not in item:
                continue
            name, value = item.strip().split('=', 1)
            cookie_names.add(name)
            if name == 'passport_auth_status':
                passport_auth_status = value

        if passport_auth_status != '1' and not any(
            name in cookie_names
            for name in ('sessionid', 'sessionid_ss', 'sid_guard', 'uid_tt')
        ):
            return {
                'success': False,
                'need_login': True,
                'message': 'Cookie 不包含登录字段，请重新登录获取 Cookie',
            }

        candidate_api = DouyinAPI(cookie)
        user, success = run_async(candidate_api.get_current_user(strict_profile=True))

        if not success:
            if user.get('_need_verify'):
                return {
                    'success': False,
                    'need_verify': True,
                    'message': _api_message(user, '登录态校验失败，请完成验证后重试'),
                }
            return {
                'success': False,
                'need_login': True,
                'message': _api_message(user, '登录态校验失败，请重新登录获取 Cookie'),
            }

        saved_profile = Config.CURRENT_USER_PROFILE if isinstance(Config.CURRENT_USER_PROFILE, dict) else {}
        return {
            'success': True,
            'nickname': (user.get('nickname') or saved_profile.get('nickname') or '').strip(),
            'user_id': user.get('uid') or user.get('sec_uid') or saved_profile.get('uid') or saved_profile.get('sec_uid') or '',
            'sec_uid': user.get('sec_uid') or saved_profile.get('sec_uid') or '',
            'avatar_thumb': _avatar_url(user, 'avatar_thumb', 'avatar_100x100', 'avatar_168x168', 'avatar_medium', 'avatar_300x300', 'avatar_larger') or saved_profile.get('avatar_thumb') or '',
            'avatar_medium': _avatar_url(user, 'avatar_medium', 'avatar_168x168', 'avatar_300x300', 'avatar_larger', 'avatar_thumb', 'avatar_100x100') or saved_profile.get('avatar_medium') or '',
            'avatar_larger': _avatar_url(user, 'avatar_larger', 'avatar_300x300', 'avatar_medium', 'avatar_168x168', 'avatar_thumb', 'avatar_100x100') or saved_profile.get('avatar_larger') or '',
        }
    except Exception as error:
        logger.warning('原生 Cookie 登录校验失败: %s', error)
        return {'success': False, 'message': str(error)}


def _save_cookie_login_success(
    cookie: str,
    nickname: str = '',
    relation_signer: dict | None = None,
    current_user_profile: dict | None = None,
) -> None:
    Config.COOKIE = cookie
    Config.RELATION_SIGNER = relation_signer
    if isinstance(current_user_profile, dict) and current_user_profile:
        Config.CURRENT_USER_PROFILE = {
            **(Config.CURRENT_USER_PROFILE if isinstance(Config.CURRENT_USER_PROFILE, dict) else {}),
            **current_user_profile,
        }
    Config.save_config(
        Config.COOKIE,
        Config.BASE_DIR,
        Config.HISTORY_DIRS,
        relation_signer=Config.RELATION_SIGNER,
        current_user_profile=Config.CURRENT_USER_PROFILE,
    )
    _stop_im_message_listener()
    init_app()
    _ensure_im_message_listener()

    success_message = 'Cookie 获取成功！已自动保存。'
    if nickname:
        success_message = f'Cookie 获取成功！已登录为 {nickname}'

    _emit_cookie_login_status('success', success_message, cookie_set=True)
    logger.info('通过原生登录窗口成功获取 Cookie')


def _start_native_cookie_login(timeout: int) -> tuple[bool, str]:
    global _native_cookie_login_session

    if not is_native_cookie_login_available():
        return False, 'native_unavailable'

    try:
        login_window = create_login_window()
    except Exception as error:
        logger.warning('创建原生登录窗口失败，将回退其他方案: %s', error)
        return False, str(error)

    session = NativeCookieLoginSession(window=login_window)
    _native_cookie_login_session = session

    def emit_once(event: str, message: str, cookie_set: bool = False) -> None:
        if session.last_event == event and session.last_message == message:
            return
        session.last_event = event
        session.last_message = message
        _emit_cookie_login_status(event, message, cookie_set=cookie_set)

    def finish() -> None:
        global _native_cookie_login_session
        session.finished_event.set()
        if _native_cookie_login_session is session:
            _native_cookie_login_session = None

    def poll_cookie_window() -> None:
        poll_interval = 0.5
        relation_signer_attempts = 8
        relation_signer_interval = 0.75
        try:
            emit_once('pending', '登录窗口已打开，请在窗口中完成登录')

            if not session.window.events.loaded.wait(45):
                if not session.cancel_event.is_set():
                    session.close()
                    emit_once('error', '登录窗口加载超时，请重试')
                return

            while True:
                if session.cancel_event.is_set():
                    session.close()
                    emit_once('cancelled', '登录已取消')
                    return

                if session.window.events.closed.is_set():
                    emit_once('cancelled', '登录窗口已关闭')
                    return

                if time.monotonic() - session.created_at >= timeout:
                    session.close()
                    emit_once('timeout', '登录超时，请重试')
                    return

                try:
                    raw_cookies = session.window.get_cookies() or []
                except Exception as error:
                    logger.debug('读取原生登录窗口 Cookie 失败: %s', error)
                    time.sleep(poll_interval)
                    continue

                entries = normalize_cookie_entries(raw_cookies)
                if not has_login_cookie(entries):
                    time.sleep(poll_interval)
                    continue

                relation_signer = extract_relation_signer_entries(entries)
                current_user_profile = extract_current_user_profile_entries(entries)
                if not relation_signer_ready(relation_signer) or not current_user_profile:
                    inject_relation_signer_probe(session.window)

                cookie_string = serialize_cookie_entries(entries)
                if not cookie_string:
                    time.sleep(poll_interval)
                    continue

                now = time.monotonic()
                should_verify = (
                    cookie_string != session.last_cookie_value
                    or now - session.last_verify_at >= 1.5
                )

                if not should_verify:
                    time.sleep(poll_interval)
                    continue

                session.last_cookie_value = cookie_string
                session.last_verify_at = now
                emit_once('pending', '已检测到登录 Cookie，正在校验登录状态')

                verify_result = _verify_native_cookie_login(cookie_string)
                if not verify_result.get('success'):
                    logger.info(
                        '原生登录窗口候选 Cookie 校验未通过: %s',
                        verify_result.get('message', 'unknown'),
                    )
                    time.sleep(poll_interval)
                    continue

                user_id = str(verify_result.get('user_id') or '').strip()
                if user_id:
                    if not relation_signer_ready_for_uid(relation_signer, user_id):
                        emit_once('pending', '登录已确认，正在采集私信安全参数')
                        try:
                            session.window.load_url('https://www.douyin.com/?recommend=1')
                        except Exception as error:
                            logger.debug('跳转推荐页采集私信安全参数失败: %s', error)
                        for _ in range(relation_signer_attempts):
                            inject_relation_signer_probe(session.window)
                            time.sleep(relation_signer_interval)
                            try:
                                latest_entries = normalize_cookie_entries(session.window.get_cookies() or [])
                            except Exception as error:
                                logger.debug('读取私信安全参数 Cookie 失败: %s', error)
                                continue
                            latest_signer = extract_relation_signer_entries(latest_entries)
                            latest_profile = extract_current_user_profile_entries(latest_entries)
                            if latest_profile:
                                current_user_profile = {
                                    **(current_user_profile if isinstance(current_user_profile, dict) else {}),
                                    **latest_profile,
                                }
                            if latest_signer:
                                latest_signer['uid'] = user_id
                                relation_signer = {
                                    **(relation_signer if isinstance(relation_signer, dict) else {}),
                                    **latest_signer,
                                }
                            latest_cookie_string = serialize_cookie_entries(latest_entries)
                            if latest_cookie_string:
                                cookie_string = latest_cookie_string
                            if relation_signer_ready_for_uid(relation_signer, user_id):
                                break
                    if isinstance(relation_signer, dict):
                        relation_signer['uid'] = user_id
                if isinstance(relation_signer, dict):
                    logger.info(
                        '原生登录窗口采集关系动作参数: uid=%s ticket_len=%s ts_sign_len=%s public_key_len=%s ecdh_key_len=%s dtrait_len=%s creator_ticket_len=%s',
                        relation_signer.get('uid') or '',
                        len(str(relation_signer.get('ticket') or '')),
                        len(str(relation_signer.get('ts_sign') or '')),
                        len(str(relation_signer.get('public_key') or '')),
                        len(str(relation_signer.get('ecdh_key') or '')),
                        len(str(relation_signer.get('dtrait') or '')),
                        len(str(relation_signer.get('creator_ticket') or '')),
                    )

                if not relation_signer_ready_for_uid(relation_signer, user_id):
                    previous_signer = Config.RELATION_SIGNER if isinstance(Config.RELATION_SIGNER, dict) else None
                    if relation_signer_ready_for_uid(previous_signer, user_id):
                        relation_signer = previous_signer
                    elif not relation_signer_has_ticket_guard(relation_signer, user_id):
                        relation_signer = None

                if isinstance(current_user_profile, dict):
                    current_user_profile = {
                        **current_user_profile,
                        "uid": current_user_profile.get("uid") or verify_result.get("user_id") or "",
                        "sec_uid": current_user_profile.get("sec_uid") or verify_result.get("sec_uid") or "",
                        "nickname": current_user_profile.get("nickname") or verify_result.get("nickname") or "",
                    }

                _save_cookie_login_success(
                    cookie_string,
                    verify_result.get('nickname', ''),
                    relation_signer,
                    current_user_profile,
                )
                session.close()
                return
        finally:
            finish()

    threading.Thread(target=poll_cookie_window, daemon=True).start()
    return True, 'native_started'

@app.route('/api/cookie/browser_login', methods=['POST'])
def cookie_browser_login():
    """启动登录窗口让用户登录抖音，自动提取 Cookie"""
    global _native_cookie_login_session

    if _native_cookie_login_session and _native_cookie_login_session.is_active():
        return jsonify({'success': False, 'message': '登录窗口已在进行中'}), 409
    
    data = _request_json()
    timeout = _coerce_int(data.get('timeout'), 300, 30, 900)
    _ = data.get('browser', 'chrome')

    started, reason = _start_native_cookie_login(timeout)
    if started:
        return jsonify({'success': True, 'message': '登录窗口已启动，请在弹出的窗口中登录抖音'})

    return jsonify({
        'success': False,
        'message': '当前运行模式不支持内置登录窗口，请使用“从浏览器读取 Cookie”或手动粘贴 Cookie',
        'reason': reason,
    }), 400

@app.route('/api/cookie/browser_login/cancel', methods=['POST'])
def cookie_browser_login_cancel():
    """取消正在进行的原生登录窗口"""
    global _native_cookie_login_session

    if _native_cookie_login_session and _native_cookie_login_session.is_active():
        _native_cookie_login_session.close()
        _native_cookie_login_session.last_event = 'cancelled'
        _native_cookie_login_session.last_message = '登录已取消'
        _emit_cookie_login_status('cancelled', '登录已取消')
        return jsonify({'success': True, 'message': '已取消登录'})

    return jsonify({'success': False, 'message': '没有正在进行的登录窗口'})


@app.route('/api/cookie/generate_temp', methods=['POST'])
def cookie_generate_temp():
    """生成临时 Cookie（未登录状态）"""
    try:
        # 使用统一的 API 接口获取临时 cookie
        from src.api.api import DouyinAPI

        # 创建临时的 API 实例（无需 cookie）
        api = DouyinAPI(cookie='')
        result = run_async(api.get_temp_cookie())

        if result.get('success'):
            return jsonify({
                'success': True,
                'cookie': result.get('cookie', ''),
                'message': result.get('message', '临时 Cookie 生成成功')
            })
        else:
            return jsonify({
                'success': False,
                'message': result.get('message', '生成失败')
            })

    except Exception as e:
        logger.exception(f"生成临时 cookie 异常: {e}")
        return jsonify({
            'success': False,
            'message': f'生成失败: {str(e)}'
        })


@app.route('/api/cookie/from_browser', methods=['POST'])
def cookie_from_browser():
    """从浏览器读取已登录的 Cookie"""
    try:
        from src.api.api import DouyinAPI

        result = DouyinAPI.get_browser_cookies()

        if result.get('success'):
            return jsonify({
                'success': True,
                'cookie': result.get('cookie', ''),
                'message': result.get('message', '读取成功'),
                'browser': result.get('browser', ''),
                'count': result.get('count', 0)
            })
        else:
            return jsonify({
                'success': False,
                'message': result.get('message', '读取失败')
            })

    except Exception as e:
        logger.exception(f"从浏览器读取 Cookie 异常: {e}")
        return jsonify({
            'success': False,
            'message': f'读取失败: {str(e)}'
        })



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

        # 获取当前配置的 cookie
        cookie = Config.COOKIE if Config.COOKIE else ''

        if not cookie:
            return jsonify({
                'success': False,
                'message': '请先登录抖音账号'
            })

        if not api:
            return jsonify({
                'success': False,
                'message': '服务未初始化'
            })

        # 直接调用 DouyinAPI，与其他接口保持一致
        logger.info(f"[推荐视频] 请求 {count} 个视频")

        async def fetch_recommended():
            resp, success = await api.get_recommended_feed(count, cursor)
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
        logger.info(f"[推荐视频] API 返回 {len(aweme_list)} 个视频")

        # 格式化视频信息
        videos = []
        skipped_count = 0
        for aweme in aweme_list:
            try:
                # 提取视频播放地址
                video_data = aweme.get('video', {})
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
                cover_data = video_data.get('cover', {})
                if isinstance(cover_data, dict):
                    cover = cover_data.get('url_list', [''])[0]
                else:
                    cover = cover_data if cover_data else ''

                if not cover:
                    skipped_count += 1
                    logger.debug(f"跳过视频 {aweme.get('aweme_id')}: 无封面")
                    continue

                # 提取动态封面
                dynamic_cover_data = video_data.get('dynamic_cover', {})
                if isinstance(dynamic_cover_data, dict):
                    dynamic_cover = dynamic_cover_data.get('url_list', [''])[0]
                else:
                    dynamic_cover = dynamic_cover_data if dynamic_cover_data else ''

                origin_cover_data = video_data.get('origin_cover', {})
                if isinstance(origin_cover_data, dict):
                    origin_cover = origin_cover_data.get('url_list', [''])[0]
                else:
                    origin_cover = origin_cover_data if origin_cover_data else cover

                play_addr_h264_data = video_data.get('play_addr_h264', {})
                if isinstance(play_addr_h264_data, dict):
                    play_addr_h264 = play_addr_h264_data.get('url_list', [''])[0]
                else:
                    play_addr_h264 = play_addr_h264_data if play_addr_h264_data else ''

                play_addr_lowbr_data = video_data.get('play_addr_lowbr', {})
                if isinstance(play_addr_lowbr_data, dict):
                    play_addr_lowbr = play_addr_lowbr_data.get('url_list', [''])[0]
                else:
                    play_addr_lowbr = play_addr_lowbr_data if play_addr_lowbr_data else ''

                download_addr_data = video_data.get('download_addr', {})
                if isinstance(download_addr_data, dict):
                    download_addr = download_addr_data.get('url_list', [''])[0]
                else:
                    download_addr = download_addr_data if download_addr_data else ''

                # 提取作者头像
                author_data = aweme.get('author', {})
                avatar_data = author_data.get('avatar_thumb', {})
                if isinstance(avatar_data, dict):
                    avatar_thumb = avatar_data.get('url_list', [''])[0]
                else:
                    avatar_thumb = avatar_data if avatar_data else ''

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
                    'bgm_url': dash_audio_url or _extract_music_info(aweme.get('music') or {}).get('play_url', ''),
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
                        'play_addr_h264': _media_first_url(video_data.get('play_addr_h264')),
                        'play_addr_lowbr': _media_first_url(video_data.get('play_addr_lowbr')),
                        'download_addr': _media_first_url(video_data.get('download_addr')),
                        'width': video_data.get('width', 0),
                        'height': video_data.get('height', 0),
                        'duration': _raw_duration_value(video_data.get('duration', 0)),
                        'duration_unit': 'milliseconds',
                        'ratio': video_data.get('ratio', ''),
                        'bit_rate': video_data.get('bit_rate') or [],
                    },
                    'music': {
                        **_extract_music_info(aweme.get('music') or {}),
                        'cover': (aweme.get('music') or {}).get('cover_large', {}).get('url_list', [''])[0] if isinstance((aweme.get('music') or {}).get('cover_large'), dict) else '',
                    }
                }

                videos.append(video_info)
            except Exception as e:
                import traceback
                logger.error(f"解析视频信息失败: {e}")
                logger.error(traceback.format_exc())
                continue

        logger.info(f"[推荐视频] 返回 {len(videos)} 个有效视频, 跳过 {skipped_count} 个无效视频")

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
            'count': len(videos)
        })

    except Exception as e:
        logger.exception(f"获取推荐视频异常: {e}")
        return jsonify({
            'success': False,
            'message': f'获取失败: {str(e)}'
        })


@app.route('/api/download_video', methods=['POST'])
def download_video_by_aweme_id():
    """通过 aweme_id 下载视频"""
    try:
        data = _request_json()
        aweme_id = data.get('aweme_id', '').strip()

        if not aweme_id:
            return jsonify({'success': False, 'message': 'aweme_id 参数不能为空'}), 400

        if not user_manager:
            return jsonify({'success': False, 'message': '请先初始化'}), 400

        # 使用统一的 API 接口获取视频详情
        detail = run_async(user_manager.get_video_detail(aweme_id))

        if not detail:
            return jsonify({'success': False, 'message': '获取视频详情失败'}), 500

        # 获取媒体信息
        media_type = detail.get('media_type', 'video')
        media_urls = normalize_download_media_urls(detail.get('media_urls', []), media_type)
        video_fallback_urls = user_manager.get_video_download_urls((detail.get('video') or {}))

        if not media_urls:
            return jsonify({'success': False, 'message': '无法获取视频下载地址'}), 500

        # 生成文件名
        author_name = detail.get('author', {}).get('nickname', '未知作者')
        name = build_download_name(author_name, detail.get('desc', ''), aweme_id, media_type=media_type, default_title_prefix='未知作品')

        # 添加到下载队列
        task_id = str(uuid.uuid4())

        async def do_download():
            try:
                if len(media_urls) == 1 and media_urls[0].get('type') == 'video':
                    success = await asyncio.to_thread(
                        user_manager.downloader.download_video,
                        media_urls[0]['url'],
                        name,
                        aweme_id,
                        asyncio.Event(),
                        socketio,
                        task_id,
                        None,
                        None,
                        False,
                        fallback_urls=video_fallback_urls,
                    )
                else:
                    success = await asyncio.to_thread(
                        user_manager.downloader.download_media_group,
                        media_urls,
                        name,
                        aweme_id,
                        socketio,
                        task_id,
                        asyncio.Event(),
                        None,
                        None,
                        False,
                    )

                if success:
                    socketio.emit('download_complete', {
                        'task_id': task_id,
                        'aweme_id': aweme_id,
                        'message': f'{name} 下载完成'
                    })
                else:
                    socketio.emit('download_error', {
                        'task_id': task_id,
                        'aweme_id': aweme_id,
                        'message': f'{name} 下载失败'
                    })
            except Exception as e:
                logger.error(f"下载视频失败: {e}")
                socketio.emit('download_error', {
                    'task_id': task_id,
                    'aweme_id': aweme_id,
                    'message': f'下载失败: {str(e)}'
                })

        # 在后台线程执行下载
        loop = get_or_create_loop()
        asyncio.run_coroutine_threadsafe(do_download(), loop)

        return jsonify({'success': True, 'task_id': task_id, 'message': '已添加到下载队列'})

    except Exception as e:
        logger.exception(f"下载视频异常: {e}")
        return jsonify({'success': False, 'message': f'下载失败: {str(e)}'}), 500


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

if __name__ == '__main__':
    main()
