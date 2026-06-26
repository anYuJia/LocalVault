#!/usr/bin/env python
# -*- coding: utf-8 -*-

import sys
import os

if sys.platform == 'win32':
    import multiprocessing
    multiprocessing.freeze_support()
    import asyncio
    try:
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    except Exception:
        pass

if __name__ == '__main__':
    # ==========================================
    # 常规主进程启动逻辑 (pywebview 原生窗口)
    # ==========================================
    import socket
    import threading
    import time
    import webbrowser

    # macOS 上跳过 gevent patch，避免与 Cocoa 运行循环冲突
    os.environ['USE_PYWEBVIEW'] = '1'

    IS_MACOS = sys.platform == 'darwin'
    IS_WINDOWS = sys.platform == 'win32'

    if IS_WINDOWS:
        from flask_server import run_flask_process

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
        """窗口关闭回调 — 立即退出（对 Alt+F4 / 任务栏关闭等系统路径生效）"""
        if IS_WINDOWS:
            # closing 事件在 UI 线程同步执行（_should_lock=True），
            # 直接 Hide() + os._exit(0) 即可瞬间退出，无任何清理延迟。
            try:
                import webview.platforms.winforms as _wf
                i = next(iter(_wf.BrowserView.instances.values()), None)
                if i is not None:
                    try:
                        i.Hide()
                    except Exception:
                        pass
            except Exception:
                pass
        os._exit(0)

    class WindowAPI:
        """Expose native pywebview window controls to the React shell."""

        _maximized = False

        def _get_window(self):
            """动态获取 window，不存储引用（避免 pywebview WinForms 无限递归）"""
            try:
                import webview as _wv
                return _wv.windows[0] if _wv.windows else None
            except Exception:
                return None

        def minimize(self):
            w = self._get_window()
            if w:
                w.minimize()

        def toggle_maximize(self):
            w = self._get_window()
            if not w:
                return
            if WindowAPI._maximized:
                w.restore()
            else:
                w.maximize()
            WindowAPI._maximized = not WindowAPI._maximized

        def close(self):
            # Windows: 通过 WinForms Invoke 在 UI 主线程上执行，
            # 先 Hide() 让窗口立刻从屏幕消失（用户感知瞬间关闭），
            # 再 os._exit(0) 强制退出进程，避免任何清理延迟。
            if IS_WINDOWS:
                try:
                    import clr  # noqa: F401
                    from System import Action
                    from System.Windows.Forms import Application
                    import webview.platforms.winforms as _wf
                    i = next(iter(_wf.BrowserView.instances.values()), None)
                    if i is not None:
                        def _do_close():
                            try:
                                i.Hide()
                            except Exception:
                                pass
                            os._exit(0)
                        i.Invoke(Action(_do_close))
                        return
                except Exception:
                    pass
            os._exit(0)

        def open_external_url(self, url):
            target = str(url or '').strip()
            if target.startswith(('http://', 'https://')):
                webbrowser.open(target)

    # 查找可用端口
    port = find_free_port()

    # 启动 Flask 服务
    if IS_WINDOWS:
        import multiprocessing
        project_root = os.path.dirname(os.path.abspath(__file__))
        _flask_exit_event = multiprocessing.Event()
        flask_proc = multiprocessing.Process(
            target=run_flask_process, args=(port, project_root, _flask_exit_event), daemon=True
        )
        flask_proc.start()

        def _watch_flask_exit():
            _flask_exit_event.wait()
            os._exit(0)
        _exit_watcher = threading.Thread(target=_watch_flask_exit, daemon=True)
        _exit_watcher.start()
    else:
        # Mac/Linux: 线程（不引入 multiprocessing，避免创建子进程在 Dock 显示多余图标）
        from src.web.web_app import start_server as _flask_start_server
        flask_thread = threading.Thread(
            target=_flask_start_server, kwargs={'port': port}, daemon=True
        )
        flask_thread.start()

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

    def configure_macos_native_window(target_window):
        """Mac: 隐藏标题栏文字，保留左上角三个系统按键（关闭/最小化/缩放）"""
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
            native_window.setOpaque_(False)
            native_window.setBackgroundColor_(AppKit.NSColor.clearColor())
            native_window.setStyleMask_(
                native_window.styleMask() | AppKit.NSWindowStyleMaskFullSizeContentView
            )
            if hasattr(native_window, 'setToolbarStyle_') and hasattr(AppKit, 'NSWindowToolbarStyleUnifiedCompact'):
                native_window.setToolbarStyle_(AppKit.NSWindowToolbarStyleUnifiedCompact)
            if hasattr(native_window, 'setTitlebarSeparatorStyle_') and hasattr(AppKit, 'NSTitlebarSeparatorStyleNone'):
                native_window.setTitlebarSeparatorStyle_(AppKit.NSTitlebarSeparatorStyleNone)
            def clear_view_background(view, force=False):
                if view is None:
                    return
                class_name = ''
                try:
                    class_name = str(view.className())
                except Exception:
                    pass
                should_clear = force or any(
                    token in class_name
                    for token in ('Titlebar', 'Toolbar', 'ThemeFrame', 'FrameView', 'Container')
                )
                try:
                    if should_clear:
                        view.setWantsLayer_(True)
                        layer = view.layer()
                        if layer is not None:
                            layer.setBackgroundColor_(None)
                            layer.setOpaque_(False)
                            layer.setMasksToBounds_(False)
                except Exception:
                    pass
                try:
                    if should_clear and hasattr(view, 'setDrawsBackground_'):
                        view.setDrawsBackground_(False)
                except Exception:
                    pass
                try:
                    for child in view.subviews():
                        clear_view_background(child)
                except Exception:
                    pass

            content_view = native_window.contentView()
            frame_host = content_view.superview() if content_view is not None else None
            if frame_host is not None:
                window_frame = native_window.frame()
                full_bounds = AppKit.NSMakeRect(0, 0, window_frame.size.width, window_frame.size.height)
                frame_host.setFrame_(full_bounds)
                frame_host.setAutoresizingMask_(
                    AppKit.NSViewWidthSizable | AppKit.NSViewHeightSizable
                )
                clear_view_background(frame_host, force=True)

                if content_view is not None:
                    content_view.setFrame_(frame_host.bounds())
                    content_view.setAutoresizingMask_(
                        AppKit.NSViewWidthSizable | AppKit.NSViewHeightSizable
                    )
                    clear_view_background(content_view)
            for button_kind in (
                AppKit.NSWindowCloseButton,
                AppKit.NSWindowMiniaturizeButton,
                AppKit.NSWindowZoomButton,
            ):
                button = native_window.standardWindowButton_(button_kind)
                if button is not None:
                    button.setHidden_(False)
                    button.setEnabled_(True)
                    button.setAlphaValue_(1.0)
        except Exception:
            pass

    def patch_macos_pywebview_overlay():
        """Apply the overlay titlebar after pywebview mounts WKWebView as contentView."""
        if not IS_MACOS:
            return
        try:
            import webview.platforms.cocoa as cocoa
            original = cocoa.BrowserView.BrowserDelegate.webView_didFinishNavigation_
            if getattr(original, '_better_douyin_patched', False):
                return

            def patched(self, webview, nav):
                result = original(self, webview, nav)
                try:
                    configure_macos_native_window(webview.pywebview_window)
                except Exception:
                    pass
                return result

            patched._better_douyin_patched = True
            cocoa.BrowserView.BrowserDelegate.webView_didFinishNavigation_ = patched
        except Exception:
            pass

    window_api = WindowAPI()
    window_options = {}
    if IS_WINDOWS:
        window_options['frameless'] = True
    # Mac 使用系统标题栏按钮；通过 Cocoa overlay patch 让内容延伸到标题栏下方。
    patch_macos_pywebview_overlay()

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
        easy_drag=False,
        **window_options,
    )
    window.events.closing += on_closing

    if IS_MACOS:
        def configure_macos_window_after_show():
            for delay in (0.1, 0.5, 1.2):
                threading.Timer(delay, configure_macos_native_window, args=(window,)).start()

        window.events.shown += configure_macos_window_after_show

    # 在主线程启动pywebview（阻塞），debug模式查看控制台错误
    webview.start()
