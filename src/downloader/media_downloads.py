"""图片/视频媒体下载实现。

从 DouyinDownloader 中拆出的媒体下载主流程代理层。
MediaDownloads 持有 DouyinDownloader 实例引用，
转发调用到各子模块：VideoDownloads、ImageDownloads、MediaGroupDownloads。
"""

from typing import List, Optional

from src.downloader.video_downloads import VideoDownloads
from src.downloader.image_downloads import ImageDownloads
from src.downloader.media_group_downloads import MediaGroupDownloads


class MediaDownloads:
    """图片/视频媒体下载实现服务。"""

    def __init__(self, dl):
        self._dl = dl
        self._video = VideoDownloads(dl)
        self._image = ImageDownloads(dl)
        self._media_group = MediaGroupDownloads(dl)

    @property
    def api(self):
        return self._dl.api

    @property
    def download_dir(self) -> str:
        return self._dl.download_dir

    @property
    def socketio(self):
        return self._dl.socketio

    @property
    def debug_mode(self) -> bool:
        return self._dl.debug_mode

    def _split_download_name(self, name: str) -> tuple[str, str]:
        return self._dl._split_download_name(name)

    def _sanitize_filename(self, name: str, default: str = '未命名作品', max_length: Optional[int] = None, protected_suffix: str = '') -> str:
        return self._dl._sanitize_filename(name, default, max_length, protected_suffix)

    def _extension_for_media(self, file_type: str, url: str, response=None) -> str:
        return self._dl._extension_for_media(file_type, url, response)

    def _unique_filepath(self, directory: str, filename: str, extension: str) -> str:
        return self._dl._unique_filepath(directory, filename, extension)

    def _get_download_headers(self):
        return self._dl._get_download_headers()

    def _get_response_size(self, response) -> int:
        return self._dl._get_response_size(response)

    def _emit_download_progress(self, socketio, task_id, progress_callback=None, **payload):
        return self._dl._emit_download_progress(socketio, task_id, progress_callback, **payload)

    def _wait_if_paused(self, pause_event=None, cancel_event=None):
        return self._dl._wait_if_paused(pause_event, cancel_event)

    def _is_aweme_downloaded(self, aweme_id: str, user_dir: str = '') -> bool:
        return self._dl._is_aweme_downloaded(aweme_id, user_dir)

    def _save_download_record(self, user_dir: str, aweme_id: str):
        return self._dl._save_download_record(user_dir, aweme_id)

    def download_media_group(self, urls: List[dict], name: str, aweme_id: str = None, socketio=None, task_id=None, cancel_event=None, progress_callback=None, pause_event=None, check_existing: bool = True) -> bool:
        """下载一组媒体文件（代理到 MediaGroupDownloads）"""
        return self._media_group.download_media_group(urls, name, aweme_id, socketio=socketio, task_id=task_id, cancel_event=cancel_event, progress_callback=progress_callback, pause_event=pause_event, check_existing=check_existing)



    def download_video(self, url: str, name: str, aweme_id: str, cancel_event=None, socketio=None, task_id=None, progress_callback=None, pause_event=None, check_existing: bool = True, fallback_urls: Optional[List[str]] = None) -> bool:
        """下载视频（代理到 VideoDownloads）"""
        return self._video.download_video(url, name, aweme_id, cancel_event=cancel_event, socketio=socketio, task_id=task_id, progress_callback=progress_callback, pause_event=pause_event, check_existing=check_existing, fallback_urls=fallback_urls)

    def download_image(self, url: str, name: str, aweme_id: str, is_live: bool = False, check_existing: bool = True) -> bool:
        """下载图片或Live Photo（代理到 ImageDownloads）"""
        return self._image.download_image(url, name, aweme_id, is_live=is_live, check_existing=check_existing)

    def download_video_direct(self, url: str, filename: str) -> bool:
        """直接通过URL下载视频文件（代理到 VideoDownloads）"""
        return self._video.download_video_direct(url, filename)

    def download_image_direct(self, url: str, filename: str) -> bool:
        """直接通过URL下载图片文件（代理到 ImageDownloads）"""
        return self._image.download_image_direct(url, filename)
