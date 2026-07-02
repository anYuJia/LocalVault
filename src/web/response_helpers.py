"""Common API response helpers for login, verification, and error messages."""
from __future__ import annotations

_Config = None
_verify_native_cookie_login = None


def setup_response_helpers(*, Config, verify_native_cookie_login=None) -> None:
    global _Config, _verify_native_cookie_login
    _Config = Config
    _verify_native_cookie_login = verify_native_cookie_login


def set_verify_native_cookie_login(verify_native_cookie_login) -> None:
    global _verify_native_cookie_login
    _verify_native_cookie_login = verify_native_cookie_login


def api_message(payload, fallback='请求失败'):
    if isinstance(payload, dict):
        for key in ('message', 'status_msg'):
            value = payload.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
    return fallback


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


def verify_error_response(payload, fallback='需要完成抖音验证', verify_url=None):
    payload_dict = payload if isinstance(payload, dict) else {}
    if _Config.COOKIE and _verify_native_cookie_login:
        login_status = _verify_native_cookie_login(_Config.COOKIE)
        if not login_status.get('success'):
            _set_current_account_valid(False)
            if login_status.get('need_verify'):
                return {
                    'success': False,
                    'need_verify': True,
                    'verify_url': verify_url or payload_dict.get('_verify_url') or 'https://www.douyin.com/',
                    'message': api_message(login_status, fallback),
                }
            return login_error_response(login_status)

    message = api_message(payload, fallback)
    return {
        'success': False,
        'need_verify': True,
        'verify_url': verify_url or payload_dict.get('_verify_url') or 'https://www.douyin.com/',
        'message': message,
    }


def verify_error_response_without_login_check(payload, fallback='需要完成抖音验证', verify_url=None):
    payload_dict = payload if isinstance(payload, dict) else {}
    return {
        'success': False,
        'need_verify': True,
        'verify_url': verify_url or payload_dict.get('_verify_url') or 'https://www.douyin.com/',
        'message': api_message(payload, fallback),
    }


def login_error_response(payload, fallback='登录态已失效，请重新登录获取 Cookie'):
    _set_current_account_valid(False)
    return {
        'success': False,
        'need_login': True,
        'message': api_message(payload, fallback),
    }


def feature_login_error_response(feature: str):
    return {
        'success': False,
        'need_login': True,
        'message': f'请登录后获取{feature}',
    }


def cookie_aware_error_response(payload, fallback='请求失败，请检查 Cookie 或稍后重试'):
    if _Config.COOKIE and _verify_native_cookie_login:
        login_status = _verify_native_cookie_login(_Config.COOKIE)
        if not login_status.get('success'):
            _set_current_account_valid(False)
            if login_status.get('need_verify'):
                return verify_error_response(login_status, fallback)
            return login_error_response(login_status)

    return {
        'success': False,
        'message': api_message(payload, fallback),
    }


def verify_or_request_error_response(payload, fallback='请求失败，请稍后重试', verify_url=None):
    """只有 Cookie 校验也确认需要验证时才弹验证窗口，避免普通接口失败误触发验证。"""
    payload_dict = payload if isinstance(payload, dict) else {}
    if _Config.COOKIE and _verify_native_cookie_login:
        login_status = _verify_native_cookie_login(_Config.COOKIE)
        if login_status.get('success'):
            return {
                'success': False,
                'message': api_message(payload_dict, fallback),
            }
        _set_current_account_valid(False)
        if login_status.get('need_verify'):
            return {
                'success': False,
                'need_verify': True,
                'verify_url': verify_url or payload_dict.get('_verify_url') or 'https://www.douyin.com/',
                'message': api_message(login_status, '需要完成验证后重试'),
            }
        return login_error_response(login_status)

    return verify_error_response(payload_dict, fallback, verify_url)
