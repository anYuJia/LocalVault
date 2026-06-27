"""下载相关路由。

从 web_app.py 抽离。模块内部依赖通过 setup 注入，
外部调用方（web_app.py）需要在导入本模块后调用 setup_downloads_routes(...)。
"""
from __future__ import annotations

from typing import Any, Callable

from flask import Blueprint

downloads_bp = Blueprint("downloads", __name__)

# 注入的依赖
_logger = None
_Config = None
_socketio = None
_request_json: Callable[[], dict] | None = None
_coerce_int: Callable[..., int] | None = None
_run_async: Callable[..., Any] | None = None
_api_message: Callable[..., str] | None = None
_verify_error_response: Callable[..., dict] | None = None
_login_error_response: Callable[..., dict] | None = None
_normalize_download_media_urls: Callable[..., list] | None = None
_build_download_title: Callable[..., str] | None = None
_build_download_name: Callable[..., str] | None = None
_get_or_create_loop: Callable[..., Any] | None = None
_task_store = None


def setup_downloads_routes(
    *,
    logger,
    Config,
    socketio,
    request_json: Callable[[], dict],
    coerce_int: Callable[..., int],
    run_async: Callable[..., Any],
    api_message: Callable[..., str],
    verify_error_response: Callable[..., dict],
    login_error_response: Callable[..., dict],
    normalize_download_media_urls: Callable[..., list],
    build_download_title: Callable[..., str],
    build_download_name: Callable[..., str],
    get_or_create_loop: Callable[..., Any],
    task_store,
) -> None:
    """注入 web_app 模块的全局对象，避免循环导入。"""
    global _logger, _Config, _socketio, _request_json, _coerce_int, _run_async
    global _api_message, _verify_error_response, _login_error_response
    global _normalize_download_media_urls, _build_download_title, _build_download_name
    global _get_or_create_loop
    global _task_store
    _logger = logger
    _Config = Config
    _socketio = socketio
    _request_json = request_json
    _coerce_int = coerce_int
    _run_async = run_async
    _api_message = api_message
    _verify_error_response = verify_error_response
    _login_error_response = login_error_response
    _normalize_download_media_urls = normalize_download_media_urls
    _build_download_title = build_download_title
    _build_download_name = build_download_name
    _get_or_create_loop = get_or_create_loop
    _task_store = task_store


def _get_user_manager():
    """延迟读取 web_app.user_manager，避免 setup 时还未初始化。"""
    from src.web import web_app
    return web_app.user_manager


def _get_downloader():
    """延迟读取 web_app.downloader，避免 setup 时还未初始化。"""
    from src.web import web_app
    return web_app.downloader

