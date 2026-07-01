"""配置与好友聊天状态路由。

从 web_app.py 抽离。模块内部依赖通过 setup 注入。
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Callable

from flask import Blueprint, jsonify

from src.utils.download_history_index import (
    invalidate_download_history_cache,
    rebuild_download_history_index,
)

config_bp = Blueprint("config_routes", __name__)

# 注入的依赖
_logger = None
_Config = None
_request_json: Callable[[], dict] | None = None
_coerce_int: Callable[..., int] | None = None
_get_download_root: Callable[[], Path] | None = None
_get_all_download_roots: Callable[[], list[Path]] | None = None
_get_current_app_version: Callable[[], str] | None = None
_init_app: Callable[[], None] | None = None
_move_directory_contents: Callable[[Path, Path], int] | None = None


def setup_config_routes(
    *,
    logger,
    Config,
    request_json: Callable[[], dict],
    coerce_int: Callable[..., int],
    get_download_root: Callable[[], Path],
    get_all_download_roots: Callable[[], list[Path]],
    get_current_app_version: Callable[[], str],
    init_app: Callable[[], None],
    move_directory_contents: Callable[[Path, Path], int],
) -> None:
    """注入 web_app 模块的全局对象，避免循环导入。"""
    global _logger, _Config, _request_json, _coerce_int
    global _get_download_root, _get_all_download_roots
    global _get_current_app_version, _init_app, _move_directory_contents
    _logger = logger
    _Config = Config
    _request_json = request_json
    _coerce_int = coerce_int
    _get_download_root = get_download_root
    _get_all_download_roots = get_all_download_roots
    _get_current_app_version = get_current_app_version
    _init_app = init_app
    _move_directory_contents = move_directory_contents


def _friend_chat_state_path() -> Path:
    current_uid = getattr(_Config, 'CURRENT_SEC_UID', '')
    if current_uid:
        return Path(_Config.CONFIG_FILE).with_name(f'friend_chat_state_{current_uid}.json')
    return Path(_Config.CONFIG_FILE).with_name('friend_chat_state.json')


def _sanitize_friend_chat_message(value):
    if not isinstance(value, dict):
        return None
    text = str(value.get('text') or '').strip()
    if not text:
        return None

    # Check if text is raw JSON command_type
    if text.startswith('{') and 'command_type' in text:
        try:
            parsed = json.loads(text)
            if isinstance(parsed, dict) and ('command_type' in parsed or parsed.get('command_type') == 6):
                ext_data = parsed.get('ext_data') or []
                found_spark = False
                for ext_item in ext_data:
                    if isinstance(ext_item, dict) and ext_item.get('key') == 'a:consecutive_chat_data':
                        val_str = ext_item.get('value') or '{}'
                        try:
                            val_json = json.loads(val_str)
                            count_info = val_json.get('consecutive_count_info') or {}
                            count = count_info.get('consecutive_count') or 1
                            text = f"🔥 连续聊天火花已亮起（第 {count} 天）"
                            found_spark = True
                        except Exception:
                            pass
                if not found_spark:
                    return None
        except Exception:
            pass

    try:
        created_at = int(float(value.get('createdAt') or value.get('created_at') or 0))
    except Exception:
        created_at = 0
    if created_at <= 0:
        return None
    direction = str(value.get('direction') or '').strip()
    if direction not in ('in', 'out'):
        direction = 'out'
    status = str(value.get('status') or '').strip()
    if status not in ('pending', 'sent', 'error'):
        status = 'sent'
    return {
        'id': str(value.get('id') or f'message-{created_at}')[:160],
        'text': text[:1000],
        'createdAt': created_at,
        'status': status,
        'direction': direction,
        'senderUid': str(value.get('senderUid') or value.get('sender_uid') or '')[:80],
    }


def _sanitize_friend_chat_state(value):
    if not isinstance(value, dict):
        return {'summaries': {}, 'unreadCounts': {}}
    raw_summaries = value.get('summaries') if isinstance(value.get('summaries'), dict) else {}
    raw_unread = value.get('unreadCounts') if isinstance(value.get('unreadCounts'), dict) else {}
    summaries = {}
    unread_counts = {}
    for raw_sec_uid, raw_summary in raw_summaries.items():
        sec_uid = str(raw_sec_uid or '').strip()
        if not sec_uid or len(sec_uid) > 220 or not isinstance(raw_summary, dict):
            continue
        latest_message = _sanitize_friend_chat_message(raw_summary.get('latestMessage'))
        try:
            latest_at = int(float(raw_summary.get('latestMessageAt') or 0))
        except Exception:
            latest_at = 0
        try:
            unread_count = max(0, min(999, int(float(raw_summary.get('unreadCount') or 0))))
        except Exception:
            unread_count = 0
        if latest_message:
            latest_at = max(latest_at, int(latest_message.get('createdAt') or 0))
        if latest_at <= 0 and unread_count <= 0:
            continue
        summaries[sec_uid] = {
            'latestMessage': latest_message,
            'latestMessageAt': latest_at,
            'unreadCount': unread_count,
        }
        if unread_count > 0:
            unread_counts[sec_uid] = unread_count
    for raw_sec_uid, raw_count in raw_unread.items():
        sec_uid = str(raw_sec_uid or '').strip()
        if not sec_uid or len(sec_uid) > 220:
            continue
        try:
            count = max(0, min(999, int(float(raw_count or 0))))
        except Exception:
            count = 0
        if count > 0:
            unread_counts[sec_uid] = count
            if sec_uid in summaries:
                summaries[sec_uid]['unreadCount'] = max(int(summaries[sec_uid].get('unreadCount') or 0), count)
    return {
        'summaries': summaries,
        'unreadCounts': unread_counts,
    }


@config_bp.route('/api/config', methods=['GET'])
def get_config():
    """获取配置信息"""
    return jsonify({
        'cookie_set': bool(_Config.COOKIE),
        'download_dir': _Config.BASE_DIR,
        'download_root': str(_get_download_root()),
        'download_roots': [str(root) for root in _get_all_download_roots()],
        'cookie_preview': f"{_Config.COOKIE[:12]}..." if _Config.COOKIE else '',
        'download_quality': getattr(_Config, 'DOWNLOAD_QUALITY', 'auto'),
        'download_live_photo_video': getattr(_Config, 'DOWNLOAD_LIVE_PHOTO_VIDEO', True),
        'download_live_photo_image': getattr(_Config, 'DOWNLOAD_LIVE_PHOTO_IMAGE', True),
        'max_concurrent': getattr(_Config, 'MAX_CONCURRENT', 3),
        'proxy': getattr(_Config, 'PROXY', '') or None,
        'ssl_verify': getattr(_Config, 'SSL_VERIFY', True),
        'filename_template': getattr(_Config, 'FILENAME_TEMPLATE', '{title}'),
        'folder_name_template': getattr(_Config, 'FOLDER_NAME_TEMPLATE', '{author}'),
        'auto_create_folder': getattr(_Config, 'AUTO_CREATE_FOLDER', True),
        'im_friend_sec_user_ids': getattr(_Config, 'IM_FRIEND_SEC_USER_IDS', []),
        'im_friend_include_all_users': getattr(_Config, 'IM_FRIEND_INCLUDE_ALL_USERS', False),
        'im_friend_refresh_interval_seconds': getattr(_Config, 'IM_FRIEND_REFRESH_INTERVAL_SECONDS', 30),
        'app_version': _get_current_app_version(),
        'accounts': getattr(_Config, 'ACCOUNTS', []),
        'current_sec_uid': getattr(_Config, 'CURRENT_SEC_UID', ''),
    })


@config_bp.route('/api/friend_chat_state', methods=['GET'])
def get_friend_chat_state():
    try:
        state_path = _friend_chat_state_path()
        if not state_path.exists():
            return jsonify({'success': True, 'summaries': {}, 'unreadCounts': {}})
        with open(state_path, 'r', encoding='utf-8') as state_file:
            state = _sanitize_friend_chat_state(json.load(state_file))
        return jsonify({'success': True, **state})
    except Exception as error:
        _logger.warning('读取好友聊天状态失败: %s', error)
        return jsonify({'success': True, 'summaries': {}, 'unreadCounts': {}})


@config_bp.route('/api/friend_chat_state', methods=['POST'])
def save_friend_chat_state():
    try:
        state = _sanitize_friend_chat_state(_request_json())
        state_path = _friend_chat_state_path()
        state_path.parent.mkdir(parents=True, exist_ok=True)
        temp_path = state_path.with_suffix(f'{state_path.suffix}.tmp')
        with open(temp_path, 'w', encoding='utf-8') as state_file:
            json.dump(state, state_file, ensure_ascii=False, indent=2)
            state_file.write('\n')
        os.replace(temp_path, state_path)
        return jsonify({'success': True})
    except Exception as error:
        _logger.warning('保存好友聊天状态失败: %s', error)
        return jsonify({'success': False, 'message': f'保存好友聊天状态失败: {str(error)}'}), 500


@config_bp.route('/api/config', methods=['POST'])
def set_config():
    """设置配置"""
    try:
        data = _request_json()
        previous_download_dir = str(_get_download_root())
        previous_all_roots = [str(root) for root in _get_all_download_roots()]

        if 'cookie' in data:
            _Config.COOKIE = data['cookie'].replace('\n', '').replace('\r', '').strip()
        if 'download_dir' in data:
            _Config.BASE_DIR = data['download_dir']
            _Config.DOWNLOAD_DIR = _Config.BASE_DIR
        if 'download_quality' in data:
            _Config.DOWNLOAD_QUALITY = _Config.normalize_download_quality(data.get('download_quality'))
        if 'download_live_photo_video' in data:
            _Config.DOWNLOAD_LIVE_PHOTO_VIDEO = bool(data.get('download_live_photo_video'))
        if 'download_live_photo_image' in data:
            _Config.DOWNLOAD_LIVE_PHOTO_IMAGE = bool(data.get('download_live_photo_image'))
        if not _Config.DOWNLOAD_LIVE_PHOTO_VIDEO and not _Config.DOWNLOAD_LIVE_PHOTO_IMAGE:
            _Config.DOWNLOAD_LIVE_PHOTO_VIDEO = True
        if 'max_concurrent' in data:
            _Config.MAX_CONCURRENT = _coerce_int(data.get('max_concurrent'), 3, 1, 10)
        if 'proxy' in data:
            _Config.PROXY = _Config.normalize_proxy(data.get('proxy'))
        if 'ssl_verify' in data:
            from src.utils.ssl_utils import parse_ssl_verify

            _Config.SSL_VERIFY = parse_ssl_verify(data.get('ssl_verify'), True)
        if 'filename_template' in data:
            _Config.FILENAME_TEMPLATE = _Config.normalize_filename_template(
                data.get('filename_template'),
                '{title}',
            )
        if 'folder_name_template' in data:
            _Config.FOLDER_NAME_TEMPLATE = _Config.normalize_filename_template(
                data.get('folder_name_template'),
                '{author}',
            )
        if 'auto_create_folder' in data:
            _Config.AUTO_CREATE_FOLDER = bool(data.get('auto_create_folder'))
        if 'im_friend_sec_user_ids' in data:
            _Config.IM_FRIEND_SEC_USER_IDS = _Config.normalize_sec_user_ids(data.get('im_friend_sec_user_ids'))
        if 'im_friend_include_all_users' in data:
            _Config.IM_FRIEND_INCLUDE_ALL_USERS = bool(data.get('im_friend_include_all_users'))
        if 'im_friend_refresh_interval_seconds' in data:
            _Config.IM_FRIEND_REFRESH_INTERVAL_SECONDS = _coerce_int(
                data.get('im_friend_refresh_interval_seconds'),
                30,
                1,
                3600,
            )

        move_existing_files = bool(data.get('move_existing_files'))
        history_dirs = list(getattr(_Config, 'HISTORY_DIRS', []))
        new_download_dir = str(_get_download_root())

        if previous_download_dir.lower() != new_download_dir.lower():
            if move_existing_files:
                moved_count = 0
                for old_root in previous_all_roots:
                    if os.path.abspath(old_root).lower() == os.path.abspath(new_download_dir).lower():
                        continue
                    moved_count += _move_directory_contents(Path(old_root), Path(new_download_dir))

                history_dirs = [
                    path for path in history_dirs
                    if os.path.abspath(path).lower() not in {
                        os.path.abspath(root).lower() for root in previous_all_roots
                    }
                ]
            else:
                moved_count = 0
                history_dirs.extend(previous_all_roots)
        else:
            moved_count = 0

        _Config.HISTORY_DIRS = _Config.normalize_history_dirs(history_dirs)
        _Config.save_config(
            _Config.COOKIE,
            _Config.BASE_DIR,
            _Config.HISTORY_DIRS,
            download_quality=_Config.DOWNLOAD_QUALITY,
            download_live_photo_video=_Config.DOWNLOAD_LIVE_PHOTO_VIDEO,
            download_live_photo_image=_Config.DOWNLOAD_LIVE_PHOTO_IMAGE,
            max_concurrent=_Config.MAX_CONCURRENT,
            proxy=_Config.PROXY,
            ssl_verify=_Config.SSL_VERIFY,
            filename_template=_Config.FILENAME_TEMPLATE,
            folder_name_template=_Config.FOLDER_NAME_TEMPLATE,
            auto_create_folder=_Config.AUTO_CREATE_FOLDER,
            accounts=_Config.ACCOUNTS,
            current_sec_uid=_Config.CURRENT_SEC_UID,
            im_friend_sec_user_ids=_Config.IM_FRIEND_SEC_USER_IDS,
            im_friend_include_all_users=_Config.IM_FRIEND_INCLUDE_ALL_USERS,
            im_friend_refresh_interval_seconds=_Config.IM_FRIEND_REFRESH_INTERVAL_SECONDS,
        )

        if previous_download_dir.lower() != new_download_dir.lower():
            rebuild_download_history_index()
        else:
            invalidate_download_history_cache(drop_disk=False)

        # 重新初始化API和下载器
        _init_app()

        return jsonify({
            'success': True,
            'message': '配置保存成功',
            'moved_count': moved_count,
            'download_root': str(_get_download_root()),
            'download_roots': [str(root) for root in _get_all_download_roots()],
            'download_quality': _Config.DOWNLOAD_QUALITY,
            'download_live_photo_video': _Config.DOWNLOAD_LIVE_PHOTO_VIDEO,
            'download_live_photo_image': _Config.DOWNLOAD_LIVE_PHOTO_IMAGE,
            'max_concurrent': _Config.MAX_CONCURRENT,
            'proxy': _Config.PROXY or None,
            'ssl_verify': _Config.SSL_VERIFY,
            'filename_template': _Config.FILENAME_TEMPLATE,
            'folder_name_template': _Config.FOLDER_NAME_TEMPLATE,
            'auto_create_folder': _Config.AUTO_CREATE_FOLDER,
            'im_friend_sec_user_ids': _Config.IM_FRIEND_SEC_USER_IDS,
            'im_friend_include_all_users': _Config.IM_FRIEND_INCLUDE_ALL_USERS,
            'im_friend_refresh_interval_seconds': _Config.IM_FRIEND_REFRESH_INTERVAL_SECONDS,
        })
    except Exception as e:
        return jsonify({'success': False, 'message': f'配置保存失败: {str(e)}'}), 500
