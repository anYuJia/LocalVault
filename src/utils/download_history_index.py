import json
import os
import threading
import time
from pathlib import Path

from src.config.config import Config

_INDEX_VERSION = 2
_CACHE_LOCK = threading.Lock()
_CACHE_ROOTS = None
_CACHE_ITEMS = None

LOCAL_MEDIA_EXTENSIONS = {
    '.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi', '.flv',
    '.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif', '.heic', '.heif',
    '.mp3', '.m4a', '.aac', '.wav', '.flac', '.ogg',
}


def _index_file_path() -> Path:
    return Path(os.path.dirname(Config.CONFIG_FILE)) / 'download_history_index.json'


def get_download_history_roots() -> list[Path]:
    roots = []
    seen = set()

    for raw_path in [Config.DOWNLOAD_DIR, *getattr(Config, 'HISTORY_DIRS', [])]:
        if not raw_path:
            continue
        path = Path(raw_path).resolve()
        key = str(path).lower()
        if key in seen:
            continue
        seen.add(key)
        roots.append(path)

    return roots


def _roots_signature(roots: list[Path]) -> tuple[str, ...]:
    return tuple(str(root) for root in roots)


def _is_subpath(candidate: Path, root: Path) -> bool:
    try:
        candidate.resolve().relative_to(root.resolve())
        return True
    except ValueError:
        return False


def _item_from_path(path: Path, roots: list[Path]) -> dict | None:
    candidate = Path(path).expanduser().resolve()
    if not candidate.exists() or not candidate.is_file():
        return None
    if candidate.name == 'download_record.json':
        return None
    if candidate.suffix.lower() not in LOCAL_MEDIA_EXTENSIONS:
        return None

    root = next((root for root in roots if _is_subpath(candidate, root)), None)
    if root is None:
        return None

    stat = candidate.stat()
    rel_path = candidate.relative_to(root)
    parts = rel_path.parts
    author = parts[0] if len(parts) > 1 else ''

    return {
        'name': candidate.name,
        'path': str(candidate),
        'relative_path': str(rel_path),
        'root_path': str(root),
        'author': author,
        'size': stat.st_size,
        'modified_at': int(stat.st_mtime),
        'extension': candidate.suffix.lower(),
    }


def _sorted_items(items: list[dict]) -> list[dict]:
    return sorted(items, key=lambda item: item.get('modified_at', 0), reverse=True)


def _clone_items(items: list[dict]) -> list[dict]:
    return [dict(item) for item in items]


def _read_disk_index(expected_roots: tuple[str, ...]) -> list[dict] | None:
    index_file = _index_file_path()
    if not index_file.exists():
        return None

    try:
        payload = json.loads(index_file.read_text(encoding='utf-8'))
    except Exception:
        return None

    if not isinstance(payload, dict):
        return None
    if payload.get('version') != _INDEX_VERSION:
        return None

    payload_roots = tuple(payload.get('roots') or [])
    if payload_roots != expected_roots:
        return None

    items = payload.get('items') or []
    if not isinstance(items, list):
        return None

    return _sorted_items([item for item in items if isinstance(item, dict)])


def _write_disk_index(roots_signature: tuple[str, ...], items: list[dict]) -> None:
    index_file = _index_file_path()
    payload = {
        'version': _INDEX_VERSION,
        'roots': list(roots_signature),
        'updated_at': int(time.time()),
        'items': _sorted_items(items),
    }

    index_file.parent.mkdir(parents=True, exist_ok=True)
    temp_file = index_file.with_suffix('.tmp')
    temp_file.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding='utf-8')
    os.replace(temp_file, index_file)


def invalidate_download_history_cache(drop_disk: bool = False) -> None:
    global _CACHE_ROOTS, _CACHE_ITEMS

    with _CACHE_LOCK:
        _CACHE_ROOTS = None
        _CACHE_ITEMS = None

    if drop_disk:
        try:
            _index_file_path().unlink(missing_ok=True)
        except Exception:
            pass


def rebuild_download_history_index() -> list[dict]:
    global _CACHE_ROOTS, _CACHE_ITEMS

    roots = get_download_history_roots()
    roots_signature = _roots_signature(roots)
    items = []

    for root in roots:
        if not root.exists():
            continue
        for path in root.rglob('*'):
            item = _item_from_path(path, roots)
            if item:
                items.append(item)

    items = _sorted_items(items)

    with _CACHE_LOCK:
        _write_disk_index(roots_signature, items)
        _CACHE_ROOTS = roots_signature
        _CACHE_ITEMS = _clone_items(items)

    return _clone_items(items)


def get_download_history_items(force_refresh: bool = False) -> list[dict]:
    global _CACHE_ROOTS, _CACHE_ITEMS

    roots = get_download_history_roots()
    roots_signature = _roots_signature(roots)

    with _CACHE_LOCK:
        if not force_refresh and _CACHE_ROOTS == roots_signature and _CACHE_ITEMS is not None:
            return _clone_items(_CACHE_ITEMS)

        if not force_refresh:
            disk_items = _read_disk_index(roots_signature)
            if disk_items is not None:
                _CACHE_ROOTS = roots_signature
                _CACHE_ITEMS = _clone_items(disk_items)
                return _clone_items(disk_items)

    return rebuild_download_history_index()


def upsert_download_history_entries(paths: list[str | os.PathLike]) -> None:
    global _CACHE_ROOTS, _CACHE_ITEMS

    if not paths:
        return

    roots = get_download_history_roots()
    roots_signature = _roots_signature(roots)

    with _CACHE_LOCK:
        if _CACHE_ROOTS == roots_signature and _CACHE_ITEMS is not None:
            items = _clone_items(_CACHE_ITEMS)
        else:
            items = _read_disk_index(roots_signature) or []

        by_path = {item['path']: dict(item) for item in items if item.get('path')}

        for raw_path in paths:
            item = _item_from_path(Path(raw_path), roots)
            if item:
                by_path[item['path']] = item

        merged_items = _sorted_items(list(by_path.values()))
        _write_disk_index(roots_signature, merged_items)
        _CACHE_ROOTS = roots_signature
        _CACHE_ITEMS = _clone_items(merged_items)


def remove_download_history_entries(paths: list[str | os.PathLike]) -> None:
    global _CACHE_ROOTS, _CACHE_ITEMS

    if not paths:
        return

    roots_signature = _roots_signature(get_download_history_roots())
    targets = {str(Path(path).expanduser().resolve()) for path in paths}

    with _CACHE_LOCK:
        if _CACHE_ROOTS == roots_signature and _CACHE_ITEMS is not None:
            items = _clone_items(_CACHE_ITEMS)
        else:
            items = _read_disk_index(roots_signature) or []

        filtered_items = [item for item in items if item.get('path') not in targets]
        _write_disk_index(roots_signature, filtered_items)
        _CACHE_ROOTS = roots_signature
        _CACHE_ITEMS = _clone_items(filtered_items)


def move_download_history_entries(move_map: dict[str, str]) -> None:
    if not move_map:
        return

    remove_download_history_entries(list(move_map.keys()))
    upsert_download_history_entries(list(move_map.values()))
