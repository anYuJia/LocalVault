"""视频下载实现。

从 MediaDownloads 中拆出的视频下载逻辑，包括：
- download_video: 标准视频下载，支持 fallback URLs
- download_video_direct: 直接 URL 视频下载
- DASH video-only URL 跳过逻辑
- 视频下载进度事件发送
"""

import os
import time
from typing import List, Optional

from src.config.config import Config
from src.downloader.progress import PROGRESS_EMIT_INTERVAL_SECONDS
from src.utils.download_history_index import (
    remove_download_history_entries,
    upsert_download_history_entries,
)
from src.downloader.downloader import (
    _get_session,
    _is_dash_video_only_url,
)


class VideoDownloads:
    """视频下载实现。"""

    def __init__(self, dl):
        self._dl = dl

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
                if _is_dash_video_only_url(candidate_url):
                    if self.debug_mode:
                        print("\033[93m[Downloader] 跳过无声音轨 DASH 视频分片\033[0m")
                    continue
                if candidate_url and candidate_url not in candidate_urls:
                    candidate_urls.append(candidate_url)
            if not candidate_urls:
                raise RuntimeError("没有可用的带音频视频下载地址")

            last_error = None
            selected_url = candidate_urls[0]
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
                            now - last_emit_time >= PROGRESS_EMIT_INTERVAL_SECONDS or
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
