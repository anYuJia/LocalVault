"""媒体 URL 处理与请求来源校验工具。

从 web_app.py 抽离。模块内部依赖通过 setup_media_url_utils 注入。
"""
from __future__ import annotations

from typing import Callable
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

from flask import request

from src.config.config import Config

# 媒体代理允许的域名后缀
ALLOWED_MEDIA_HOST_SUFFIXES = (
    'douyin.com',
    'douyinvod.com',
    'douyinpic.com',
    'douyinstatic.com',
    'byteimg.com',
    'ixigua.com',
    'amemv.com',
    'snssdk.com',
    'pstatp.com',
)
# 需要转发账号 Cookie 的域名后缀
COOKIE_MEDIA_HOST_SUFFIXES = (
    'douyin.com',
    'amemv.com',
    'snssdk.com',
)

# 注入的依赖
_logger = None
_http_requests = None
_get_user_manager: Callable[[], object] | None = None


def setup_media_url_utils(
    *,
    logger,
    http_requests,
    get_user_manager: Callable[[], object],
) -> None:
    """注入 web_app 模块的全局对象，避免循环导入。"""
    global _logger, _http_requests, _get_user_manager
    _logger = logger
    _http_requests = http_requests
    _get_user_manager = get_user_manager


def media_first_url(value):
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, dict):
        url_list = value.get('url_list')
        if isinstance(url_list, list):
            for item in url_list:
                if isinstance(item, str) and item.strip():
                    return item.strip()
        for key in (
            'main_url',
            'backup_url',
            'fallback_url',
            'play_addr',
            'play_url',
            'download_addr',
            'download_url',
            'url',
            'uri',
        ):
            url = media_first_url(value.get(key))
            if key == 'uri' and not url.lower().startswith(('http://', 'https://')):
                continue
            if url:
                return url
    if isinstance(value, list):
        for item in value:
            url = media_first_url(item)
            if url:
                return url
    return ''


def clean_no_watermark_url(url):
    cleaned = str(url or '').strip()
    if not cleaned:
        return ''
    cleaned = cleaned.replace('playwm', 'play')
    try:
        parsed = urlparse(cleaned)
        query = dict(parse_qsl(parsed.query, keep_blank_values=True))
        if 'watermark' in query:
            query['watermark'] = '0'
        return urlunparse(parsed._replace(query=urlencode(query, doseq=True)))
    except Exception:
        return cleaned.replace('watermark=1', 'watermark=0')


def looks_watermarked_url(url):
    text = str(url or '').lower()
    return 'watermark=1' in text or 'playwm' in text or 'logo_name=' in text


def select_recommended_video_url(video_data, fallback=''):
    video_data = video_data or {}
    user_manager = _get_user_manager() if _get_user_manager else None
    try:
        if user_manager:
            selected_url = user_manager._select_video_url(video_data)
            if selected_url:
                return selected_url
    except Exception:
        pass

    candidates = []

    def push_candidate(url, metric):
        normalized_url = media_first_url(url)
        if normalized_url and not is_dash_video_only_url(normalized_url):
            candidates.append((metric, normalized_url))

    def metric(bit_rate):
        if not isinstance(bit_rate, dict):
            return 0
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

    for bit_rate in video_data.get('bit_rate') or []:
        item_metric = metric(bit_rate)
        push_candidate((bit_rate or {}).get('play_addr'), 9_000_000 + item_metric)
        push_candidate((bit_rate or {}).get('play_addr_h264'), 8_000_000 + item_metric)

    push_candidate(fallback, 7_000_000)
    push_candidate(video_data.get('play_addr_h264'), 6_000_000)
    push_candidate(video_data.get('play_addr'), 5_000_000)
    push_candidate(video_data.get('play_addr_lowbr'), 1_000_000)
    push_candidate(video_data.get('download_addr'), 500_000)

    selected = ''
    for _, url in sorted(candidates, key=lambda item: item[0], reverse=True):
        if not looks_watermarked_url(url):
            selected = url
            break
    if not selected and candidates:
        selected = max(candidates, key=lambda item: item[0])[1]
    return clean_no_watermark_url(selected)


def select_dash_video_url(video_data):
    """优先选择推荐流里的 h264 DASH 分片源，用于播放器 seek。"""
    video_data = video_data or {}
    for bit_rate in video_data.get('bit_rate') or []:
        if not isinstance(bit_rate, dict):
            continue
        if str(bit_rate.get('format') or '').lower() != 'dash':
            continue
        if bool(bit_rate.get('is_h265')):
            continue
        urls = ((bit_rate.get('play_addr') or {}).get('url_list') or [])
        if not isinstance(urls, list):
            continue
        for url in urls:
            url = str(url or '').strip()
            if url and 'media-video-avc1' in url:
                return url
        for url in urls:
            url = str(url or '').strip()
            if url:
                return url
    return ''


def select_dash_audio_url(video_data):
    """选择与 DASH 视频配套的音频源。"""
    video_data = video_data or {}
    for audio_rate in video_data.get('bit_rate_audio') or []:
        if not isinstance(audio_rate, dict):
            continue
        audio_meta = audio_rate.get('audio_meta') or {}
        url = media_first_url(audio_meta.get('url_list'))
        if url:
            return url
    return ''


def infer_media_type_from_url(url, fallback_type='video'):
    """根据 URL 粗略推断媒体类型，用于兼容旧前端传入的字符串数组。"""
    normalized_fallback = fallback_type if fallback_type in ('video', 'image', 'live_photo', 'audio') else 'video'
    if not isinstance(url, str) or not url:
        return normalized_fallback

    clean_url = url.split('?', 1)[0].lower()
    if clean_url.endswith(('.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.heic', '.heif')):
        return 'image'
    if clean_url.endswith(('.mp3', '.m4a', '.aac', '.wav', '.flac', '.ogg')):
        return 'audio'
    if clean_url.endswith(('.mp4', '.mov', '.m4v', '.webm')):
        return 'video'
    return normalized_fallback


def normalize_media_urls(media_urls, raw_media_type='video'):
    """统一媒体数据结构为 [{'url': str, 'type': str}]。"""
    if not isinstance(media_urls, list):
        raise ValueError(f"媒体URL格式错误: {type(media_urls)}")

    fallback_type = raw_media_type if raw_media_type in ('video', 'image', 'live_photo', 'audio') else 'video'
    normalized_urls = []

    for item in media_urls:
        if isinstance(item, dict):
            url = str(item.get('url', '')).strip()
            if not url:
                continue
            normalized_urls.append({
                'url': url,
                'type': item.get('type') or infer_media_type_from_url(url, fallback_type)
            })
            continue

        if isinstance(item, str):
            url = item.strip()
            if not url:
                continue
            normalized_urls.append({
                'url': url,
                'type': infer_media_type_from_url(url, fallback_type)
            })
            continue

        _logger.warning(f"跳过不支持的媒体URL项: {item}")

    return normalized_urls


def filter_live_photo_media_urls(media_urls):
    """Apply live-photo video/image download preferences to normalized media URLs."""
    if not isinstance(media_urls, list):
        return []
    has_live_photo = any(isinstance(item, dict) and item.get('type') == 'live_photo' for item in media_urls)
    if not has_live_photo:
        return media_urls

    keep_video = bool(getattr(Config, 'DOWNLOAD_LIVE_PHOTO_VIDEO', True))
    keep_image = bool(getattr(Config, 'DOWNLOAD_LIVE_PHOTO_IMAGE', True))
    if not keep_video and not keep_image:
        keep_video = True

    filtered = []
    for item in media_urls:
        if not isinstance(item, dict):
            continue
        media_type = item.get('type')
        if media_type == 'live_photo' and not keep_video:
            continue
        if media_type == 'image' and not keep_image:
            continue
        filtered.append(item)
    return filtered


def clean_video_download_url(url: str) -> str:
    return (
        str(url or '').strip()
        .replace('watermark=1', 'watermark=0')
        .replace('playwm', 'play')
    )


def is_watermark_video_url(url: str) -> bool:
    normalized_url = str(url or '').strip().lower()
    return bool(
        normalized_url
        and (
            'playwm' in normalized_url
            or 'watermark=1' in normalized_url
            or '/aweme/v1/playwm' in normalized_url
        )
    )


def is_dash_video_only_url(url: str) -> bool:
    normalized_url = str(url or '').strip().lower()
    return 'media-video' in normalized_url or 'media_video' in normalized_url


def normalize_download_media_urls(media_urls, raw_media_type='video'):
    normalized_urls = normalize_media_urls(media_urls, raw_media_type) if media_urls else []
    cleaned_urls = []
    seen = set()

    for item in normalized_urls:
        url = item.get('url', '')
        media_type = item.get('type') or infer_media_type_from_url(url, raw_media_type)
        if media_type == 'video':
            url = clean_video_download_url(url)
            if is_watermark_video_url(url) or is_dash_video_only_url(url):
                continue
        if not url or (media_type, url) in seen:
            continue
        seen.add((media_type, url))
        cleaned_urls.append({'url': url, 'type': media_type})

    return filter_live_photo_media_urls(cleaned_urls)


def is_allowed_media_url(url: str) -> bool:
    """只允许代理明确属于抖音/字节媒体域名的 http(s) URL。"""
    try:
        parsed = urlparse((url or '').strip())
    except Exception:
        return False

    if parsed.scheme not in ('http', 'https') or not parsed.hostname:
        return False

    hostname = parsed.hostname.lower().rstrip('.')
    return any(hostname == suffix or hostname.endswith(f'.{suffix}') for suffix in ALLOWED_MEDIA_HOST_SUFFIXES)


def should_forward_douyin_cookie(url: str) -> bool:
    """只向登录相关域名转发账号 Cookie。"""
    try:
        hostname = (urlparse((url or '').strip()).hostname or '').lower().rstrip('.')
    except Exception:
        return False
    return any(hostname == suffix or hostname.endswith(f'.{suffix}') for suffix in COOKIE_MEDIA_HOST_SUFFIXES)


def media_url_label(raw_url: str) -> str:
    """日志里只保留媒体域名和路径，避免刷出签名参数。"""
    try:
        parsed = urlparse((raw_url or '').strip())
        if parsed.netloc:
            return f'{parsed.netloc}{parsed.path}'[:160]
    except Exception:
        pass
    return str(raw_url or '')[:80]


def allowed_media_request_origin() -> tuple[bool, str | None]:
    origin = (request.headers.get('Origin') or '').strip()
    if not origin or origin == 'null':
        return True, None

    try:
        parsed = urlparse(origin)
    except Exception:
        return False, None

    hostname = (parsed.hostname or '').lower().rstrip('.')
    if parsed.scheme not in ('http', 'https') or not hostname:
        return False, None

    request_host = (request.host or '').split(':', 1)[0].lower().rstrip('.')
    allowed_hosts = {'127.0.0.1', 'localhost', 'tauri.localhost'}
    if request_host:
        allowed_hosts.add(request_host)

    if hostname in allowed_hosts:
        return True, origin

    return False, None


def resolve_media_redirect_target(current_url: str, location: str) -> str | None:
    if not location:
        return None
    try:
        return _http_requests.compat.urljoin(current_url, location)
    except Exception:
        return None
