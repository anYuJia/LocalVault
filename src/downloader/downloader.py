import os
import json
import re
import threading
import asyncio
import atexit
import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry
from typing import List, Optional
from contextlib import asynccontextmanager

from src.config.config import Config
from src.api.api import DouyinAPI
from src.downloader.download_records import DownloadRecords
from src.downloader.file_paths import FilePaths
from src.downloader.progress import Progress
from src.downloader.filename_builder import (
    build_download_name,
    build_download_title,
)
from src.utils.download_history_index import (
    remove_download_history_entries,
    upsert_download_history_entries,
)
from src.utils.ssl_utils import requests_verify_value

# 带重试的 requests session。Session 本身不跨线程共享，避免批量下载并发时互相污染连接状态。
_retry = Retry(total=3, backoff_factor=0.5, status_forcelist=[500, 502, 503, 504])
_thread_local = threading.local()


def _create_session():
    session = requests.Session()
    session.verify = requests_verify_value()
    pool_size = max(10, int(getattr(Config, 'MAX_CONCURRENT', 3) or 3) * 4)
    adapter = HTTPAdapter(max_retries=_retry, pool_connections=pool_size, pool_maxsize=pool_size)
    session.mount('https://', adapter)
    session.mount('http://', adapter)
    return session


def _get_session():
    session = getattr(_thread_local, 'session', None)
    if session is None:
        session = _create_session()
        _thread_local.session = session
    else:
        session.verify = requests_verify_value()
    return session


def _is_dash_video_only_url(url: str) -> bool:
    text = str(url or '').strip().lower()
    return 'media-video' in text or 'media_video' in text


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

        # 下载记录管理（延迟初始化）
        self._records: DownloadRecords | None = None
        # 文件路径/扩展名处理服务（延迟初始化）
        self._file_paths: FilePaths | None = None
        # 下载进度/请求头辅助服务（延迟初始化）
        self._progress: Progress | None = None
        # 媒体下载实现服务（延迟初始化）
        self._media_downloads = None
        # 异步下载会复用同一个 aiohttp session/connector，减少批量下载重复建连。
        self._async_session = None
        self._async_session_key = None
        self._async_session_lock = None
        self._async_session_lock_loop = None
        atexit.register(self.close)

        self._ensure_download_dirs()

    def _async_download_session_key(self) -> tuple[str, bool]:
        return (str(getattr(Config, 'PROXY', '') or '').strip(), bool(getattr(Config, 'SSL_VERIFY', True)))

    def async_download_proxy(self) -> str | None:
        proxy = str(getattr(Config, 'PROXY', '') or '').strip()
        return proxy or None

    async def _close_async_download_session(self):
        session = self._async_session
        self._async_session = None
        self._async_session_key = None
        if session and not session.closed:
            await session.close()

    async def _get_async_download_session(self):
        current_loop = asyncio.get_running_loop()
        if self._async_session_lock is None or self._async_session_lock_loop is not current_loop:
            self._async_session_lock = asyncio.Lock()
            self._async_session_lock_loop = current_loop

        key = self._async_download_session_key()
        session = self._async_session
        session_loop = getattr(session, '_loop', None) if session is not None else None
        if session is not None and not session.closed and self._async_session_key == key and session_loop is current_loop:
            return session

        async with self._async_session_lock:
            key = self._async_download_session_key()
            session = self._async_session
            session_loop = getattr(session, '_loop', None) if session is not None else None
            if session is not None and not session.closed and self._async_session_key == key and session_loop is current_loop:
                return session

            await self._close_async_download_session()
            import aiohttp
            from src.utils.ssl_utils import aiohttp_ssl_context

            connector = aiohttp.TCPConnector(
                ssl=aiohttp_ssl_context(),
                limit=max(10, int(getattr(Config, 'MAX_CONCURRENT', 3) or 3) * 4),
                limit_per_host=max(4, int(getattr(Config, 'MAX_CONCURRENT', 3) or 3) * 2),
                keepalive_timeout=75,
            )
            self._async_session = aiohttp.ClientSession(auto_decompress=False, connector=connector)
            self._async_session_key = key
            return self._async_session

    @asynccontextmanager
    async def download_session(self):
        session = await self._get_async_download_session()
        try:
            yield session
        finally:
            pass

    async def aclose(self):
        await self._close_async_download_session()

    def close(self):
        session = self._async_session
        if not session or session.closed:
            return
        loop = getattr(session, '_loop', None)
        if loop and loop.is_running():
            future = asyncio.run_coroutine_threadsafe(self._close_async_download_session(), loop)
            try:
                future.result(timeout=3)
            except Exception:
                pass
        else:
            try:
                asyncio.run(self._close_async_download_session())
            except RuntimeError:
                pass

    @property
    def records(self) -> DownloadRecords:
        """获取下载记录管理实例（懒加载）。"""
        if self._records is None:
            self._records = DownloadRecords(self)
        return self._records

    @property
    def file_paths(self) -> FilePaths:
        """获取文件路径/扩展名处理服务实例（懒加载）。"""
        if self._file_paths is None:
            self._file_paths = FilePaths(self)
        return self._file_paths

    @property
    def progress(self) -> Progress:
        """获取下载进度/请求头辅助服务实例（懒加载）。"""
        if self._progress is None:
            self._progress = Progress(self)
        return self._progress

    @property
    def media(self):
        """获取媒体下载实现服务实例（懒加载，懒导入避免循环依赖）。"""
        if self._media_downloads is None:
            from src.downloader.media_downloads import MediaDownloads
            self._media_downloads = MediaDownloads(self)
        return self._media_downloads

    # ---------- 下载记录薄代理（委托给 DownloadRecords） ----------

    def _clear_download_record_cache(self):
        self.records.clear_cache()

    def _sync_download_dir(self):
        self.records.sync_download_dir()

    def _extract_downloaded_aweme_id(self, filename: str) -> str:
        return DownloadRecords._extract_downloaded_aweme_id(filename)

    def _is_complete_download_file(self, dirpath: str, filename: str) -> bool:
        return DownloadRecords._is_complete_download_file(dirpath, filename)

    def _ensure_download_dirs(self):
        """确保下载目录存在"""
        download_path = self.download_dir
        if self.debug_mode:
            print(f"\033[93m[Downloader] 确保下载目录存在: {download_path}\033[0m")
        os.makedirs(download_path, exist_ok=True)

    def _get_record_path(self, user_dir: str) -> str:
        return self.records._get_record_path(user_dir)

    def _load_download_record(self, user_dir: str) -> set:
        return self.records._load_download_record(user_dir)

    def _record_roots(self) -> list[str]:
        return self.records._record_roots()

    def _load_all_download_records(self) -> set:
        return self.records._load_all_download_records()

    def _downloaded_file_exists(self, aweme_id: str) -> bool:
        return self.records._downloaded_file_exists(aweme_id)

    def _is_aweme_downloaded(self, aweme_id: str, user_dir: str = '') -> bool:
        return self.records._is_aweme_downloaded(aweme_id, user_dir)

    def _save_download_record(self, user_dir: str, aweme_id: str):
        self.records._save_download_record(user_dir, aweme_id)

    def _get_download_headers(self):
        return self.progress._get_download_headers()

    def _get_response_size(self, response) -> int:
        return self.progress._get_response_size(response)
    def _extension_for_media(self, file_type: str, url: str, response=None) -> str:
        return self.file_paths._extension_for_media(file_type, url, response)

    def _unique_filepath(self, directory: str, filename: str, extension: str) -> str:
        return self.file_paths._unique_filepath(directory, filename, extension)

    def _emit_download_progress(self, socketio, task_id, progress_callback=None, **payload):
        return self.progress._emit_download_progress(socketio, task_id, progress_callback, **payload)

    def _wait_if_paused(self, pause_event=None, cancel_event=None):
        return self.progress._wait_if_paused(pause_event, cancel_event)

    def _split_download_name(self, name: str) -> tuple[str, str]:
        return self.file_paths._split_download_name(name)
        
    def download_media_group(self, urls: List[dict], name: str, aweme_id: str = None, socketio=None, task_id=None, cancel_event=None, progress_callback=None, pause_event=None, check_existing: bool = True) -> bool:
        return self.media.download_media_group(urls, name, aweme_id, socketio=socketio, task_id=task_id, cancel_event=cancel_event, progress_callback=progress_callback, pause_event=pause_event, check_existing=check_existing)

    def download_video(self, url: str, name: str, aweme_id: str, cancel_event=None, socketio=None, task_id=None, progress_callback=None, pause_event=None, check_existing: bool = True, fallback_urls: Optional[List[str]] = None) -> bool:
        return self.media.download_video(url, name, aweme_id, cancel_event=cancel_event, socketio=socketio, task_id=task_id, progress_callback=progress_callback, pause_event=pause_event, check_existing=check_existing, fallback_urls=fallback_urls)

    def download_image(self, url: str, name: str, aweme_id: str, is_live: bool = False, check_existing: bool = True) -> bool:
        return self.media.download_image(url, name, aweme_id, is_live=is_live, check_existing=check_existing)

    def download_video_direct(self, url: str, filename: str) -> bool:
        return self.media.download_video_direct(url, filename)

    def download_image_direct(self, url: str, filename: str) -> bool:
        return self.media.download_image_direct(url, filename)

    def _sanitize_filename(
        self,
        name: str,
        default: str = '未命名作品',
        max_length: Optional[int] = None,
        protected_suffix: str = '',
    ) -> str:
        return self.file_paths._sanitize_filename(name, default, max_length, protected_suffix)

    def _sanitize_path_segment(self, name: str, default: str = '未知作者') -> str:
        return self.file_paths._sanitize_path_segment(name, default)
