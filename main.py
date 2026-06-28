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
        gui_queue = multiprocessing.Queue()
        flask_proc = multiprocessing.Process(
            target=run_flask_process, args=(port, project_root, _flask_exit_event, gui_queue), daemon=True
        )
        flask_proc.start()

        def _watch_flask_exit():
            _flask_exit_event.wait()
            os._exit(0)
        _exit_watcher = threading.Thread(target=_watch_flask_exit, daemon=True)
        _exit_watcher.start()

        def _watch_gui_queue(p, q):
            import time
            import threading
            import requests
            import os
            from src.config.config import Config

            def debug_log(msg):
                try:
                    log_file = os.path.join(Config.USER_DATA_DIR, "debug_ipc.log")
                    with open(log_file, "a", encoding="utf-8") as f:
                        f.write(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] [MAIN] {msg}\n")
                except Exception as ex:
                    print(f"Failed to write debug_log: {ex}", flush=True)

            debug_log("GUI queue watcher thread started.")
            time.sleep(2)

            session_info = {
                'window': None,
                'cancel_event': threading.Event(),
                'finished_event': threading.Event(),
            }

            def status_sync(event, message=None, cookies=None):
                payload = {
                    'event': event,
                }
                if message:
                    payload['message'] = message
                if cookies is not None:
                    payload['cookies'] = cookies
                debug_log(f"Sending status_sync event: {event}, cookies count: {len(cookies) if cookies else 0}")
                try:
                    res = requests.post(f"http://127.0.0.1:{p}/api/cookie/browser_login/status_sync", json=payload, timeout=2)
                    debug_log(f"status_sync response: {res.status_code}, {res.text}")
                except Exception as e:
                    debug_log(f"status_sync failed: {e}")

            while True:
                try:
                    msg = q.get()
                    if not msg:
                        continue
                    action, args = msg
                    debug_log(f"Received msg from queue: action={action}, args={args}")
                    if action == 'start_login':
                        timeout = args.get('timeout', 300)
                        old_cookie = args.get('old_cookie')

                        if session_info['window'] is not None:
                            try:
                                debug_log("Destroying existing login window before creating a new one")
                                session_info['window'].destroy()
                            except Exception as ex:
                                debug_log(f"Failed to destroy existing window: {ex}")

                        session_info['cancel_event'].clear()
                        session_info['finished_event'].clear()

                        from src.api.native_cookie_login import (
                            create_login_window,
                            apply_cookie_to_window,
                            inject_relation_signer_probe,
                            normalize_cookie_entries,
                        )

                        try:
                            debug_log("Creating login window")
                            login_window = create_login_window()
                            session_info['window'] = login_window
                        except Exception as e:
                            debug_log(f"Failed to create login window: {e}")
                            status_sync('error', message=f'创建登录窗口失败: {e}')
                            continue

                        if old_cookie:
                            debug_log("Applying old cookie to window")
                            apply_cookie_to_window(login_window, old_cookie, reload_after_apply=True, force=True, post_load_delay=0.5)

                        def poll(win, cancel_ev, finished_ev, t_out):
                            poll_interval = 0.5
                            relation_signer_interval = 0.75
                            try:
                                debug_log("Starting poll thread")
                                status_sync('pending', message='登录窗口已打开，请在窗口中完成登录')

                                debug_log("Waiting for window events.loaded")
                                if not win.events.loaded.wait(45):
                                    if not cancel_ev.is_set():
                                        try: win.destroy()
                                        except Exception: pass
                                        debug_log("Window loaded event timed out (45s)")
                                        status_sync('error', message='登录窗口加载超时，请重试')
                                    finished_ev.set()
                                    return

                                debug_log("Window loaded. Starting cookie polling loop")
                                start_time = time.monotonic()
                                last_probe_time = 0
                                while True:
                                    if cancel_ev.is_set():
                                        try: win.destroy()
                                        except Exception: pass
                                        debug_log("Login cancelled by event")
                                        finished_ev.set()
                                        return

                                    if win.events.closed.is_set():
                                        debug_log("Window closed by user")
                                        status_sync('window_closed')
                                        finished_ev.set()
                                        return

                                    if time.monotonic() - start_time >= t_out:
                                        try: win.destroy()
                                        except Exception: pass
                                        debug_log("Login session timed out")
                                        status_sync('timeout')
                                        finished_ev.set()
                                        return

                                    now = time.monotonic()
                                    if now - last_probe_time >= relation_signer_interval:
                                        inject_relation_signer_probe(win)
                                        last_probe_time = now

                                    cookie_result = [None]
                                    cookie_error = [None]
                                    def _fetch_cookies():
                                        try:
                                            cookie_result[0] = win.get_cookies() or []
                                        except Exception as e:
                                            cookie_error[0] = e
                                    t = threading.Thread(target=_fetch_cookies, daemon=True)
                                    t.start()
                                    t.join(timeout=2.0)
                                    if t.is_alive():
                                        debug_log("win.get_cookies() timed out (hung)")
                                        time.sleep(poll_interval)
                                        continue
                                    if cookie_error[0]:
                                        debug_log(f"win.get_cookies() error: {cookie_error[0]}")
                                        time.sleep(poll_interval)
                                        continue
                                    raw_cookies = cookie_result[0]
                                    normalized = normalize_cookie_entries(raw_cookies)

                                    # Only log cookies when normalized contains entries to prevent spam
                                    if normalized:
                                        debug_log(f"Polled raw cookies: {len(raw_cookies)}, normalized entries: {len(normalized)}")
                                        
                                    status_sync('cookies_polled', cookies=normalized)
                                    time.sleep(poll_interval)

                            except Exception as ex:
                                debug_log(f"Exception in poll thread: {ex}")
                                status_sync('error', message=f'登录异常: {ex}')
                                finished_ev.set()

                        threading.Thread(
                            target=poll,
                            args=(login_window, session_info['cancel_event'], session_info['finished_event'], timeout),
                            daemon=True
                        ).start()

                    elif action == 'cancel_login' or action == 'close_window':
                        debug_log(f"Handling cancel/close action: {action}")
                        session_info['cancel_event'].set()
                        if session_info['window'] is not None:
                            try:
                                session_info['window'].destroy()
                                debug_log("Window destroyed successfully")
                            except Exception as ex:
                                debug_log(f"Failed to destroy window during cancel: {ex}")
                            session_info['window'] = None

                except Exception:
                    time.sleep(0.5)

        _gui_watcher = threading.Thread(target=_watch_gui_queue, args=(port, gui_queue), daemon=True)
        _gui_watcher.start()
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
