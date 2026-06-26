"""下载目录、历史文件和本地媒体路径工具。"""
from __future__ import annotations

import mimetypes
import shutil
from pathlib import Path

from flask import request

from src.web.http_utils import request_non_negative_int

LOCAL_MEDIA_EXTENSIONS = {
    '.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi', '.flv',
    '.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif', '.heic', '.heif',
    '.mp3', '.m4a', '.aac', '.wav', '.flac', '.ogg',
}

_Config = None


def setup_path_utils(*, Config) -> None:
    global _Config
    _Config = Config


def get_download_root() -> Path:
    """返回实际下载根目录。"""
    return Path(_Config.DOWNLOAD_DIR).resolve()


def get_all_download_roots() -> list[Path]:
    """返回当前及历史下载目录列表。"""
    roots = []
    seen = set()

    for raw_path in [_Config.DOWNLOAD_DIR, *getattr(_Config, 'HISTORY_DIRS', [])]:
        if not raw_path:
            continue
        path = Path(raw_path).resolve()
        key = str(path).lower()
        if key in seen:
            continue
        seen.add(key)
        roots.append(path)

    return roots


def is_subpath(candidate: Path, root: Path) -> bool:
    try:
        candidate.resolve().relative_to(root.resolve())
        return True
    except ValueError:
        return False


def get_root_for_path(candidate: Path) -> Path | None:
    """返回某个下载文件所属的根目录。"""
    for root in get_all_download_roots():
        if is_subpath(candidate, root):
            return root
    return None


def safe_history_path(raw_path: str) -> Path:
    if not raw_path:
        raise ValueError('路径不能为空')

    candidate = Path(raw_path).expanduser().resolve()
    roots = get_all_download_roots()
    if not any(is_subpath(candidate, root) for root in roots):
        raise ValueError('目标路径不在下载目录范围内')
    return candidate


def guess_local_media_mimetype(path: Path) -> str:
    guessed, _ = mimetypes.guess_type(str(path))
    if guessed:
        return guessed

    suffix = path.suffix.lower()
    if suffix in ('.mp4', '.m4v'):
        return 'video/mp4'
    if suffix == '.mov':
        return 'video/quicktime'
    if suffix == '.webm':
        return 'video/webm'
    if suffix in ('.jpg', '.jpeg'):
        return 'image/jpeg'
    if suffix == '.png':
        return 'image/png'
    if suffix == '.webp':
        return 'image/webp'
    if suffix == '.gif':
        return 'image/gif'
    if suffix in ('.mp3',):
        return 'audio/mpeg'
    if suffix in ('.m4a', '.aac'):
        return 'audio/aac'
    return 'application/octet-stream'


def download_history_media_kind(item: dict) -> str:
    raw_type = str(item.get('media_type') or item.get('file_type') or '').strip().lower().lstrip('.')
    if raw_type in ('video', 'image', 'audio'):
        return raw_type

    extension = str(item.get('extension') or raw_type or '').strip().lower().lstrip('.')
    if not extension and item.get('path'):
        extension = Path(str(item.get('path'))).suffix.lower().lstrip('.')

    if extension in ('mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi', 'flv'):
        return 'video'
    if extension in ('jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'heic', 'heif'):
        return 'image'
    if extension in ('mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg'):
        return 'audio'
    return 'media'


def download_history_timestamp(item: dict) -> int:
    try:
        return int(item.get('timestamp') or item.get('modified_at') or item.get('create_time') or 0)
    except (TypeError, ValueError):
        return 0


def download_history_size(item: dict) -> int:
    try:
        return int(item.get('size') or item.get('file_size') or 0)
    except (TypeError, ValueError):
        return 0


def download_history_matches_query(item: dict, query: str) -> bool:
    if not query:
        return True

    fields = (
        item.get('name'),
        item.get('filename'),
        item.get('title'),
        item.get('desc'),
        item.get('author'),
        item.get('author_id'),
        item.get('aweme_id'),
        item.get('id'),
        item.get('path'),
        item.get('relative_path'),
        item.get('root_path'),
        item.get('extension'),
        item.get('media_type'),
        item.get('file_type'),
    )
    return any(query in str(value).lower() for value in fields if value)


def filter_download_history_items(items: list[dict]) -> tuple[list[dict], int, int, dict | None]:
    query = str(request.args.get('query') or '').strip().lower()
    media_type = str(request.args.get('media_type') or request.args.get('mediaType') or 'all').strip().lower()
    sort_by = str(request.args.get('sort_by') or request.args.get('sortBy') or 'date_desc').strip()

    filtered = [
        dict(item)
        for item in items
        if download_history_matches_query(item, query)
        and (media_type == 'all' or download_history_media_kind(item) == media_type)
    ]

    if sort_by == 'date_asc':
        filtered.sort(key=download_history_timestamp)
    elif sort_by == 'size_desc':
        filtered.sort(key=download_history_size, reverse=True)
    elif sort_by == 'size_asc':
        filtered.sort(key=download_history_size)
    else:
        filtered.sort(key=download_history_timestamp, reverse=True)

    total = len(filtered)
    total_size = sum(download_history_size(item) for item in filtered)
    latest = dict(filtered[0]) if filtered else None

    offset = request_non_negative_int('offset') or 0
    limit = request_non_negative_int('limit')
    paged = filtered[offset:]
    if limit is not None:
        paged = paged[:limit]

    return paged, total, total_size, latest


def move_directory_contents(source_dir: Path, target_dir: Path) -> int:
    """将源目录中的内容合并移动到目标目录。"""
    moved_count = 0
    if not source_dir.exists() or not source_dir.is_dir():
        return moved_count

    target_dir.mkdir(parents=True, exist_ok=True)

    for child in source_dir.iterdir():
        destination = target_dir / child.name
        if destination.exists():
            if child.is_dir() and destination.is_dir():
                moved_count += move_directory_contents(child, destination)
                try:
                    child.rmdir()
                except OSError:
                    pass
                continue

            stem = destination.stem
            suffix = destination.suffix
            counter = 1
            while destination.exists():
                destination = target_dir / f"{stem}_{counter}{suffix}"
                counter += 1

        shutil.move(str(child), str(destination))
        moved_count += 1

    return moved_count


def unique_destination_path(destination: Path) -> Path:
    if not destination.exists():
        return destination

    stem = destination.stem
    suffix = destination.suffix
    counter = 1
    candidate = destination
    while candidate.exists():
        candidate = destination.parent / f"{stem}_{counter}{suffix}"
        counter += 1
    return candidate


def cleanup_empty_parent_dirs(path: Path, stop_root: Path) -> None:
    """Remove empty parent directories without crossing the owning download root."""
    try:
        parent = path.parent.resolve()
        stop_root = stop_root.resolve()
    except Exception:
        return

    while parent != stop_root and is_subpath(parent, stop_root) and parent.exists():
        try:
            next(parent.iterdir())
            break
        except StopIteration:
            parent.rmdir()
            parent = parent.parent
        except OSError:
            break
