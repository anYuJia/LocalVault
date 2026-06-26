"""音乐/音频元数据与下载文件名辅助函数。

从 web_app.py 抽离。模块内部依赖通过 setup_audio_helpers 注入。
"""
from __future__ import annotations

import re
from typing import Callable
from urllib.parse import quote

# 注入的依赖
_Config = None
_coerce_int: Callable[..., int] | None = None


def setup_audio_helpers(
    *,
    Config,
    coerce_int: Callable[..., int],
) -> None:
    """注入 web_app 模块的全局对象，避免循环导入。"""
    global _Config, _coerce_int
    _Config = Config
    _coerce_int = coerce_int


def extract_music_url(music_data):
    """从音乐数据中提取播放地址"""
    play_url = music_data.get('play_url') or {}
    if isinstance(play_url, dict):
        url_list = play_url.get('url_list', [])
        if url_list:
            return url_list[0]
        uri = play_url.get('uri', '')
        if isinstance(uri, str) and uri.startswith('http'):
            return uri

    music_file = music_data.get('music_file') or {}
    if isinstance(music_file, dict):
        url_list = music_file.get('url_list', [])
        if url_list:
            return url_list[0]

    for key in ('play_url', 'src_url', 'mp3_url', 'music_file'):
        val = music_data.get(key, '')
        if isinstance(val, str) and val.startswith('http'):
            return val
    return ''


def normalize_duration_seconds(value):
    """将抖音接口里的时长统一转换为秒。"""
    try:
        duration_value = float(value or 0)
    except (TypeError, ValueError):
        return 0

    if duration_value <= 0:
        return 0

    # 抖音不同接口里的 duration 单位并不统一：
    # - video.duration 常见为 1/100000 秒
    # - music.duration 常见为 1/100 秒
    # - 少量场景会直接返回毫秒或秒
    if duration_value >= 100000:
        return max(1, round(duration_value / 100000))
    if duration_value >= 1000:
        return max(1, round(duration_value / 1000))
    if duration_value >= 100:
        return max(1, round(duration_value / 100))

    return max(1, round(duration_value))


def raw_duration_value(value):
    try:
        duration_value = float(value or 0)
    except (TypeError, ValueError):
        return 0
    return int(round(duration_value)) if duration_value > 0 else 0


def extract_post_status(post):
    status = (post or {}).get('status') or {}
    return {
        'is_delete': bool(status.get('is_delete', False)),
        'private_status': _coerce_int(status.get('private_status'), 0, 0),
        'review_status': _coerce_int(status.get('review_status'), 0, 0),
        'with_goods': bool(status.get('with_goods', False)),
        'is_prohibited': bool(status.get('is_prohibited', False)),
    }


def extract_music_info(music_data):
    """提取统一的音乐信息结构。"""
    if not isinstance(music_data, dict):
        return {
            'title': '',
            'author': '',
            'play_url': '',
            'duration': 0,
        }

    return {
        'title': music_data.get('title', '') or '',
        'author': music_data.get('author', '') or music_data.get('owner_nickname', '') or '',
        'play_url': extract_music_url(music_data),
        'duration': normalize_duration_seconds(music_data.get('duration', 0)),
    }


def sanitize_download_filename(name: str, default: str = '背景音乐') -> str:
    raw_name = (name or '').strip()
    sanitized = re.sub(r'[\\/:*?"<>|]', '_', raw_name)
    sanitized = ' '.join(sanitized.split()).strip(' .')
    sanitized = sanitized[:_Config.MAX_FILENAME_LENGTH]
    return sanitized or default


def guess_audio_extension(url: str, content_type: str) -> str:
    normalized_url = (url or '').lower()
    normalized_type = (content_type or '').lower()

    if '.m4a' in normalized_url or 'audio/mp4' in normalized_type or 'audio/x-m4a' in normalized_type:
        return '.m4a'
    if '.aac' in normalized_url or 'audio/aac' in normalized_type:
        return '.aac'
    if '.wav' in normalized_url or 'audio/wav' in normalized_type:
        return '.wav'
    if '.ogg' in normalized_url or 'audio/ogg' in normalized_type:
        return '.ogg'

    return '.mp3'


def guess_audio_content_type(url: str, content_type: str = '') -> str:
    normalized_type = (content_type or '').lower()
    if normalized_type and normalized_type != 'application/octet-stream':
        return normalized_type.split(';', 1)[0].strip()

    extension = guess_audio_extension(url, normalized_type)
    return {
        '.m4a': 'audio/mp4',
        '.aac': 'audio/aac',
        '.wav': 'audio/wav',
        '.ogg': 'audio/ogg',
    }.get(extension, 'audio/mpeg')


def build_content_disposition(filename: str, disposition_type: str = 'attachment') -> str | None:
    if not filename:
        return None

    ascii_filename = re.sub(r'[^\x20-\x7E]', '_', filename) or 'download.bin'
    return f"{disposition_type}; filename=\"{ascii_filename}\"; filename*=UTF-8''{quote(filename)}"
