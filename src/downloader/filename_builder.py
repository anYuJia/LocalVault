"""Download filename and folder-name builders."""
from __future__ import annotations

import re
import time
from typing import Optional

from src.config.config import Config


def truncate_filename_text(
    value: str,
    default: str,
    max_length: int,
    max_bytes: int,
    protected_suffix: str = '',
) -> str:
    text = str(value or '')
    suffix = str(protected_suffix or '')

    if suffix and text.endswith(suffix):
        suffix_len = len(suffix)
        if suffix_len >= max_length:
            text = suffix[:max_length]
        else:
            prefix = text[:-suffix_len][: max(0, max_length - suffix_len)]
            text = f"{prefix}{suffix}"

        if max_bytes > 0:
            suffix_bytes = len(suffix.encode('utf-8'))
            if suffix_bytes >= max_bytes:
                text = suffix.encode('utf-8')[:max_bytes].decode('utf-8', 'ignore')
            else:
                prefix = text[:-suffix_len] if suffix_len else text
                while prefix and len(f"{prefix}{suffix}".encode('utf-8')) > max_bytes:
                    prefix = prefix[:-1]
                text = f"{prefix}{suffix}"
    else:
        text = text[:max_length]
        if max_bytes > 0:
            while text and len(text.encode('utf-8')) > max_bytes:
                text = text[:-1]

    text = text.strip(' ._')
    return text or default


def coerce_timestamp_seconds(value) -> Optional[float]:
    try:
        timestamp = float(value or 0)
    except (TypeError, ValueError):
        return None
    if timestamp <= 0:
        return None
    if timestamp > 1_000_000_000_000:
        timestamp = timestamp / 1000
    return timestamp


def template_fields(
    desc: str,
    aweme_id: str,
    author: str = '',
    media_type: str = '',
    create_time=None,
) -> dict:
    normalized_title = ' '.join(str(desc or '').split()).strip()
    normalized_aweme_id = str(aweme_id or '').strip()
    normalized_author = ' '.join(str(author or '').split()).strip()
    timestamp = coerce_timestamp_seconds(create_time)
    published_at = time.localtime(timestamp) if timestamp is not None else None
    return {
        'title': normalized_title,
        'aweme_id': normalized_aweme_id,
        'author': normalized_author,
        'date': time.strftime('%Y%m%d', published_at) if published_at is not None else '',
        'time': time.strftime('%Y%m%d_%H%M%S', published_at) if published_at is not None else '',
        'media_type': str(media_type or '').strip(),
    }


def render_template(template: str, fields: dict, default_template: str) -> str:
    template_text = str(template or '').strip() or default_template

    def replace_token(match):
        return str(fields.get(match.group(1), ''))

    return re.sub(r'\{([a-zA-Z_][a-zA-Z0-9_]*)\}', replace_token, template_text)


def neutralize_path_separators(value: str) -> str:
    return re.sub(r'[\\/]+', '_', str(value or ''))


def sanitize_template_component(value: str, default: str) -> str:
    sanitized = re.sub(r'[\\/:*?"<>|\x00-\x1f]', '_', str(value or ''))
    sanitized = ' '.join(sanitized.split()).strip(' ._')
    return sanitized if sanitized not in ('', '.', '..') else default


def build_download_title(
    desc: str,
    aweme_id: str,
    author: str = '',
    media_type: str = '',
    template: Optional[str] = None,
    default_prefix: str = '无标题',
    max_length: Optional[int] = None,
    max_bytes: Optional[int] = None,
    create_time=None,
) -> str:
    fields = template_fields(
        desc,
        aweme_id,
        author=author,
        media_type=media_type,
        create_time=create_time,
    )
    normalized_desc = fields['title']
    normalized_aweme_id = fields['aweme_id']
    fallback = default_prefix
    template_text = template if template is not None else getattr(Config, 'FILENAME_TEMPLATE', '{title}')
    base = render_template(
        template_text,
        {**fields, 'title': normalized_desc or default_prefix},
        '{title}',
    )
    base = neutralize_path_separators(base)
    base = ' '.join(base.split()).strip(' ._') or fallback
    protected_suffix = ''
    if normalized_aweme_id and '{aweme_id}' in str(template_text or ''):
        protected_suffix = normalized_aweme_id if base.endswith(normalized_aweme_id) else f'_{normalized_aweme_id}'
    candidate = base
    if protected_suffix and not base.endswith(protected_suffix):
        candidate = f'{base}{protected_suffix}'
    return truncate_filename_text(
        candidate,
        fallback,
        int(max_length or Config.MAX_FILENAME_LENGTH),
        int(max_bytes or getattr(Config, 'MAX_FILENAME_BYTES', 200)),
        protected_suffix=protected_suffix,
    )


def build_download_name(
    author: str,
    desc: str,
    aweme_id: str,
    media_type: str = '',
    default_title_prefix: str = '无标题',
    create_time=None,
) -> str:
    fields = template_fields(
        desc,
        aweme_id,
        author=author,
        media_type=media_type,
        create_time=create_time,
    )
    folder = render_template(
        getattr(Config, 'FOLDER_NAME_TEMPLATE', '{author}'),
        fields,
        '{author}',
    )
    folder = sanitize_template_component(neutralize_path_separators(folder), fields['author'] or '未知作者')
    title = build_download_title(
        desc,
        aweme_id,
        author=author,
        media_type=media_type,
        create_time=create_time,
        default_prefix=default_title_prefix,
    )
    if not getattr(Config, 'AUTO_CREATE_FOLDER', True):
        return title
    return f"{folder}/{title}"
