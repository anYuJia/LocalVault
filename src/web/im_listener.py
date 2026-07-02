"""抖音 IM 私信 WebSocket 监听器与好友缓存辅助函数。

从 web_app.py 抽离。模块内部依赖通过 setup_im_listener 注入。
"""
from __future__ import annotations

import hashlib
import json
import threading
import time
from typing import Callable
from urllib.parse import urlencode

from src.api import douyin_im_proto

# 注入的依赖
_logger = None
_Config = None
_socketio = None
_run_async: Callable[..., object] | None = None
_api_message: Callable[..., str] | None = None

# 模块内状态
_im_message_ws = None
_im_message_thread = None
_im_message_stop_event = threading.Event()
_im_message_lock = threading.Lock()
_im_message_start_timer = None

_IM_RECONNECT_BASE_SECONDS = 5
_IM_RECONNECT_MAX_SECONDS = 60


def setup_im_listener(
    *,
    logger,
    Config,
    socketio,
    run_async: Callable[..., object],
    api_message: Callable[..., str],
) -> None:
    """注入 web_app 模块的全局对象，避免循环导入。"""
    global _logger, _Config, _socketio, _run_async, _api_message
    _logger = logger
    _Config = Config
    _socketio = socketio
    _run_async = run_async
    _api_message = api_message


def _get_api():
    """延迟读取 web_app.api，避免 setup 时 api 还未初始化。"""
    from src.web import web_app
    return web_app.api


def sanitize_sec_user_ids(values):
    if not isinstance(values, list):
        return []
    result = []
    seen = set()
    for item in values:
        value = str(item or '').strip()
        if not value or not value.startswith('MS4w') or value in seen:
            continue
        seen.add(value)
        result.append(value)
    return result


def collect_sec_uid_records(value):
    records = []
    seen = set()

    def visit(item):
        if isinstance(item, list):
            for child in item:
                visit(child)
            return
        if not isinstance(item, dict):
            return
        sec_uid = str(item.get('sec_uid') or item.get('sec_user_id') or '').strip()
        if sec_uid and sec_uid not in seen:
            seen.add(sec_uid)
            records.append(item)
        for child in item.values():
            if isinstance(child, (dict, list)):
                visit(child)

    visit(value)
    return records


def save_im_friend_cache(sec_user_ids=None):
    if sec_user_ids is not None:
        _Config.IM_FRIEND_SEC_USER_IDS = _Config.normalize_sec_user_ids(sec_user_ids)
    current_sec_uid = str(getattr(_Config, 'CURRENT_SEC_UID', '') or '').strip()
    if current_sec_uid:
        accounts = []
        for account in list(getattr(_Config, 'ACCOUNTS', []) or []):
            if account.get('sec_uid') == current_sec_uid:
                account = {
                    **account,
                    'im_friend_sec_user_ids': list(getattr(_Config, 'IM_FRIEND_SEC_USER_IDS', []) or []),
                }
            accounts.append(account)
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


def _im_cookie_dict(cookie: str) -> dict:
    result = {}
    for item in str(cookie or '').split(';'):
        if '=' in item:
            key, value = item.strip().split('=', 1)
            if key:
                result[key] = value
    return result


def _extract_text_message(message: dict) -> str:
    content = str((message or {}).get('content') or '')
    if not content:
        return ''
    try:
        parsed = json.loads(content)
        if isinstance(parsed, dict):
            if 'command_type' in parsed or parsed.get('command_type') == 6:
                ext_data = parsed.get('ext_data') or []
                found_spark = False
                text = ""
                for ext_item in ext_data:
                    if isinstance(ext_item, dict) and ext_item.get('key') == 'a:consecutive_chat_data':
                        text = "🔥 连续聊天火花已亮起"
                        found_spark = True
                        val_str = ext_item.get('value') or '{}'
                        try:
                            val_json = json.loads(val_str)
                            count_info = val_json.get('consecutive_count_info') or {}
                            count = count_info.get('consecutive_count') or 1
                            text = f"🔥 连续聊天火花已亮起（第 {count} 天）"
                        except Exception:
                            pass
                if found_spark:
                    return text
                else:
                    return '__FILTERED_CONTROL_MESSAGE__'
            return str(parsed.get('text') or parsed.get('tips') or parsed.get('hint_text') or '')
    except Exception:
        pass
    return content


def _emit_im_message(response: dict) -> None:
    sent = douyin_im_proto.sent_message(response)
    if not sent:
        return
    try:
        content = _extract_text_message({'content': sent.content})
        if content == '__FILTERED_CONTROL_MESSAGE__' or not content:
            return
        payload = {
            'conversation_id': sent.conversation_id,
            'conversation_short_id': sent.conversation_short_id,
            'conversation_type': sent.conversation_type,
            'server_message_id': sent.server_message_id,
            'index_in_conversation': sent.index_in_conversation,
            'sender_uid': str(sent.sender or ''),
            'content': content,
            'raw_content': sent.content,
            'created_at': int(time.time() * 1000),
        }
        _logger.info(
            'Douyin IM websocket message: conversation=%s sender=%s message_id=%s text_len=%s',
            payload['conversation_id'],
            payload['sender_uid'],
            payload['server_message_id'],
            len(content),
        )
        _socketio.emit('im_message', payload)
    except Exception as error:
        _logger.warning('解析 IM WebSocket 消息失败: %s', error)


def stop_im_message_listener() -> None:
    global _im_message_ws
    _im_message_stop_event.set()
    ws = _im_message_ws
    _im_message_ws = None
    if ws is not None:
        try:
            ws.close()
        except Exception:
            pass


def ensure_im_message_listener() -> None:
    global _im_message_thread, _im_message_start_timer
    api = _get_api()
    if not api or not _Config.COOKIE:
        return
    with _im_message_lock:
        if _im_message_thread and _im_message_thread.is_alive():
            return
        if _im_message_start_timer is not None:
            return  # Timer already scheduled

        def _delayed_start():
            global _im_message_thread, _im_message_start_timer
            with _im_message_lock:
                _im_message_start_timer = None
                if _im_message_thread and _im_message_thread.is_alive():
                    return
                _im_message_stop_event.clear()
                _im_message_thread = threading.Thread(
                    target=_run_im_message_listener, daemon=True
                )
                _im_message_thread.start()

        _im_message_start_timer = threading.Timer(30.0, _delayed_start)
        _im_message_start_timer.daemon = True
        _im_message_start_timer.start()


def _run_im_message_listener() -> None:
    global _im_message_ws
    api = _get_api()
    try:
        try:
            import websocket
        except Exception:
            _logger.warning('未安装 websocket-client，无法接收 IM 消息')
            _socketio.emit('im_status', {'connected': False, 'message': '缺少 websocket-client，无法接收私信'})
            return
        import ssl

        reconnect_delay = _IM_RECONNECT_BASE_SECONDS

        def on_open(ws):
            nonlocal reconnect_delay
            reconnect_delay = _IM_RECONNECT_BASE_SECONDS
            _logger.info('Douyin IM WebSocket 已连接')
            _socketio.emit('im_status', {'connected': True, 'message': '私信接收已连接'})

        def on_message(ws, message):
            try:
                data = message if isinstance(message, bytes) else bytes(message or b'')
                frame = douyin_im_proto.parse_push_frame(data)
                response_data = frame.get('response')
                if isinstance(response_data, dict):
                    _emit_im_message(response_data)
                elif frame.get('payload_type') == 'text/json':
                    _logger.debug('Douyin IM WebSocket JSON: %s', frame.get('payload'))
            except Exception as error:
                _logger.warning('处理 IM WebSocket 消息失败: %s', error)

        def on_error(ws, error):
            _logger.warning('Douyin IM WebSocket 错误: %s', error)
            _socketio.emit('im_status', {'connected': False, 'message': f'私信接收连接错误: {error}'})

        def on_close(ws, close_status_code, close_msg):
            _logger.info('Douyin IM WebSocket 已关闭: status=%s msg=%s', close_status_code, close_msg)
            _socketio.emit('im_status', {'connected': False, 'message': '私信接收已断开'})

        while not _im_message_stop_event.is_set():
            cookie_dict = _im_cookie_dict(_Config.COOKIE)
            sessionid = cookie_dict.get('sessionid') or cookie_dict.get('sessionid_ss') or ''
            if not sessionid:
                _logger.info('IM WebSocket 未启动：Cookie 缺少 sessionid')
                _socketio.emit('im_status', {'connected': False, 'message': 'Cookie 缺少 sessionid，私信接收未启动'})
                return

            device_id, success, response = _run_async(api.get_im_device_id(), timeout=30)
            if not success or not device_id:
                message = _api_message(response, '未知错误') if isinstance(response, dict) else response
                _logger.warning('IM WebSocket 获取 device_id 失败: %s', message)
                _socketio.emit('im_status', {'connected': False, 'message': f'私信接收重连准备失败: {message}'})
                if _im_message_stop_event.wait(reconnect_delay):
                    break
                reconnect_delay = min(reconnect_delay * 2, _IM_RECONNECT_MAX_SECONDS)
                continue

            app_key = 'e1bd35ec9db7b8d846de66ed140b1ad9'
            fp_id = '9'
            access_key = hashlib.md5(f'{fp_id}{app_key}{device_id}f8a69f1719916z'.encode('utf-8')).hexdigest()
            params = urlencode({
                'aid': '6383',
                'device_platform': 'douyin_pc',
                'fpid': fp_id,
                'device_id': device_id,
                'token': sessionid,
                'access_key': access_key,
            })
            url = f'wss://frontier-im.douyin.com/ws/v2?{params}'

            _socketio.emit('im_status', {'connected': False, 'message': '正在连接私信接收'})
            _im_message_ws = websocket.WebSocketApp(
                url,
                header={
                    'Pragma': 'no-cache',
                    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6',
                    'User-Agent': getattr(api, 'common_headers', {}).get('User-Agent', ''),
                    'Cache-Control': 'no-cache',
                    'Sec-WebSocket-Protocol': 'binary, base64, pbbp2',
                    'Sec-WebSocket-Extensions': 'permessage-deflate; client_max_window_bits',
                },
                cookie=_Config.COOKIE,
                on_open=on_open,
                on_message=on_message,
                on_error=on_error,
                on_close=on_close,
            )
            _im_message_ws.run_forever(
                origin='https://www.douyin.com',
                sslopt={'cert_reqs': ssl.CERT_NONE, 'check_hostname': False},
                ping_interval=25,
                ping_timeout=10,
            )
            _im_message_ws = None
            if _im_message_stop_event.is_set():
                break
            _logger.info('Douyin IM WebSocket 将在 %s 秒后重连', reconnect_delay)
            _socketio.emit('im_status', {'connected': False, 'message': f'私信接收已断开，{reconnect_delay} 秒后重连'})
            if _im_message_stop_event.wait(reconnect_delay):
                break
            reconnect_delay = min(reconnect_delay * 2, _IM_RECONNECT_MAX_SECONDS)
    except Exception as error:
        _logger.warning('IM WebSocket 监听线程退出: %s', error)
    finally:
        _im_message_ws = None
