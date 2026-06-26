"""账号管理路由（/api/accounts 及子路由）。

从 web_app.py 抽离。模块内部依赖通过 setup 注入，
外部调用方（web_app.py）需要在导入本模块后调用 setup_accounts(...)。
"""
from __future__ import annotations

from typing import Callable

from flask import Blueprint, jsonify

from src.web.cookie_login import _cookie_verify_cache, _verify_native_cookie_login

accounts_bp = Blueprint("accounts", __name__)

# 注入的依赖
_Config = None
_request_json: Callable[[], dict] | None = None
_init_app: Callable[[], None] | None = None


def setup_accounts(
    *,
    Config,
    request_json: Callable[[], dict],
    init_app: Callable[[], None],
) -> None:
    """注入 web_app 模块的全局对象，避免循环导入。"""
    global _Config, _request_json, _init_app
    _Config = Config
    _request_json = request_json
    _init_app = init_app


def _save_accounts_config() -> None:
    _Config.save_config(
        _Config.COOKIE,
        _Config.BASE_DIR,
        _Config.HISTORY_DIRS,
        download_quality=_Config.DOWNLOAD_QUALITY,
        max_concurrent=_Config.MAX_CONCURRENT,
        filename_template=_Config.FILENAME_TEMPLATE,
        folder_name_template=_Config.FOLDER_NAME_TEMPLATE,
        auto_create_folder=_Config.AUTO_CREATE_FOLDER,
        relation_signer=_Config.RELATION_SIGNER,
        current_user_profile=_Config.CURRENT_USER_PROFILE,
        accounts=_Config.ACCOUNTS,
        current_sec_uid=_Config.CURRENT_SEC_UID,
        im_friend_sec_user_ids=_Config.IM_FRIEND_SEC_USER_IDS,
        im_friend_include_all_users=_Config.IM_FRIEND_INCLUDE_ALL_USERS,
        im_friend_refresh_interval_seconds=_Config.IM_FRIEND_REFRESH_INTERVAL_SECONDS,
    )


def _public_account_payload(account: dict) -> dict:
    """Return non-sensitive account fields safe for API responses."""
    return {
        'sec_uid': account.get('sec_uid', ''),
        'nickname': account.get('nickname', ''),
        'avatar_thumb': account.get('avatar_thumb', ''),
    }


@accounts_bp.route('/api/accounts', methods=['GET'])
def get_accounts():
    """获取所有账号信息"""
    accounts = getattr(_Config, 'ACCOUNTS', [])
    current_sec_uid = getattr(_Config, 'CURRENT_SEC_UID', '')

    public_accounts = [_public_account_payload(acc) for acc in accounts]

    return jsonify({
        'success': True,
        'accounts': public_accounts,
        'current_sec_uid': current_sec_uid,
    })


@accounts_bp.route('/api/accounts/switch', methods=['POST'])
def switch_account():
    """切换当前账号"""
    _cookie_verify_cache.clear()
    try:
        data = _request_json()
        sec_uid = data.get('sec_uid')
        if not sec_uid:
            return jsonify({'success': False, 'message': '缺少必要参数 sec_uid'}), 400

        accounts = getattr(_Config, 'ACCOUNTS', [])
        target_account = next((acc for acc in accounts if acc.get('sec_uid') == sec_uid), None)
        if not target_account:
            return jsonify({'success': False, 'message': '账号不存在'}), 404

        _Config.COOKIE = target_account.get('cookie', '')
        _Config.CURRENT_SEC_UID = sec_uid
        _save_accounts_config()
        _init_app()
        return jsonify({
            'success': True,
            'message': f"已切换为 {target_account.get('nickname')}",
            'nickname': target_account.get('nickname'),
        })
    except Exception as e:
        return jsonify({'success': False, 'message': f'切换账号失败: {str(e)}'}), 500


@accounts_bp.route('/api/accounts', methods=['DELETE'])
def delete_account():
    """删除账号"""
    _cookie_verify_cache.clear()
    try:
        data = _request_json()
        sec_uid = data.get('sec_uid')
        if not sec_uid:
            return jsonify({'success': False, 'message': '缺少必要参数 sec_uid'}), 400

        accounts = list(getattr(_Config, 'ACCOUNTS', []))
        new_accounts = [acc for acc in accounts if acc.get('sec_uid') != sec_uid]
        if len(new_accounts) == len(accounts):
            return jsonify({'success': False, 'message': '账号不存在'}), 404

        _Config.ACCOUNTS = new_accounts
        if getattr(_Config, 'CURRENT_SEC_UID', '') == sec_uid:
            if new_accounts:
                next_acc = new_accounts[0]
                _Config.COOKIE = next_acc.get('cookie', '')
                _Config.CURRENT_SEC_UID = next_acc.get('sec_uid', '')
            else:
                _Config.COOKIE = ''
                _Config.CURRENT_SEC_UID = ''

        _save_accounts_config()
        _init_app()
        return jsonify({'success': True, 'message': '账号已删除'})
    except Exception as e:
        return jsonify({'success': False, 'message': f'删除账号失败: {str(e)}'}), 500


@accounts_bp.route('/api/accounts/add', methods=['POST'])
def add_account():
    """手动添加账号"""
    _cookie_verify_cache.clear()
    try:
        data = _request_json()
        cookie = data.get('cookie')
        if not cookie:
            return jsonify({'success': False, 'message': '缺少必要参数 cookie'}), 400

        cookie = cookie.replace('\n', '').replace('\r', '').strip()
        verify_result = _verify_native_cookie_login(cookie)
        if not verify_result.get('success'):
            return jsonify({
                'success': False,
                'message': verify_result.get('message') or 'Cookie 验证失败',
                'need_login': verify_result.get('need_login', False),
                'need_verify': verify_result.get('need_verify', False),
            })

        nickname = verify_result.get('nickname', '')
        sec_uid = verify_result.get('sec_uid', '')
        avatar_thumb = verify_result.get('avatar_thumb', '')

        _Config.COOKIE = cookie
        _Config.CURRENT_SEC_UID = sec_uid
        accounts = list(getattr(_Config, 'ACCOUNTS', []))
        accounts = [account for account in accounts if account.get('sec_uid') != sec_uid]
        accounts.append({
            'sec_uid': sec_uid,
            'nickname': nickname,
            'avatar_thumb': avatar_thumb,
            'cookie': cookie,
        })
        _Config.ACCOUNTS = accounts

        _save_accounts_config()
        _init_app()
        return jsonify({
            'success': True,
            'message': f'成功添加并切换账号: {nickname}',
            'nickname': nickname,
            'sec_uid': sec_uid,
            'avatar_thumb': avatar_thumb,
        })
    except Exception as e:
        return jsonify({'success': False, 'message': f'添加账号失败: {str(e)}'}), 500
