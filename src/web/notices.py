"""通知消息路由。

从 web_app.py 抽离。模块内部依赖通过 setup_notices(...) 注入，
外部调用方（web_app.py）需要在导入本模块后调用 setup_notices(...)。
"""
from __future__ import annotations

from typing import Any, Callable

from flask import Blueprint, jsonify

notices_bp = Blueprint("notices", __name__)

# 注入的依赖
_logger = None
_request_json: Callable[[], dict] | None = None
_coerce_int: Callable[..., int] | None = None
_run_async: Callable[..., Any] | None = None
_api_message: Callable[..., str] | None = None
_verify_error_response: Callable[..., dict] | None = None
_login_error_response: Callable[..., dict] | None = None
_get_api: Callable[[], Any] | None = None


def setup_notices(
    *,
    logger,
    request_json: Callable[[], dict],
    coerce_int: Callable[..., int],
    run_async: Callable[..., Any],
    api_message: Callable[..., str],
    verify_error_response: Callable[..., dict],
    login_error_response: Callable[..., dict],
    get_api: Callable[[], Any],
) -> None:
    """注入 web_app 模块的全局对象，避免循环导入。"""
    global _logger, _request_json, _coerce_int, _run_async
    global _api_message, _verify_error_response, _login_error_response, _get_api
    _logger = logger
    _request_json = request_json
    _coerce_int = coerce_int
    _run_async = run_async
    _api_message = api_message
    _verify_error_response = verify_error_response
    _login_error_response = login_error_response
    _get_api = get_api


# 通知类型到中文标签的映射（type 字段，实测 notice_list_v2）。
# 31=评论/回复，41=赞（赞作品/赞评论），45=@我，33=新粉丝，
# 514/9002=互动汇总。其余 type 统一显示「通知」。
_NOTICE_TYPE_LABELS = {
    1: "赞",
    31: "评论",
    33: "新粉丝",
    41: "赞",
    45: "@我",
    514: "互动",
    9002: "互动",
}


def _first_url(media: Any) -> str:
    """从抖音常见的 url_list 结构里取第一个地址。"""
    if isinstance(media, dict):
        url_list = media.get('url_list')
        if isinstance(url_list, list):
            for url in url_list:
                if isinstance(url, str) and url.strip():
                    return url.strip()
    return ''


def _format_user(user: dict) -> dict:
    """整形单个用户信息。"""
    if not isinstance(user, dict):
        return {}
    avatar = _first_url(user.get('avatar_thumb')) or _first_url(user.get('avatar_larger'))
    return {
        'uid': str(user.get('uid') or ''),
        'nickname': str(user.get('nickname') or '').strip(),
        'sec_uid': str(user.get('sec_uid') or ''),
        'avatar': avatar,
        'unique_id': str(user.get('unique_id') or ''),
        'follow_status': user.get('follow_status'),
        'follower_status': user.get('follower_status'),
        'is_verified': bool(user.get('is_verified')),
    }


def _format_aweme_brief(aweme: dict) -> dict | None:
    """整形通知里附带的作品摘要（封面/描述）。"""
    if not isinstance(aweme, dict):
        return None
    cover = ''
    video = aweme.get('video')
    if isinstance(video, dict):
        cover = _first_url(video.get('cover')) or _first_url(video.get('origin_cover'))
    if not cover:
        images = aweme.get('images')
        if isinstance(images, list) and images:
            cover = _first_url(images[0])
    return {
        'aweme_id': str(aweme.get('aweme_id') or ''),
        'desc': str(aweme.get('desc') or '').strip(),
        'cover': cover,
        'aweme_type': aweme.get('aweme_type'),
    }


def _format_notice(item: dict) -> dict | None:
    """把单条 notice_list_v2 元素整形为前端可用的结构。"""
    if not isinstance(item, dict):
        return None

    notice_type = item.get('type')
    type_label = _NOTICE_TYPE_LABELS.get(notice_type) or '通知'

    users: list[dict] = []
    content = ''
    merge_count = 0
    label_text = ''
    aweme_brief: dict | None = None
    digg_type = None
    comment_text = ''
    # 赞评论/赞回复的通知在 digg 里带 comment 字段（digg_type=10/3），
    # 赞作品（digg_type=1）则没有。用 comment 是否存在来区分，比硬编码 digg_type 稳。
    is_comment_like = False
    is_reply = False
    # type 31 评论/回复通知的定位信息：cid（别人发的那条）+ root_cid（根评论）。
    # 实测 comment_wrap.parent_id 恒为根评论 cid；reply_comment 不带 cid 不可用。
    comment_brief: dict | None = None

    digg = item.get('digg')
    follow = item.get('follow')
    comment_wrap = item.get('comment')
    at = item.get('at')

    if isinstance(digg, dict):
        # 点赞类通知：from_user 是数组，可能合并多人。
        from_users = digg.get('from_user')
        if isinstance(from_users, list):
            users = [_format_user(u) for u in from_users if isinstance(u, dict)]
            users = [u for u in users if u.get('uid') or u.get('nickname')]
        content = str(digg.get('content') or '').strip()
        merge_count = int(digg.get('merge_count') or 0) or 0
        digg_type = digg.get('digg_type')
        label_text = str(digg.get('label_text') or '').strip()
        if not label_text:
            label_list = digg.get('label_list')
            if isinstance(label_list, list) and label_list:
                first = label_list[0]
                if isinstance(first, dict):
                    label_text = str(first.get('text') or '').strip()
        comment = digg.get('comment')
        if isinstance(comment, dict):
            is_comment_like = True
            comment_text = str(comment.get('text') or '').strip()
            # 赞评论通知：被赞评论本身置顶高光。无 parent_id，root_cid 用 cid 自身。
            liked_cid = str(comment.get('cid') or '').strip()
            liked_text = comment_text
            liked_user: dict | None = None
            liked_user_raw = comment.get('user')
            if isinstance(liked_user_raw, dict):
                formatted = _format_user(liked_user_raw)
                if formatted.get('uid') or formatted.get('nickname'):
                    liked_user = formatted
            if liked_cid and liked_user:
                comment_brief = {
                    'cid': liked_cid,
                    'root_cid': liked_cid,
                    'is_sub': False,
                    'text': liked_text,
                    'digg_count': int(comment.get('digg_count') or 0),
                    'create_time': int(item.get('create_time') or 0),
                    'user': liked_user,
                }
        aweme_brief = _format_aweme_brief(digg.get('aweme'))
    elif isinstance(comment_wrap, dict):
        # 评论/回复类通知（type 31）：顶层 comment 是包装层，真实评论在
        # comment.comment（含 cid/text/user），根评论 cid 在 comment.parent_id。
        reply_to_user: dict | None = None
        reply_to_text = ''
        reply = comment_wrap.get('reply_comment')
        if isinstance(reply, dict):
            reply_to_text = str(reply.get('text') or '').strip()
            reply_user = reply.get('user')
            if isinstance(reply_user, dict):
                formatted = _format_user(reply_user)
                if formatted.get('uid') or formatted.get('nickname'):
                    reply_to_user = formatted
        inner = comment_wrap.get('comment')
        inner_cid = ''
        inner_user: dict | None = None
        inner_text = ''
        if isinstance(inner, dict):
            inner_cid = str(inner.get('cid') or '').strip()
            user = inner.get('user')
            if isinstance(user, dict):
                formatted = _format_user(user)
                if formatted.get('uid') or formatted.get('nickname'):
                    users = [formatted]
                    inner_user = formatted
            inner_text = str(inner.get('text') or '').strip()
            comment_text = inner_text
        parent_id = str(comment_wrap.get('parent_id') or '').strip()
        reply = comment_wrap.get('reply_comment')
        if isinstance(reply, dict) and (reply.get('text') or reply.get('cid')):
            is_reply = True
        # 定位信息：用 cid 走 insert_ids 拉评论列表，前端按 cid 在根列表或子评论里定位。
        # root_cid 供通知内回复用（publish_comment 的 reply_id）。
        if inner_cid and inner_user:
            comment_brief = {
                'cid': inner_cid,
                'root_cid': parent_id or inner_cid,
                'is_sub': bool(parent_id),
                'text': inner_text,
                'digg_count': int(inner.get('digg_count') or 0) if isinstance(inner, dict) else 0,
                'create_time': int(item.get('create_time') or 0),
                'user': inner_user,
                'reply_to_user': reply_to_user,
                'reply_to_text': reply_to_text,
            }
        merge_count = int(comment_wrap.get('merge_count') or 0) or 0
        label_text = str(comment_wrap.get('label_text') or '').strip()
        if not label_text:
            label_list = comment_wrap.get('label_list')
            if isinstance(label_list, list) and label_list:
                first = label_list[0]
                if isinstance(first, dict):
                    label_text = str(first.get('text') or '').strip()
        aweme_brief = _format_aweme_brief(comment_wrap.get('aweme'))
    elif isinstance(at, dict):
        # @我 通知（type 45）：用户在 user_info（单个对象），文案在 content。
        user_info = at.get('user_info')
        at_user: dict | None = None
        if isinstance(user_info, dict):
            formatted = _format_user(user_info)
            if formatted.get('uid') or formatted.get('nickname'):
                users = [formatted]
                at_user = formatted
        # at.content 形如 "@昵称"，不是通知主文案，仅作参考。
        content = ''
        label_text = str(at.get('label_text') or '').strip()
        aweme_brief = _format_aweme_brief(at.get('aweme'))
        # @评论的 cid 在 schema_url 里：aweme://aweme/detail/{aweme_id}?cid={cid}
        schema_url = str(at.get('schema_url') or '')
        at_cid = ''
        for seg in schema_url.split('?'):
            if seg.startswith('cid='):
                at_cid = seg[4:].strip()
                break
        if at_cid and at_user:
            comment_brief = {
                'cid': at_cid,
                'root_cid': at_cid,
                'is_sub': False,
                'text': '',
                'digg_count': 0,
                'create_time': int(item.get('create_time') or 0),
                'user': at_user,
            }
    elif isinstance(follow, dict):
        # 关注类通知：from_user 是单个对象。
        from_user = follow.get('from_user')
        if isinstance(from_user, dict):
            formatted = _format_user(from_user)
            if formatted.get('uid') or formatted.get('nickname'):
                users = [formatted]
        content = str(follow.get('content') or '').strip()
        merge_count = int(follow.get('merge_count') or 0) or 0

    # 兜底文案：接口 content 为空时按类型合成一句。
    if not content:
        names = '、'.join(u.get('nickname', '') for u in users if u.get('nickname'))
        if notice_type == 33:
            content = f'{names} 关注了你' if names else '关注了你'
        elif notice_type in (1, 41):
            target = '你的评论' if is_comment_like else '你的作品'
            if merge_count > 1:
                content = f'{names} 等 {merge_count} 人赞了{target}' if names else f'{merge_count} 人赞了{target}'
            else:
                content = f'{names} 赞了{target}' if names else f'赞了{target}'
        elif notice_type == 31:
            action = '回复了你的评论' if is_reply else '评论了你'
            content = f'{names} {action}' if names else action
        elif notice_type == 45:
            content = f'{names} @了你' if names else '@了你'
        else:
            content = type_label

    return {
        'id': str(item.get('nid_str') or item.get('nid') or ''),
        'type': notice_type,
        'type_label': type_label,
        'create_time': int(item.get('create_time') or 0),
        'has_read': bool(item.get('has_read')),
        'content': content,
        'merge_count': merge_count,
        'label_text': label_text,
        'users': users,
        'aweme': aweme_brief,
        'digg_type': digg_type,
        'is_comment_like': is_comment_like,
        'is_reply': is_reply,
        'comment_text': comment_text,
        'comment': comment_brief,
    }


@notices_bp.route('/api/get_notices', methods=['POST'])
def get_notices_api():
    """获取通知消息列表（点赞/关注/评论等互动通知）。"""
    try:
        data = _request_json()
        count = _coerce_int(data.get('count'), 10, 1, 50)
        # 翻历史：前端传上一批返回的 cursor（即接口 max_time）作为本批 max_time。
        max_time = _coerce_int(data.get('max_time') or data.get('maxTime'), 0, 0)
        min_time = _coerce_int(data.get('min_time') or data.get('minTime'), 0, 0)
        notice_group = _coerce_int(data.get('notice_group') or data.get('noticeGroup'), 960, 1)

        api = _get_api()
        if not api:
            return jsonify({'success': False, 'need_login': True, 'message': '请先设置 Cookie'})

        async def fetch_notices():
            resp, success = await api.notice.get_notices(
                count=count,
                min_time=min_time,
                max_time=max_time,
                notice_group=notice_group,
            )
            return resp, success

        resp, success = _run_async(fetch_notices())

        if isinstance(resp, dict) and resp.get('_need_verify'):
            return jsonify(_verify_error_response(resp, '获取通知失败，请完成验证后重试'))
        if isinstance(resp, dict) and resp.get('_need_login'):
            return jsonify(_login_error_response(resp))

        if not success or not isinstance(resp, dict):
            return jsonify({
                'success': False,
                'message': _api_message(resp, '获取通知失败，请稍后重试'),
            })

        raw_list = resp.get('notice_list_v2')
        if not isinstance(raw_list, list):
            raw_list = resp.get('notice_list') or []

        notices: list[dict] = []
        for item in raw_list:
            try:
                formatted = _format_notice(item)
                if formatted is not None:
                    notices.append(formatted)
            except Exception as e:
                if _logger:
                    _logger.debug(f"[通知] 整形单条通知失败: {e}")
                continue

        unread_count = sum(1 for n in notices if not n.get('has_read'))
        has_more_raw = resp.get('has_more')
        has_more = has_more_raw == 1 or has_more_raw is True
        # 翻历史游标：抖音 notice 接口用返回的 max_time 作为下一批的 max_time
        # （实测 min_time 方向会返回 status=4「服务器打瞌睡」）。
        cursor = int(resp.get('max_time') or 0)

        return jsonify({
            'success': True,
            'message': '获取通知成功',
            'notices': notices,
            'count': len(notices),
            'unread_count': unread_count,
            'has_more': has_more,
            'cursor': cursor,
        })
    except Exception as e:
        if _logger:
            _logger.exception(f"获取通知异常: {e}")
        return jsonify({'success': False, 'message': f'获取通知失败: {str(e)}'}), 500
