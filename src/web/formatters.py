"""Web API 响应格式化工具。"""
from __future__ import annotations


def count_value(value, default: int = 0) -> int:
    if isinstance(value, bool):
        return default
    if isinstance(value, (int, float)):
        return max(0, int(round(value)))
    if isinstance(value, str):
        text = value.strip().replace(',', '')
        if not text:
            return default
        multiplier = 1
        suffix = text[-1].lower()
        if suffix in ('w', '万'):
            multiplier = 10000
            text = text[:-1]
        elif suffix in ('k', '千'):
            multiplier = 1000
            text = text[:-1]
        try:
            return max(0, int(round(float(text) * multiplier)))
        except ValueError:
            return default
    return default


def first_count(sources: list[dict], keys: tuple[str, ...]) -> int:
    for source in sources:
        if not isinstance(source, dict):
            continue
        for key in keys:
            count = count_value(source.get(key), -1)
            if count >= 0:
                return count
    return 0


def safe_get_url(obj, default=''):
    """安全地从常见抖音媒体字段中获取 URL，避免索引越界。"""
    if not obj:
        return default
    if isinstance(obj, str):
        return obj.strip() or default
    if isinstance(obj, (list, tuple)):
        for item in obj:
            url = safe_get_url(item, '')
            if url:
                return url
        return default
    if not isinstance(obj, dict):
        return default
    for key in (
        'url_list',
        'urlList',
        'large_url_list',
        'origin_url_list',
        'medium_url_list',
        'thumb_url_list',
    ):
        url = safe_get_url(obj.get(key), '')
        if url:
            return url
    for key in ('url', 'uri', 'download_url', 'src'):
        value = obj.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return default


def avatar_url(user_info: dict, *keys: str) -> str:
    if not isinstance(user_info, dict):
        return ''
    for key in keys:
        url = safe_get_url(user_info.get(key), '')
        if url:
            return url
    return ''


def search_user_payload(user_info: dict, item: dict | None = None) -> dict:
    item = item if isinstance(item, dict) else {}
    user_info = user_info if isinstance(user_info, dict) else {}
    sources = [
        user_info,
        user_info.get('stats') or {},
        user_info.get('card_info') or {},
        user_info.get('extra') or {},
        item,
        item.get('stats') or {},
        item.get('card_info') or {},
        item.get('user_info') or {},
    ]
    return {
        'uid': user_info.get('uid', ''),
        'nickname': user_info.get('nickname', ''),
        'unique_id': user_info.get('unique_id', ''),
        'follower_count': first_count(sources, ('follower_count', 'follower_count_str', 'follower_count_text', 'fans_count', 'fans_count_str', 'fans_count_text')),
        'following_count': first_count(sources, ('following_count', 'following_count_str', 'following_count_text', 'follow_count', 'follow_count_str', 'follow_count_text')),
        'total_favorited': first_count(sources, ('total_favorited', 'total_favorited_str', 'total_favorited_text', 'favorited_count', 'favorited_count_str', 'like_count', 'like_count_str')),
        'aweme_count': first_count(sources, ('aweme_count', 'aweme_count_str', 'aweme_count_text', 'work_count', 'work_count_str', 'works_count', 'works_count_str', 'video_count', 'video_count_str')),
        'favoriting_count': first_count(sources, ('favoriting_count', 'favoriting_count_str', 'favoriting_count_text')),
        'signature': user_info.get('signature', ''),
        'sec_uid': user_info.get('sec_uid', ''),
        'avatar_thumb': avatar_url(user_info, 'avatar_thumb', 'avatar_100x100', 'avatar_168x168', 'avatar_medium', 'avatar_300x300', 'avatar_larger'),
        'avatar_medium': avatar_url(user_info, 'avatar_medium', 'avatar_168x168', 'avatar_300x300', 'avatar_larger', 'avatar_thumb', 'avatar_100x100'),
        'avatar_larger': avatar_url(user_info, 'avatar_larger', 'avatar_300x300', 'avatar_medium', 'avatar_168x168', 'avatar_thumb', 'avatar_100x100'),
        'is_follow': bool(user_info.get('is_follow', False)) or bool(user_info.get('follow_status', 0)),
        'follow_status': count_value(user_info.get('follow_status'), 0),
        'verify_status': count_value(user_info.get('verify_status'), 0),
    }


def user_detail_payload(user_info: dict, fallback_sec_uid: str = '', fallback_nickname: str = '') -> dict:
    payload = search_user_payload(user_info)
    payload['uid'] = (user_info or {}).get('uid', '')
    payload['sec_uid'] = payload.get('sec_uid') or fallback_sec_uid
    payload['nickname'] = payload.get('nickname') or fallback_nickname
    payload['avatar_thumb'] = payload.get('avatar_thumb') or avatar_url(user_info or {}, 'avatar_thumb', 'avatar_100x100', 'avatar_168x168', 'avatar_medium', 'avatar_300x300', 'avatar_larger')
    payload['avatar_medium'] = payload.get('avatar_medium') or avatar_url(user_info or {}, 'avatar_medium', 'avatar_168x168', 'avatar_300x300', 'avatar_larger', 'avatar_thumb', 'avatar_100x100')
    payload['avatar_larger'] = payload.get('avatar_larger') or avatar_url(user_info or {}, 'avatar_larger', 'avatar_300x300', 'avatar_medium', 'avatar_168x168', 'avatar_thumb', 'avatar_100x100')
    return payload


def format_comment_item(item: dict) -> dict:
    user = item.get('user') or {}
    reply_to_user = (
        item.get('reply_to_user')
        or item.get('reply_user')
        or item.get('reply_to_user_info')
        or item.get('to_user')
        or {}
    )
    reply_to_user_id = (
        item.get('reply_to_userid')
        or item.get('reply_to_uid')
        or item.get('reply_to_user_id')
        or (reply_to_user.get('uid') if isinstance(reply_to_user, dict) else '')
        or ''
    )
    reply_to_user_name = (
        item.get('reply_to_user_name')
        or item.get('reply_to_nickname')
        or (reply_to_user.get('nickname') if isinstance(reply_to_user, dict) else '')
        or ''
    )
    sticker = item.get('sticker') or {}
    sticker_url = safe_get_url(sticker.get('static_url') or {}) or safe_get_url(sticker.get('animate_url') or {})
    return {
        'cid': item.get('cid', ''),
        'text': item.get('text', ''),
        'create_time': item.get('create_time', 0),
        'user': {
            'uid': user.get('uid', ''),
            'nickname': user.get('nickname', ''),
            'avatar_thumb': safe_get_url(user.get('avatar_thumb') or {}),
            'sec_uid': user.get('sec_uid', ''),
        },
        'digg_count': item.get('digg_count', 0),
        'user_digged': item.get('user_digged', 0),
        'reply_comment_total': item.get('reply_comment_total', 0),
        # 保留根评论附带的 reply_comment 子数组（insert_ids 拉取时含目标子评论）。
        'sub_comments': [format_comment_item(sub) for sub in (item.get('reply_comment') or []) if isinstance(sub, dict)] or None,
        'reply_id': item.get('reply_id') or item.get('comment_id') or item.get('parent_id') or '',
        'reply_to_reply_id': item.get('reply_to_reply_id') or item.get('reply_to_cid') or item.get('reply_to_comment_id') or '',
        'reply_to_user_id': str(reply_to_user_id),
        'reply_to_user_name': str(reply_to_user_name),
        'status': item.get('status', 0),
        'ip_label': item.get('ip_label', ''),
        'sticker_url': sticker_url,
    }
