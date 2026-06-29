"""下载历史相关路由。

从 web_app.py 抽离。模块内部依赖通过 setup 注入，
外部调用方（web_app.py）需要在导入本模块后调用 setup_download_history(...)。
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any, Callable

from flask import Blueprint, jsonify, request, send_file

from src.utils.download_history_index import (
    move_download_history_entries,
    remove_download_history_entries,
)

download_history_bp = Blueprint("download_history", __name__)

# 注入的依赖
_logger = None
_Config = None
_IS_WINDOWS: bool = False
_request_json: Callable[[], dict] | None = None
_get_download_root: Callable[[], Path] | None = None
_get_all_download_roots: Callable[[], list[Path]] | None = None
_get_root_for_path: Callable[[Path], Path | None] | None = None
_safe_history_path: Callable[[str], Path] | None = None
_filter_download_history_items: Callable[[list[dict]], tuple[list[dict], int, int, dict | None]] | None = None
_get_download_history_items: Callable[..., list[dict]] | None = None
_guess_local_media_mimetype: Callable[[Path], str] | None = None
_cleanup_empty_parent_dirs: Callable[[Path, Path], None] | None = None
_unique_destination_path: Callable[[Path], Path] | None = None
_LOCAL_MEDIA_EXTENSIONS: set[str] | None = None


def setup_download_history(
    *,
    logger,
    Config,
    is_windows: bool,
    request_json: Callable[[], dict],
    get_download_root: Callable[[], Path],
    get_all_download_roots: Callable[[], list[Path]],
    get_root_for_path: Callable[[Path], Path | None],
    safe_history_path: Callable[[str], Path],
    filter_download_history_items: Callable[[list[dict]], tuple[list[dict], int, int, dict | None]],
    get_download_history_items: Callable[..., list[dict]],
    guess_local_media_mimetype: Callable[[Path], str],
    cleanup_empty_parent_dirs: Callable[[Path, Path], None],
    unique_destination_path: Callable[[Path], Path],
    local_media_extensions: set[str],
) -> None:
    """注入 web_app 模块的全局对象，避免循环导入。"""
    global _logger, _Config, _IS_WINDOWS, _request_json
    global _get_download_root, _get_all_download_roots, _get_root_for_path
    global _safe_history_path, _filter_download_history_items, _get_download_history_items
    global _guess_local_media_mimetype, _cleanup_empty_parent_dirs, _unique_destination_path
    global _LOCAL_MEDIA_EXTENSIONS
    _logger = logger
    _Config = Config
    _IS_WINDOWS = is_windows
    _request_json = request_json
    _get_download_root = get_download_root
    _get_all_download_roots = get_all_download_roots
    _get_root_for_path = get_root_for_path
    _safe_history_path = safe_history_path
    _filter_download_history_items = filter_download_history_items
    _get_download_history_items = get_download_history_items
    _guess_local_media_mimetype = guess_local_media_mimetype
    _cleanup_empty_parent_dirs = cleanup_empty_parent_dirs
    _unique_destination_path = unique_destination_path
    _LOCAL_MEDIA_EXTENSIONS = local_media_extensions


def _write_text_to_clipboard(text: str) -> None:
    if _IS_WINDOWS:
        subprocess.run(['clip'], input=text, text=True, check=True, timeout=5, creationflags=0x08000000)
        return

    if sys.platform == 'darwin':
        subprocess.run(['pbcopy'], input=text, text=True, check=True, timeout=5)
        return

    linux_commands = [
        ['wl-copy'],
        ['xclip', '-selection', 'clipboard'],
        ['xsel', '--clipboard', '--input'],
    ]
    for command in linux_commands:
        if shutil.which(command[0]):
            subprocess.run(command, input=text, text=True, check=True, timeout=5)
            return

    raise RuntimeError('当前系统缺少可用的剪贴板工具')


@download_history_bp.route('/api/download_history', methods=['GET'])
def get_download_history():
    """获取下载历史文件列表。"""
    try:
        force_refresh = str(request.args.get('refresh', '')).lower() in ('1', 'true', 'yes')
        items, total, total_size, latest = _filter_download_history_items(
            _get_download_history_items(force_refresh=force_refresh)
        )
        root = _get_download_root()
        return jsonify({
            'success': True,
            'download_root': str(root),
            'download_roots': [str(item) for item in _get_all_download_roots()],
            'base_dir': _Config.BASE_DIR,
            'items': items,
            'total': total,
            'total_size': total_size,
            'latest': latest,
        })
    except Exception as e:
        _logger.error(f"获取下载历史失败: {str(e)}")
        return jsonify({'success': False, 'message': f'获取下载历史失败: {str(e)}'}), 500


@download_history_bp.route('/api/local-media')
def local_media():
    """安全读取下载目录内的本地媒体，用于 pywebview 中显示缩略图/视频首帧。"""
    try:
        file_path = _safe_history_path(request.args.get('path', ''))
        if not file_path.exists() or not file_path.is_file():
            return 'File not found', 404
        if file_path.suffix.lower() not in _LOCAL_MEDIA_EXTENSIONS:
            return 'Unsupported media type', 415

        mimetype = _guess_local_media_mimetype(file_path)
        response = send_file(
            file_path,
            mimetype=mimetype,
            conditional=True,
            etag=True,
            last_modified=file_path.stat().st_mtime,
            max_age=3600,
        )
        response.headers['Accept-Ranges'] = 'bytes'
        response.headers['Cache-Control'] = 'private, max-age=3600'
        return response
    except ValueError as error:
        return str(error), 400
    except Exception as e:
        _logger.error(f"读取本地媒体失败: {str(e)}")
        return 'Local media error', 500


@download_history_bp.route('/api/clipboard/write', methods=['POST'])
def write_clipboard_text():
    """写入系统剪贴板，供嵌入 WebView 和普通浏览器兜底使用。"""
    try:
        data = _request_json()
        text = str(data.get('text') or '')
        if not text:
            return jsonify({'success': False, 'message': '复制内容不能为空'}), 400

        _write_text_to_clipboard(text)
        return jsonify({'success': True})
    except Exception as e:
        _logger.error(f"写入剪贴板失败: {str(e)}")
        return jsonify({'success': False, 'message': f'写入剪贴板失败: {str(e)}'}), 500


@download_history_bp.route('/api/download_history/open', methods=['POST'])
def open_download_history_file():
    """打开下载文件。"""
    try:
        data = _request_json()
        file_path = _safe_history_path(data.get('path', ''))
        if not file_path.exists() or not file_path.is_file():
            return jsonify({'success': False, 'message': '文件不存在'}), 404

        if _IS_WINDOWS:
            os.startfile(str(file_path))
        elif sys.platform == 'darwin':
            subprocess.Popen(['open', str(file_path)])
        else:
            subprocess.Popen(['xdg-open', str(file_path)])

        return jsonify({'success': True})
    except Exception as e:
        _logger.error(f"打开下载文件失败: {str(e)}")
        return jsonify({'success': False, 'message': f'打开下载文件失败: {str(e)}'}), 500


@download_history_bp.route('/api/download_history/open_location', methods=['POST'])
def open_download_history_location():
    """打开文件所在目录。"""
    try:
        data = _request_json()
        file_path = _safe_history_path(data.get('path', ''))
        if not file_path.exists():
            return jsonify({'success': False, 'message': '文件不存在'}), 404

        open_dir = file_path if file_path.is_dir() else file_path.parent

        if _IS_WINDOWS:
            if file_path.is_dir():
                subprocess.Popen(['explorer.exe', os.path.normpath(str(open_dir))], creationflags=0x08000000)
            else:
                normalized_path = os.path.normpath(str(file_path))
                subprocess.Popen(['explorer.exe', '/select,', normalized_path], creationflags=0x08000000)
        elif sys.platform == 'darwin':
            if file_path.is_dir():
                subprocess.Popen(['open', str(open_dir)])
            else:
                subprocess.Popen(['open', '-R', str(file_path)])
        else:
            subprocess.Popen(['xdg-open', str(open_dir)])

        return jsonify({'success': True})
    except Exception as e:
        _logger.error(f"打开文件位置失败: {str(e)}")
        return jsonify({'success': False, 'message': f'打开文件位置失败: {str(e)}'}), 500


@download_history_bp.route('/api/download_history/open_directory', methods=['POST'])
def open_download_history_directory():
    """打开当前下载目录。"""
    try:
        download_root = _get_download_root()
        download_root.mkdir(parents=True, exist_ok=True)

        if _IS_WINDOWS:
            os.startfile(str(download_root))
        elif sys.platform == 'darwin':
            subprocess.Popen(['open', str(download_root)])
        else:
            subprocess.Popen(['xdg-open', str(download_root)])

        return jsonify({'success': True, 'path': str(download_root)})
    except Exception as e:
        _logger.error(f"打开下载目录失败: {str(e)}")
        return jsonify({'success': False, 'message': f'打开下载目录失败: {str(e)}'}), 500


@download_history_bp.route('/api/download_history/delete', methods=['POST'])
def delete_download_history_files():
    """删除下载文件，支持批量。"""
    deleted = []
    missing = []
    try:
        data = _request_json()
        raw_paths = data.get('paths') or []
        if not isinstance(raw_paths, list) or not raw_paths:
            return jsonify({'success': False, 'message': '请选择至少一个文件'}), 400

        for raw_path in raw_paths:
            try:
                file_path = _safe_history_path(str(raw_path))
            except ValueError:
                missing.append(str(raw_path))
                continue

            if not file_path.exists() or not file_path.is_file():
                missing.append(str(file_path))
                continue

            root = _get_root_for_path(file_path)
            if root is None:
                missing.append(str(file_path))
                continue

            file_path.unlink()
            deleted.append(str(file_path))
            _cleanup_empty_parent_dirs(file_path, root)

        return jsonify({
            'success': True,
            'deleted_count': len(deleted),
            'missing_count': len(missing),
            'deleted': deleted,
            'missing': missing
        })
    except Exception as e:
        _logger.error(f"删除下载文件失败: {str(e)}")
        return jsonify({'success': False, 'message': f'删除下载文件失败: {str(e)}'}), 500
    finally:
        if deleted:
            remove_download_history_entries(deleted)


@download_history_bp.route('/api/download_history/move_selected', methods=['POST'])
def move_selected_download_history_files():
    """将选中的下载文件迁移到新的下载目录。"""
    try:
        data = _request_json()
        raw_paths = data.get('paths') or []
        target_dir_raw = (data.get('target_dir') or '').strip()

        if not isinstance(raw_paths, list) or not raw_paths:
            return jsonify({'success': False, 'message': '请选择至少一个文件'}), 400
        if not target_dir_raw:
            return jsonify({'success': False, 'message': '目标目录不能为空'}), 400

        target_dir = Path(target_dir_raw).expanduser().resolve()
        target_dir.mkdir(parents=True, exist_ok=True)

        moved = []
        missing = []
        moved_map = {}

        for raw_path in raw_paths:
            try:
                file_path = _safe_history_path(str(raw_path))
            except ValueError:
                missing.append(str(raw_path))
                continue

            if not file_path.exists() or not file_path.is_file():
                missing.append(str(file_path))
                continue

            root = _get_root_for_path(file_path)
            if root is None:
                missing.append(str(file_path))
                continue

            relative_path = file_path.relative_to(root)
            destination = _unique_destination_path(target_dir / relative_path)
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(file_path), str(destination))
            moved.append(str(destination))
            moved_map[str(file_path)] = str(destination)
            _cleanup_empty_parent_dirs(file_path, root)

        _Config.HISTORY_DIRS = _Config.normalize_history_dirs([
            *getattr(_Config, 'HISTORY_DIRS', []),
            str(target_dir)
        ])
        _Config.save_config(
            _Config.COOKIE,
            _Config.BASE_DIR,
            _Config.HISTORY_DIRS,
            download_quality=_Config.DOWNLOAD_QUALITY,
            max_concurrent=_Config.MAX_CONCURRENT,
        )
        move_download_history_entries(moved_map)

        return jsonify({
            'success': True,
            'moved_count': len(moved),
            'missing_count': len(missing),
            'moved': moved,
            'missing': missing,
            'download_root': str(_get_download_root()),
            'download_roots': [str(root) for root in _get_all_download_roots()]
        })
    except Exception as e:
        _logger.error(f"迁移选中文件失败: {str(e)}")
        return jsonify({'success': False, 'message': f'迁移选中文件失败: {str(e)}'}), 500


@download_history_bp.route('/api/check_files_exist', methods=['POST'])
def check_files_exist():
    """检查给定的文件路径列表在磁盘上是否存在。"""
    try:
        data = _request_json()
        paths = data.get('paths') or []
        if not isinstance(paths, list):
            return jsonify({'success': False, 'message': '参数格式错误，需为列表'}), 400

        exists_result = []
        for path_str in paths:
            try:
                file_path = _safe_history_path(str(path_str))
                exists_result.append(file_path.exists())
            except Exception:
                exists_result.append(False)

        return jsonify({'success': True, 'exists': exists_result})
    except Exception as e:
        _logger.error(f"检查文件是否存在失败: {str(e)}")
        return jsonify({'success': False, 'message': f'检查文件是否存在失败: {str(e)}'}), 500

