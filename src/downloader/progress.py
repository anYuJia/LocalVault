"""下载进度事件与下载请求头辅助逻辑。

从 DouyinDownloader 中拆出的进度回调、暂停/取消等待、响应大小读取、
下载请求头构造等辅助逻辑。Progress 持有 DouyinDownloader 实例引用，
共享 api、socketio、debug_mode 等状态。原方法保留为薄代理，确保外部
与子模块调用兼容。
"""

import time

from src.config.config import Config

PROGRESS_EMIT_INTERVAL_SECONDS = 0.65


def _redact_headers(headers: dict) -> dict:
    redacted = dict(headers)
    for key in list(redacted.keys()):
        if key.lower() in ('cookie', 'authorization'):
            redacted[key] = '<redacted>'
    return redacted


class Progress:
    """下载进度事件与请求头辅助服务。"""

    def __init__(self, dl):
        self._dl = dl

    @property
    def api(self):
        return self._dl.api

    @property
    def debug_mode(self) -> bool:
        return self._dl.debug_mode

    def _get_download_headers(self):
        """获取下载用的请求头"""
        headers = Config.COMMON_HEADERS.copy()
        headers.update({
            'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
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
