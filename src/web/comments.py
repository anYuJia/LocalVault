"""评论相关路由（获取评论/回复、点赞、发布）。

从 web_app.py 抽离。模块内部依赖通过 setup 注入，
外部调用方（web_app.py）需要在导入本模块后调用 setup_comments(...)。
"""
from __future__ import annotations

from typing import Any, Callable

from flask import Blueprint, jsonify

comments_bp = Blueprint("comments", __name__)

# 注入的依赖
_logger = None
_request_json: Callable[[], dict] | None = None
_coerce_int: Callable[..., int] | None = None
_run_async: Callable[..., Any] | None = None
_api_message: Callable[..., str] | None = None
_verify_error_response: Callable[..., dict] | None = None
_login_error_response: Callable[..., dict] | None = None
_format_comment_item: Callable[[Any], dict] | None = None


def setup_comments(
    *,
    logger,
    request_json: Callable[[], dict],
    coerce_int: Callable[..., int],
    run_async: Callable[..., Any],
    api_message: Callable[..., str],
    verify_error_response: Callable[..., dict],
    login_error_response: Callable[..., dict],
    format_comment_item: Callable[[Any], dict],
) -> None:
    """注入 web_app 模块的全局对象，避免循环导入。"""
    global _logger, _request_json, _coerce_int, _run_async
    global _api_message, _verify_error_response, _login_error_response
    global _format_comment_item
    _logger = logger
    _request_json = request_json
    _coerce_int = coerce_int
    _run_async = run_async
    _api_message = api_message
    _verify_error_response = verify_error_response
    _login_error_response = login_error_response
    _format_comment_item = format_comment_item


def _get_api():
    """延迟读取 web_app.api，避免 setup 时 api 还未初始化。"""
    from src.web import web_app
    return web_app.api


@comments_bp.route('/api/get_comments', methods=['POST'])
def get_comments():
    """获取视频评论列表。"""
    try:
        data = _request_json()
        aweme_id = str(data.get('aweme_id') or '').strip()
        count = _coerce_int(data.get('count'), 20, 1, 100)
        cursor = _coerce_int(data.get('cursor'), 0, 0)
        insert_ids = str(data.get('insert_ids') or data.get('insertIds') or '').strip()

        if not aweme_id:
            return jsonify({'success': False, 'message': '视频ID不能为空'}), 400

        api = _get_api()
        if not api:
            return jsonify({'success': False, 'message': '服务未初始化'}), 400

        resp, success = _run_async(api.get_comments(aweme_id, count, cursor, insert_ids))

        if isinstance(resp, dict) and resp.get('_need_verify'):
            return jsonify(_verify_error_response(
                resp,
                '获取评论失败，请完成验证后重试',
                verify_url=f'https://www.douyin.com/video/{aweme_id}',
            ))
        if isinstance(resp, dict) and resp.get('_need_login'):
            return jsonify(_login_error_response(resp))

        if not success:
            return jsonify({
                'success': False,
                'message': _api_message(resp, '获取评论失败，请稍后重试'),
            })

        data_block = resp.get('data') if isinstance(resp.get('data'), dict) else resp
        raw_comments = data_block.get('comments') or []
        comments = [_format_comment_item(item) for item in raw_comments if isinstance(item, dict)]

        has_more = data_block.get('has_more', False)
        return jsonify({
            'success': True,
            'comments': comments,
            'cursor': data_block.get('cursor', 0),
            'has_more': has_more == 1 or has_more is True,
            'total': data_block.get('total', 0),
        })

    except Exception as e:
        _logger.exception(f"获取评论失败: {e}")
        return jsonify({'success': False, 'message': f'获取评论失败: {str(e)}'}), 500


@comments_bp.route('/api/get_comment_replies', methods=['POST'])
def get_comment_replies():
    """获取评论的二级回复列表。"""
    try:
        data = _request_json()
        aweme_id = str(data.get('aweme_id') or '').strip()
        comment_id = str(data.get('comment_id') or '').strip()
        count = _coerce_int(data.get('count'), 6, 1, 50)
        cursor = _coerce_int(data.get('cursor'), 0, 0)

        if not aweme_id:
            return jsonify({'success': False, 'message': '视频ID不能为空'}), 400
        if not comment_id:
            return jsonify({'success': False, 'message': '评论ID不能为空'}), 400
        api = _get_api()
        if not api:
            return jsonify({'success': False, 'message': '服务未初始化'}), 400

        resp, success = _run_async(api.get_comment_replies(aweme_id, comment_id, count, cursor))

        if isinstance(resp, dict) and resp.get('_need_verify'):
            return jsonify(_verify_error_response(
                resp,
                '获取评论回复失败，请完成验证后重试',
                verify_url=f'https://www.douyin.com/video/{aweme_id}',
            ))
        if isinstance(resp, dict) and resp.get('_need_login'):
            return jsonify(_login_error_response(resp))

        if not success:
            return jsonify({
                'success': False,
                'message': _api_message(resp, '获取评论回复失败，请稍后重试'),
            })

        data_block = resp.get('data') if isinstance(resp.get('data'), dict) else resp
        raw_comments = data_block.get('comments') or data_block.get('reply_comments') or []
        has_more = data_block.get('has_more', False)
        return jsonify({
            'success': True,
            'comments': [_format_comment_item(item) for item in raw_comments if isinstance(item, dict)],
            'cursor': data_block.get('cursor', 0),
            'has_more': has_more == 1 or has_more is True,
            'total': data_block.get('total', 0),
        })

    except Exception as e:
        _logger.exception(f"获取评论回复失败: {e}")
        return jsonify({'success': False, 'message': f'获取评论回复失败: {str(e)}'}), 500


@comments_bp.route('/api/comment_digg', methods=['POST'])
def comment_digg():
    """点赞或取消点赞评论。"""
    try:
        data = _request_json()
        aweme_id = str(data.get('aweme_id') or '').strip()
        comment_id = str(data.get('comment_id') or '').strip()
        raw_liked = data.get('liked')
        liked = str(raw_liked).strip().lower() in ('1', 'true', 'yes', 'on') if isinstance(raw_liked, str) else bool(raw_liked)
        level = _coerce_int(data.get('level'), 1, 1, 2)

        if not aweme_id:
            return jsonify({'success': False, 'message': '视频ID不能为空'}), 400
        if not comment_id:
            return jsonify({'success': False, 'message': '评论ID不能为空'}), 400
        api = _get_api()
        if not api:
            return jsonify({'success': False, 'message': '服务未初始化'}), 400

        resp, success = _run_async(api.set_comment_liked(aweme_id, comment_id, liked, level))

        if isinstance(resp, dict) and resp.get('_need_verify'):
            return jsonify(_verify_error_response(
                resp,
                '评论点赞失败，请完成验证后重试',
                verify_url=f'https://www.douyin.com/video/{aweme_id}',
            ))
        if isinstance(resp, dict) and resp.get('_need_login'):
            return jsonify(_login_error_response(resp))

        if not success:
            return jsonify({
                'success': False,
                'message': _api_message(resp, '评论点赞失败，请稍后重试'),
                'security_blocked': bool(isinstance(resp, dict) and resp.get('_security_blocked')),
            })

        return jsonify({
            'success': True,
            'aweme_id': aweme_id,
            'cid': comment_id,
            'user_digged': 1 if liked else 0,
            'raw': resp,
            'message': '评论点赞成功' if liked else '已取消评论点赞',
        })

    except Exception as e:
        _logger.exception(f"评论点赞失败: {e}")
        return jsonify({'success': False, 'message': f'评论点赞失败: {str(e)}'}), 500


@comments_bp.route('/api/comment_publish', methods=['POST'])
def comment_publish():
    """发布一级评论或回复评论。"""
    try:
        data = _request_json()
        aweme_id = str(data.get('aweme_id') or '').strip()
        text = str(data.get('text') or '').strip()
        reply_id = str(data.get('reply_id') or '').strip()
        reply_to_reply_id = str(data.get('reply_to_reply_id') or '').strip()
        _logger.info(
            "comment_publish route: aweme_id=%s text_len=%s reply=%s",
            aweme_id,
            len(text),
            bool(reply_id),
        )

        if not aweme_id:
            return jsonify({'success': False, 'message': '视频ID不能为空'}), 400
        if not text:
            return jsonify({'success': False, 'message': '评论内容不能为空'}), 400
        api = _get_api()
        if not api:
            return jsonify({'success': False, 'message': '服务未初始化'}), 400

        resp, success = _run_async(api.publish_comment(aweme_id, text, reply_id, reply_to_reply_id))

        if isinstance(resp, dict) and resp.get('_need_verify'):
            return jsonify(_verify_error_response(
                resp,
                '发表评论失败，请完成验证后重试',
                verify_url=f'https://www.douyin.com/video/{aweme_id}',
            ))
        if isinstance(resp, dict) and resp.get('_need_login'):
            return jsonify(_login_error_response(resp))

        if not success:
            _logger.warning("发表评论失败，抖音响应: %s", resp)
            return jsonify({
                'success': False,
                'message': _api_message(resp, '发表评论失败，请稍后重试'),
            })

        raw_comment = resp.get('comment') if isinstance(resp, dict) else None
        _logger.info(
            "comment_publish success: aweme_id=%s cid=%s status=%s",
            aweme_id,
            raw_comment.get('cid') if isinstance(raw_comment, dict) else '',
            resp.get('status_code') if isinstance(resp, dict) else '',
        )
        return jsonify({
            'success': True,
            'aweme_id': aweme_id,
            'comment': _format_comment_item(raw_comment) if isinstance(raw_comment, dict) else None,
            'raw': resp,
            'message': '评论已发布',
        })

    except Exception as e:
        _logger.exception(f"发表评论失败: {e}")
        return jsonify({'success': False, 'message': f'发表评论失败: {str(e)}'}), 500
