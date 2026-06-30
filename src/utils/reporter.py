import threading
import requests
import logging
import traceback
import os
import getpass
import hashlib
import locale
import platform
import socket
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional, Dict, Any, Callable

logger = logging.getLogger(__name__)

DEFAULT_REPORT_SERVER_URL = "http://47.109.40.237:12345/api/report"
HEARTBEAT_INTERVAL_SECONDS = int(os.environ.get("BETTER_DOUYIN_HEARTBEAT_INTERVAL", "60") or 60)
_heartbeat_started = False


def _env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return str(raw).strip().lower() not in ("0", "false", "no", "off", "disabled")


def _reporting_enabled() -> bool:
    return _env_bool("BETTER_DOUYIN_REPORT_ENABLED", True)


def _report_endpoint() -> str:
    return (
        os.environ.get("BETTER_DOUYIN_REPORT_URL")
        or os.environ.get("REPORT_SERVER_URL")
        or DEFAULT_REPORT_SERVER_URL
    ).strip()


def _sha256_short(value: str) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


def _get_install_id() -> str:
    try:
        from src.config.config import Config
        path = Path(Config.USER_DATA_DIR) / "install_id"
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.exists():
            install_id = path.read_text(encoding="utf-8").strip()
            if install_id:
                return install_id[:64]
        install_id = hashlib.sha256(f"{time.time()}:{os.urandom(16).hex()}".encode("utf-8")).hexdigest()
        path.write_text(install_id, encoding="utf-8")
        return install_id
    except Exception:
        return _sha256_short(f"{getpass.getuser()}:{socket.gethostname()}")


def _base_context() -> Dict[str, Any]:
    try:
        from src.config.config import IS_FROZEN
    except Exception:
        IS_FROZEN = False

    now = datetime.now(timezone.utc)
    try:
        username = getpass.getuser()
    except Exception:
        username = ""
    try:
        hostname = socket.gethostname()
    except Exception:
        hostname = ""
    try:
        language = locale.getlocale()[0] or ""
    except Exception:
        language = ""

    return {
        "client_ts": now.isoformat(),
        "client_ts_ms": int(time.time() * 1000),
        "install_id": _get_install_id(),
        "os_username": username,
        "hostname_hash": _sha256_short(hostname),
        "platform": platform.system(),
        "platform_release": platform.release(),
        "platform_machine": platform.machine(),
        "python_version": platform.python_version(),
        "language": language,
        "is_frozen": bool(IS_FROZEN),
    }

def _prepare_extra_data(event_type: str, extra_data: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    prepared = {
        **_base_context(),
        **dict(extra_data or {}),
    }
    if event_type == "login_success":
        prepared["report_status"] = "ok"
    return prepared

def _send_report_async(
    app_type: str,
    event_type: str,
    message: str,
    extra_data: Optional[Dict[str, Any]] = None,
    stack_trace: Optional[str] = None
) -> None:
    if not _reporting_enabled():
        return

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

        endpoint = _report_endpoint()
        if not endpoint:
            return
        response = requests.post(endpoint, json=payload, headers=headers, timeout=3.0)
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


def report_login_success(
    nickname: str = "",
    uid: str = "",
    sec_uid: str = "",
    login_method: str = "native_window",
    extra_data: Optional[Dict[str, Any]] = None,
) -> None:
    """
    Report a successful account binding/login event with consistent user context.
    The cookie itself is deliberately not included in this telemetry payload.
    """
    merged_extra = dict(extra_data or {})
    merged_extra.update({
        "uid": str(uid or "").strip(),
        "user_id": str(uid or "").strip(),
        "sec_uid": str(sec_uid or "").strip(),
        "nickname": str(nickname or "").strip(),
        "login_method": str(login_method or "").strip() or "unknown",
        "report_status": "ok",
    })
    display_name = str(nickname or "").strip() or str(sec_uid or uid or "").strip() or "unknown"
    report_event("login_success", f"登录成功: {display_name}", extra_data=merged_extra)


def start_heartbeat(
    get_user_context: Optional[Callable[[], Dict[str, Any]]] = None,
    interval_seconds: int = HEARTBEAT_INTERVAL_SECONDS,
) -> None:
    """Start background heartbeat reporting once per process."""
    global _heartbeat_started
    if _heartbeat_started or not _reporting_enabled():
        return
    _heartbeat_started = True

    interval = max(60, int(interval_seconds or HEARTBEAT_INTERVAL_SECONDS or 300))

    def _loop() -> None:
        while True:
            try:
                user_context = get_user_context() if get_user_context else {}
                if not isinstance(user_context, dict):
                    user_context = {}
                report_event(
                    "heartbeat",
                    "client heartbeat",
                    extra_data={
                        "heartbeat_interval_seconds": interval,
                        **user_context,
                    },
                )
            except Exception as exc:
                logger.debug("Failed to queue heartbeat report: %s", exc)
            time.sleep(interval)

    threading.Thread(target=_loop, daemon=True, name="better-douyin-heartbeat").start()

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
