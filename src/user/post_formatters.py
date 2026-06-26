from src.user import media_selectors


def video_display_url(video_data: dict, media_urls: list[dict] | None = None) -> str:
    selected_url = media_selectors.select_video_url(video_data or {})
    if selected_url:
        return selected_url

    for item in media_urls or []:
        if not isinstance(item, dict):
            continue
        url = media_selectors.first_url(item.get('url') or item.get('play_addr') or item.get('download_addr'))
        if url and str(item.get('type') or '').lower() == 'video':
            return media_selectors.clean_video_download_url(url)

    for item in media_urls or []:
        if not isinstance(item, dict):
            continue
        url = media_selectors.first_url(item.get('url') or item.get('play_addr') or item.get('download_addr'))
        if url:
            return media_selectors.clean_video_download_url(url)

    return ''


def normalize_duration_seconds(value) -> int:
    try:
        duration = float(value or 0)
    except (TypeError, ValueError):
        return 0
    if duration > 1000:
        return int(round(duration / 1000))
    return int(round(duration))


def raw_duration_value(value) -> int:
    try:
        duration = float(value or 0)
    except (TypeError, ValueError):
        return 0
    return int(round(duration)) if duration > 0 else 0


def extract_post_status(post: dict) -> dict:
    status = post.get('status') or {}
    return {
        'is_delete': bool(status.get('is_delete', False)),
        'private_status': int(status.get('private_status') or 0),
        'review_status': int(status.get('review_status') or 0),
        'with_goods': bool(status.get('with_goods', False)),
        'is_prohibited': bool(status.get('is_prohibited', False)),
    }


def is_image_post(post: dict) -> bool:
    return post.get("images") is not None and len(post.get("images", [])) > 0


def extract_bgm_url(post: dict) -> str | None:
    bgm_url = None

    if post.get('music'):
        music_data = post['music']
        if isinstance(music_data.get('play_url'), dict):
            play_urls = music_data['play_url'].get('url_list', [])
            bgm_url = play_urls[0] if play_urls else None
        elif isinstance(music_data.get('play_url'), str):
            bgm_url = music_data['play_url']

        if not bgm_url:
            bgm_url = music_data.get('h5_url', '') or music_data.get('web_url', '')

        if not bgm_url and music_data.get('music_file'):
            if isinstance(music_data['music_file'], dict):
                file_urls = music_data['music_file'].get('url_list', [])
                bgm_url = file_urls[0] if file_urls else None
            elif isinstance(music_data['music_file'], str):
                bgm_url = music_data['music_file']

    return bgm_url


def media_type_label(media_type: str, media_urls: list[dict]) -> str:
    if media_type == 'mixed':
        live_count = sum(1 for item in media_urls if item.get('type') == 'live_photo')
        img_count = sum(1 for item in media_urls if item.get('type') == 'image')
        return f'图片({img_count}张)+Live图({live_count}张)'
    return {
        'video': '视频',
        'image': f'图片({len(media_urls)}张)',
        'live_photo': f'Live图({len(media_urls)}张)',
        'unknown': '未知'
    }.get(media_type, '未知')
