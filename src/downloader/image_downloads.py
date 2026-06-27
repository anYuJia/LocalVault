"""图片下载实现。

从 MediaDownloads 中拆出的图片下载逻辑，包括：
- download_image: 标准图片/Live Photo 下载
- download_image_direct: 直接 URL 图片下载
"""

import os
from typing import Optional

from src.config.config import Config
from src.utils.download_history_index import upsert_download_history_entries
from src.downloader.downloader import _get_session


class ImageDownloads:
    """图片下载实现。"""

    def __init__(self, dl):
        self._dl = dl

    @property
    def download_dir(self) -> str:
        return self._dl.download_dir

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

    def _is_aweme_downloaded(self, aweme_id: str, user_dir: str = '') -> bool:
        return self._dl._is_aweme_downloaded(aweme_id, user_dir)

    def _save_download_record(self, user_dir: str, aweme_id: str):
        return self._dl._save_download_record(user_dir, aweme_id)

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
