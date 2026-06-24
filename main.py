#!/usr/bin/env python
# -*- coding: utf-8 -*-

import sys
import os
import multiprocessing

# PyInstaller 打包时需要调用这个方法以防在双击执行时进入多进程递归死循环
multiprocessing.freeze_support()

if __name__ == '__main__':
    # ==========================================
    # 常规主进程启动逻辑 (pywebview 原生窗口)
    # ==========================================
    import socket
    import threading
    import time

    # macOS 上跳过 gevent patch，避免与 Cocoa 运行循环冲突
    os.environ['USE_PYWEBVIEW'] = '1'

    from src.web.web_app import start_server, socketio

    def find_free_port(start=5001, end=5010):
        """查找可用端口"""
        for port in range(start, end + 1):
            try:
                with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                    s.bind(('127.0.0.1', port))
                return port
            except OSError:
                continue
        return start  # fallback

    def wait_for_server(port, timeout=30):
        """等待Flask服务就绪"""
        start_time = time.time()
        while time.time() - start_time < timeout:
            try:
                import urllib.request
                urllib.request.urlopen('http://127.0.0.1:{}/'.format(port), timeout=1)
                return True
            except Exception:
                time.sleep(0.3)
        return False

    def on_closing():
        """窗口关闭回调"""
        try:
            socketio.stop()
        except Exception:
            pass
        os._exit(0)

    class WindowAPI:
        """Expose native pywebview window controls to the React shell."""

        def __init__(self):
            self.window = None
            self._maximized = False

        def bind(self, target_window):
            self.window = target_window

        def minimize(self):
            if self.window:
                self.window.minimize()

        def toggle_maximize(self):
            if not self.window:
                return
            if self._maximized:
                self.window.restore()
            else:
                self.window.maximize()
            self._maximized = not self._maximized

        def close(self):
            if self.window:
                self.window.destroy()

    # 查找可用端口
    port = find_free_port()

    # 在后台线程启动Flask服务
    server_thread = threading.Thread(
        target=start_server, kwargs={'port': port}, daemon=True
    )
    server_thread.start()

    # 等待服务就绪
    if not wait_for_server(port):
        # 服务启动失败，延迟导入 webview 显示错误对话框
        import webview
        err_win = webview.create_window(
            title='启动失败',
            html='<h2>服务启动超时</h2><p>端口 {} 无法连接，请检查是否有其他程序占用。</p>'.format(port),
            width=400, height=200,
        )
        webview.start()
        os._exit(1)

    # 延迟导入 webview，避免启动时加载
    import webview

    def patch_macos_pywebview_titlebar():
        if sys.platform != 'darwin':
            return
        try:
            from pathlib import Path
            from webview.platforms import cocoa

            cocoa_path = Path(cocoa.__file__)
            source = cocoa_path.read_text()
            if "getattr(window, 'macos_overlay_titlebar', False)" in source:
                return

            original = """            self.window.standardWindowButton_(AppKit.NSWindowCloseButton).setHidden_(True)
            self.window.standardWindowButton_(AppKit.NSWindowMiniaturizeButton).setHidden_(True)
            self.window.standardWindowButton_(AppKit.NSWindowZoomButton).setHidden_(True)
"""
            patched = """            if getattr(window, 'macos_overlay_titlebar', False):
                self.window.setMovableByWindowBackground_(True)
                for button_kind in (
                    AppKit.NSWindowCloseButton,
                    AppKit.NSWindowMiniaturizeButton,
                    AppKit.NSWindowZoomButton,
                ):
                    button = self.window.standardWindowButton_(button_kind)
                    if button is None:
                        continue
                    button.setHidden_(False)
                    button.setEnabled_(True)
                    button.setAlphaValue_(1.0)
            else:
                self.window.standardWindowButton_(AppKit.NSWindowCloseButton).setHidden_(True)
                self.window.standardWindowButton_(AppKit.NSWindowMiniaturizeButton).setHidden_(True)
                self.window.standardWindowButton_(AppKit.NSWindowZoomButton).setHidden_(True)
"""
            if original in source:
                cocoa_path.write_text(source.replace(original, patched))
        except Exception:
            pass

    patch_macos_pywebview_titlebar()

    def configure_macos_native_window(target_window):
        if sys.platform != 'darwin':
            return
        try:
            import AppKit

            native_window = getattr(target_window, 'native', None)
            if native_window is None:
                return

            native_window.setTitlebarAppearsTransparent_(True)
            native_window.setTitleVisibility_(AppKit.NSWindowTitleHidden)
            native_window.setMovableByWindowBackground_(True)
            native_window.setStyleMask_(
                native_window.styleMask() | AppKit.NSWindowStyleMaskFullSizeContentView
            )
        except Exception:
            pass

    window_api = WindowAPI()
    window_options = {}
    if sys.platform in ('darwin', 'win32'):
        window_options['frameless'] = True

    # 创建pywebview窗口
    window = webview.create_window(
        title='better-douyin',
        url='http://127.0.0.1:{}'.format(port),
        width=1280,
        height=800,
        resizable=True,
        text_select=True,
        zoomable=True,
        js_api=window_api,
        **window_options,
    )
    window_api.bind(window)
    window.events.closing += on_closing

    if sys.platform == 'darwin':
        window.macos_overlay_titlebar = True
        window.events.shown += lambda: threading.Timer(
            0.1,
            configure_macos_native_window,
            args=(window,),
        ).start()

    # 在主线程启动pywebview（阻塞），debug模式查看控制台错误
    webview.start()
