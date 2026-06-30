"""应用更新与目录选择路由。

从 web_app.py 抽离。更新相关的辅助函数位于 src/web/updater.py，
目录选择对话框辅助函数内联在本模块中。
"""
from __future__ import annotations

import base64
import json
import os
import shutil
import subprocess
import sys
import threading
from pathlib import Path
from typing import Callable

from flask import Blueprint, jsonify

from src.web import updater

update_routes_bp = Blueprint("update_routes", __name__)

# 注入的依赖
_logger = None
_Config = None
_IS_WINDOWS: bool = False
_IS_MACOS: bool = False
_LATEST_RELEASE_PAGE_URL: str = ''
_get_current_app_version: Callable[[], str] | None = None


def setup_update_routes(
    *,
    logger,
    Config,
    is_windows: bool,
    is_macos: bool,
    latest_release_page_url: str,
    get_current_app_version: Callable[[], str],
) -> None:
    """注入 web_app 模块的全局对象，避免循环导入。"""
    global _logger, _Config, _IS_WINDOWS, _IS_MACOS
    global _LATEST_RELEASE_PAGE_URL, _get_current_app_version
    _logger = logger
    _Config = Config
    _IS_WINDOWS = is_windows
    _IS_MACOS = is_macos
    _LATEST_RELEASE_PAGE_URL = latest_release_page_url
    _get_current_app_version = get_current_app_version


def _dialog_cancelled(result: subprocess.CompletedProcess[str]) -> bool:
    stdout = (result.stdout or "").strip()
    stderr = (result.stderr or "").strip().lower()
    if stdout:
        return False
    if not stderr and result.returncode in (0, 1):
        return True
    return any(token in stderr for token in ("cancel", "canceled", "cancelled", "user canceled", "user cancelled"))


def _dialog_error_message(result: subprocess.CompletedProcess[str], fallback: str) -> str:
    stderr = (result.stderr or "").strip()
    return stderr or fallback


def _decode_utf8_base64_path(value: str) -> str:
    value = (value or "").strip()
    if not value:
        return ""
    try:
        return base64.b64decode(value, validate=True).decode("utf-8").strip()
    except Exception:
        return value


def _select_directory_with_tkinter(initial_dir: str) -> str:
    import tkinter as tk
    from tkinter import filedialog

    root = tk.Tk()
    root.withdraw()
    root.attributes('-topmost', True)
    try:
        directory = filedialog.askdirectory(
            parent=root,
            title='选择下载目录',
            initialdir=initial_dir or os.path.expanduser('~'),
            mustexist=False,
        )
        return str(directory or '').strip()
    finally:
        try:
            root.destroy()
        except Exception:
            pass


@update_routes_bp.route('/api/get_app_version', methods=['GET'])
def get_app_version():
    """返回当前应用版本。"""
    return jsonify(_get_current_app_version())


@update_routes_bp.route('/api/check_update', methods=['GET'])
def check_update():
    """检查 GitHub Releases 上是否有新版本。"""
    current_version = _get_current_app_version()

    try:
        metadata = updater.fetch_updater_metadata()

        release = None
        if not metadata:
            try:
                release = updater.fetch_latest_release()
            except Exception as exc:
                _logger.debug(f"Fetch latest release failed: {exc}")

        latest_version = updater.normalize_version_text(
            (metadata or {}).get('version') or
            (release or {}).get('tag_name') or
            (release or {}).get('name') or
            ''
        )
        has_update = bool(latest_version) and updater.is_newer_version(latest_version, current_version)
        asset = updater.select_update_asset(release or {}, metadata)

        return jsonify({
            'success': True,
            'has_update': has_update,
            'current_version': current_version,
            'version': latest_version or current_version,
            'notes': updater.normalize_update_notes((metadata or {}).get('notes') or (release or {}).get('body')) or '暂无更新说明',
            'html_url': (release or {}).get('html_url') or _LATEST_RELEASE_PAGE_URL,
            'download_url': asset.get('url'),
            'asset_name': asset.get('name'),
            'asset_size': asset.get('size'),
            'portable': asset.get('portable'),
            'install_mode': asset.get('install_mode'),
            'signed': bool(asset.get('signature')),
        })
    except Exception as e:
        _logger.error(f"检查更新失败: {e}")
        return jsonify({
            'success': False,
            'has_update': False,
            'current_version': current_version,
            'message': f'检查更新失败: {str(e)}'
        })


@update_routes_bp.route('/api/download_update', methods=['GET'])
def download_update():
    """在应用内下载对应平台的发布资源，并打开安装包或所在目录。"""
    try:
        metadata = updater.fetch_updater_metadata()

        release = None
        if not metadata:
            try:
                release = updater.fetch_latest_release()
            except Exception as exc:
                _logger.debug(f"Fetch latest release failed: {exc}")

        current_version = _get_current_app_version()
        latest_version = updater.normalize_version_text(
            (metadata or {}).get('version') or
            (release or {}).get('tag_name') or
            (release or {}).get('name') or
            _get_current_app_version()
        )
        if latest_version and not updater.is_newer_version(latest_version, current_version):
            return jsonify({
                'success': False,
                'message': '当前已是最新版本'
            }), 409

        asset = updater.select_update_asset(release or {}, metadata)
        download_url = str(asset.get('url') or '')

        if not download_url or asset.get('install_mode') == 'browser':
            target_url = download_url or str((release or {}).get('html_url') or _LATEST_RELEASE_PAGE_URL)
            if not updater.open_external_target(target_url):
                return jsonify({
                    'success': False,
                    'message': '无法打开下载页面，请手动前往 Releases 页面'
                }), 500
            return jsonify({
                'success': True,
                'mode': 'browser',
                'restart_required': False,
                'download_url': target_url,
                'message': '未找到匹配安装包，已打开 Releases 页面'
            })

        file_path = updater.download_update_asset(
            download_url,
            str(asset.get('name') or ''),
            latest_version,
            str(asset.get('digest') or ''),
            str(asset.get('signature') or ''),
        )
        install_mode = str(asset.get('install_mode') or 'download')

        try:
            staged = updater.stage_self_update(file_path, install_mode)
            updater.schedule_app_exit_for_update()
            return jsonify({
                'success': True,
                'mode': 'auto_install',
                'portable': bool(asset.get('portable')),
                'install_mode': install_mode,
                'restart_required': staged.get('restart_required', False),
                'auto_relaunch': True,
                'download_url': download_url,
                'file_path': str(file_path),
                'message': staged.get('message') or '更新已下载，应用即将关闭并自动安装重启',
            })
        except Exception as install_error:
            _logger.warning(f"自动安装更新不可用，回退为打开更新包: {install_error}")

        opened = updater.open_update_file(file_path, install_mode)

        updater.emit_update_event('update_download_finished', {
            'file_path': str(file_path),
            'install_mode': install_mode,
            'opened': opened,
            'restart_required': False,
            'message': updater.update_download_message(file_path, install_mode, opened),
        })

        return jsonify({
            'success': True,
            'mode': 'download',
            'portable': bool(asset.get('portable')),
            'install_mode': install_mode,
            'restart_required': False,
            'download_url': download_url,
            'file_path': str(file_path),
            'message': updater.update_download_message(file_path, install_mode, opened),
        })
    except Exception as e:
        updater.emit_update_event('update_download_error', {'message': str(e)})
        _logger.error(f"打开更新下载失败: {e}")
        return jsonify({'success': False, 'message': f'更新下载失败: {str(e)}'}), 500


@update_routes_bp.route('/api/restart_app', methods=['GET'])
def restart_app():
    """重启当前打包应用。源码模式下保留兼容返回。"""
    if getattr(sys, 'frozen', False):
        executable = Path(sys.executable)

        def relaunch() -> None:
            try:
                if _IS_MACOS:
                    app_bundle = next((parent for parent in executable.parents if parent.suffix == '.app'), None)
                    if app_bundle:
                        subprocess.Popen(['open', '-n', str(app_bundle)])
                    else:
                        subprocess.Popen([str(executable)], cwd=str(executable.parent))
                else:
                    subprocess.Popen([str(executable)], cwd=str(executable.parent), close_fds=True)
            finally:
                os._exit(0)

        threading.Timer(0.5, relaunch).start()
        return jsonify({
            'success': True,
            'message': '应用正在重启'
        })

    return jsonify({
        'success': False,
        'message': '源码运行模式不支持自动重启'
    }), 501


@update_routes_bp.route('/api/select_directory', methods=['POST'])
def select_directory():
    """打开系统文件夹选择器，返回用户选择的路径"""
    try:
        initial_dir = _Config.BASE_DIR or os.path.expanduser('~')

        if _IS_WINDOWS:
            try:
                directory = _select_directory_with_tkinter(str(initial_dir))
                if directory:
                    return jsonify({'success': True, 'path': directory})
                return jsonify({'success': False, 'message': '用户取消选择'})
            except Exception as error:
                _logger.warning("tkinter 选择目录失败，回退 PowerShell: %s", error)

            initial_dir_ps = str(initial_dir).replace("'", "''")
            script = f'''
            Add-Type -AssemblyName System.Windows.Forms
            [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
            $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
            $dialog.Description = "选择下载目录"
            $dialog.SelectedPath = '{initial_dir_ps}'
            $dialog.ShowNewFolderButton = $true
            if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {{
                [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($dialog.SelectedPath))
            }}
            '''
            result = subprocess.run(
                ['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
                capture_output=True,
                text=True,
                encoding='utf-8',
                errors='replace',
                timeout=120,
                creationflags=0x08000000,
            )
            directory = _decode_utf8_base64_path(result.stdout)

            if directory:
                return jsonify({'success': True, 'path': directory})
            if _dialog_cancelled(result):
                return jsonify({'success': False, 'message': '用户取消选择'})
            raise RuntimeError(_dialog_error_message(result, '选择目录失败'))

        if not _IS_MACOS:
            if shutil.which('zenity'):
                result = subprocess.run(
                    ['zenity', '--file-selection', '--directory', '--filename', str(initial_dir)],
                    capture_output=True,
                    text=True,
                    encoding='utf-8',
                    errors='replace',
                    timeout=120,
                )
                if result.returncode == 0 and result.stdout.strip():
                    return jsonify({'success': True, 'path': result.stdout.strip()})
                if _dialog_cancelled(result):
                    return jsonify({'success': False, 'message': '用户取消选择'})
                raise RuntimeError(_dialog_error_message(result, '选择目录失败'))

            if shutil.which('kdialog'):
                result = subprocess.run(
                    ['kdialog', '--getexistingdirectory', str(initial_dir)],
                    capture_output=True,
                    text=True,
                    encoding='utf-8',
                    errors='replace',
                    timeout=120,
                )
                if result.returncode == 0 and result.stdout.strip():
                    return jsonify({'success': True, 'path': result.stdout.strip()})
                if _dialog_cancelled(result):
                    return jsonify({'success': False, 'message': '用户取消选择'})
                raise RuntimeError(_dialog_error_message(result, '选择目录失败'))

            return jsonify({'success': False, 'message': '当前系统缺少目录选择器，请安装 zenity 或 kdialog'})

        initial_dir_json = json.dumps(str(initial_dir))
        script = f'''
        tell application "System Events"
            activate
            set selected_folder to choose folder with prompt "选择下载目录:" default location POSIX file {initial_dir_json}
            return POSIX path of selected_folder
        end tell
        '''

        result = subprocess.run(
            ['osascript', '-e', script],
            capture_output=True,
            text=True,
            encoding='utf-8',
            errors='replace',
            timeout=60
        )

        if result.returncode == 0 and result.stdout.strip():
            directory = result.stdout.strip()
            return jsonify({'success': True, 'path': directory})
        if _dialog_cancelled(result):
            return jsonify({'success': False, 'message': '用户取消选择'})
        raise RuntimeError(_dialog_error_message(result, '选择目录失败'))
    except subprocess.TimeoutExpired:
        _logger.warning("选择目录超时")
        return jsonify({'success': False, 'message': '选择目录超时，请重试'}), 504
    except Exception as e:
        _logger.exception("选择目录失败")
        return jsonify({'success': False, 'message': f'选择失败：{str(e)}'}), 500
