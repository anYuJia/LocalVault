"""视频操作路由（详情、点赞、收藏、关注、链接解析）。

从 web_app.py 抽离。模块内部依赖通过 setup 注入。
"""
from __future__ import annotations

from typing import Any, Callable

from flask import Blueprint, jsonify

video_actions_bp = Blueprint("video_actions", __name__)

# 注入的依赖
_logger = None
_request_json: Callable[[], dict] | None = None
_run_async: Callable[..., Any] | None = None
_api_message: Callable[..., str] | None = None
_coerce_bool: Callable[..., bool] | None = None
_verify_error_response: Callable[..., dict] | None = None
_login_error_response: Callable[..., dict] | None = None


def setup_video_actions(
    *,
    logger,
    request_json: Callable[[], dict],
    run_async: Callable[..., Any],
    api_message: Callable[..., str],
    coerce_bool: Callable[..., bool],
    verify_error_response: Callable[..., dict],
    login_error_response: Callable[..., dict],
) -> None:
    """注入 web_app 模块的全局对象，避免循环导入。"""
    global _logger, _request_json, _run_async, _api_message
    global _coerce_bool, _verify_error_response, _login_error_response
    _logger = logger
    _request_json = request_json
    _run_async = run_async
    _api_message = api_message
    _coerce_bool = coerce_bool
    _verify_error_response = verify_error_response
    _login_error_response = login_error_response


def _get_user_manager():
    """延迟读取 web_app.user_manager，避免 setup 时还未初始化。"""
    from src.web import web_app
    return web_app.user_manager


@video_actions_bp.route('/api/video_detail', methods=['POST'])
def get_video_detail():
    """获取视频详情"""
    try:
        data = _request_json()
        aweme_id = data.get('aweme_id', '').strip()

        if not aweme_id:
            return jsonify({'success': False, 'message': '视频ID不能为空'}), 400

        user_manager = _get_user_manager()
        if not user_manager:
            return jsonify({'success': False, 'message': '请先设置Cookie'}), 400

        video_detail = _run_async(user_manager.get_video_detail(aweme_id))

        if isinstance(video_detail, dict) and video_detail.get('_need_verify'):
            return jsonify(_verify_error_response(video_detail, '需要完成滑块验证'))
        if isinstance(video_detail, dict) and video_detail.get('_need_login'):
            return jsonify(_login_error_response(video_detail))

        if not video_detail:
            _logger.warning(f"视频详情为空，可能是视频不存在或 API 限流：aweme_id={aweme_id}")
            return jsonify({
                'success': False,
                'message': '获取视频详情失败，可能是视频不存在或抖音 API 限流，请尝试其他视频或重新登录'
            }), 404

        return jsonify({
            'success': True,
            'video': video_detail
        })
    except Exception as e:
        _logger.error(f'获取视频详情异常: {str(e)}', exc_info=True)
        return jsonify({'success': False, 'message': f'获取视频详情失败: {str(e)}'}), 500


@video_actions_bp.route('/api/video_like', methods=['POST'])
def set_video_liked_api():
    """点赞或取消点赞作品"""
    try:
        data = _request_json()
        aweme_id = str(data.get('aweme_id') or '').strip()
        liked = _coerce_bool(data.get('liked'), False)

        if not aweme_id:
            return jsonify({'success': False, 'message': '作品ID不能为空'}), 400
        user_manager = _get_user_manager()
        if not user_manager:
            return jsonify({'success': False, 'message': '请先设置Cookie'}), 400

        result = _run_async(user_manager.set_video_liked(aweme_id, liked))
        if isinstance(result, dict):
            if result.get('_security_blocked'):
                return jsonify({
                    'success': False,
                    'security_blocked': True,
                    'message': _api_message(result, '点赞被抖音安全校验拒绝，请稍后重试'),
                })
            if result.get('_need_verify'):
                return jsonify(_verify_error_response(result, '点赞失败，请完成验证后重试'))
            if result.get('_need_login'):
                return jsonify(_login_error_response(result))
            if result.get('_error') or result.get('status_code', 0) not in (0, None):
                return jsonify({
                    'success': False,
                    'message': _api_message(result, '点赞失败，请检查 Cookie 或稍后重试'),
                })

        return jsonify({
            'success': True,
            'aweme_id': aweme_id,
            'is_liked': result.get('is_liked', liked) if isinstance(result, dict) else liked,
            'raw': result.get('raw') if isinstance(result, dict) else None,
            'message': result.get('message') if isinstance(result, dict) else ('点赞成功' if liked else '已取消点赞'),
        })
    except Exception as e:
        _logger.error(f'设置点赞状态异常: {str(e)}', exc_info=True)
        return jsonify({'success': False, 'message': f'点赞失败: {str(e)}'}), 500


@video_actions_bp.route('/api/video_collect', methods=['POST'])
def set_video_collected_api():
    """收藏或取消收藏作品"""
    try:
        data = _request_json()
        aweme_id = str(data.get('aweme_id') or '').strip()
        collected = _coerce_bool(data.get('collected'), False)

        if not aweme_id:
            return jsonify({'success': False, 'message': '作品ID不能为空'}), 400
        user_manager = _get_user_manager()
        if not user_manager:
            return jsonify({'success': False, 'message': '请先设置Cookie'}), 400

        result = _run_async(user_manager.set_video_collected(aweme_id, collected))
        if isinstance(result, dict):
            if result.get('_security_blocked'):
                return jsonify({
                    'success': False,
                    'security_blocked': True,
                    'message': _api_message(result, '收藏被抖音安全校验拒绝，请稍后重试'),
                })
            if result.get('_need_verify'):
                return jsonify(_verify_error_response(result, '收藏失败，请完成验证后重试'))
            if result.get('_need_login'):
                return jsonify(_login_error_response(result))
            if result.get('_error') or result.get('status_code', 0) not in (0, None):
                return jsonify({
                    'success': False,
                    'message': _api_message(result, '收藏失败，请检查 Cookie 或稍后重试'),
                })

        return jsonify({
            'success': True,
            'aweme_id': aweme_id,
            'is_collected': collected,
            'message': '收藏成功' if collected else '已取消收藏',
        })
    except Exception as e:
        _logger.error(f'设置收藏状态异常: {str(e)}', exc_info=True)
        return jsonify({'success': False, 'message': f'收藏失败: {str(e)}'}), 500


@video_actions_bp.route('/api/user_follow', methods=['POST'])
def set_user_followed_api():
    """关注或取消关注用户"""
    try:
        data = _request_json()
        user_id = str(data.get('user_id') or data.get('uid') or '').strip()
        follow = _coerce_bool(data.get('follow'), False)

        if not user_id:
            return jsonify({'success': False, 'message': '用户ID不能为空'}), 400
        user_manager = _get_user_manager()
        if not user_manager:
            return jsonify({'success': False, 'message': '请先设置Cookie'}), 400

        result = _run_async(user_manager.set_user_followed(user_id, follow))
        if isinstance(result, dict):
            if result.get('_security_blocked'):
                return jsonify({
                    'success': False,
                    'security_blocked': True,
                    'message': _api_message(result, '关注被抖音安全校验拒绝，请稍后重试'),
                })
            if result.get('_need_verify'):
                return jsonify(_verify_error_response(result, '关注失败，请完成验证后重试'))
            if result.get('_need_login'):
                return jsonify(_login_error_response(result))
            if result.get('_error') or result.get('status_code', 0) not in (0, None):
                return jsonify({
                    'success': False,
                    'message': _api_message(result, '关注失败，请检查 Cookie 或稍后重试'),
                })

        return jsonify({
            'success': True,
            'user_id': user_id,
            'is_follow': follow,
            'follow_status': result.get('follow_status', 1 if follow else 0),
            'message': '关注成功' if follow else '已取消关注',
        })
    except Exception as e:
        _logger.error(f'设置关注状态异常: {str(e)}', exc_info=True)
        return jsonify({'success': False, 'message': f'关注失败: {str(e)}'}), 500


@video_actions_bp.route('/api/parse_link', methods=['POST'])
def parse_link():
    """解析抖音链接"""
    try:
        data = _request_json()
        link = data.get('link', '').strip()

        if not link:
            return jsonify({'success': False, 'message': '链接不能为空'}), 400

        user_manager = _get_user_manager()
        if not user_manager:
            return jsonify({'success': False, 'message': '请先设置Cookie'}), 400

        def run_parse_link():
            # 解析链接获取视频信息
            video_info = _run_async(user_manager.parse_share_link(link))
            if not video_info:
                return None, None

            # 获取作者的详细信息
            author_sec_uid = video_info.get('author', {}).get('sec_uid', '')
            user_detail = None
            if author_sec_uid:
                user_detail = _run_async(user_manager.get_user_detail(author_sec_uid))
                if isinstance(user_detail, dict) and (user_detail.get('_need_verify') or user_detail.get('_need_login')):
                    return video_info, user_detail
                if user_detail:
                    user_detail = {
                        'nickname': user_detail.get('nickname', ''),
                        'unique_id': user_detail.get('unique_id', ''),
                        'follower_count': user_detail.get('follower_count', 0),
                        'following_count': user_detail.get('following_count', 0),
                        'total_favorited': user_detail.get('total_favorited', 0),
                        'aweme_count': user_detail.get('aweme_count', 0),
                        'signature': user_detail.get('signature', ''),
                        'sec_uid': user_detail.get('sec_uid', ''),
                        'avatar_thumb': user_detail.get('avatar_thumb', {}).get('url_list', [''])[0] if user_detail.get('avatar_thumb') else '',
                        'avatar_larger': user_detail.get('avatar_larger', {}).get('url_list', [''])[0] if user_detail.get('avatar_larger') else ''
                    }
            return video_info, user_detail

        video_info, user_detail = run_parse_link()

        if isinstance(video_info, dict) and video_info.get('_need_verify'):
            return jsonify(_verify_error_response(video_info, '需要完成滑块验证'))
        if isinstance(video_info, dict) and video_info.get('_need_login'):
            return jsonify(_login_error_response(video_info))
        if isinstance(user_detail, dict) and user_detail.get('_need_verify'):
            return jsonify(_verify_error_response(user_detail, '解析链接失败，请完成验证后重试'))
        if isinstance(user_detail, dict) and user_detail.get('_need_login'):
            return jsonify(_login_error_response(user_detail))

        if video_info:
            # 格式化视频数据
            formatted_video = {
                'author': video_info.get('author', {}),
                'aweme_id': video_info.get('aweme_id', ''),
                'comment_count': video_info.get('comment_count', 0),
                'cover_url': video_info.get('cover_url', ''),
                'create_time': video_info.get('create_time', 0),
                'desc': video_info.get('desc', ''),
                'digg_count': video_info.get('digg_count', 0),
                'duration': video_info.get('duration', 0),
                'duration_unit': video_info.get('duration_unit', 'milliseconds'),
                'media_type': video_info.get('media_type', ''),
                'raw_media_type': video_info.get('raw_media_type', video_info.get('media_type', '')),
                'media_urls': video_info.get('media_urls', []),
                'share_count': video_info.get('share_count', 0)
            }

            # 返回包含作者详细信息和作品信息的数据结构
            response_data = {
                'success': True,
                'type': 'link_parse',
                'video': formatted_video,  # 单个视频信息
                'videos': [formatted_video]  # 兼容原有格式
            }

            # 如果获取到作者详细信息，添加到响应中
            if user_detail:
                response_data['user'] = user_detail

            return jsonify(response_data)
        else:
            return jsonify({'success': False, 'message': '解析链接失败，请检查链接是否有效'}), 404

    except Exception as e:
        return jsonify({'success': False, 'message': f'解析链接失败: {str(e)}'}), 500
