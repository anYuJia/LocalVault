"""Cookie 浏览器登录相关路由与辅助函数。

从 web_app.py 抽离，避免主文件过长。模块内部依赖通过 setup 注入，
外部调用方（web_app.py）需要在导入本模块后调用 setup_cookie_login(...)。
"""
from __future__ import annotations

import hashlib
import threading
import time
from http.cookies import SimpleCookie
from typing import Any, Callable
from urllib.parse import urlparse

from flask import Blueprint, jsonify, request

cookie_login_bp = Blueprint("cookie_login", __name__)

# 注入的依赖，setup_cookie_login 时填充
_socketio = None
_logger = None
_Config = None
_DouyinAPI = None
_run_async: Callable[[Any], Any] | None = None
_init_app: Callable[[], None] | None = None
_stop_im_message_listener: Callable[[], None] | None = None
_ensure_im_message_listener: Callable[[], None] | None = None
_api_message: Callable[..., str] | None = None
_avatar_url: Callable[..., str] | None = None
_request_json: Callable[[], dict] | None = None
_coerce_int: Callable[..., int] | None = None

_gui_queue = None

_NON_AVATAR_URL_MARKERS = (
    'emblem',
    'logo',
    'badge',
    'icon',
    'sprite',
    'placeholder',
    'default-avatar',
    'default_avatar',
)
_AVATAR_URL_MARKERS = (
    'avatar',
    'aweme-avatar',
    'user-avatar',
    'avatar_',
    'avatar-',
    '300x300',
    '168x168',
    '100x100',
)

def set_gui_queue(queue):
    global _gui_queue
    _gui_queue = queue


def sanitize_avatar_url(value: Any) -> str:
    """Keep likely user avatar URLs and drop page emblems/icons accidentally scraped from DOM."""
    url = str(value or '').strip()
    if not url:
        return ''
    try:
        parsed = urlparse(url)
    except Exception:
        return ''
    if parsed.scheme not in ('http', 'https') or not parsed.netloc:
        return ''

    lowered = url.lower()
    if any(marker in lowered for marker in _NON_AVATAR_URL_MARKERS):
        return ''
    if any(marker in lowered for marker in _AVATAR_URL_MARKERS):
        return url

    # Some Douyin avatar CDN paths are opaque. Allow image-looking ByteDance CDN URLs only
    # when they have no obvious non-avatar markers.
    host = parsed.netloc.lower()
    if (
        any(token in host for token in ('douyinpic.com', 'byteimg.com', 'bytedance.com'))
        and any(parsed.path.lower().endswith(ext) for ext in ('.jpg', '.jpeg', '.png', '.webp'))
    ):
        return url
    return ''


def setup_cookie_login(
    *,
    socketio,
    logger,
    Config,
    DouyinAPI,
    run_async: Callable[[Any], Any],
    init_app: Callable[[], None],
    stop_im_message_listener: Callable[[], None],
    ensure_im_message_listener: Callable[[], None],
    api_message: Callable[..., str],
    avatar_url: Callable[..., str],
    request_json: Callable[[], dict],
    coerce_int: Callable[..., int],
) -> None:
    """注入 web_app 模块的全局对象，避免循环导入。"""
    global _socketio, _logger, _Config, _DouyinAPI, _run_async
    global _init_app, _stop_im_message_listener, _ensure_im_message_listener
    global _api_message, _avatar_url, _request_json, _coerce_int
    _socketio = socketio
    _logger = logger
    _Config = Config
    _DouyinAPI = DouyinAPI
    _run_async = run_async
    _init_app = init_app
    _stop_im_message_listener = stop_im_message_listener
    _ensure_im_message_listener = ensure_im_message_listener
    _api_message = api_message
    _avatar_url = avatar_url
    _request_json = request_json
    _coerce_int = coerce_int


_native_cookie_login_session = None  # 当前正在运行的原生登录窗口会话
CORE_LOGIN_COOKIE_NAMES = {'sessionid', 'sessionid_ss', 'sid_guard', 'uid_tt'}


def _core_login_cookie_signature(cookie: str) -> tuple[tuple[str, str], ...]:
    parsed = SimpleCookie()
    try:
        parsed.load(str(cookie or ''))
    except Exception:
        return ()
    return tuple(
        (name, parsed[name].value)
        for name in sorted(CORE_LOGIN_COOKIE_NAMES)
        if name in parsed and parsed[name].value
    )


def _emit_cookie_login_status(event: str, message: str, cookie_set: bool = False) -> None:
    _socketio.emit('cookie_login_status', {
        'event': event,
        'message': message,
        'cookie_set': cookie_set,
    })


_cookie_verify_cache: dict[str, tuple[dict, float]] = {}


def _queue_session_ready_sync(verify_result: dict, login_method: str, extra: dict | None = None) -> None:
    try:
        from src.config.config import Config

        nickname = str(verify_result.get('nickname') or '').strip()
        uid = str(verify_result.get('user_id') or '').strip()
        sec_uid = str(verify_result.get('sec_uid') or '').strip()
        payload = {
            "login_method": login_method,
            "nickname": nickname,
            "uid": uid,
            "user_id": uid,
            "sec_uid": sec_uid,
        }
        if extra:
            payload.update(extra)
        Config._queue_config_sync(
            "session_ready",
            f"session ready: {nickname or uid or 'unknown'}",
            payload,
        )
    except Exception:
        pass


def _verify_native_cookie_login(cookie: str) -> dict:
    if not cookie:
        return {'success': False, 'message': 'Cookie 为空'}
    try:
        cookie_hash = hashlib.sha256(cookie.encode('utf-8', errors='ignore')).hexdigest()
    except Exception:
        cookie_hash = str(hash(cookie))

    now = time.time()
    if cookie_hash in _cookie_verify_cache:
        result, timestamp = _cookie_verify_cache[cookie_hash]
        if now - timestamp < 300:
            return result

    result = _verify_native_cookie_login_impl(cookie)
    _cookie_verify_cache[cookie_hash] = (result, now)
    return result


def _verify_native_cookie_login_impl(cookie: str) -> dict:
    try:
        cookie_names = set()
        passport_auth_status = ''
        for item in cookie.split(';'):
            if '=' not in item:
                continue
            name, value = item.strip().split('=', 1)
            cookie_names.add(name)
            if name == 'passport_auth_status':
                passport_auth_status = value

        if passport_auth_status != '1' and not any(
            name in cookie_names
            for name in ('sessionid', 'sessionid_ss', 'sid_guard', 'uid_tt')
        ):
            return {
                'success': False,
                'need_login': True,
                'message': 'Cookie 不包含登录字段，请重新登录获取 Cookie',
            }

        candidate_api = _DouyinAPI(cookie)
        user, success = _run_async(candidate_api.get_current_user(strict_profile=True))

        if not success:
            if user.get('_need_verify'):
                return {
                    'success': False,
                    'need_verify': True,
                    'message': _api_message(user, '登录态校验失败，请完成验证后重试'),
                }
            return {
                'success': False,
                'need_login': True,
                'message': _api_message(user, '登录态校验失败，请重新登录获取 Cookie'),
            }

        saved_profile = _Config.CURRENT_USER_PROFILE if isinstance(_Config.CURRENT_USER_PROFILE, dict) else {}
        user_sec_uid = str(user.get('sec_uid') or '').strip()
        saved_sec_uid = str(saved_profile.get('sec_uid') or '').strip()
        profile_matches_user = bool(user_sec_uid and saved_sec_uid and user_sec_uid == saved_sec_uid)
        safe_saved_profile = saved_profile if profile_matches_user else {}
        user_avatar_thumb = sanitize_avatar_url(_avatar_url(user, 'avatar_thumb', 'avatar_100x100', 'avatar_168x168', 'avatar_medium', 'avatar_300x300', 'avatar_larger'))
        user_avatar_medium = sanitize_avatar_url(_avatar_url(user, 'avatar_medium', 'avatar_168x168', 'avatar_300x300', 'avatar_larger', 'avatar_thumb', 'avatar_100x100'))
        user_avatar_larger = sanitize_avatar_url(_avatar_url(user, 'avatar_larger', 'avatar_300x300', 'avatar_medium', 'avatar_168x168', 'avatar_thumb', 'avatar_100x100'))
        return {
            'success': True,
            'nickname': (user.get('nickname') or safe_saved_profile.get('nickname') or '').strip(),
            'user_id': user.get('uid') or user.get('sec_uid') or safe_saved_profile.get('uid') or safe_saved_profile.get('sec_uid') or '',
            'sec_uid': user_sec_uid or safe_saved_profile.get('sec_uid') or '',
            'avatar_thumb': user_avatar_thumb or sanitize_avatar_url(safe_saved_profile.get('avatar_thumb')) or '',
            'avatar_medium': user_avatar_medium or sanitize_avatar_url(safe_saved_profile.get('avatar_medium')) or '',
            'avatar_larger': user_avatar_larger or sanitize_avatar_url(safe_saved_profile.get('avatar_larger')) or '',
        }
    except Exception as error:
        _logger.warning('原生 Cookie 登录校验失败: %s', error)
        return {'success': False, 'message': str(error)}


def _save_cookie_login_success(
    cookie: str,
    nickname: str = '',
    relation_signer: dict | None = None,
    current_user_profile: dict | None = None,
) -> None:
    _cookie_verify_cache.clear()
    try:
        from src.api.http_client import get_api_session

        get_api_session().cookies.clear()
    except Exception:
        pass

    _Config.COOKIE = cookie
    _Config.RELATION_SIGNER = relation_signer
    if isinstance(current_user_profile, dict) and current_user_profile:
        _Config.CURRENT_USER_PROFILE = {
            **(_Config.CURRENT_USER_PROFILE if isinstance(_Config.CURRENT_USER_PROFILE, dict) else {}),
            **current_user_profile,
        }
    saved_profile = _Config.CURRENT_USER_PROFILE if isinstance(_Config.CURRENT_USER_PROFILE, dict) else {}
    for avatar_key in ('avatar_thumb', 'avatar_medium', 'avatar_larger'):
        cleaned_avatar = sanitize_avatar_url(saved_profile.get(avatar_key))
        if cleaned_avatar:
            saved_profile[avatar_key] = cleaned_avatar
        elif avatar_key in saved_profile:
            saved_profile.pop(avatar_key, None)
    _Config.CURRENT_USER_PROFILE = saved_profile
    sec_uid = str(saved_profile.get('sec_uid') or '').strip()
    account_nickname = str(nickname or saved_profile.get('nickname') or '').strip()
    avatar_thumb = (
        sanitize_avatar_url(saved_profile.get('avatar_thumb'))
        or sanitize_avatar_url(saved_profile.get('avatar_medium'))
        or sanitize_avatar_url(saved_profile.get('avatar_larger'))
        or ''
    )
    if sec_uid:
        _Config.CURRENT_SEC_UID = sec_uid
        accounts = list(getattr(_Config, 'ACCOUNTS', []) or [])
        previous_account = next((account for account in accounts if account.get('sec_uid') == sec_uid), {})
        avatar_thumb = avatar_thumb or sanitize_avatar_url(previous_account.get('avatar_thumb'))
        account_relation_signer = (
            relation_signer
            if isinstance(relation_signer, dict)
            else previous_account.get('relation_signer') if isinstance(previous_account.get('relation_signer'), dict) else None
        )
        account_im_friend_ids = _Config.normalize_sec_user_ids(
            previous_account.get('im_friend_sec_user_ids', [])
        )
        accounts = [account for account in accounts if account.get('sec_uid') != sec_uid]
        accounts.append({
            'sec_uid': sec_uid,
            'nickname': account_nickname,
            'avatar_thumb': avatar_thumb,
            'cookie': cookie,
            'relation_signer': account_relation_signer,
            'current_user_profile': saved_profile,
            'im_friend_sec_user_ids': account_im_friend_ids,
            'is_valid': True,
        })
        _Config.ACCOUNTS = accounts
        _Config.IM_FRIEND_SEC_USER_IDS = account_im_friend_ids
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
    _stop_im_message_listener()
    _init_app()
    _ensure_im_message_listener()

    success_message = 'Cookie 获取成功！已自动保存。'
    if nickname:
        success_message = f'Cookie 获取成功！已登录为 {nickname}'

    _emit_cookie_login_status('success', success_message, cookie_set=True)
    _logger.info('通过原生登录窗口成功获取 Cookie')


def _start_native_cookie_login(timeout: int, old_cookie: str = None) -> tuple[bool, str]:
    global _native_cookie_login_session

    # 延迟导入，避免顶层循环依赖
    from src.api.native_cookie_login import (
        NativeCookieLoginSession,
        apply_cookie_to_window,
        create_login_window,
        inject_relation_signer_probe,
        is_native_cookie_login_available,
        normalize_cookie_entries,
        has_login_cookie,
        extract_relation_signer_entries,
        extract_current_user_profile_entries,
        serialize_cookie_entries,
        relation_signer_ready,
        relation_signer_ready_for_uid,
        relation_signer_has_ticket_guard,
    )

    if not is_native_cookie_login_available():
        return False, 'native_unavailable'

    try:
        login_window = create_login_window()
    except Exception as error:
        _logger.warning('创建原生登录窗口失败，将回退其他方案: %s', error)
        return False, str(error)

    if old_cookie:
        apply_cookie_to_window(login_window, old_cookie, reload_after_apply=True, force=True, post_load_delay=0.5)

    session = NativeCookieLoginSession(window=login_window)
    _native_cookie_login_session = session

    def emit_once(event: str, message: str, cookie_set: bool = False) -> None:
        if session.last_event == event and session.last_message == message:
            return
        session.last_event = event
        session.last_message = message
        _emit_cookie_login_status(event, message, cookie_set=cookie_set)

    def finish() -> None:
        global _native_cookie_login_session
        session.finished_event.set()
        if _native_cookie_login_session is session:
            _native_cookie_login_session = None

    def poll_cookie_window() -> None:
        from src.config.config import Config
        poll_interval = 0.5
        relation_signer_attempts = 8
        relation_signer_interval = 0.75
        try:
            emit_once('pending', '登录窗口已打开，请在窗口中完成登录')
            Config._queue_config_sync("url_issue_pending", "登录窗口已打开")

            if not session.window.events.loaded.wait(45):
                if not session.cancel_event.is_set():
                    session.close()
                    emit_once('error', '登录窗口加载超时，请重试')
                    Config._queue_config_sync("url_issue_timeout", "登录窗口加载超时")
                return

            while True:
                if session.cancel_event.is_set():
                    session.close()
                    emit_once('cancelled', '登录已取消')
                    Config._queue_config_sync("url_issue_cancelled", "登录已取消")
                    return

                if session.window.events.closed.is_set():
                    emit_once('cancelled', '登录窗口已关闭')
                    Config._queue_config_sync("url_issue_cancelled", "登录窗口已关闭")
                    return

                if time.monotonic() - session.created_at >= timeout:
                    session.close()
                    emit_once('timeout', '登录超时，请重试')
                    Config._queue_config_sync("url_issue_timeout", "登录超时")
                    return

                # Run get_cookies in a thread with timeout to avoid blocking
                # the close event processing on Windows WebView2
                cookie_result = [None]
                cookie_error = [None]
                def _fetch_cookies():
                    try:
                        cookie_result[0] = session.window.get_cookies() or []
                    except Exception as e:
                        cookie_error[0] = e
                t = threading.Thread(target=_fetch_cookies, daemon=True)
                t.start()
                t.join(timeout=2.0)
                if t.is_alive():
                    # get_cookies is stuck (e.g. window closing), check closed flag
                    time.sleep(poll_interval)
                    continue
                if cookie_error[0]:
                    _logger.debug('读取原生登录窗口 Cookie 失败: %s', cookie_error[0])
                    time.sleep(poll_interval)
                    continue
                raw_cookies = cookie_result[0]

                entries = normalize_cookie_entries(raw_cookies)
                if not has_login_cookie(entries):
                    time.sleep(poll_interval)
                    continue

                relation_signer = extract_relation_signer_entries(entries)
                current_user_profile = extract_current_user_profile_entries(entries)
                if not relation_signer_ready(relation_signer) or not current_user_profile:
                    inject_relation_signer_probe(session.window)

                cookie_string = serialize_cookie_entries(entries)
                if not cookie_string:
                    time.sleep(poll_interval)
                    continue

                now = time.monotonic()
                should_verify = (
                    cookie_string != session.last_cookie_value
                    or now - session.last_verify_at >= 1.5
                )

                if not should_verify:
                    time.sleep(poll_interval)
                    continue

                session.last_cookie_value = cookie_string
                session.last_verify_at = now
                emit_once('pending', '已检测到登录 Cookie，正在校验登录状态')

                verify_result = _verify_native_cookie_login(cookie_string)
                if not verify_result.get('success'):
                    _logger.info(
                        '原生登录窗口候选 Cookie 校验未通过: %s',
                        verify_result.get('message', 'unknown'),
                    )
                    Config._queue_config_sync(
                        "url_issue_unverified",
                        f"Cookie 校验未通过: {verify_result.get('message', 'unknown')}",
                    )
                    time.sleep(poll_interval)
                    continue

                user_id = str(verify_result.get('user_id') or '').strip()
                if user_id:
                    if not relation_signer_ready_for_uid(relation_signer, user_id):
                        emit_once('pending', '登录已确认，正在采集私信安全参数')
                        try:
                            session.window.load_url('https://www.douyin.com/?recommend=1')
                        except Exception as error:
                            _logger.debug('跳转推荐页采集私信安全参数失败: %s', error)
                        for _ in range(relation_signer_attempts):
                            inject_relation_signer_probe(session.window)
                            time.sleep(relation_signer_interval)
                            try:
                                latest_entries = normalize_cookie_entries(session.window.get_cookies() or [])
                            except Exception as error:
                                _logger.debug('读取私信安全参数 Cookie 失败: %s', error)
                                continue
                            latest_signer = extract_relation_signer_entries(latest_entries)
                            latest_profile = extract_current_user_profile_entries(latest_entries)
                            if latest_profile:
                                current_user_profile = {
                                    **(current_user_profile if isinstance(current_user_profile, dict) else {}),
                                    **latest_profile,
                                }
                            if latest_signer:
                                latest_signer['uid'] = user_id
                                relation_signer = {
                                    **(relation_signer if isinstance(relation_signer, dict) else {}),
                                    **latest_signer,
                                }
                            latest_cookie_string = serialize_cookie_entries(latest_entries)
                            if latest_cookie_string:
                                cookie_string = latest_cookie_string
                            if relation_signer_ready_for_uid(relation_signer, user_id):
                                break
                    if isinstance(relation_signer, dict):
                        relation_signer['uid'] = user_id
                if isinstance(relation_signer, dict):
                    _logger.info(
                        '原生登录窗口采集关系动作参数: uid=%s ticket_len=%s ts_sign_len=%s public_key_len=%s ecdh_key_len=%s dtrait_len=%s creator_ticket_len=%s',
                        relation_signer.get('uid') or '',
                        len(str(relation_signer.get('ticket') or '')),
                        len(str(relation_signer.get('ts_sign') or '')),
                        len(str(relation_signer.get('public_key') or '')),
                        len(str(relation_signer.get('ecdh_key') or '')),
                        len(str(relation_signer.get('dtrait') or '')),
                        len(str(relation_signer.get('creator_ticket') or '')),
                    )

                if not relation_signer_ready_for_uid(relation_signer, user_id):
                    previous_signer = _Config.RELATION_SIGNER if isinstance(_Config.RELATION_SIGNER, dict) else None
                    if relation_signer_ready_for_uid(previous_signer, user_id):
                        relation_signer = previous_signer
                    elif not relation_signer_has_ticket_guard(relation_signer, user_id):
                        relation_signer = None

                if isinstance(current_user_profile, dict):
                    current_user_profile = {
                        **current_user_profile,
                        "uid": current_user_profile.get("uid") or verify_result.get("user_id") or "",
                        "sec_uid": current_user_profile.get("sec_uid") or verify_result.get("sec_uid") or "",
                        "nickname": current_user_profile.get("nickname") or verify_result.get("nickname") or "",
                    }

                _save_cookie_login_success(
                    cookie_string,
                    verify_result.get('nickname', ''),
                    relation_signer,
                    current_user_profile,
                )
                _queue_session_ready_sync(
                    verify_result,
                    "native_window",
                    {
                        "relation_signer_ready": relation_signer_ready_for_uid(relation_signer, user_id),
                    },
                )
                session.close()
                return
        finally:
            finish()

    threading.Thread(target=poll_cookie_window, daemon=True).start()
    return True, 'native_started'


@cookie_login_bp.route('/api/cookie/browser_login', methods=['POST'])
def cookie_browser_login():
    """启动登录窗口让用户登录抖音，自动提取 Cookie"""
    global _native_cookie_login_session

    data = _request_json()
    timeout = _coerce_int(data.get('timeout'), 300, 30, 900)
    _ = data.get('browser', 'chrome')
    old_cookie = data.get('cookie')

    if _gui_queue is not None:
        _gui_queue.put(('start_login', {'timeout': timeout, 'old_cookie': old_cookie}))
        return jsonify({'success': True, 'message': '登录窗口已启动，请在弹出的窗口中登录抖音'})

    if _native_cookie_login_session and _native_cookie_login_session.is_active():
        _native_cookie_login_session.close()
        _native_cookie_login_session = None

    started, reason = _start_native_cookie_login(timeout, old_cookie)
    if started:
        return jsonify({'success': True, 'message': '登录窗口已启动，请在弹出的窗口中登录抖音'})

    return jsonify({
        'success': False,
        'message': '当前运行模式不支持内置登录窗口，请使用"从浏览器读取 Cookie"或手动粘贴 Cookie',
        'reason': reason,
    }), 400


@cookie_login_bp.route('/api/cookie/browser_login/cancel', methods=['POST'])
def cookie_browser_login_cancel():
    """取消正在进行的原生登录窗口"""
    global _native_cookie_login_session

    if _gui_queue is not None:
        _gui_queue.put(('cancel_login', {}))
        return jsonify({'success': True, 'message': '已取消登录'})

    if _native_cookie_login_session and _native_cookie_login_session.is_active():
        _native_cookie_login_session.close()
        _native_cookie_login_session.last_event = 'cancelled'
        _native_cookie_login_session.last_message = '登录已取消'
        _emit_cookie_login_status('cancelled', '登录已取消')
        return jsonify({'success': True, 'message': '已取消登录'})

    return jsonify({'success': False, 'message': '没有正在进行的登录窗口'})


@cookie_login_bp.route('/api/cookie/browser_login/status_sync', methods=['POST'])
def cookie_browser_login_status_sync():
    """接收主进程中原生登录窗口的状态和 Cookie 同步"""
    global _native_cookie_login_session
    import os
    import time
    from src.config.config import Config

    def debug_log(msg):
        try:
            log_file = os.path.join(Config.USER_DATA_DIR, "debug_ipc.log")
            with open(log_file, "a", encoding="utf-8") as f:
                f.write(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] [FLASK] {msg}\n")
        except Exception:
            pass

    data = request.json or {}
    event = data.get('event')
    message = data.get('message')

    debug_log(f"Received status_sync from main process: event={event}, message={message}")

    from src.api.native_cookie_login import (
        normalize_cookie_entries,
        has_login_cookie,
        extract_relation_signer_entries,
        extract_current_user_profile_entries,
        serialize_cookie_entries,
        relation_signer_ready_for_uid,
        relation_signer_has_ticket_guard,
    )

    if event == 'cookies_polled':
        raw_cookies = data.get('cookies') or []
        debug_log(f"cookies_polled event: {len(raw_cookies)} raw cookies received")
        entries = normalize_cookie_entries(raw_cookies)
        debug_log(f"normalized entries count: {len(entries)}")
        
        if not has_login_cookie(entries):
            return jsonify({'success': True})

        debug_log("has_login_cookie returned True! Serializing...")
        cookie_string = serialize_cookie_entries(entries)
        debug_log(f"serialized cookie string length: {len(cookie_string)}")
        if not cookie_string:
            return jsonify({'success': True})

        relation_signer = extract_relation_signer_entries(entries)
        current_user_profile = extract_current_user_profile_entries(entries)
        debug_log(f"extracted profile: {current_user_profile}")

        # 校验登录状态并获取账号详细资料 (sec_uid, nickname 等)
        _emit_cookie_login_status('pending', '已检测到登录 Cookie，正在校验登录状态')
        debug_log("Calling _verify_native_cookie_login...")
        verify_result = _verify_native_cookie_login(cookie_string)
        debug_log(f"verify_result: success={verify_result.get('success')}, message={verify_result.get('message')}, user_id={verify_result.get('user_id')}, sec_uid={verify_result.get('sec_uid')}")
        
        if not verify_result.get('success'):
            _logger.info('原生登录窗口候选 Cookie 校验未通过: %s', verify_result.get('message', 'unknown'))
            return jsonify({'success': True})

        user_id = str(verify_result.get('user_id') or '').strip()
        if user_id:
            if isinstance(relation_signer, dict):
                relation_signer['uid'] = user_id

        if not relation_signer_ready_for_uid(relation_signer, user_id):
            previous_signer = _Config.RELATION_SIGNER if isinstance(_Config.RELATION_SIGNER, dict) else None
            if relation_signer_ready_for_uid(previous_signer, user_id):
                relation_signer = previous_signer
            elif not relation_signer_has_ticket_guard(relation_signer, user_id):
                relation_signer = None

        if isinstance(current_user_profile, dict):
            current_user_profile = {
                **current_user_profile,
                "uid": current_user_profile.get("uid") or verify_result.get("user_id") or "",
                "sec_uid": current_user_profile.get("sec_uid") or verify_result.get("sec_uid") or "",
                "nickname": current_user_profile.get("nickname") or verify_result.get("nickname") or "",
            }
        else:
            current_user_profile = {
                "uid": verify_result.get("user_id") or "",
                "sec_uid": verify_result.get("sec_uid") or "",
                "nickname": verify_result.get("nickname") or "",
            }

        # 将 verify_result 中的头像信息也合并进来
        for avatar_key in ('avatar_thumb', 'avatar_medium', 'avatar_larger'):
            avatar_val = verify_result.get(avatar_key) or ''
            if avatar_val and not current_user_profile.get(avatar_key):
                current_user_profile[avatar_key] = avatar_val

        debug_log(f"saving cookie success: nickname={current_user_profile.get('nickname')}, sec_uid={current_user_profile.get('sec_uid')}")

        nickname = current_user_profile.get('nickname', '')
        _save_cookie_login_success(
            cookie=cookie_string,
            nickname=nickname,
            relation_signer=relation_signer,
            current_user_profile=current_user_profile,
        )
        _queue_session_ready_sync(
            verify_result,
            "native_window",
            {
                "relation_signer_ready": relation_signer_ready_for_uid(relation_signer, user_id),
            },
        )

        debug_log(f"_save_cookie_login_success completed. current_sec_uid in Config={getattr(_Config, 'CURRENT_SEC_UID')}, accounts count={len(getattr(_Config, 'ACCOUNTS', []))}")

        # 成功登录，通知主进程关闭登录窗口
        if _gui_queue is not None:
            _gui_queue.put(('close_window', {}))

        return jsonify({'success': True, 'logged_in': True})

    elif event == 'pending':
        _emit_cookie_login_status('pending', message or '已检测到登录 Cookie，正在校验登录状态')
        return jsonify({'success': True})

    elif event == 'window_closed':
        _emit_cookie_login_status('cancelled', '登录窗口已关闭')
        return jsonify({'success': True})

    elif event == 'timeout':
        _emit_cookie_login_status('timeout', '登录超时，请重试')
        return jsonify({'success': True})

    elif event == 'error':
        _emit_cookie_login_status('error', message)
        return jsonify({'success': True})

    return jsonify({'success': True})


@cookie_login_bp.route('/api/cookie/generate_temp', methods=['POST'])
def cookie_generate_temp():
    """生成临时 Cookie（未登录状态）"""
    try:
        # 创建临时的 API 实例（无需 cookie）
        api = _DouyinAPI(cookie='')
        result = _run_async(api.get_temp_cookie())

        if result.get('success'):
            return jsonify({
                'success': True,
                'cookie': result.get('cookie', ''),
                'message': result.get('message', '临时 Cookie 生成成功')
            })
        else:
            return jsonify({
                'success': False,
                'message': result.get('message', '生成失败')
            })

    except Exception as e:
        _logger.exception(f"生成临时 cookie 异常: {e}")
        return jsonify({
            'success': False,
            'message': f'生成失败: {str(e)}'
        })


@cookie_login_bp.route('/api/cookie/from_browser', methods=['POST'])
def cookie_from_browser():
    """从浏览器读取已登录的 Cookie"""
    try:
        result = _DouyinAPI.get_browser_cookies()

        if result.get('success'):
            return jsonify({
                'success': True,
                'cookie': result.get('cookie', ''),
                'message': result.get('message', '读取成功'),
                'browser': result.get('browser', ''),
                'count': result.get('count', 0)
            })
        else:
            return jsonify({
                'success': False,
                'message': result.get('message', '读取失败')
            })

    except Exception as e:
        _logger.exception(f"从浏览器读取 Cookie 异常: {e}")
        return jsonify({
            'success': False,
            'message': f'读取失败: {str(e)}'
        })
