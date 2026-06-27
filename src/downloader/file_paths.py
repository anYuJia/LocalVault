"""文件路径与扩展名处理逻辑。

从 DouyinDownloader 中拆出的文件名清理、路径唯一化、媒体扩展名推断、
下载名拆分等纯逻辑。FilePaths 持有 DouyinDownloader 实例引用，共享
download_dir、debug_mode 等状态。原方法保留为薄代理，确保外部与子模块
调用兼容。
"""

import os
from urllib.parse import urlparse
from typing import Optional

from src.config.config import Config
from src.downloader.filename_builder import (
    sanitize_template_component as _sanitize_template_component,
    truncate_filename_text as _truncate_filename_text,
)


class FilePaths:
    """文件路径与扩展名处理服务。"""

    def __init__(self, dl):
        self._dl = dl

    @property
    def debug_mode(self) -> bool:
        return self._dl.debug_mode

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

        # 限制最大重试次数，避免在只读目录、权限问题或异常文件系统状态下陷入死循环。
        max_attempts = 1000
        for counter in range(2, 2 + max_attempts):
            candidate = os.path.join(directory, f"{filename}_{counter}.{safe_extension}")
            if not os.path.exists(candidate):
                return candidate

        raise RuntimeError(
            f"无法为文件 {filename}.{safe_extension} 在 {directory} 中找到可用名称"
            f"（已尝试 {max_attempts} 次）"
        )

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
