"""好友 IM 私信相关路由。

从 web_app.py 抽离。模块内部依赖通过 setup 注入，
外部调用方（web_app.py）需要在导入本模块后调用 setup_friend_im(...)。
"""
from __future__ import annotations

from typing import Any, Callable

from flask import Blueprint, jsonify
from src.api.im_formatters import collect_spotlight_recent_interactions

friend_im_bp = Blueprint("friend_im", __name__)

# 注入的依赖
_logger = None
_Config = None
_request_json: Callable[[], dict] | None = None
_coerce_int: Callable[..., int] | None = None
_run_async: Callable[..., Any] | None = None
_api_message: Callable[..., str] | None = None
_ensure_im_message_listener: Callable[[], None] | None = None
_sanitize_sec_user_ids: Callable[[list], list] | None = None
_save_im_friend_cache: Callable[[list], None] | None = None
_collect_sec_uid_records: Callable[[Any], list] | None = None


def setup_friend_im(
    *,
    logger,
    Config,
    request_json: Callable[[], dict],
    coerce_int: Callable[..., int],
    run_async: Callable[..., Any],
    api_message: Callable[..., str],
    ensure_im_message_listener: Callable[[], None],
    sanitize_sec_user_ids: Callable[[list], list],
    save_im_friend_cache: Callable[[list], None],
    collect_sec_uid_records: Callable[[Any], list],
) -> None:
    """注入 web_app 模块的全局对象，避免循环导入。"""
    global _logger, _Config, _request_json, _coerce_int, _run_async
    global _api_message, _ensure_im_message_listener, _sanitize_sec_user_ids
    global _save_im_friend_cache, _collect_sec_uid_records
    _logger = logger
    _Config = Config
    _request_json = request_json
    _coerce_int = coerce_int
    _run_async = run_async
    _api_message = api_message
    _ensure_im_message_listener = ensure_im_message_listener
    _sanitize_sec_user_ids = sanitize_sec_user_ids
    _save_im_friend_cache = save_im_friend_cache
    _collect_sec_uid_records = collect_sec_uid_records


def _get_api():
    """延迟读取 web_app.api，避免 setup 时 api 还未初始化。"""
    from src.web import web_app
    return web_app.api


@friend_im_bp.route('/api/get_friend_online_status', methods=['POST'])
def get_friend_online_status_api():
    """获取 IM 好友资料与在线状态。"""
    try:
        data = _request_json()
        _ensure_im_message_listener()
        provided_ids = data.get('sec_user_ids') or data.get('secUserIds') or []
        conv_ids = data.get('conv_ids') or data.get('convIds') or []
        offset = _coerce_int(data.get('offset'), 0, 0)
        limit = _coerce_int(data.get('limit'), 20, 1, 100)
        sec_user_ids = _sanitize_sec_user_ids(provided_ids)
        has_provided_ids = bool(sec_user_ids)

        if has_provided_ids:
            merged = _Config.normalize_sec_user_ids([*getattr(_Config, 'IM_FRIEND_SEC_USER_IDS', []), *sec_user_ids])
            if merged != getattr(_Config, 'IM_FRIEND_SEC_USER_IDS', []):
                _save_im_friend_cache(merged)

        if not sec_user_ids:
            sec_user_ids = _Config.normalize_sec_user_ids(getattr(_Config, 'IM_FRIEND_SEC_USER_IDS', []))

        api = _get_api()
        if not api:
            return jsonify({'success': False, 'need_login': True, 'message': '请先设置 Cookie'})

        fetched_ids, auto_success, auto_response = _run_async(
            api.get_im_spotlight_relation_sec_user_ids(
                500,
                bool(getattr(_Config, 'IM_FRIEND_INCLUDE_ALL_USERS', False)),
            )
        )
        recent_interactions = collect_spotlight_recent_interactions(auto_response if isinstance(auto_response, dict) else {})
        if auto_success:
            sec_user_ids = _Config.normalize_sec_user_ids(fetched_ids)
            if sec_user_ids != getattr(_Config, 'IM_FRIEND_SEC_USER_IDS', []):
                _save_im_friend_cache(sec_user_ids)
        elif not sec_user_ids:
            return jsonify({
                'success': False,
                'message': _api_message(auto_response, '没有获取到 IM 好友关系；Cookie 可用，但 spotlight relation 没有返回可用 sec_user_id。'),
            })

        # Fallback: spotlight 返回空时，用关注列表补全（与 Rust 版本一致）
        if not sec_user_ids:
            current_user, cu_success = _run_async(api.get_current_user())
            if cu_success and isinstance(current_user, dict):
                uid = str(current_user.get('uid') or '').strip()
                cu_sec_uid = str(current_user.get('sec_uid') or '').strip()
                if uid and cu_sec_uid:
                    include_all = bool(getattr(_Config, 'IM_FRIEND_INCLUDE_ALL_USERS', False))
                    following_ids, fw_success, _ = _run_async(
                        api.get_following_sec_user_ids(uid, cu_sec_uid, 500, not include_all)
                    )
                    if fw_success and following_ids:
                        sec_user_ids = _Config.normalize_sec_user_ids(following_ids)
                        merged = _Config.normalize_sec_user_ids([
                            *getattr(_Config, 'IM_FRIEND_SEC_USER_IDS', []),
                            *sec_user_ids,
                        ])
                        if merged != getattr(_Config, 'IM_FRIEND_SEC_USER_IDS', []):
                            _save_im_friend_cache(merged)
                        sec_user_ids = merged

        if not sec_user_ids:
            return jsonify({
                'success': False,
                'message': '没有获取到 IM 好友关系；Cookie 可用，但 spotlight relation 和关注列表都没有返回可用 sec_user_id。',
            })

        all_sec_user_ids = list(sec_user_ids)
        total_count = len(all_sec_user_ids)
        page_offset = min(offset, total_count)
        page_sec_user_ids = all_sec_user_ids[page_offset:page_offset + limit]
        next_offset = page_offset + len(page_sec_user_ids)

        user_info_data = []
        active_status_data = []
        user_info_extra = None
        active_status_extra = None
        conv_ids = [str(value).strip() for value in conv_ids if str(value).strip()] if isinstance(conv_ids, list) else []

        for index in range(0, len(page_sec_user_ids), 20):
            chunk = page_sec_user_ids[index:index + 20]
            user_info, user_success = _run_async(api.get_im_user_info(chunk))
            if not user_success:
                return jsonify({
                    'success': False,
                    'message': _api_message(user_info, '获取好友资料失败'),
                    'need_login': bool(isinstance(user_info, dict) and user_info.get('_need_login')),
                    'need_verify': bool(isinstance(user_info, dict) and user_info.get('_need_verify')),
                    'verify_url': user_info.get('_verify_url') if isinstance(user_info, dict) else None,
                })
            if user_info_extra is None and isinstance(user_info, dict):
                user_info_extra = user_info.get('extra')
            user_info_data.extend(_collect_sec_uid_records(user_info))

            active_status, active_success = _run_async(api.get_im_user_active_status(chunk, conv_ids))
            if not active_success:
                return jsonify({
                    'success': False,
                    'message': _api_message(active_status, '获取好友在线状态失败'),
                    'need_login': bool(isinstance(active_status, dict) and active_status.get('_need_login')),
                    'need_verify': bool(isinstance(active_status, dict) and active_status.get('_need_verify')),
                    'verify_url': active_status.get('_verify_url') if isinstance(active_status, dict) else None,
                })
            if active_status_extra is None and isinstance(active_status, dict):
                active_status_extra = active_status.get('extra')
            active_status_data.extend(_collect_sec_uid_records(active_status))

        return jsonify({
            'success': True,
            'message': '获取好友在线状态成功',
            'sec_user_ids': page_sec_user_ids,
            'all_sec_user_ids': all_sec_user_ids,
            'recent_interactions': recent_interactions,
            'offset': page_offset,
            'limit': limit,
            'next_offset': next_offset,
            'total_count': total_count,
            'has_more': next_offset < total_count,
            'user_info': {
                'data': user_info_data,
                'extra': user_info_extra,
            },
            'active_status': {
                'data': active_status_data,
                'extra': active_status_extra,
            },
        })
    except Exception as e:
        return jsonify({'success': False, 'message': f'获取好友在线状态失败: {str(e)}'}), 500


@friend_im_bp.route('/api/get_share_friends', methods=['POST'])
def get_share_friends_api():
    """获取视频分享面板可展示的好友列表。"""
    try:
        api = _get_api()
        if not api:
            return jsonify({'success': False, 'need_login': True, 'message': '请先设置 Cookie'})

        data = _request_json()
        count = _coerce_int(data.get('count'), 50, 1, 100)
        result, success = _run_async(api.get_im_share_friends(count))
        if not success:
            return jsonify({
                'success': False,
                'message': _api_message(result, '获取分享好友失败'),
                'need_login': bool(isinstance(result, dict) and result.get('_need_login')),
                'need_verify': bool(isinstance(result, dict) and result.get('_need_verify')),
                'verify_url': result.get('_verify_url') if isinstance(result, dict) else None,
            })

        friends = result.get('friends') if isinstance(result, dict) else []
        return jsonify({
            'success': True,
            'message': result.get('message') if isinstance(result, dict) else '获取分享好友成功',
            'friends': friends if isinstance(friends, list) else [],
            'count': len(friends) if isinstance(friends, list) else 0,
            'has_more': bool(result.get('has_more')) if isinstance(result, dict) else False,
        })
    except Exception as e:
        return jsonify({'success': False, 'message': f'获取分享好友失败: {str(e)}'}), 500


@friend_im_bp.route('/api/send_friend_message', methods=['POST'])
def send_friend_message_api():
    """发送文本私信。"""
    try:
        _ensure_im_message_listener()
        data = _request_json()
        to_user_id = data.get('to_user_id') or data.get('toUserId') or data.get('uid') or ''
        content = str(data.get('content') or data.get('message') or '').strip()
        if not str(to_user_id).strip():
            return jsonify({'success': False, 'message': '缺少好友数字 uid，无法发送私信'}), 400
        if not content:
            return jsonify({'success': False, 'message': '消息内容不能为空'}), 400
        api = _get_api()
        if not api:
            return jsonify({'success': False, 'need_login': True, 'message': '请先设置 Cookie'})

        result, success = _run_async(api.send_im_text_message(to_user_id, content), timeout=60)
        return jsonify({
            'success': bool(success),
            **(result if isinstance(result, dict) else {'message': str(result)}),
        })
    except Exception as e:
        return jsonify({'success': False, 'message': f'发送私信失败: {str(e)}'}), 500


@friend_im_bp.route('/api/send_friend_image_message', methods=['POST'])
def send_friend_image_message_api():
    """发送图片私信。"""
    try:
        _ensure_im_message_listener()
        data = _request_json()
        to_user_id = data.get('to_user_id') or data.get('toUserId') or data.get('uid') or ''
        image_data_url = str(data.get('image_data_url') or data.get('imageDataUrl') or '').strip()
        if not str(to_user_id).strip():
            return jsonify({'success': False, 'message': '缺少好友数字 uid，无法发送图片'}), 400
        if not image_data_url:
            return jsonify({'success': False, 'message': '图片内容不能为空'}), 400
        if len(image_data_url) > 8 * 1024 * 1024:
            return jsonify({'success': False, 'message': '图片太大，请选择 8MB 以内的图片'}), 400
        api = _get_api()
        if not api:
            return jsonify({'success': False, 'need_login': True, 'message': '请先设置 Cookie'})

        result, success = _run_async(
            api.send_im_image_message(
                to_user_id,
                image_data_url,
                data.get('width') or 0,
                data.get('height') or 0,
                str(data.get('file_name') or data.get('fileName') or ''),
                str(data.get('mime_type') or data.get('mimeType') or ''),
            ),
            timeout=60,
        )
        return jsonify({
            'success': bool(success),
            **(result if isinstance(result, dict) else {'message': str(result)}),
        })
    except Exception as e:
        return jsonify({'success': False, 'message': f'发送图片私信失败: {str(e)}'}), 500


@friend_im_bp.route('/api/send_friend_video_share', methods=['POST'])
def send_friend_video_share_api():
    """发送视频分享卡片私信。"""
    try:
        _ensure_im_message_listener()
        data = _request_json()
        to_user_id = data.get('to_user_id') or data.get('toUserId') or data.get('uid') or ''
        video = data.get('video') if isinstance(data.get('video'), dict) else data
        if not str(to_user_id).strip():
            return jsonify({'success': False, 'message': '缺少好友数字 uid，无法分享视频'}), 400
        if not isinstance(video, dict) or not str(video.get('aweme_id') or video.get('itemId') or '').strip():
            return jsonify({'success': False, 'message': '缺少作品信息，无法分享视频'}), 400
        api = _get_api()
        if not api:
            return jsonify({'success': False, 'need_login': True, 'message': '请先设置 Cookie'})

        result, success = _run_async(api.send_im_video_share_message(to_user_id, video), timeout=60)
        return jsonify({
            'success': bool(success),
            **(result if isinstance(result, dict) else {'message': str(result)}),
        })
    except Exception as e:
        return jsonify({'success': False, 'message': f'分享视频失败: {str(e)}'}), 500


@friend_im_bp.route('/api/get_friend_message_history', methods=['POST'])
def get_friend_message_history_api():
    """获取最近的 IM 历史消息。"""
    try:
        data = _request_json()
        cursor = _coerce_int(data.get('cursor'), 0, 0)
        to_user_id = data.get('to_user_id') or data.get('toUserId') or data.get('uid') or None
        conversation_id = data.get('conversation_id') or data.get('conversationId') or None
        conversation_short_id = _coerce_int(data.get('conversation_short_id') or data.get('conversationShortId'), 0, 0)
        conversation_type = _coerce_int(data.get('conversation_type') or data.get('conversationType'), 1, 1)
        api = _get_api()
        if not api:
            return jsonify({'success': False, 'need_login': True, 'message': '请先设置 Cookie'})
        result, success = _run_async(
            api.get_im_history_messages(
                cursor=cursor,
                to_user_id=to_user_id,
                conversation_id=conversation_id,
                conversation_short_id=conversation_short_id,
                conversation_type=conversation_type,
            ),
            timeout=60,
        )
        if isinstance(result, dict):
            _logger.info(
                "friend message history: cursor=%s to_user_id_present=%s conversation_id_present=%s messages=%s next_cursor=%s has_more=%s",
                cursor,
                bool(to_user_id),
                bool(conversation_id),
                len(result.get('messages') or []) if isinstance(result.get('messages'), list) else 0,
                result.get('next_cursor'),
                result.get('has_more'),
            )
        return jsonify({
            'success': bool(success),
            **(result if isinstance(result, dict) else {'message': str(result)}),
        })
    except Exception as e:
        return jsonify({'success': False, 'message': f'获取历史消息失败: {str(e)}'}), 500
