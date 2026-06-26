import json

from src.config.config import Config


def first_url(value) -> str:
    if isinstance(value, str):
        return value.strip()

    if isinstance(value, dict):
        url_list = value.get('url_list')
        if isinstance(url_list, list):
            for item in url_list:
                if isinstance(item, str) and item.strip():
                    return item.strip()
        for key in (
            'url',
            'main_url',
            'backup_url',
            'fallback_url',
            'play_addr',
            'play_url',
            'download_addr',
            'download_url',
            'display_url',
            'uri',
        ):
            nested = value.get(key)
            if nested is not None and nested is not value:
                url = first_url(nested)
                if key == 'uri' and not url.lower().startswith(('http://', 'https://')):
                    continue
                if url:
                    return url

    if isinstance(value, list):
        for item in value:
            url = first_url(item)
            if url:
                return url

    return ''


def clean_video_download_url(url: str) -> str:
    normalized_url = str(url or '').strip()
    if not normalized_url:
        return ''
    return (
        normalized_url
        .replace('watermark=1', 'watermark=0')
        .replace('playwm', 'play')
    )


def is_watermark_url(url: str) -> bool:
    normalized_url = str(url or '').strip().lower()
    if not normalized_url:
        return False
    return (
        'playwm' in normalized_url
        or 'watermark=1' in normalized_url
        or '/aweme/v1/playwm' in normalized_url
    )


def video_download_quality() -> str:
    return Config.normalize_download_quality(getattr(Config, 'DOWNLOAD_QUALITY', 'auto'))


def download_quality_target_height(quality: str) -> int:
    return {
        '480p': 480,
        '720p': 720,
        '1080p': 1080,
        '2k': 1440,
        '1440p': 1440,
        '4k': 2160,
        '2160p': 2160,
    }.get(str(quality or '').strip().lower(), 0)


def quality_height_from_text(value) -> int:
    text = str(value or '').strip().lower()
    if not text:
        return 0
    if '4k' in text or 'uhd' in text or '2160' in text:
        return 2160
    if '2k' in text or 'qhd' in text or '1440' in text:
        return 1440

    for token in ''.join(ch if ch.isalnum() else ' ' for ch in text).split():
        raw = token[:-1] if token.endswith('p') else token
        try:
            height = int(raw)
        except (TypeError, ValueError):
            continue
        if 240 <= height <= 4320:
            return height
    return 0


def positive_int(value) -> int:
    try:
        number = int(value or 0)
    except (TypeError, ValueError):
        return 0
    return number if number > 0 else 0


def nearest_standard_quality_height(value: int) -> int:
    value = positive_int(value)
    if value <= 0:
        return 0

    standard_heights = (4320, 2160, 1440, 1080, 720, 540, 480, 360, 240)
    nearest = min(standard_heights, key=lambda height: abs(height - value))
    tolerance = max(24, int(nearest * 0.12))
    if abs(nearest - value) <= tolerance:
        return nearest

    return value if 240 <= value <= 4320 else 0


def standard_quality_height_from_dimension(value: int) -> int:
    value = positive_int(value)
    if value <= 0:
        return 0

    standard_heights = (4320, 2160, 1440, 1080, 720, 540, 480, 360, 240)
    nearest = min(standard_heights, key=lambda height: abs(height - value))
    tolerance = max(16, int(nearest * 0.04))
    return nearest if abs(nearest - value) <= tolerance else 0


def long_side_quality_height(value: int) -> int:
    value = positive_int(value)
    if value <= 0:
        return 0

    long_side_to_quality = (
        (3840, 2160),
        (2560, 1440),
        (1920, 1080),
        (1280, 720),
        (960, 540),
        (854, 480),
        (852, 480),
    )
    for long_side, quality_height in long_side_to_quality:
        if abs(value - long_side) <= max(24, int(long_side * 0.04)):
            return quality_height
    return 0


def dimension_quality_height(width, height) -> int:
    width = positive_int(width)
    height = positive_int(height)

    if width > 0 and height > 0:
        candidates = [
            standard_quality_height_from_dimension(width),
            standard_quality_height_from_dimension(height),
            long_side_quality_height(width),
            long_side_quality_height(height),
        ]
        measured = [candidate for candidate in candidates if candidate > 0]
        if measured:
            return max(measured)
        return nearest_standard_quality_height(max(width, height))

    value = width or height
    if value <= 0:
        return 0

    return (
        standard_quality_height_from_dimension(value)
        or long_side_quality_height(value)
        or nearest_standard_quality_height(value)
    )


def bit_rate_metric(bit_rate: dict) -> int:
    for key in ('data_size', 'bit_rate', 'quality_type'):
        try:
            value = int(bit_rate.get(key) or 0)
        except (TypeError, ValueError):
            value = 0
        if value > 0:
            return value

    try:
        width = int(bit_rate.get('width') or 0)
        height = int(bit_rate.get('height') or 0)
    except (TypeError, ValueError):
        return 0
    return width * height if width > 0 and height > 0 else 0


def bit_rate_height(bit_rate: dict) -> int:
    heights = []
    gear_height = quality_height_from_text(bit_rate.get('gear_name'))
    if gear_height > 0:
        heights.append(gear_height)

    try:
        quality_type = int(bit_rate.get('quality_type') or 0)
    except (TypeError, ValueError):
        quality_type = 0
    if quality_type in (72, 73):
        heights.append(2160)

    dimension_height = dimension_quality_height(
        bit_rate.get('width'),
        bit_rate.get('height'),
    )
    if dimension_height > 0:
        heights.append(dimension_height)

    return max(heights, default=0)


def is_dash_video_only_url(url: str) -> bool:
    text = str(url or '').lower()
    return 'media-video' in text or 'media_video' in text


def collect_video_candidates(video_data: dict) -> list[dict]:
    candidates = []
    seen = set()

    top_level_height = max(
        dimension_quality_height(video_data.get('width'), video_data.get('height')),
        quality_height_from_text(video_data.get('ratio')),
    )
    lowbr_height = min(top_level_height, 480) if top_level_height > 0 else 480

    def push_candidate(
        url: str,
        metric: int,
        height: int = 0,
        is_h264: bool = False,
        is_quality_candidate: bool = False,
        is_download_addr: bool = False,
        is_lowbr: bool = False,
    ) -> None:
        normalized_url = clean_video_download_url(url)
        if (
            not normalized_url
            or normalized_url in seen
            or is_dash_video_only_url(normalized_url)
        ):
            return
        seen.add(normalized_url)
        candidates.append({
            'url': normalized_url,
            'metric': int(metric or 0),
            'height': int(height or 0),
            'is_h264': bool(is_h264),
            'is_quality_candidate': bool(is_quality_candidate),
            'is_download_addr': bool(is_download_addr),
            'is_lowbr': bool(is_lowbr),
            'is_watermark': is_watermark_url(normalized_url),
        })

    push_candidate(first_url(video_data.get('download_addr')), 0, top_level_height, False, False, True, False)
    push_candidate(first_url(video_data.get('play_addr_h264')), 0, top_level_height, True, False, False, False)
    push_candidate(first_url(video_data.get('play_addr_lowbr')), 1, lowbr_height, True, False, False, True)

    for bit_rate in video_data.get('bit_rate') or []:
        if not isinstance(bit_rate, dict):
            continue
        metric = bit_rate_metric(bit_rate)
        height = bit_rate_height(bit_rate)
        h264_metric = metric + 1 if metric > 0 else 0
        push_candidate(first_url(bit_rate.get('play_addr_h264')), h264_metric, height, True, True, False, False)
        push_candidate(
            first_url(bit_rate.get('play_addr')),
            metric,
            height,
            not bool(bit_rate.get('is_h265')),
            True,
            False,
            False,
        )

    push_candidate(first_url(video_data.get('preview_addr')), 0, top_level_height, False, False, False, False)
    push_candidate(first_url(video_data.get('play_addr')), 0, top_level_height, False, False, False, False)
    return candidates


def get_video_download_urls(video_data: dict) -> list[str]:
    candidates = collect_video_candidates(video_data or {})
    if not candidates:
        return []

    clean_candidates = [candidate for candidate in candidates if not candidate['is_watermark']]
    if not clean_candidates:
        return []

    ordered = []
    seen = set()

    def push(candidate) -> None:
        if not candidate:
            return
        url = candidate.get('url', '')
        if url and url not in seen:
            seen.add(url)
            ordered.append(url)

    download_addr = next((candidate for candidate in clean_candidates if candidate['is_download_addr']), None)
    h264_candidates = [
        candidate for candidate in clean_candidates
        if candidate['is_h264'] and not candidate['is_lowbr']
    ]
    h264_best = max(h264_candidates, key=lambda item: item['metric'], default=None)
    quality_candidates = [
        candidate for candidate in clean_candidates
        if candidate['metric'] > 0 and not candidate['is_download_addr'] and not candidate['is_lowbr']
    ]
    highest_metric = max(quality_candidates, key=lambda item: item['metric'], default=None)
    lowbr = next((candidate for candidate in clean_candidates if candidate['is_lowbr']), None)
    metric_candidates = [candidate for candidate in clean_candidates if candidate['metric'] > 0]
    smallest_metric = min(metric_candidates, key=lambda item: item['metric'], default=None)
    first = clean_candidates[0] if clean_candidates else None

    def best_target_candidate(target_height: int):
        explicit_measured = [
            candidate for candidate in clean_candidates
            if candidate.get('is_quality_candidate')
            and int(candidate.get('height') or 0) > 0
            and not candidate['is_download_addr']
        ]
        measured = explicit_measured or [
            candidate for candidate in clean_candidates
            if int(candidate.get('height') or 0) > 0 and not candidate['is_download_addr']
        ]
        lower_or_equal = [
            candidate for candidate in measured
            if int(candidate.get('height') or 0) <= target_height
        ]
        if lower_or_equal:
            return max(
                lower_or_equal,
                key=lambda item: (
                    int(item.get('height') or 0),
                    1 if item.get('is_h264') else 0,
                    int(item.get('metric') or 0),
                ),
            )

        higher = [
            candidate for candidate in measured
            if int(candidate.get('height') or 0) > target_height
        ]
        if higher:
            return min(
                higher,
                key=lambda item: (
                    int(item.get('height') or 0),
                    0 if item.get('is_h264') else 1,
                    -int(item.get('metric') or 0),
                ),
            )
        return None

    quality = video_download_quality()
    target_height = download_quality_target_height(quality)
    if target_height > 0:
        target_best = best_target_candidate(target_height)
        target_h264 = None
        if target_best:
            selected_height = int(target_best.get('height') or 0)
            target_h264 = next(
                (
                    candidate for candidate in clean_candidates
                    if candidate['is_h264']
                    and int(candidate.get('height') or 0) == selected_height
                    and not candidate['is_lowbr']
                    and not candidate['is_download_addr']
                ),
                None,
            )
        for candidate in (target_best, target_h264, highest_metric, h264_best, download_addr, first):
            push(candidate)
    elif quality == 'highest':
        for candidate in (highest_metric, h264_best, download_addr, first):
            push(candidate)
    elif quality == 'h264':
        for candidate in (h264_best, highest_metric, download_addr, first):
            push(candidate)
    elif quality == 'smallest':
        for candidate in (lowbr, smallest_metric, h264_best, first):
            push(candidate)
    else:
        for candidate in (h264_best, highest_metric, download_addr, first):
            push(candidate)

    if target_height > 0:
        rest = sorted(
            clean_candidates,
            key=lambda item: (
                abs(int(item.get('height') or 0) - target_height)
                if int(item.get('height') or 0) > 0
                else 99999,
                -int(item.get('height') or 0),
                -int(item.get('metric') or 0),
            ),
        )
    else:
        rest = sorted(clean_candidates, key=lambda item: item['metric'], reverse=True)
    for candidate in rest:
        push(candidate)

    return ordered


def select_video_url(video_data: dict) -> str:
    urls = get_video_download_urls(video_data)
    return urls[0] if urls else ''


def select_dash_video_url(video_data: dict) -> str:
    for bit_rate in (video_data or {}).get('bit_rate') or []:
        if not isinstance(bit_rate, dict) or bit_rate.get('format') != 'dash' or bit_rate.get('is_h265'):
            continue
        urls = (bit_rate.get('play_addr') or {}).get('url_list') or []
        for url in urls:
            text = str(url or '').strip()
            if text and 'media-video' in text:
                return text
        for url in urls:
            text = str(url or '').strip()
            if text:
                return text
    return ''


def select_dash_audio_url(video_data: dict) -> str:
    for audio_rate in (video_data or {}).get('bit_rate_audio') or []:
        url_list = ((audio_rate or {}).get('audio_meta') or {}).get('url_list') or {}
        for key in ('main_url', 'backup_url', 'fallback_url'):
            text = str(url_list.get(key) or '').strip()
            if text:
                return text
    return ''


def build_video_media_urls(video_data: dict) -> list[dict]:
    video_data = video_data or {}
    selected_url = select_video_url(video_data)
    return [{'type': 'video', 'url': selected_url}] if selected_url else []


def available_video_quality_height(video_data: dict) -> int:
    return max(
        (
            int(candidate.get('height') or 0)
            for candidate in collect_video_candidates(video_data or {})
            if not candidate.get('is_watermark')
            and not candidate.get('is_download_addr')
            and not candidate.get('is_lowbr')
            and int(candidate.get('height') or 0) > 0
        ),
        default=0,
    )


def video_quality_candidate_count(video_data: dict) -> int:
    return sum(
        1
        for candidate in collect_video_candidates(video_data or {})
        if not candidate.get('is_watermark')
        and candidate.get('is_quality_candidate')
        and not candidate.get('is_download_addr')
        and not candidate.get('is_lowbr')
    )


def bit_rate_download_key(bit_rate: dict) -> str:
    url_key = '|'.join(
        url for url in (
            first_url(bit_rate.get('play_addr_h264')),
            first_url(bit_rate.get('play_addr')),
        )
        if url
    )
    if url_key:
        return url_key
    return json.dumps([
        bit_rate.get('gear_name') or '',
        bit_rate.get('format') or '',
        bit_rate.get('quality_type') or 0,
        bit_rate.get('width') or 0,
        bit_rate.get('height') or 0,
        bit_rate.get('data_size') or 0,
    ], ensure_ascii=False, separators=(',', ':'))
