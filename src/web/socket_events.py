"""Socket.IO connection and diagnostic events."""
from __future__ import annotations

from datetime import datetime

from flask_socketio import emit

_logger = None
_socketio = None
_ensure_im_message_listener = None


def register_socket_events(*, socketio, logger, ensure_im_message_listener) -> None:
    global _logger, _socketio, _ensure_im_message_listener
    _logger = logger
    _socketio = socketio
    _ensure_im_message_listener = ensure_im_message_listener

    @socketio.on('connect')
    def handle_connect():
        """客户端连接"""
        _logger.debug("客户端已连接")
        _ensure_im_message_listener()
        emit('connected', {'message': '连接成功'})

    @socketio.on('disconnect')
    def handle_disconnect():
        """客户端断开连接"""
        _logger.debug("客户端已断开连接")

    @socketio.on('test_connection')
    def handle_test_connection(data):
        """测试WebSocket连接"""
        _logger.debug(f"收到测试连接请求: {data}")
        emit('test_response', {'message': '连接测试成功', 'received': data})
        _socketio.emit('broadcast_message', {
            'message': '服务器广播测试消息',
            'time': datetime.now().strftime('%H:%M:%S'),
        })
