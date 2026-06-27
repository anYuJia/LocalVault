"""图片/视频媒体下载实现。

从 DouyinDownloader 中拆出的媒体下载主流程：媒体组下载、
图片/Live Photo 下载，以及直接 URL 下载。MediaDownloads 持有
DouyinDownloader 实例引用，共享 download_dir、debug_mode、file_paths、
progress、records 等状态。原方法保留为薄代理，确保外部调用兼容。

视频下载已拆分到 video_downloads.py。
"""

import os
import time
from datetime import datetime
from typing import List, Optional

from src.config.config import Config
from src.utils.download_history_index import (
    remove_download_history_entries,
    upsert_download_history_entries,
)
from src.downloader.downloader import (
    _get_session,
    _is_dash_video_only_url,
)
from src.downloader.video_downloads import VideoDownloads
from src.downloader.image_downloads import ImageDownloads


class MediaDownloads:
    """图片/视频媒体下载实现服务。"""

    def __init__(self, dl):
        self._dl = dl
        self._video = VideoDownloads(dl)
        self._image = ImageDownloads(dl)

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
                    if file_type == 'video' and _is_dash_video_only_url(url):
                        raise ValueError("该视频地址是无声音轨的视频分片，已跳过以避免保存无声文件")

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
