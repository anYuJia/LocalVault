import threading
import requests
import logging
import traceback
import os
from typing import Optional, Dict, Any

logger = logging.getLogger(__name__)

REPORT_SERVER_URL = "http://47.109.40.237:12345/api/report"

def _prepare_extra_data(event_type: str, extra_data: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    prepared = dict(extra_data or {})
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
