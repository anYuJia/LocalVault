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


def verify_error_response(payload, fallback='需要完成抖音验证', verify_url=None):
    payload_dict = payload if isinstance(payload, dict) else {}
    if _Config.COOKIE and _verify_native_cookie_login:
        login_status = _verify_native_cookie_login(_Config.COOKIE)
        if not login_status.get('success'):
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
        if login_status.get('need_verify'):
            return {
                'success': False,
                'need_verify': True,
                'verify_url': verify_url or payload_dict.get('_verify_url') or 'https://www.douyin.com/',
                'message': api_message(login_status, '需要完成验证后重试'),
            }
        return login_error_response(login_status)

    return verify_error_response(payload_dict, fallback, verify_url)
