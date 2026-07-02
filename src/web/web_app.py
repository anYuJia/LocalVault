import platform
import os

IS_WINDOWS = platform.system().lower() == 'windows'
IS_MACOS = platform.system().lower() == 'darwin'

# macOS + pywebview 时跳过 gevent patch，避免与 Cocoa 运行循环冲突
# 也跳过 PyInstaller 分析阶段（避免 monkey.patch_all 破坏模块分析）
if not IS_WINDOWS and not (IS_MACOS and os.environ.get('USE_PYWEBVIEW') == '1') and 'PYINSTALLER_CONFIGDIR' not in os.environ:
    from gevent import monkey
    monkey.patch_all()

from flask import Flask, jsonify, request
from flask_socketio import SocketIO
import asyncio
import sys
if sys.platform == 'win32':
    try:
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    except Exception:
        pass
import threading
import logging
import warnings
import time
import webbrowser
import requests as http_requests
import urllib3
from urllib3.exceptions import InsecureRequestWarning
from datetime import datetime

# 配置日志
logging.basicConfig(level=logging.DEBUG if os.environ.get('DEBUG_MODE', '').lower() in ('true', '1') else logging.INFO,
                    format='[%(levelname)s] %(message)s')
logger = logging.getLogger('web_app')
logging.getLogger('werkzeug').setLevel(logging.WARNING)
logging.getLogger('urllib3.connectionpool').setLevel(logging.WARNING)
urllib3.disable_warnings(InsecureRequestWarning)
warnings.filterwarnings('ignore', category=InsecureRequestWarning)
socketio_debug = os.environ.get('DEBUG_MODE', '').lower() in ('true', '1', 'yes')

MEDIA_PROXY_INITIAL_VIDEO_RANGE = 'bytes=0-1048575'
MEDIA_PROXY_MAX_RANGE_BYTES = 4 * 1024 * 1024
MEDIA_PROXY_MAX_RETRIES = 3
MEDIA_PROXY_REDIRECT_CACHE_MAX_SIZE = 256
DOWNLOAD_TASK_HISTORY_MAX_SIZE = 200
LATEST_RELEASE_API_URL = 'https://api.github.com/repos/anYuJia/better-douyin/releases/latest'
LATEST_RELEASE_PAGE_URL = 'https://github.com/anYuJia/better-douyin/releases/latest'
UPDATER_METADATA_URL = 'https://github.com/anYuJia/better-douyin/releases/latest/download/latest.json'
UPDATER_PUBLIC_KEY = (
    'dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEQ4N0YyNERCNDcxNjlGRgpS'
    'V1QvYVhHMFRmS0hEZmpYNEdhWEFnUExoU1dqUHFiYXhnU2UzWm1Rblo5UUc4MnM0cE13RXFiNAo='
)
MEDIA_PROXY_REDIRECT_CACHE = {}


def _cap_media_range_header(range_header: str, requested_media_type: str) -> str:
    if requested_media_type not in ('audio', 'video') or not range_header:
        return range_header
    text = str(range_header).strip()
    if not text.startswith('bytes=') or ',' in text:
        return range_header
    start_text, _, end_text = text[6:].partition('-')
    if not start_text.strip():
        return range_header
    try:
        start = int(start_text.strip())
    except (TypeError, ValueError):
        return range_header
    if start < 0:
        return range_header
    capped_end = start + MEDIA_PROXY_MAX_RANGE_BYTES - 1
    if end_text.strip():
        try:
            end = min(int(end_text.strip()), capped_end)
        except (TypeError, ValueError):
            end = capped_end
    else:
        end = capped_end
    if end < start:
        return range_header
    capped = f'bytes={start}-{end}'
    return range_header if capped == text else capped

# 添加项目根目录到Python路径
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src.config.config import Config, get_resource_path
from src.api.api import DouyinAPI
from src.downloader.downloader import DouyinDownloader, build_download_name, build_download_title
from src.web import async_runtime
from src.web.download_task_store import DownloadTaskStore
from src.web.formatters import (
    avatar_url,
    format_comment_item,
    safe_get_url,
    search_user_payload,
    user_detail_payload,
)
from src.web.http_utils import coerce_bool, coerce_int, request_json
from src.web.path_utils import (
    LOCAL_MEDIA_EXTENSIONS,
    cleanup_empty_parent_dirs,
    filter_download_history_items,
    get_all_download_roots,
    get_download_root,
    get_root_for_path,
    guess_local_media_mimetype,
    move_directory_contents,
    safe_history_path,
    unique_destination_path,
)
from src.web.response_helpers import (
    api_message,
    feature_login_error_response,
    login_error_response,
    set_verify_native_cookie_login,
    setup_response_helpers,
    verify_error_response,
    verify_error_response_without_login_check,
    verify_or_request_error_response,
)
from src.web.static_routes import get_react_dist_dir, setup_static_routes, static_assets_bp
from src.web.socket_events import register_socket_events
from src.web.port_utils import find_available_port
from src.utils.download_history_index import get_download_history_items
from src.user.user_manager import DouyinUserManager

# 移除增强下载器支持
ENHANCED_DOWNLOADER_AVAILABLE = False
EnhancedDouyinDownloader = None

app = Flask(__name__, static_folder=None)
app.config['SECRET_KEY'] = 'better_douyin_secret_key'
app.config['SEND_FILE_MAX_AGE_DEFAULT'] = 0  # 禁用静态文件缓存
# macOS + pywebview 时 gevent 未 patch，必须用 threading 模式
if IS_WINDOWS or (IS_MACOS and os.environ.get('USE_PYWEBVIEW') == '1'):
    socketio_async_mode = 'threading'
else:
    socketio_async_mode = 'gevent'
# 修改SocketIO初始化，添加更多选项
socketio = SocketIO(
    app, 
    cors_allowed_origins="*",
    async_mode=socketio_async_mode,
    logger=socketio_debug,
    engineio_logger=socketio_debug,
    ping_timeout=60,  # 增加ping超时时间
    ping_interval=25  # 增加ping间隔
)

from src.web import path_utils

async_runtime.setup_async_runtime(logger=logger)
get_or_create_loop = async_runtime.get_or_create_loop
run_async = async_runtime.run_async
path_utils.setup_path_utils(Config=Config)
setup_static_routes(get_resource_path=get_resource_path)
app.register_blueprint(static_assets_bp)
setup_response_helpers(Config=Config)

# 全局变量
api = None
downloader = None
user_manager = None
download_task_store = DownloadTaskStore(history_max_size=DOWNLOAD_TASK_HISTORY_MAX_SIZE)

# 主进程退出事件（Flask 子进程通过此事件通知主进程关闭）
_main_process_exit_event = None

# 更新辅助函数已抽离到 src/web/updater.py
from src.web import updater

def set_main_process_exit_event(event) -> None:
    global _main_process_exit_event
    _main_process_exit_event = event
    updater.set_main_process_exit_event(event)


_gui_queue = None

def set_gui_queue(queue):
    global _gui_queue
    _gui_queue = queue
    from src.web import cookie_login
    cookie_login.set_gui_queue(queue)
    try:
        from src.web import verify_routes
        verify_routes.set_gui_queue(queue)
    except Exception:
        pass

updater.setup_updater(
    logger=logger,
    Config=Config,
    http_requests=http_requests,
    socketio=socketio,
    is_windows=IS_WINDOWS,
    is_macos=IS_MACOS,
    latest_release_api_url=LATEST_RELEASE_API_URL,
    updater_metadata_url=UPDATER_METADATA_URL,
    updater_public_key=UPDATER_PUBLIC_KEY,
    latest_release_page_url=LATEST_RELEASE_PAGE_URL,
    main_process_exit_event=_main_process_exit_event,
)

# 媒体 URL 处理工具已抽离到 src/web/media_url_utils.py
from src.web import media_url_utils

def _get_user_manager_runtime():
    return user_manager

media_url_utils.setup_media_url_utils(
    logger=logger,
    http_requests=http_requests,
    get_user_manager=_get_user_manager_runtime,
)

def _guess_image_content_type_from_bytes(data: bytes) -> str:
    if data.startswith(b'\xff\xd8\xff'):
        return 'image/jpeg'
    if data.startswith(b'\x89PNG\r\n\x1a\n'):
        return 'image/png'
    if data.startswith(b'RIFF') and data[8:12] == b'WEBP':
        return 'image/webp'
    if data.startswith(b'GIF87a') or data.startswith(b'GIF89a'):
        return 'image/gif'
    return 'application/octet-stream'


def build_download_history() -> list[dict]:
    return get_download_history_items()



# 音乐/音频辅助函数已抽离到 src/web/audio_helpers.py
from src.web import audio_helpers

audio_helpers.setup_audio_helpers(
    Config=Config,
    coerce_int=coerce_int,
)


def _remember_media_redirect(cache_key: str | None, target_url: str) -> None:
    if not cache_key or not target_url:
        return
    if cache_key in MEDIA_PROXY_REDIRECT_CACHE:
        MEDIA_PROXY_REDIRECT_CACHE.pop(cache_key, None)
    elif len(MEDIA_PROXY_REDIRECT_CACHE) >= MEDIA_PROXY_REDIRECT_CACHE_MAX_SIZE:
        oldest_key = next(iter(MEDIA_PROXY_REDIRECT_CACHE), None)
        if oldest_key is not None:
            MEDIA_PROXY_REDIRECT_CACHE.pop(oldest_key, None)
    MEDIA_PROXY_REDIRECT_CACHE[cache_key] = target_url
def init_app():
    """初始化应用"""
    global api, downloader, user_manager
    try:
        Config.init()
        cookie = Config.COOKIE if Config.COOKIE else ''
        api = DouyinAPI(cookie)
        
        # 使用标准下载器
        downloader = DouyinDownloader(api, socketio=socketio)
        logger.info("Web服务使用标准下载器")
        
        # 传递socketio对象给用户管理器
        user_manager = DouyinUserManager(api, downloader, socketio=socketio,cookie=cookie)
        
        # 启动全局 Loop
        get_or_create_loop()

        logger.info("Web应用初始化完成")
    except Exception as e:
        logger.error(f"Web应用初始化失败: {str(e)}")




# 配置与好友聊天状态路由已抽离到 src/web/config_routes.py
from src.web.config_routes import config_bp, setup_config_routes

setup_config_routes(
    logger=logger,
    Config=Config,
    request_json=request_json,
    coerce_int=coerce_int,
    get_download_root=get_download_root,
    get_all_download_roots=get_all_download_roots,
    get_current_app_version=updater.get_current_app_version,
    init_app=init_app,
    move_directory_contents=move_directory_contents,
)
app.register_blueprint(config_bp)

# 更新检查与目录选择路由已抽离到 src/web/update_routes.py
from src.web.update_routes import update_routes_bp, setup_update_routes

setup_update_routes(
    logger=logger,
    Config=Config,
    is_windows=IS_WINDOWS,
    is_macos=IS_MACOS,
    latest_release_page_url=LATEST_RELEASE_PAGE_URL,
    get_current_app_version=updater.get_current_app_version,
)
app.register_blueprint(update_routes_bp)


# 账号管理路由已抽离到 src/web/accounts.py
from src.web.accounts import accounts_bp, setup_accounts

setup_accounts(
    Config=Config,
    request_json=request_json,
    init_app=init_app,
)
app.register_blueprint(accounts_bp)



# 下载历史相关路由已抽离到 src/web/download_history.py
from src.web.download_history import download_history_bp, setup_download_history

setup_download_history(
    logger=logger,
    Config=Config,
    is_windows=IS_WINDOWS,
    request_json=request_json,
    get_download_root=get_download_root,
    get_all_download_roots=get_all_download_roots,
    get_root_for_path=get_root_for_path,
    safe_history_path=safe_history_path,
    filter_download_history_items=filter_download_history_items,
    get_download_history_items=get_download_history_items,
    guess_local_media_mimetype=guess_local_media_mimetype,
    cleanup_empty_parent_dirs=cleanup_empty_parent_dirs,
    unique_destination_path=unique_destination_path,
    local_media_extensions=LOCAL_MEDIA_EXTENSIONS,
)
app.register_blueprint(download_history_bp)

# 媒体代理相关路由已抽离到 src/web/media_proxy.py
# setup_media_proxy 调用移到文件末尾，确保所有 helper 已定义
from src.web.media_proxy import media_proxy_bp, setup_media_proxy
app.register_blueprint(media_proxy_bp)


# 用户数据查询路由已抽离到 src/web/user_queries.py
# setup_user_queries 调用移到文件末尾，确保所有 helper 已定义
from src.web.user_queries import user_queries_bp, setup_user_queries
app.register_blueprint(user_queries_bp)



# 好友 IM 私信路由已抽离到 src/web/friend_im.py
from src.web.friend_im import friend_im_bp, setup_friend_im
from src.web import im_listener

im_listener.setup_im_listener(
    logger=logger,
    Config=Config,
    socketio=socketio,
    run_async=run_async,
    api_message=api_message,
)

setup_friend_im(
    logger=logger,
    Config=Config,
    request_json=request_json,
    coerce_int=coerce_int,
    run_async=run_async,
    api_message=api_message,
    ensure_im_message_listener=im_listener.ensure_im_message_listener,
    sanitize_sec_user_ids=im_listener.sanitize_sec_user_ids,
    save_im_friend_cache=im_listener.save_im_friend_cache,
    collect_sec_uid_records=im_listener.collect_sec_uid_records,
)
app.register_blueprint(friend_im_bp)

# 下载相关路由已抽离到 src/web/downloads_routes.py
from src.web.downloads_routes import downloads_bp, setup_downloads_routes

setup_downloads_routes(
    logger=logger,
    Config=Config,
    socketio=socketio,
    request_json=request_json,
    coerce_int=coerce_int,
    run_async=run_async,
    api_message=api_message,
    verify_error_response=verify_error_response,
    login_error_response=login_error_response,
    normalize_download_media_urls=media_url_utils.normalize_download_media_urls,
    build_download_title=build_download_title,
    build_download_name=build_download_name,
    get_or_create_loop=get_or_create_loop,
    task_store=download_task_store,
)

# 下载任务控制路由（取消/暂停/恢复）注册到同一个 downloads_bp
from src.web import download_events  # noqa: E402,F401
# 批量下载路由（点赞视频/点赞作者/aweme_id 下载）注册到同一个 downloads_bp
from src.web import batch_download_routes  # noqa: E402,F401
# 下载任务创建路由（单个作品/用户全部作品）注册到同一个 downloads_bp
from src.web import download_tasks  # noqa: E402,F401

app.register_blueprint(downloads_bp)

# 视频操作路由已抽离到 src/web/video_actions.py
from src.web.video_actions import video_actions_bp, setup_video_actions

setup_video_actions(
    logger=logger,
    request_json=request_json,
    run_async=run_async,
    api_message=api_message,
    coerce_bool=coerce_bool,
    verify_error_response=verify_error_response,
    login_error_response=login_error_response,
)
app.register_blueprint(video_actions_bp)

# 评论相关路由已抽离到 src/web/comments.py
from src.web.comments import comments_bp, setup_comments

setup_comments(
    logger=logger,
    request_json=request_json,
    coerce_int=coerce_int,
    run_async=run_async,
    api_message=api_message,
    verify_error_response=verify_error_response,
    login_error_response=login_error_response,
    format_comment_item=format_comment_item,
)
app.register_blueprint(comments_bp)

# 推荐流路由已抽离到 src/web/recommended_feed.py
from src.web.recommended_feed import recommended_feed_bp, setup_recommended_feed

def _get_api_runtime():
    return api

setup_recommended_feed(
    logger=logger,
    Config=Config,
    request_json=request_json,
    coerce_int=coerce_int,
    run_async=run_async,
    api_message=api_message,
    verify_error_response=verify_error_response,
    login_error_response=login_error_response,
    media_url_utils=media_url_utils,
    audio_helpers=audio_helpers,
    get_api=_get_api_runtime,
)
app.register_blueprint(recommended_feed_bp)

# 通知消息路由已抽离到 src/web/notices.py
from src.web.notices import notices_bp, setup_notices

setup_notices(
    logger=logger,
    request_json=request_json,
    coerce_int=coerce_int,
    run_async=run_async,
    api_message=api_message,
    verify_error_response=verify_error_response,
    login_error_response=login_error_response,
    get_api=_get_api_runtime,
)
app.register_blueprint(notices_bp)

# 下载任务状态路由已抽离到 src/web/task_routes.py
from src.web.task_routes import task_routes_bp, setup_task_routes

setup_task_routes(
    task_store=download_task_store,
)
app.register_blueprint(task_routes_bp)

register_socket_events(
    socketio=socketio,
    logger=logger,
    ensure_im_message_listener=im_listener.ensure_im_message_listener,
)

# ═══════════════════════════════════════════════
# COOKIE 浏览器登录（已抽离到 src/web/cookie_login.py）
# ═══════════════════════════════════════════════
from src.web.cookie_login import (
    cookie_login_bp,
    setup_cookie_login,
    _verify_native_cookie_login,
    _cookie_verify_cache,
    _core_login_cookie_signature,
    _save_cookie_login_success,
)
set_verify_native_cookie_login(_verify_native_cookie_login)

setup_cookie_login(
    socketio=socketio,
    logger=logger,
    Config=Config,
    DouyinAPI=DouyinAPI,
    run_async=run_async,
    init_app=init_app,
    stop_im_message_listener=im_listener.stop_im_message_listener,
    ensure_im_message_listener=im_listener.ensure_im_message_listener,
    api_message=api_message,
    avatar_url=avatar_url,
    request_json=request_json,
    coerce_int=coerce_int,
)
app.register_blueprint(cookie_login_bp)


# 添加一个定时发送心跳的函数
def send_heartbeat():
    """定时发送心跳消息"""
    logger.debug("发送WebSocket心跳消息")
    socketio.emit('heartbeat', {'timestamp': datetime.now().strftime('%H:%M:%S')})


@app.route('/api/health')
def health_check():
    startup_token = os.environ.get('BETTER_DOUYIN_STARTUP_TOKEN', '')
    request_token = request.args.get('token', '')
    if startup_token and request_token != startup_token:
        return jsonify({'success': False, 'message': 'token mismatch'}), 403
    return jsonify({
        'success': True,
        'app': 'better-douyin',
        'token': startup_token,
        'timestamp': datetime.now().isoformat(),
    })


def start_server(port=None):
    """启动Flask/SocketIO服务（在后台线程中调用）"""
    import os

    logger.info("启动抖音下载器Web服务...")
    logger.info(f"SocketIO async_mode: {socketio.async_mode}")

    host = (os.environ.get('HOST') or '127.0.0.1').strip() or '127.0.0.1'
    if port is None:
        port = find_available_port(host=host)

    # 初始化应用
    init_app()

    run_kwargs = {
        'app': app,
        'host': host,
        'port': port,
        'debug': False
    }
    if socketio.async_mode == 'threading':
        run_kwargs['allow_unsafe_werkzeug'] = True

    if host in ('0.0.0.0', '::'):
        logger.warning("Web服务已暴露到局域网/公网，请自行处理访问控制与 Cookie 风险")
    logger.info(f"Web服务开始监听: {host}:{port}")
    socketio.run(**run_kwargs)


def main():
    """启动Web服务（兼容旧版命令行启动方式）"""
    import os
    import webbrowser
    import threading
    import time

    host = (os.environ.get('HOST') or '127.0.0.1').strip() or '127.0.0.1'
    port = find_available_port(host=host)
    url = f"http://localhost:{port}"

    # 在后台线程启动服务
    server_thread = threading.Thread(target=start_server, kwargs={'port': port}, daemon=True)
    server_thread.start()

    # 等待服务就绪
    time.sleep(1.5)
    try:
        webbrowser.open(url)
        logger.info(f"已自动打开浏览器: {url}")
    except Exception as e:
        logger.warning(f"自动打开浏览器失败: {str(e)}")

    # 阻塞主线程，等待服务线程结束
    server_thread.join()


# 主页 / 验证页面 / Cookie 校验路由已抽离到 src/web/verify_routes.py
from src.web.verify_routes import verify_routes_bp, setup_verify_routes

setup_verify_routes(
    logger=logger,
    Config=Config,
    request_json=request_json,
    get_react_dist_dir=get_react_dist_dir,
    verify_native_cookie_login=_verify_native_cookie_login,
    core_login_cookie_signature=_core_login_cookie_signature,
    save_cookie_login_success=_save_cookie_login_success,
)
app.register_blueprint(verify_routes_bp)


# 模块加载完成后注入媒体代理模块的依赖（部分 helper 定义在文件后段）
setup_media_proxy(
    logger=logger,
    sanitize_download_filename=audio_helpers.sanitize_download_filename,
    allowed_media_request_origin=media_url_utils.allowed_media_request_origin,
    is_allowed_media_url=media_url_utils.is_allowed_media_url,
    cap_media_range_header=_cap_media_range_header,
    media_proxy_redirect_cache=MEDIA_PROXY_REDIRECT_CACHE,
    media_proxy_max_retries=MEDIA_PROXY_MAX_RETRIES,
    media_url_label=media_url_utils.media_url_label,
    should_forward_douyin_cookie=media_url_utils.should_forward_douyin_cookie,
    resolve_media_redirect_target=media_url_utils.resolve_media_redirect_target,
    remember_media_redirect=_remember_media_redirect,
    guess_audio_content_type=audio_helpers.guess_audio_content_type,
    build_content_disposition=audio_helpers.build_content_disposition,
    guess_image_content_type_from_bytes=_guess_image_content_type_from_bytes,
    guess_audio_extension=audio_helpers.guess_audio_extension,
)

# 用户数据查询模块的依赖（部分 helper 定义在文件后段）
setup_user_queries(
    logger=logger,
    Config=Config,
    request_json=request_json,
    coerce_int=coerce_int,
    run_async=run_async,
    api_message=api_message,
    verify_error_response=verify_error_response,
    login_error_response=login_error_response,
    verify_error_response_without_login_check=verify_error_response_without_login_check,
    verify_or_request_error_response=verify_or_request_error_response,
    feature_login_error_response=feature_login_error_response,
    search_user_payload=search_user_payload,
    user_detail_payload=user_detail_payload,
    safe_get_url=safe_get_url,
    extract_music_info=audio_helpers.extract_music_info,
    raw_duration_value=audio_helpers.raw_duration_value,
)


if __name__ == '__main__':
    main()
