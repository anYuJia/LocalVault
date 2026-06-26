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


def search_user_needs_detail(user_info: dict, item: dict | None = None) -> bool:
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
    ]
    aweme_count = first_count(sources, (
        'aweme_count',
        'aweme_count_str',
        'aweme_count_text',
        'work_count',
        'work_count_str',
        'works_count',
        'works_count_str',
        'video_count',
        'video_count_str',
    ))
    following_count = first_count(sources, (
        'following_count',
        'following_count_str',
        'following_count_text',
        'follow_count',
        'follow_count_str',
        'follow_count_text',
    ))
    return aweme_count <= 0 or following_count <= 0


def merge_user_detail(user_info: dict, detail: dict) -> None:
    if not isinstance(user_info, dict) or not isinstance(detail, dict):
        return
    if detail.get('_need_verify') or detail.get('_need_login') or detail.get('_error'):
        return

    for key in (
        'uid',
        'nickname',
        'unique_id',
        'sec_uid',
        'signature',
        'avatar_thumb',
        'avatar_medium',
        'avatar_larger',
        'is_follow',
        'follow_status',
        'verify_status',
    ):
        if detail.get(key) and not user_info.get(key):
            user_info[key] = detail.get(key)

    for key in (
        'follower_count',
        'following_count',
        'total_favorited',
        'aweme_count',
        'favoriting_count',
    ):
        detail_count = count_value(detail.get(key), -1)
        current_count = count_value(user_info.get(key), -1)
        if detail_count >= 0 and (current_count < 0 or detail_count > current_count):
            user_info[key] = detail_count
