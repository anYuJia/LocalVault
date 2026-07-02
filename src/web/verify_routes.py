"""主页、验证页面与 Cookie 校验路由。

从 web_app.py 抽离。模块内部依赖通过 setup_verify_routes 注入。
"""
from __future__ import annotations

import threading
import time
import webbrowser
from typing import Callable

from flask import Blueprint, Response, jsonify, send_file

from src.api.native_cookie_login import (
    NativeCookieLoginSession,
    apply_cookie_to_window,
    create_native_douyin_window,
    has_login_cookie,
    is_native_cookie_login_available,
    normalize_cookie_entries,
    serialize_cookie_entries,
)

verify_routes_bp = Blueprint("verify_routes", __name__)

VERIFY_COOKIE_SYNC_TIMEOUT = 10 * 60

_native_verify_window = None
_native_verify_window_session = None
_gui_queue = None

# 注入的依赖
_logger = None
_Config = None
_request_json: Callable[[], dict] | None = None
_get_react_dist_dir: Callable[[], object] | None = None
_verify_native_cookie_login: Callable[..., dict] | None = None
_core_login_cookie_signature: Callable[[str], object] | None = None
_save_cookie_login_success: Callable[[str], None] | None = None


def setup_verify_routes(
    *,
    logger,
    Config,
    request_json: Callable[[], dict],
    get_react_dist_dir: Callable[[], object],
    verify_native_cookie_login: Callable[..., dict],
    core_login_cookie_signature: Callable[[str], object],
    save_cookie_login_success: Callable[[str], None],
) -> None:
    """注入 web_app 模块的全局对象，避免循环导入。"""
    global _logger, _Config, _request_json, _get_react_dist_dir
    global _verify_native_cookie_login, _core_login_cookie_signature
    global _save_cookie_login_success
    _logger = logger
    _Config = Config
    _request_json = request_json
    _get_react_dist_dir = get_react_dist_dir
    _verify_native_cookie_login = verify_native_cookie_login
    _core_login_cookie_signature = core_login_cookie_signature
    _save_cookie_login_success = save_cookie_login_success


def set_gui_queue(queue) -> None:
    """注入 Windows 主进程 GUI 队列，用于在 UI 线程创建验证窗口。"""
    global _gui_queue
    _gui_queue = queue


def _save_verify_cookie_entries(raw_cookies) -> bool:
    entries = normalize_cookie_entries(raw_cookies or [])
    if not has_login_cookie(entries):
        return False

    cookie_string = serialize_cookie_entries(entries)
    if not cookie_string:
        return False

    core_signature = _core_login_cookie_signature(cookie_string)
    current_config_signature = _core_login_cookie_signature(_Config.COOKIE or '')
    if not core_signature or core_signature == current_config_signature:
        return False

    _save_cookie_login_success(cookie_string)
    _logger.info('验证窗口 Cookie 已同步到后端')
    return True


def _start_native_verify_cookie_sync(window):
    """持续读取验证窗口 Cookie，滑块验证写入新 Cookie 后同步到后端请求层。"""
    global _native_verify_window_session

    if not window:
        return

    active_session = _native_verify_window_session
    if active_session and active_session.is_active() and active_session.window is window:
        return
    if active_session and active_session.is_active():
        active_session.close()

    session = NativeCookieLoginSession(window=window)
    session.last_cookie_value = _Config.COOKIE or ''
    session.last_core_cookie_signature = _core_login_cookie_signature(_Config.COOKIE or '')
    _native_verify_window_session = session

    def finish() -> None:
        global _native_verify_window_session
        session.finished_event.set()
        if _native_verify_window_session is session:
            _native_verify_window_session = None

    def poll_verify_window_cookies() -> None:
        try:
            if not session.window.events.loaded.wait(45):
                _logger.debug('验证窗口加载超时，停止 Cookie 同步')
                return

            while True:
                if session.cancel_event.is_set() or session.window.events.closed.is_set():
                    return
                if time.monotonic() - session.created_at >= VERIFY_COOKIE_SYNC_TIMEOUT:
                    _logger.debug('验证窗口 Cookie 同步超时，停止监听')
                    return

                try:
                    raw_cookies = session.window.get_cookies() or []
                except Exception as error:
                    _logger.debug('读取验证窗口 Cookie 失败: %s', error)
                    time.sleep(1)
                    continue

                entries = normalize_cookie_entries(raw_cookies)
                if not has_login_cookie(entries):
                    time.sleep(1)
                    continue

                cookie_string = serialize_cookie_entries(entries)
                if not cookie_string:
                    time.sleep(1)
                    continue

                core_signature = _core_login_cookie_signature(cookie_string)
                current_config_signature = _core_login_cookie_signature(_Config.COOKIE or '')
                if not core_signature:
                    time.sleep(1)
                    continue

                if (
                    core_signature == getattr(session, 'last_core_cookie_signature', ())
                    or core_signature == current_config_signature
                ):
                    time.sleep(1)
                    continue

                session.last_cookie_value = cookie_string
                session.last_core_cookie_signature = core_signature
                _save_cookie_login_success(cookie_string)
                _logger.info('验证窗口 Cookie 已同步到后端')
                time.sleep(2)
        finally:
            finish()

    threading.Thread(target=poll_verify_window_cookies, daemon=True).start()


def _schedule_verify_navigation(window, target_url: str, delay: float = 2.2) -> None:
    def navigate() -> None:
        try:
            if window and not window.events.closed.is_set():
                window.load_url(target_url)
        except Exception as error:
            _logger.debug('验证窗口跳转目标页面失败: %s', error)

    threading.Timer(delay, navigate).start()


def _set_current_account_valid(is_valid: bool) -> None:
    current_sec_uid = str(getattr(_Config, 'CURRENT_SEC_UID', '') or '').strip()
    if not current_sec_uid:
        return

    accounts = []
    changed = False
    for account in list(getattr(_Config, 'ACCOUNTS', []) or []):
        if account.get('sec_uid') == current_sec_uid and account.get('is_valid', True) != is_valid:
            account = {**account, 'is_valid': is_valid}
            changed = True
        accounts.append(account)

    if not changed:
        return

    _Config.ACCOUNTS = accounts
    _Config.save_config(
        _Config.COOKIE,
        _Config.BASE_DIR,
        _Config.HISTORY_DIRS,
        download_quality=_Config.DOWNLOAD_QUALITY,
        max_concurrent=_Config.MAX_CONCURRENT,
        filename_template=_Config.FILENAME_TEMPLATE,
        folder_name_template=_Config.FOLDER_NAME_TEMPLATE,
        auto_create_folder=_Config.AUTO_CREATE_FOLDER,
        relation_signer=_Config.RELATION_SIGNER,
        current_user_profile=_Config.CURRENT_USER_PROFILE,
        accounts=_Config.ACCOUNTS,
        current_sec_uid=_Config.CURRENT_SEC_UID,
        im_friend_sec_user_ids=_Config.IM_FRIEND_SEC_USER_IDS,
        im_friend_include_all_users=_Config.IM_FRIEND_INCLUDE_ALL_USERS,
        im_friend_refresh_interval_seconds=_Config.IM_FRIEND_REFRESH_INTERVAL_SECONDS,
    )


@verify_routes_bp.route('/')
def index():
    """主页"""
    react_index = _get_react_dist_dir() / 'index.html'
    if react_index.exists():
        return send_file(react_index)
    _logger.error("React frontend build not found at %s", react_index)
    return Response(
        """
        <!doctype html>
        <html lang="zh-CN">
          <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <title>better-douyin</title>
            <style>
              body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0b0b11; color: #f5f5f7; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
              main { width: min(680px, calc(100vw - 40px)); border: 1px solid rgba(255,255,255,.12); border-radius: 18px; padding: 24px; background: rgba(255,255,255,.05); box-shadow: 0 20px 60px rgba(0,0,0,.35); }
              h1 { margin: 0 0 12px; font-size: 20px; }
              p { margin: 0 0 14px; color: #b8b8c5; line-height: 1.7; }
              code { display: inline-block; padding: 3px 7px; border-radius: 8px; background: rgba(255,255,255,.08); color: #fff; }
            </style>
          </head>
          <body>
            <main>
              <h1>React 前端尚未构建</h1>
              <p>Python 版现在只使用 React 前端。请先在项目根目录执行：</p>
              <p><code>cd frontend &amp;&amp; npm install &amp;&amp; npm run build</code></p>
              <p>构建完成后重新启动应用。</p>
            </main>
          </body>
        </html>
        """,
        status=503,
        mimetype='text/html',
    )


@verify_routes_bp.route('/api/verify_page')
def verify_page():
    """返回一个验证页面，用iframe嵌入抖音来完成滑块验证"""
    return '''<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>抖音验证</title>
<style>
body{margin:0;background:#0a0a0f;color:#fff;font-family:'Outfit',sans-serif;display:flex;flex-direction:column;height:100vh}
.header{padding:16px 24px;background:rgba(255,255,255,0.03);border-bottom:1px solid rgba(255,255,255,0.06);display:flex;align-items:center;justify-content:space-between}
.header h3{margin:0;font-size:1.1rem}
.header .hint{color:#8b8b9e;font-size:0.82rem}
iframe{flex:1;border:none;width:100%}
.btn-done{background:#FE2C55;color:#fff;border:none;padding:10px 28px;border-radius:10px;font-size:0.9rem;cursor:pointer;font-weight:500}
.btn-done:hover{background:#ff4d73}
</style></head><body>
<div class="header">
    <div>
        <h3>请完成滑块验证</h3>
        <div class="hint">在下方页面完成验证后点击"验证完成"</div>
    </div>
    <button class="btn-done" onclick="window.close()">验证完成</button>
</div>
<iframe src="https://www.douyin.com/"></iframe>
</body></html>'''


@verify_routes_bp.route('/api/open_verify_browser', methods=['POST'])
def open_verify_browser():
    """打开抖音验证页面，只使用应用内 pywebview 窗口并注入当前 Cookie。"""
    global _native_verify_window

    try:
        data = _request_json()
        target_url = (data.get('target_url') or '').strip() or 'https://www.douyin.com/'
        initial_url = 'https://www.douyin.com/' if 'douyin.com/jingxuan/search/' in target_url else target_url

        if _gui_queue is not None:
            _gui_queue.put((
                'open_verify',
                {
                    'target_url': target_url,
                    'initial_url': initial_url,
                    'cookie': _Config.COOKIE or '',
                },
            ))
            return jsonify({'success': True, 'message': '已打开验证窗口，请完成验证', 'open_url': target_url})

        if not is_native_cookie_login_available():
            webbrowser.open(target_url)
            return jsonify({
                'success': True,
                'message': '已在系统浏览器中打开验证页面，请完成验证',
                'open_url': target_url,
            })

        if _native_verify_window and not _native_verify_window.events.closed.is_set():
            try:
                _native_verify_window.load_url(initial_url)
                if _Config.COOKIE:
                    apply_cookie_to_window(
                        _native_verify_window,
                        _Config.COOKIE,
                        reload_after_apply=True,
                        force=True,
                        post_load_delay=1.2,
                    )
                if initial_url != target_url:
                    _schedule_verify_navigation(_native_verify_window, target_url)
                _start_native_verify_cookie_sync(_native_verify_window)
                _native_verify_window.show()
                return jsonify({'success': True, 'message': '验证窗口已打开，请完成验证', 'open_url': target_url})
            except Exception:
                _native_verify_window = None

        verify_window = create_native_douyin_window('抖音验证', initial_url, width=1100, height=750)
        _native_verify_window = verify_window
        if _Config.COOKIE:
            apply_cookie_to_window(
                verify_window,
                _Config.COOKIE,
                reload_after_apply=True,
                force=True,
                post_load_delay=1.2,
            )
        if initial_url != target_url:
            _schedule_verify_navigation(verify_window, target_url)
        _start_native_verify_cookie_sync(verify_window)
        return jsonify({'success': True, 'message': '已打开验证窗口，请完成验证', 'open_url': target_url})

    except Exception as e:
        _logger.error(f"打开验证窗口失败：{str(e)}")
        return jsonify({'success': False, 'message': f'无法打开验证窗口：{str(e)}'}), 500


@verify_routes_bp.route('/api/verify_browser/status_sync', methods=['POST'])
def verify_browser_status_sync():
    """接收 Windows 主进程验证窗口的状态和 Cookie 同步。"""
    try:
        data = _request_json()
        event = data.get('event')
        if event == 'cookies_polled':
            _save_verify_cookie_entries(data.get('cookies') or [])
        elif event == 'error':
            _logger.warning('验证窗口异常: %s', data.get('message') or 'unknown')
        return jsonify({'success': True})
    except Exception as error:
        _logger.warning('同步验证窗口状态失败: %s', error)
        return jsonify({'success': False, 'message': str(error)}), 500


@verify_routes_bp.route('/api/verify_cookie', methods=['GET'])
def verify_cookie():
    """校验当前保存的 Cookie 是否可用。"""
    cookie = (_Config.COOKIE or '').strip()
    if not cookie:
        return jsonify({
            'valid': False,
            'user_name': None,
            'user_id': None,
            'sec_uid': None,
            'expires_at': None,
            'message': '未配置 Cookie',
        })

    result = _verify_native_cookie_login(cookie)
    if result.get('success'):
        _set_current_account_valid(True)
        return jsonify({
            'valid': True,
            'user_name': result.get('nickname') or None,
            'user_id': result.get('user_id') or result.get('sec_uid') or None,
            'sec_uid': result.get('sec_uid') or None,
            'avatar_thumb': result.get('avatar_thumb') or None,
            'avatar_medium': result.get('avatar_medium') or None,
            'avatar_larger': result.get('avatar_larger') or None,
            'expires_at': None,
            'message': 'Cookie 可用',
        })

    _set_current_account_valid(False)
    return jsonify({
        'valid': False,
        'user_name': None,
        'user_id': None,
        'sec_uid': None,
        'expires_at': None,
        'need_login': bool(result.get('need_login')),
        'need_verify': bool(result.get('need_verify')),
        'message': result.get('message') or 'Cookie 不可用',
    })
