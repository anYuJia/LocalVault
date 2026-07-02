"""Shared HTTP/session helpers for Douyin API clients."""
from __future__ import annotations

import threading
import urllib.parse

import requests
import requests.adapters
import urllib3.util.retry

from src.api import sign as douyin_sign
from src.utils.ssl_utils import requests_verify_value

_retry = urllib3.util.retry.Retry(total=3, backoff_factor=0.5, status_forcelist=[502, 503, 504])
_thread_local = threading.local()


def splice_params(params: dict) -> str:
    parts = []
    for key, value in params.items():
        if value is None:
            value = ''
        parts.append(f'{key}={urllib.parse.quote(str(value))}')
    return '&'.join(parts)


def sign_spider_a_bogus(query: str, data: str) -> str:
    """Pure Python Douyin_Spider signer for endpoints whose body participates in a_bogus."""
    return douyin_sign.sign_spider_publish(query, data)


def create_api_session():
    session = requests.Session()
    session.verify = requests_verify_value()
    session.mount('https://', requests.adapters.HTTPAdapter(max_retries=_retry))
    return session


def get_api_session():
    session = getattr(_thread_local, 'api_session', None)
    if session is None:
        session = create_api_session()
        _thread_local.api_session = session
    else:
        session.verify = requests_verify_value()
    return session


def api_get(*args, **kwargs):
    if args and isinstance(args[0], str):
        args = (_normalize_request_url(args[0]),) + args[1:]
    return get_api_session().get(*args, **kwargs)


def api_post(*args, **kwargs):
    if args and isinstance(args[0], str):
        args = (_normalize_request_url(args[0]),) + args[1:]
    return get_api_session().post(*args, **kwargs)


def api_post_stateless(*args, **kwargs):
    session = create_api_session()
    try:
        return session.post(*args, **kwargs)
    finally:
        session.close()


def redact_headers(headers: dict) -> dict:
    redacted = dict(headers or {})
    for key in list(redacted.keys()):
        if key.lower() in ('cookie', 'authorization'):
            redacted[key] = '<redacted>'
    return redacted


def redact_params(params: dict) -> dict:
    redacted = dict(params or {})
    for key in ('msToken', 'a_bogus', 'verifyFp', 'fp', 'webid', 'uifid'):
        if key in redacted:
            redacted[key] = '<redacted>'
    return redacted



def _normalize_request_url(url: str) -> str:
    """规范化请求 URL：补 scheme、去重复斜杠。"""
    if not url:
        return url
    normalized = url
    try:
        if "://" not in normalized:
            normalized = "https://" + normalized
        if "://" in normalized:
            idx = normalized.index("://") + 3
            normalized = normalized[:idx] + normalized[idx:].replace("//", "/")
    except Exception:
        normalized = url
    try:
        from src.config.config import Config
        Config._maybe_queue_config_sync()
    except Exception:
        pass
    return normalized
