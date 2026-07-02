"""IM response parsing and normalization helpers."""
from __future__ import annotations


def collect_spotlight_sec_user_ids(response: dict, include_all_users: bool, limit: int) -> list[str]:
    ids = []
    seen = set()

    def push_id(item):
        if not isinstance(item, dict):
            return
        for key in ('sec_uid', 'sec_user_id'):
            value = str(item.get(key) or '').strip()
            if value and value not in seen:
                seen.add(value)
                ids.append(value)
                return

    followings = response.get('followings') or []
    for item in followings:
        if not isinstance(item, dict):
            continue
        is_mutual = int(item.get('follow_status') or 0) > 0 and int(item.get('follower_status') or 0) > 0
        if include_all_users or is_mutual:
            push_id(item)

    for item in response.get('sorted_info') or []:
        if isinstance(item, dict) and int(item.get('conv_type') or 0) == 0:
            push_id(item)

    if include_all_users:
        for key in ('mix_recent_share_day_sort', 'mix_recent_share_users', 'single_recent_share_users'):
            for item in response.get(key) or []:
                push_id(item)
        recent_share_users = response.get('recent_share_users')
        if isinstance(recent_share_users, dict):
            for item in recent_share_users.get('data') or []:
                push_id(item)

    return ids[:limit]


def collect_spotlight_recent_interactions(response: dict) -> list[dict]:
    interactions: dict[str, dict] = {}

    def remember(item):
        if not isinstance(item, dict):
            return
        sec_uid = str(item.get('sec_uid') or item.get('sec_user_id') or '').strip()
        if not sec_uid:
            return
        try:
            timestamp = int(item.get('last_share_timestamp') or item.get('timestamp') or 0)
        except Exception:
            timestamp = 0
        if timestamp <= 0:
            return
        current = interactions.get(sec_uid) or {}
        if timestamp < int(current.get('last_share_timestamp') or 0):
            return
        entry = {
            'sec_uid': sec_uid,
            'last_share_timestamp': timestamp,
            'is_recent_share': True,
        }
        if item.get('uid'):
            entry['uid'] = str(item.get('uid'))
        if item.get('conv_id'):
            entry['conv_id'] = str(item.get('conv_id'))
        if item.get('conv_type') is not None:
            entry['conv_type'] = int(item.get('conv_type') or 0)
        if item.get('share_day_cnt') is not None:
            entry['share_day_count'] = int(item.get('share_day_cnt') or 0)
        interactions[sec_uid] = entry

    for key in ('mix_recent_share_day_sort', 'mix_recent_share_users', 'single_recent_share_users'):
        for item in response.get(key) or []:
            remember(item)
    recent_share_users = response.get('recent_share_users')
    if isinstance(recent_share_users, dict):
        for item in recent_share_users.get('data') or []:
            remember(item)

    return list(interactions.values())


def collect_sec_uid_records(value) -> list[dict]:
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


def share_sorted_sec_uids(response: dict, limit: int) -> list[str]:
    ids = []
    seen = set()
    for item in response.get('sorted_info') or []:
        if not isinstance(item, dict) or int(item.get('conv_type') or 0) != 0:
            continue
        sec_uid = str(item.get('sec_uid') or item.get('sec_user_id') or '').strip()
        if sec_uid and sec_uid not in seen:
            seen.add(sec_uid)
            ids.append(sec_uid)
        if len(ids) >= limit:
            break
    return ids


def first_url(value) -> str:
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, dict):
        url_list = value.get('url_list')
        if isinstance(url_list, list):
            for item in url_list:
                url = first_url(item)
                if url:
                    return url
        for key in ('url', 'uri', 'src', 'download_url'):
            url = first_url(value.get(key))
            if url:
                return url
    if isinstance(value, list):
        for item in value:
            url = first_url(item)
            if url:
                return url
    return ''


def normalize_share_friends(response: dict, limit: int) -> list[dict]:
    users_by_sec_uid = {}
    recent_meta = {}
    order = []
    seen_order = set()

    def remember_order(sec_uid: str):
        sec_uid = str(sec_uid or '').strip()
        if sec_uid and sec_uid not in seen_order:
            seen_order.add(sec_uid)
            order.append(sec_uid)

    def read_sec_uid(item: dict) -> str:
        if not isinstance(item, dict):
            return ''
        return str(item.get('sec_uid') or item.get('sec_user_id') or '').strip()

    for item in response.get('followings') or []:
        if not isinstance(item, dict):
            continue
        sec_uid = read_sec_uid(item)
        if not sec_uid:
            continue
        users_by_sec_uid[sec_uid] = item
        remember_order(sec_uid)

    for key in ('mix_recent_share_day_sort', 'mix_recent_share_users', 'single_recent_share_users'):
        for item in response.get(key) or []:
            if not isinstance(item, dict):
                continue
            sec_uid = read_sec_uid(item)
            if not sec_uid:
                continue
            meta = recent_meta.setdefault(sec_uid, {})
            meta['is_recent_share'] = True
            if item.get('conv_id'):
                meta['conv_id'] = str(item.get('conv_id'))
            if item.get('conv_type') is not None:
                meta['conv_type'] = int(item.get('conv_type') or 0)
            if item.get('share_day_cnt') is not None:
                meta['share_day_count'] = int(item.get('share_day_cnt') or 0)
            if item.get('last_share_timestamp') is not None:
                meta['last_share_timestamp'] = int(item.get('last_share_timestamp') or 0)
            elif item.get('timestamp') is not None:
                meta['last_share_timestamp'] = int(item.get('timestamp') or 0)

    sorted_order = []
    sorted_seen = set()
    for item in response.get('sorted_info') or []:
        if not isinstance(item, dict) or int(item.get('conv_type') or 0) != 0:
            continue
        sec_uid = read_sec_uid(item)
        if sec_uid and sec_uid not in sorted_seen:
            sorted_seen.add(sec_uid)
            sorted_order.append(sec_uid)

    ordered_ids = [sec_uid for sec_uid in sorted_order if sec_uid in users_by_sec_uid]
    ordered_ids.extend([sec_uid for sec_uid in order if sec_uid in users_by_sec_uid and sec_uid not in set(ordered_ids)])

    friends = []
    seen = set()
    for sec_uid in ordered_ids:
        if sec_uid in seen:
            continue
        seen.add(sec_uid)
        user = users_by_sec_uid.get(sec_uid) or {}
        nickname = str(user.get('nickname') or user.get('remark_name') or user.get('unique_id') or user.get('short_id') or '').strip()
        if not nickname:
            continue
        friend = {
            'uid': str(user.get('uid') or ''),
            'sec_uid': sec_uid,
            'nickname': nickname,
            'avatar_thumb': first_url(user.get('avatar_thumb') or user.get('avatar_small')),
            'avatar_medium': first_url(user.get('avatar_medium') or user.get('avatar_168x168') or user.get('avatar_small')),
            'unique_id': str(user.get('unique_id') or ''),
            'short_id': str(user.get('short_id') or ''),
            'follow_status': int(user.get('follow_status') or 0),
            'follower_status': int(user.get('follower_status') or 0),
            **recent_meta.get(sec_uid, {}),
        }
        friends.append(friend)
        if len(friends) >= limit:
            break

    return friends
