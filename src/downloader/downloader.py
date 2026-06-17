import os
import json
import re
import time
import threading
import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry
from urllib.parse import urlparse
from typing import List, Optional

from src.config.config import Config
from src.api.api import DouyinAPI
from src.utils.download_history_index import (
    remove_download_history_entries,
    upsert_download_history_entries,
)

# 带重试的 requests session。Session 本身不跨线程共享，避免批量下载并发时互相污染连接状态。
_retry = Retry(total=3, backoff_factor=0.5, status_forcelist=[500, 502, 503, 504])
_thread_local = threading.local()


def _create_session():
    session = requests.Session()
    session.mount('https://', HTTPAdapter(max_retries=_retry))
    session.mount('http://', HTTPAdapter(max_retries=_retry))
    return session


def _get_session():
    session = getattr(_thread_local, 'session', None)
    if session is None:
        session = _create_session()
        _thread_local.session = session
    return session


def _redact_headers(headers: dict) -> dict:
    redacted = dict(headers)
    for key in list(redacted.keys()):
        if key.lower() in ('cookie', 'authorization'):
            redacted[key] = '<redacted>'
    return redacted


def _truncate_filename_text(
    value: str,
    default: str,
    max_length: int,
    max_bytes: int,
    protected_suffix: str = '',
) -> str:
    text = str(value or '')
    suffix = str(protected_suffix or '')

    if suffix and text.endswith(suffix):
        suffix_len = len(suffix)
        if suffix_len >= max_length:
            text = suffix[:max_length]
        else:
            prefix = text[:-suffix_len][: max(0, max_length - suffix_len)]
            text = f"{prefix}{suffix}"

        if max_bytes > 0:
            suffix_bytes = len(suffix.encode('utf-8'))
            if suffix_bytes >= max_bytes:
                text = suffix.encode('utf-8')[:max_bytes].decode('utf-8', 'ignore')
            else:
                prefix = text[:-suffix_len] if suffix_len else text
                while prefix and len(f"{prefix}{suffix}".encode('utf-8')) > max_bytes:
                    prefix = prefix[:-1]
                text = f"{prefix}{suffix}"
    else:
        text = text[:max_length]
        if max_bytes > 0:
            while text and len(text.encode('utf-8')) > max_bytes:
                text = text[:-1]

    text = text.strip(' ._')
    return text or default


def _coerce_timestamp_seconds(value) -> Optional[float]:
    try:
        timestamp = float(value or 0)
    except (TypeError, ValueError):
        return None
    if timestamp <= 0:
        return None
    if timestamp > 1_000_000_000_000:
        timestamp = timestamp / 1000
    return timestamp


def _template_fields(
    desc: str,
    aweme_id: str,
    author: str = '',
    media_type: str = '',
    create_time=None,
) -> dict:
    normalized_title = ' '.join(str(desc or '').split()).strip()
    normalized_aweme_id = str(aweme_id or '').strip()
    normalized_author = ' '.join(str(author or '').split()).strip()
    timestamp = _coerce_timestamp_seconds(create_time)
    now = time.localtime(timestamp) if timestamp is not None else time.localtime()
    return {
        'title': normalized_title,
        'aweme_id': normalized_aweme_id,
        'author': normalized_author,
        'date': time.strftime('%Y%m%d', now),
        'time': time.strftime('%H%M%S', now),
        'media_type': str(media_type or '').strip(),
    }


def _render_template(template: str, fields: dict, default_template: str) -> str:
    template_text = str(template or '').strip() or default_template

    def replace_token(match):
        return str(fields.get(match.group(1), ''))

    return re.sub(r'\{([a-zA-Z_][a-zA-Z0-9_]*)\}', replace_token, template_text)


def _neutralize_path_separators(value: str) -> str:
    return re.sub(r'[\\/]+', '_', str(value or ''))


def _sanitize_template_component(value: str, default: str) -> str:
    sanitized = re.sub(r'[\\/:*?"<>|\x00-\x1f]', '_', str(value or ''))
    sanitized = ' '.join(sanitized.split()).strip(' ._')
    return sanitized if sanitized not in ('', '.', '..') else default


def build_download_title(
    desc: str,
    aweme_id: str,
    author: str = '',
    media_type: str = '',
    template: Optional[str] = None,
    default_prefix: str = '无标题',
    max_length: Optional[int] = None,
    max_bytes: Optional[int] = None,
    create_time=None,
) -> str:
    fields = _template_fields(
        desc,
        aweme_id,
        author=author,
        media_type=media_type,
        create_time=create_time,
    )
    normalized_desc = fields['title']
    normalized_aweme_id = fields['aweme_id']
    fallback = default_prefix
    template_text = template if template is not None else getattr(Config, 'FILENAME_TEMPLATE', '{title}')
    base = _render_template(
        template_text,
        {**fields, 'title': normalized_desc or default_prefix},
        '{title}',
    )
    base = _neutralize_path_separators(base)
    base = ' '.join(base.split()).strip(' ._') or fallback
    protected_suffix = ''
    if normalized_aweme_id and '{aweme_id}' in str(template_text or ''):
        protected_suffix = normalized_aweme_id if base.endswith(normalized_aweme_id) else f'_{normalized_aweme_id}'
    candidate = base
    if protected_suffix and not base.endswith(protected_suffix):
        candidate = f'{base}{protected_suffix}'
    return _truncate_filename_text(
        candidate,
        fallback,
        int(max_length or Config.MAX_FILENAME_LENGTH),
        int(max_bytes or getattr(Config, 'MAX_FILENAME_BYTES', 200)),
        protected_suffix=protected_suffix,
    )


def build_download_name(
    author: str,
    desc: str,
    aweme_id: str,
    media_type: str = '',
    default_title_prefix: str = '无标题',
    create_time=None,
) -> str:
    fields = _template_fields(
        desc,
        aweme_id,
        author=author,
        media_type=media_type,
        create_time=create_time,
    )
    folder = _render_template(
        getattr(Config, 'FOLDER_NAME_TEMPLATE', '{author}'),
        fields,
        '{author}',
    )
    folder = _sanitize_template_component(_neutralize_path_separators(folder), fields['author'] or '未知作者')
    title = build_download_title(
        desc,
        aweme_id,
        author=author,
        media_type=media_type,
        create_time=create_time,
        default_prefix=default_title_prefix,
    )
    if not getattr(Config, 'AUTO_CREATE_FOLDER', True):
        return title
    return f"{folder}/{title}"


class DouyinDownloader:
    """抖音下载器类"""
    def __init__(self, api: DouyinAPI, socketio=None):
        self.api = api
        self.download_dir = Config.DOWNLOAD_DIR
        self.socketio = socketio  # 添加WebSocket支持
        self._record_lock = threading.RLock()
        self._download_record_cache = {}
        self._all_download_records_cache = set()
        self._downloaded_file_ids_cache = set()
        self._all_download_records_loaded = False
        self._all_download_records_roots = ()
        
        # 检查是否启用调试模式
        self.debug_mode = os.environ.get('DEBUG_MODE', '').lower() in ('true', '1', 'yes')
        if self.debug_mode:
            print(f"\033[94m[Downloader] 调试模式已启用\033[0m")
            
        self._ensure_download_dirs()

    def _clear_download_record_cache(self):
        self._download_record_cache.clear()
        self._all_download_records_cache.clear()
        self._downloaded_file_ids_cache.clear()
        self._all_download_records_loaded = False
        self._all_download_records_roots = ()

    def _sync_download_dir(self):
        current_download_dir = os.path.abspath(str(Config.DOWNLOAD_DIR))
        if os.path.abspath(str(self.download_dir)) == current_download_dir:
            return
        with self._record_lock:
            if os.path.abspath(str(self.download_dir)) != current_download_dir:
                self.download_dir = current_download_dir
                self._clear_download_record_cache()
                os.makedirs(self.download_dir, exist_ok=True)

    def _extract_downloaded_aweme_id(self, filename: str) -> str:
        stem = os.path.splitext(str(filename or ''))[0]
        match = re.search(r'_(\d{10,25})(?:_\d{2})?$', stem)
        return match.group(1) if match else ''

    def _is_complete_download_file(self, dirpath: str, filename: str) -> bool:
        if not filename or filename.startswith('.'):
            return False
        lower_name = filename.lower()
        if lower_name.endswith(('.tmp', '.part', '.download', '.crdownload')):
            return False
        if filename == "download_record.json":
            return False
        try:
            return os.path.getsize(os.path.join(dirpath, filename)) > 4096
        except OSError:
            return False
        
    def _ensure_download_dirs(self):
        """确保下载目录存在"""
        download_path = self.download_dir
        if self.debug_mode:
            print(f"\033[93m[Downloader] 确保下载目录存在: {download_path}\033[0m")
        os.makedirs(download_path, exist_ok=True)

    def _get_record_path(self, user_dir: str) -> str:
        """获取用户下载记录文件路径"""
        self._sync_download_dir()
        sanitized_user_dir = self._sanitize_path_segment(user_dir, '未知作者') if str(user_dir or '').strip() else ''
        user_path = os.path.join(self.download_dir, sanitized_user_dir)
        if self.debug_mode:
            print(f"\033[93m[Downloader] 创建用户目录: {user_path}\033[0m")
        os.makedirs(user_path, exist_ok=True)
        record_path = os.path.join(user_path, "download_record.json")
        if self.debug_mode:
            print(f"\033[93m[Downloader] 下载记录文件路径: {record_path}\033[0m")
        return record_path

    def _load_download_record(self, user_dir: str) -> set:
        """加载用户下载记录"""
        record_path = self._get_record_path(user_dir)
        try:
            with self._record_lock:
                if record_path in self._download_record_cache:
                    return set(self._download_record_cache[record_path])

                if os.path.exists(record_path):
                    if self.debug_mode:
                        print(f"\033[93m[Downloader] 加载下载记录: {record_path}\033[0m")
                    with open(record_path, 'r', encoding='utf-8') as f:
                        raw_records = json.load(f)
                        records = set(raw_records if isinstance(raw_records, list) else [])
                        self._download_record_cache[record_path] = set(records)
                        if self.debug_mode:
                            print(f"\033[93m[Downloader] 已下载记录数: {len(records)}\033[0m")
                        return records
                elif self.debug_mode:
                    print(f"\033[93m[Downloader] 下载记录文件不存在，创建新记录\033[0m")
        except Exception as e:
            if self.debug_mode:
                print(f"\033[91m[Downloader] 加载下载记录失败: {str(e)}\033[0m")
            else:
                print(f"\033[91m加载下载记录失败\033[0m")
        with self._record_lock:
            self._download_record_cache[record_path] = set()
        return set()

    def _record_roots(self) -> list[str]:
        self._sync_download_dir()
        roots = []
        seen = set()
        for raw_root in [self.download_dir, *getattr(Config, 'HISTORY_DIRS', [])]:
            if not raw_root:
                continue
            root = os.path.abspath(str(raw_root))
            key = root.lower()
            if key in seen:
                continue
            seen.add(key)
            roots.append(root)
        return roots

    def _load_all_download_records(self) -> set:
        """加载所有下载目录中的作品记录，避免命名规则变化后重复下载。"""
        records = set()
        file_ids = set()
        try:
            with self._record_lock:
                roots = tuple(self._record_roots())
                if self._all_download_records_loaded and self._all_download_records_roots == roots:
                    return set(self._all_download_records_cache)

                for root in roots:
                    if not os.path.isdir(root):
                        continue
                    for dirpath, _, filenames in os.walk(root):
                        for filename in filenames:
                            if filename == "download_record.json":
                                record_path = os.path.join(dirpath, filename)
                                try:
                                    with open(record_path, 'r', encoding='utf-8') as f:
                                        raw_records = json.load(f)
                                    if isinstance(raw_records, list):
                                        record_set = {str(item) for item in raw_records if item}
                                        records.update(record_set)
                                        self._download_record_cache[record_path] = record_set
                                except Exception as e:
                                    if self.debug_mode:
                                        print(f"\033[91m[Downloader] 读取下载记录失败 {record_path}: {str(e)}\033[0m")
                            elif self._is_complete_download_file(dirpath, filename):
                                aweme_id = self._extract_downloaded_aweme_id(filename)
                                if aweme_id:
                                    file_ids.add(aweme_id)
                self._downloaded_file_ids_cache = records & file_ids
                self._all_download_records_cache = set(self._downloaded_file_ids_cache)
                self._all_download_records_loaded = True
                self._all_download_records_roots = roots
        except Exception as e:
            if self.debug_mode:
                print(f"\033[91m[Downloader] 加载全局下载记录失败: {str(e)}\033[0m")
        return records

    def _downloaded_file_exists(self, aweme_id: str) -> bool:
        normalized_aweme_id = str(aweme_id or '').strip()
        if not normalized_aweme_id:
            return False

        if self._all_download_records_loaded:
            return normalized_aweme_id in self._downloaded_file_ids_cache

        for root in self._record_roots():
            if not os.path.isdir(root):
                continue
            for dirpath, _, filenames in os.walk(root):
                for filename in filenames:
                    if not self._is_complete_download_file(dirpath, filename):
                        continue
                    if self._extract_downloaded_aweme_id(filename) == normalized_aweme_id:
                        return True
        return False

    def _is_aweme_downloaded(self, aweme_id: str, user_dir: str = '') -> bool:
        normalized_aweme_id = str(aweme_id or '').strip()
        if not normalized_aweme_id:
            return False
        all_records = self._load_all_download_records()
        recorded = (
            normalized_aweme_id in self._load_download_record(user_dir)
            or normalized_aweme_id in all_records
        )
        return recorded and self._downloaded_file_exists(normalized_aweme_id)

    def _save_download_record(self, user_dir: str, aweme_id: str):
        """保存下载记录"""
        record_path = self._get_record_path(user_dir)
        try:
            with self._record_lock:
                downloaded = set()
                if os.path.exists(record_path):
                    if record_path in self._download_record_cache:
                        downloaded = set(self._download_record_cache[record_path])
                    else:
                        with open(record_path, 'r', encoding='utf-8') as f:
                            raw_records = json.load(f)
                            downloaded = set(raw_records if isinstance(raw_records, list) else [])

                downloaded.add(aweme_id)

                if self.debug_mode:
                    print(f"\033[93m[Downloader] 添加下载记录: {aweme_id}\033[0m")
                    print(f"\033[93m[Downloader] 当前记录总数: {len(downloaded)}\033[0m")

                temp_path = f"{record_path}.tmp"
                with open(temp_path, 'w', encoding='utf-8') as f:
                    json.dump(sorted(downloaded), f, ensure_ascii=False)
                    f.write('\n')
                    f.flush()
                    os.fsync(f.fileno())
                os.replace(temp_path, record_path)
                try:
                    dir_fd = os.open(os.path.dirname(record_path), os.O_RDONLY)
                    try:
                        os.fsync(dir_fd)
                    finally:
                        os.close(dir_fd)
                except Exception:
                    pass
                self._download_record_cache[record_path] = set(downloaded)
                self._all_download_records_cache.add(str(aweme_id))
                self._downloaded_file_ids_cache.add(str(aweme_id))

            if self.debug_mode:
                print(f"\033[92m[Downloader] 保存下载记录成功: {record_path}\033[0m")
        except Exception as e:
            try:
                os.remove(f"{record_path}.tmp")
            except Exception:
                pass
            if self.debug_mode:
                print(f"\033[91m[Downloader] 保存下载记录失败: {str(e)}\033[0m")
            else:
                print(f"\033[91m保存下载记录失败：{str(e)}\033[0m")

    def _get_download_headers(self):
        """获取下载用的请求头"""
        headers = Config.COMMON_HEADERS.copy()
        headers.update({
            'Accept': '*/*',
            'Accept-Encoding': 'identity;q=1, *;q=0',
            'Range': 'bytes=0-',
            'Referer': 'https://www.douyin.com/'
        })
        
        # 只有在有cookie的情况下才添加cookie
        if self.api.cookie:
            if self.debug_mode:
                print(f"\033[93m[Downloader] 添加Cookie到下载请求头\033[0m")
            headers['Cookie'] = self.api.cookie
        elif self.debug_mode:
            print(f"\033[93m[Downloader] 无Cookie可用于下载请求\033[0m")
            
        if self.debug_mode:
            print(f"\033[93m[Downloader] 下载请求头: {_redact_headers(headers)}\033[0m")
            
        return headers

    def _get_response_size(self, response) -> int:
        """从响应头获取文件大小，取不到时返回 0。"""
        content_length = response.headers.get('Content-Length')
        if content_length and content_length.isdigit():
            return int(content_length)

        content_range = response.headers.get('Content-Range', '')
        if '/' in content_range:
            total = content_range.rsplit('/', 1)[-1]
            if total.isdigit():
                return int(total)

        return 0

    def _extension_for_media(self, file_type: str, url: str, response=None) -> str:
        """Infer a suitable file extension from media type, response headers, and URL."""
        content_type = ''
        if response is not None:
            content_type = (response.headers.get('Content-Type') or '').split(';', 1)[0].strip().lower()

        content_type_extensions = {
            'image/jpeg': 'jpg',
            'image/jpg': 'jpg',
            'image/png': 'png',
            'image/webp': 'webp',
            'image/gif': 'gif',
            'image/avif': 'avif',
            'image/heic': 'heic',
            'image/heif': 'heif',
            'video/mp4': 'mp4',
            'video/quicktime': 'mov',
            'video/webm': 'webm',
            'audio/mpeg': 'mp3',
            'audio/mp4': 'm4a',
            'audio/aac': 'aac',
            'audio/wav': 'wav',
            'audio/ogg': 'ogg',
        }
        if content_type in content_type_extensions:
            return content_type_extensions[content_type]

        try:
            suffix = os.path.splitext(urlparse(url).path)[1].lower().lstrip('.')
        except Exception:
            suffix = ''

        allowed_extensions = {
            'mp4', 'mov', 'm4v', 'webm',
            'jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'heic', 'heif',
            'mp3', 'm4a', 'aac', 'wav', 'ogg',
        }
        if suffix in allowed_extensions:
            return 'jpg' if suffix == 'jpeg' else suffix

        if file_type in ('video', 'live_photo'):
            return 'mp4'
        if file_type == 'audio':
            return 'mp3'
        return 'jpg'

    def _unique_filepath(self, directory: str, filename: str, extension: str) -> str:
        """Return a non-existing path without overwriting previous downloads."""
        filename = self._sanitize_filename(filename)
        safe_extension = extension.lower().lstrip('.') or 'bin'
        candidate = os.path.join(directory, f"{filename}.{safe_extension}")
        if not os.path.exists(candidate):
            return candidate

        timestamp = int(time.time())
        counter = 1
        while True:
            suffix = f"{timestamp}" if counter == 1 else f"{timestamp}_{counter}"
            candidate = os.path.join(directory, f"{filename}_{suffix}.{safe_extension}")
            if not os.path.exists(candidate):
                return candidate
            counter += 1

    def _emit_download_progress(self, socketio, task_id, progress_callback=None, **payload):
        """同时兼容旧 download_progress 事件和新的批量当前作品回调。"""
        if socketio and task_id:
            socketio.emit('download_progress', {
                'task_id': task_id,
                **payload
            })

        if progress_callback:
            try:
                progress_callback(payload)
            except Exception as e:
                if self.debug_mode:
                    print(f"\033[91m[Downloader] 进度回调失败: {str(e)}\033[0m")

    def _wait_if_paused(self, pause_event=None, cancel_event=None):
        if not pause_event:
            return
        while pause_event.is_set() and not (cancel_event and cancel_event.is_set()):
            time.sleep(0.2)

    def _split_download_name(self, name: str) -> tuple[str, str]:
        raw_user_dir, separator, raw_filename = str(name or '').partition('/')
        if not separator:
            raw_filename = raw_user_dir
            return (
                '',
                self._sanitize_filename(raw_filename, '未命名作品'),
            )
        return (
            self._sanitize_path_segment(raw_user_dir, '未知作者'),
            self._sanitize_filename(raw_filename, '未命名作品'),
        )
        
    def download_media_group(self, urls: List[dict], name: str, aweme_id: str = None, socketio=None, task_id=None, cancel_event=None, progress_callback=None, pause_event=None, check_existing: bool = True) -> bool:
        """下载一组媒体文件（图片、视频或Live Photo）
        Args:
            urls: [{'url': 'https://example.com/file.mp4', 'type': 'video'|'image'|'live_photo'}]
            name: 文件名格式 "用户名/文件名"
            aweme_id: 作品ID，用于记录下载历史
            socketio: WebSocket对象，用于发送进度更新
            task_id: WebSocket任务ID，用于发送进度更新
            cancel_event: 可选的取消事件，用于中断下载
        Returns:
            bool: 是否全部下载成功
        """
        # 使用传入的socketio参数，如果没有则使用实例的socketio
        socketio = socketio or self.socketio
        try:
            if self.debug_mode:
                print(f"\033[93m[Downloader] 开始下载媒体组: {name}, 共{len(urls)}个文件\033[0m")
                if aweme_id:
                    print(f"\033[93m[Downloader] 作品ID: {aweme_id}\033[0m")

            # 检查取消信号
            if cancel_event and cancel_event.is_set():
                print(f"\033[93m媒体组下载被取消（开始前）：{name}\033[0m")
                return False

            user_dir, filename = self._split_download_name(name)

            if self.debug_mode:
                print(f"\033[93m[Downloader] 用户目录: {user_dir}, 文件名: {filename}\033[0m")

            # 只有当提供了aweme_id时才检查下载记录
            if check_existing and aweme_id and self._is_aweme_downloaded(aweme_id, user_dir):
                if self.debug_mode:
                    print(f"\033[93m[Downloader] 作品已在下载记录中: {aweme_id}\033[0m")
                print(f"\033[93m作品已下载，跳过：{user_dir}/{filename}\033[0m")
                return True

            # 下载所有文件
            success = True
            downloaded_files = []  # 记录已下载的文件，用于取消时清理

            for i, url_info in enumerate(urls):
                response = None
                # 检查取消信号
                if cancel_event and cancel_event.is_set():
                    print(f"\033[93m媒体组下载被取消（下载中），清理已下载文件：{name}\033[0m")
                    # 清理已下载的文件
                    for filepath in downloaded_files:
                        if os.path.exists(filepath):
                            os.remove(filepath)
                            print(f"\033[93m已删除：{filepath}\033[0m")
                    remove_download_history_entries(downloaded_files)
                    return False

                try:
                    url = url_info['url']
                    file_type = url_info['type']  # 'video', 'image', 'live_photo'

                    if self.debug_mode:
                        print(f"\033[93m[Downloader] 开始下载第 {i+1}/{len(urls)} 个文件: {url}\033[0m")
                        print(f"\033[93m[Downloader] 文件类型: {file_type}\033[0m")
                    
                    # 发送WebSocket进度更新 - 开始下载单个文件
                    file_started_at = time.monotonic()
                    file_type_display = {
                        'video': '视频',
                        'image': '图片',
                        'live_photo': 'Live Photo'
                    }.get(file_type, '文件')
                    if socketio and task_id:
                        from datetime import datetime
                        progress = (i / len(urls)) * 100
                        self._emit_download_progress(
                            socketio, task_id, progress_callback,
                            progress=progress,
                            completed=i,
                            total=len(urls),
                            status='downloading',
                            file_index=i + 1,
                            file_total=len(urls),
                            file_progress=0,
                            bytes_downloaded=0,
                            bytes_total=0,
                            speed_bps=0,
                            eta_seconds=None,
                            file_type=file_type,
                            file_type_display=file_type_display
                        )
                        socketio.emit('download_log', {
                            'task_id': task_id,
                            'message': f'正在下载第 {i+1}/{len(urls)} 个文件 ({file_type_display})',
                            'timestamp': datetime.now().strftime('%H:%M:%S')
                        })
                    elif progress_callback:
                        progress = (i / len(urls)) * 100
                        self._emit_download_progress(
                            socketio, task_id, progress_callback,
                            progress=progress,
                            completed=i,
                            total=len(urls),
                            status='downloading',
                            file_index=i + 1,
                            file_total=len(urls),
                            file_progress=0,
                            bytes_downloaded=0,
                            bytes_total=0,
                            speed_bps=0,
                            eta_seconds=None,
                            file_type=file_type,
                            file_type_display=file_type_display
                        )
                        
                    headers = self._get_download_headers()
                    response = _get_session().get(url, headers=headers, stream=True, timeout=(10, 120))
                    response.raise_for_status()
                    response_size = self._get_response_size(response)
                    
                    if self.debug_mode:
                        print(f"\033[93m[Downloader] 请求状态码: {response.status_code}\033[0m")
                    
                    # 改进文件命名逻辑，避免重复
                    if len(urls) == 1:
                        # 单个文件不添加索引
                        filename_with_index = self._sanitize_filename(filename)
                    else:
                        # 多个文件添加索引
                        index_suffix = f"_{i+1:02d}"
                        protected_suffix = index_suffix
                        if aweme_id and filename.endswith(f"_{aweme_id}"):
                            protected_suffix = f"_{aweme_id}{index_suffix}"
                        filename_with_index = self._sanitize_filename(
                            f"{filename}{index_suffix}",
                            protected_suffix=protected_suffix,
                        )
                    
                    user_path = os.path.join(self.download_dir, user_dir)
                    os.makedirs(user_path, exist_ok=True)
                    
                    extension = self._extension_for_media(file_type, url, response)
                    filepath = self._unique_filepath(user_path, filename_with_index, extension)
                    filename_with_index = os.path.splitext(os.path.basename(filepath))[0]

                    if self.debug_mode:
                        print(f"\033[93m[Downloader] 保存文件路径: {filepath}\033[0m")

                    # 记录已下载的文件路径，用于取消时清理
                    downloaded_files.append(filepath)

                    with open(filepath, "wb") as f:
                        downloaded_size = 0
                        last_emit_time = time.monotonic()
                        last_emit_progress = (i / len(urls)) * 100
                        for chunk in response.iter_content(chunk_size=Config.CHUNK_SIZE):
                            self._wait_if_paused(pause_event, cancel_event)
                            # 检查取消信号
                            if cancel_event and cancel_event.is_set():
                                print(f"\033[93m下载被取消，删除部分文件：{filepath}\033[0m")
                                f.close()
                                # 删除未完成的文件
                                if os.path.exists(filepath):
                                    os.remove(filepath)
                                # 清理之前下载的文件
                                for fp in downloaded_files:
                                    if os.path.exists(fp):
                                        os.remove(fp)
                                remove_download_history_entries(downloaded_files)
                                return False
                            if chunk:
                                f.write(chunk)
                                downloaded_size += len(chunk)
                                now = time.monotonic()
                                elapsed = max(now - file_started_at, 0.001)
                                file_progress = (downloaded_size / response_size * 100) if response_size > 0 else 0
                                file_progress = min(100, max(0, file_progress))
                                progress = ((i + file_progress / 100) / len(urls)) * 100
                                speed_bps = downloaded_size / elapsed
                                eta_seconds = ((response_size - downloaded_size) / speed_bps) if response_size > 0 and speed_bps > 0 else None
                                should_emit = (
                                    now - last_emit_time >= 0.5 or
                                    abs(progress - last_emit_progress) >= 1 or
                                    (response_size > 0 and downloaded_size >= response_size)
                                )
                                if should_emit:
                                    self._emit_download_progress(
                                        socketio, task_id, progress_callback,
                                        progress=progress,
                                        completed=i,
                                        total=len(urls),
                                        status='downloading',
                                        file_index=i + 1,
                                        file_total=len(urls),
                                        file_progress=file_progress,
                                        bytes_downloaded=downloaded_size,
                                        bytes_total=response_size,
                                        speed_bps=speed_bps,
                                        eta_seconds=eta_seconds,
                                        file_type=file_type,
                                        file_type_display=file_type_display
                                    )
                                    last_emit_time = now
                                    last_emit_progress = progress
                                if self.debug_mode and downloaded_size % (Config.CHUNK_SIZE * 10) == 0:
                                    print(f"\033[93m[Downloader] 已下载: {downloaded_size/1024:.2f} KB\033[0m")

                    if self.debug_mode:
                        print(f"\033[92m[Downloader] 文件下载完成: {filepath}, 大小: {os.path.getsize(filepath)/1024:.2f} KB\033[0m")
                    
                    upsert_download_history_entries([filepath])
                    print(f"\033[93m下载{file_type_display} ({i+1}/{len(urls)}) 成功：{user_dir}/{filename_with_index}.{extension}\033[0m")
                    
                    # 发送WebSocket进度更新 - 单个文件完成
                    if socketio and task_id:
                        progress = ((i + 1) / len(urls)) * 100
                        elapsed = max(time.monotonic() - file_started_at, 0.001)
                        final_size = os.path.getsize(filepath) if os.path.exists(filepath) else response_size
                        self._emit_download_progress(
                            socketio, task_id, progress_callback,
                            progress=progress,
                            completed=i + 1,
                            total=len(urls),
                            status='downloading',
                            file_index=i + 1,
                            file_total=len(urls),
                            file_progress=100,
                            bytes_downloaded=final_size,
                            bytes_total=response_size or final_size,
                            speed_bps=final_size / elapsed,
                            eta_seconds=0,
                            file_type=file_type,
                            file_type_display=file_type_display
                        )
                        socketio.emit('download_log', {
                            'task_id': task_id,
                            'message': f'✅ 第 {i+1}/{len(urls)} 个文件下载成功 ({filename_with_index}.{extension})',
                            'timestamp': datetime.now().strftime('%H:%M:%S')
                        })
                    elif progress_callback:
                        progress = ((i + 1) / len(urls)) * 100
                        elapsed = max(time.monotonic() - file_started_at, 0.001)
                        final_size = os.path.getsize(filepath) if os.path.exists(filepath) else response_size
                        self._emit_download_progress(
                            socketio, task_id, progress_callback,
                            progress=progress,
                            completed=i + 1,
                            total=len(urls),
                            status='downloading',
                            file_index=i + 1,
                            file_total=len(urls),
                            file_progress=100,
                            bytes_downloaded=final_size,
                            bytes_total=response_size or final_size,
                            speed_bps=final_size / elapsed,
                            eta_seconds=0,
                            file_type=file_type,
                            file_type_display=file_type_display
                        )
                        
                except Exception as e:
                    if self.debug_mode:
                        print(f"\033[91m[Downloader] 下载第 {i+1}/{len(urls)} 个文件失败: {str(e)}\033[0m")
                        print(f"\033[91m[Downloader] 失败URL: {url_info}\033[0m")
                    print(f"\033[91m下载第 {i+1}/{len(urls)} 个文件失败：{str(e)}\033[0m")
                    success = False
                    
                    # 发送WebSocket错误消息
                    if socketio and task_id:
                        from datetime import datetime
                        socketio.emit('download_log', {
                            'task_id': task_id,
                            'message': f'❌ 第 {i+1}/{len(urls)} 个文件下载失败: {str(e)}',
                            'timestamp': datetime.now().strftime('%H:%M:%S')
                        })
                finally:
                    if response is not None:
                        response.close()

            # 只有当提供了aweme_id且所有文件都下载成功时才记录
            if success and aweme_id:
                if self.debug_mode:
                    print(f"\033[93m[Downloader] 所有文件下载成功，记录作品ID: {aweme_id}\033[0m")
                self._save_download_record(user_dir, aweme_id)
            elif not success and self.debug_mode:
                print(f"\033[91m[Downloader] 部分文件下载失败，不记录作品ID\033[0m")
            
            return success
        
        except Exception as e:
            if self.debug_mode:
                print(f"\033[91m[Downloader] 下载媒体组失败: {str(e)}\033[0m")
                print(f"\033[91m[Downloader] 媒体组名称: {name}\033[0m")
                if aweme_id:
                    print(f"\033[91m[Downloader] 作品ID: {aweme_id}\033[0m")
            print(f"\033[91m下载失败：{str(e)}\033[0m")
            return False



    def download_video(self, url: str, name: str, aweme_id: str, cancel_event=None, socketio=None, task_id=None, progress_callback=None, pause_event=None, check_existing: bool = True, fallback_urls: Optional[List[str]] = None) -> bool:
        """下载视频
        Args:
            url: 视频URL
            name: 用户名/文件名
            aweme_id: 作品ID
            cancel_event: 可选的取消事件，用于中断下载
        Returns:
            bool: 下载是否成功
        """
        response = None
        try:
            user_dir, filename = self._split_download_name(name)

            # 检查是否已下载
            if check_existing and self._is_aweme_downloaded(aweme_id, user_dir):
                if self.debug_mode:
                    print(f"\033[93m[Downloader] 作品已在下载记录中: {aweme_id}\033[0m")
                print(f"\033[93m作品已下载，跳过：{user_dir}/{filename}\033[0m")
                return True  # 已下载视为成功

            # 检查取消信号
            if cancel_event and cancel_event.is_set():
                print(f"\033[93m下载被取消（开始下载前）：{user_dir}/{filename}\033[0m")
                return False

            headers = self._get_download_headers()
            candidate_urls = []
            for candidate_url in [url, *(fallback_urls or [])]:
                candidate_url = str(candidate_url or '').strip()
                if candidate_url and candidate_url not in candidate_urls:
                    candidate_urls.append(candidate_url)

            last_error = None
            selected_url = url
            for candidate_url in candidate_urls:
                if response is not None:
                    response.close()
                    response = None
                try:
                    response = _get_session().get(candidate_url, headers=headers, stream=True, timeout=(10, 120))
                    response.raise_for_status()
                    selected_url = candidate_url
                    break
                except Exception as request_error:
                    last_error = request_error
                    if response is not None:
                        response.close()
                        response = None
                    if self.debug_mode:
                        print(f"\033[91m[Downloader] 视频地址不可用，尝试下一个: {request_error}\033[0m")
            if response is None:
                raise last_error or RuntimeError("没有可用的视频下载地址")
            response_size = self._get_response_size(response)
            file_started_at = time.monotonic()

            user_path = os.path.join(self.download_dir, user_dir)
            os.makedirs(user_path, exist_ok=True)
            filepath = self._unique_filepath(user_path, filename, self._extension_for_media('video', selected_url, response))

            if self.debug_mode:
                print(f"\033[93m[Downloader] 开始下载视频: {filepath}\033[0m")

            self._emit_download_progress(
                socketio, task_id, progress_callback,
                progress=0,
                completed=0,
                total=1,
                status='downloading',
                file_index=1,
                file_total=1,
                file_progress=0,
                bytes_downloaded=0,
                bytes_total=response_size,
                speed_bps=0,
                eta_seconds=None,
                file_type='video',
                file_type_display='视频'
            )

            with open(filepath, "wb") as f:
                downloaded_size = 0
                last_emit_time = time.monotonic()
                last_emit_progress = 0
                for chunk in response.iter_content(chunk_size=Config.CHUNK_SIZE):
                    self._wait_if_paused(pause_event, cancel_event)
                    # 检查取消信号
                    if cancel_event and cancel_event.is_set():
                        print(f"\033[93m下载被取消，删除部分文件：{filepath}\033[0m")
                        f.close()
                        # 删除未完成的文件
                        if os.path.exists(filepath):
                            os.remove(filepath)
                            remove_download_history_entries([filepath])
                        return False
                    if chunk:
                        f.write(chunk)
                        downloaded_size += len(chunk)
                        now = time.monotonic()
                        elapsed = max(now - file_started_at, 0.001)
                        progress = (downloaded_size / response_size * 100) if response_size > 0 else 0
                        progress = min(100, max(0, progress))
                        speed_bps = downloaded_size / elapsed
                        eta_seconds = ((response_size - downloaded_size) / speed_bps) if response_size > 0 and speed_bps > 0 else None
                        should_emit = (
                            now - last_emit_time >= 0.5 or
                            abs(progress - last_emit_progress) >= 1 or
                            (response_size > 0 and downloaded_size >= response_size)
                        )
                        if should_emit:
                            self._emit_download_progress(
                                socketio, task_id, progress_callback,
                                progress=progress,
                                completed=0,
                                total=1,
                                status='downloading',
                                file_index=1,
                                file_total=1,
                                file_progress=progress,
                                bytes_downloaded=downloaded_size,
                                bytes_total=response_size,
                                speed_bps=speed_bps,
                                eta_seconds=eta_seconds,
                                file_type='video',
                                file_type_display='视频'
                            )
                            last_emit_time = now
                            last_emit_progress = progress
                        if self.debug_mode and downloaded_size % (Config.CHUNK_SIZE * 10) == 0:
                            print(f"\033[93m[Downloader] 已下载: {downloaded_size/1024:.2f} KB\033[0m")
            
            if self.debug_mode:
                file_size = os.path.getsize(filepath)
                print(f"\033[92m[Downloader] 视频下载完成: {filepath}, 大小: {file_size/1024:.2f} KB\033[0m")
                
            upsert_download_history_entries([filepath])
            print(f"\033[93m下载视频成功：{user_dir}/{os.path.basename(filepath)}\033[0m")
            elapsed = max(time.monotonic() - file_started_at, 0.001)
            final_size = os.path.getsize(filepath) if os.path.exists(filepath) else response_size
            self._emit_download_progress(
                socketio, task_id, progress_callback,
                progress=100,
                completed=1,
                total=1,
                status='completed',
                file_index=1,
                file_total=1,
                file_progress=100,
                bytes_downloaded=final_size,
                bytes_total=response_size or final_size,
                speed_bps=final_size / elapsed,
                eta_seconds=0,
                file_type='video',
                file_type_display='视频'
            )
            
            # 保存下载记录
            self._save_download_record(user_dir, aweme_id)
            return True
            
        except Exception as e:
            if self.debug_mode:
                print(f"\033[91m[Downloader] 下载视频失败: {str(e)}\033[0m")
            print(f"\033[91m下载视频失败：{str(e)}\033[0m")
            return False
        finally:
            if response is not None:
                response.close()

    def download_image(self, url: str, name: str, aweme_id: str, is_live: bool = False, check_existing: bool = True) -> bool:
        """下载图片或Live Photo
        Returns:
            bool: 下载是否成功
        """
        response = None
        try:
            # 分离用户名和文件名
            user_dir, filename = self._split_download_name(name)
            
            # 检查是否已下载
            if check_existing and self._is_aweme_downloaded(aweme_id, user_dir):
                if self.debug_mode:
                    print(f"\033[93m[Downloader] 作品已在下载记录中: {aweme_id}\033[0m")
                print(f"\033[93m作品已下载，跳过：{user_dir}/{filename}\033[0m")
                return True  # 已下载视为成功
                
            headers = self._get_download_headers()
            response = _get_session().get(url, headers=headers, stream=True, timeout=(10, 120))
            response.raise_for_status()
            
            user_path = os.path.join(self.download_dir, user_dir)
            os.makedirs(user_path, exist_ok=True)
            
            file_type_key = 'live_photo' if is_live else 'image'
            extension = self._extension_for_media(file_type_key, url, response)
            filepath = self._unique_filepath(user_path, filename, extension)
            
            if self.debug_mode:
                file_type = "Live Photo" if is_live else "图片"
                print(f"\033[93m[Downloader] 开始下载{file_type}: {filepath}\033[0m")
            
            with open(filepath, "wb") as f:
                total_size = 0
                for chunk in response.iter_content(chunk_size=Config.CHUNK_SIZE):
                    if chunk:
                        f.write(chunk)
                        total_size += len(chunk)
                        if self.debug_mode and total_size % (Config.CHUNK_SIZE * 10) == 0:
                            print(f"\033[93m[Downloader] 已下载: {total_size/1024:.2f} KB\033[0m")
            
            if self.debug_mode:
                file_size = os.path.getsize(filepath)
                file_type = "Live Photo" if is_live else "图片"
                print(f"\033[92m[Downloader] {file_type}下载完成: {filepath}, 大小: {file_size/1024:.2f} KB\033[0m")
                
            file_type = "Live Photo" if is_live else "图片"
            upsert_download_history_entries([filepath])
            print(f"\033[93m下载{file_type}成功：{user_dir}/{os.path.basename(filepath)}\033[0m")
            
            # 保存下载记录
            self._save_download_record(user_dir, aweme_id)
            return True
            
        except Exception as e:
            if self.debug_mode:
                file_type = "Live Photo" if is_live else "图片"
                print(f"\033[91m[Downloader] 下载{file_type}失败: {str(e)}\033[0m")
            print(f"\033[91m下载失败：{str(e)}\033[0m")
            return False
        finally:
            if response is not None:
                response.close()

    def download_video_direct(self, url: str, filename: str) -> bool:
        """直接通过URL下载视频文件"""
        response = None
        try:
            if self.debug_mode:
                print(f"\033[93m[Downloader] 开始直接下载视频: {filename}\033[0m")
                print(f"\033[93m[Downloader] 视频URL: {url}\033[0m")
                
            headers = self._get_download_headers()
            
            if self.debug_mode:
                print(f"\033[93m[Downloader] 开始发送视频下载请求\033[0m")
                
            response = _get_session().get(url, headers=headers, stream=True, timeout=(10, 120))
            response.raise_for_status()
            
            if self.debug_mode:
                print(f"\033[93m[Downloader] 请求状态码: {response.status_code}\033[0m")
                print(f"\033[93m[Downloader] 响应内容类型: {response.headers.get('Content-Type', '未知')}\033[0m")
                if 'Content-Length' in response.headers:
                    print(f"\033[93m[Downloader] 文件大小: {int(response.headers['Content-Length'])/1024/1024:.2f} MB\033[0m")
            
            # 创建下载目录
            download_path = os.path.join(self.download_dir, "direct_downloads")
            os.makedirs(download_path, exist_ok=True)
            filename = self._sanitize_filename(os.path.basename(str(filename)))
            filepath = self._unique_filepath(
                download_path,
                os.path.splitext(filename)[0],
                os.path.splitext(filename)[1].lstrip('.') or self._extension_for_media('video', url, response),
            )
            
            if self.debug_mode:
                print(f"\033[93m[Downloader] 保存文件路径: {filepath}\033[0m")
            
            with open(filepath, "wb") as f:
                total_size = 0
                for chunk in response.iter_content(chunk_size=Config.CHUNK_SIZE):
                    if chunk:
                        f.write(chunk)
                        total_size += len(chunk)
                        if self.debug_mode and total_size % (Config.CHUNK_SIZE * 10) == 0:
                            print(f"\033[93m[Downloader] 已下载: {total_size/1024/1024:.2f} MB\033[0m")
            
            if self.debug_mode:
                file_size = os.path.getsize(filepath)
                print(f"\033[92m[Downloader] 视频下载完成: {filepath}\033[0m")
                print(f"\033[92m[Downloader] 文件大小: {file_size/1024/1024:.2f} MB\033[0m")
                
            print(f"\033[92m直接下载视频成功：{filename}\033[0m")
            return True
            
        except Exception as e:
            if self.debug_mode:
                print(f"\033[91m[Downloader] 直接下载视频失败: {str(e)}\033[0m")
                print(f"\033[91m[Downloader] 视频URL: {url}\033[0m")
            print(f"\033[91m直接下载视频失败：{str(e)}\033[0m")
            return False
        finally:
            if response is not None:
                response.close()

    def download_image_direct(self, url: str, filename: str) -> bool:
        """直接通过URL下载图片文件"""
        response = None
        try:
            if self.debug_mode:
                print(f"\033[93m[Downloader] 开始直接下载图片: {filename}\033[0m")
                print(f"\033[93m[Downloader] 图片URL: {url}\033[0m")
                
            headers = self._get_download_headers()
            
            if self.debug_mode:
                print(f"\033[93m[Downloader] 开始发送图片下载请求\033[0m")
                
            response = _get_session().get(url, headers=headers, stream=True, timeout=(10, 120))
            response.raise_for_status()
            
            if self.debug_mode:
                print(f"\033[93m[Downloader] 请求状态码: {response.status_code}\033[0m")
                print(f"\033[93m[Downloader] 响应内容类型: {response.headers.get('Content-Type', '未知')}\033[0m")
                if 'Content-Length' in response.headers:
                    print(f"\033[93m[Downloader] 文件大小: {int(response.headers['Content-Length'])/1024:.2f} KB\033[0m")
            
            # 创建下载目录
            download_path = os.path.join(self.download_dir, "direct_downloads")
            os.makedirs(download_path, exist_ok=True)
            filename = self._sanitize_filename(os.path.basename(str(filename)))
            filepath = self._unique_filepath(
                download_path,
                os.path.splitext(filename)[0],
                os.path.splitext(filename)[1].lstrip('.') or self._extension_for_media('image', url, response),
            )
            
            if self.debug_mode:
                print(f"\033[93m[Downloader] 保存文件路径: {filepath}\033[0m")
            
            with open(filepath, "wb") as f:
                total_size = 0
                for chunk in response.iter_content(chunk_size=Config.CHUNK_SIZE):
                    if chunk:
                        f.write(chunk)
                        total_size += len(chunk)
                        if self.debug_mode and total_size % (Config.CHUNK_SIZE * 10) == 0:
                            print(f"\033[93m[Downloader] 已下载: {total_size/1024:.2f} KB\033[0m")
            
            if self.debug_mode:
                file_size = os.path.getsize(filepath)
                print(f"\033[92m[Downloader] 图片下载完成: {filepath}\033[0m")
                print(f"\033[92m[Downloader] 文件大小: {file_size/1024:.2f} KB\033[0m")
                
            print(f"\033[93m直接下载图片成功：{filename}\033[0m")
            return True
            
        except Exception as e:
            if self.debug_mode:
                print(f"\033[91m[Downloader] 直接下载图片失败: {str(e)}\033[0m")
                print(f"\033[91m[Downloader] 图片URL: {url}\033[0m")
            print(f"\033[91m直接下载图片失败：{str(e)}\033[0m")
            return False
        finally:
            if response is not None:
                response.close()

    def _sanitize_filename(
        self,
        name: str,
        default: str = '未命名作品',
        max_length: Optional[int] = None,
        protected_suffix: str = '',
    ) -> str:
        """清理文件名"""
        if self.debug_mode:
            print(f"\033[93m[Downloader] 清理文件名: {name}\033[0m")
            
        # 移除非法字符
        sanitized = _sanitize_template_component(name, default)
        result = _truncate_filename_text(
            sanitized,
            default,
            int(max_length or Config.MAX_FILENAME_LENGTH),
            int(getattr(Config, 'MAX_FILENAME_BYTES', 200)),
            protected_suffix=protected_suffix,
        )
        
        if self.debug_mode and result != name:
            print(f"\033[93m[Downloader] 文件名已清理: {result}\033[0m")
            
        return result

    def _sanitize_path_segment(self, name: str, default: str = '未知作者') -> str:
        """清理单级目录名，避免传入路径片段影响下载根目录。"""
        return self._sanitize_filename(os.path.basename(str(name or '')), default=default)
