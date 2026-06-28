"""应用更新辅助函数：版本检查、资源下载、签名校验、跨平台自更新脚本。

从 web_app.py 抽离。模块内部依赖通过 setup_updater 注入。
"""
from __future__ import annotations

import base64
import hashlib
import os
import platform
import re
import shlex
import subprocess
import sys
import tempfile
import threading
import time
import uuid
import webbrowser
from pathlib import Path
from urllib.parse import urlparse

from src.web import update_checker

# 注入的依赖
_logger = None
_Config = None
_http_requests = None
_socketio = None
_IS_WINDOWS: bool = False
_IS_MACOS: bool = False
_LATEST_RELEASE_API_URL: str = ''
_UPDATER_METADATA_URL: str = ''
_UPDATER_PUBLIC_KEY: str = ''
_LATEST_RELEASE_PAGE_URL: str = ''
_main_process_exit_event = None


def setup_updater(
    *,
    logger,
    Config,
    http_requests,
    socketio,
    is_windows: bool,
    is_macos: bool,
    latest_release_api_url: str,
    updater_metadata_url: str,
    updater_public_key: str,
    latest_release_page_url: str,
    main_process_exit_event,
) -> None:
    """注入 web_app 模块的全局对象，避免循环导入。"""
    global _logger, _Config, _http_requests, _socketio
    global _IS_WINDOWS, _IS_MACOS
    global _LATEST_RELEASE_API_URL, _UPDATER_METADATA_URL, _UPDATER_PUBLIC_KEY
    global _LATEST_RELEASE_PAGE_URL, _main_process_exit_event
    _logger = logger
    _Config = Config
    _http_requests = http_requests
    _socketio = socketio
    _IS_WINDOWS = is_windows
    _IS_MACOS = is_macos
    _LATEST_RELEASE_API_URL = latest_release_api_url
    _UPDATER_METADATA_URL = updater_metadata_url
    _UPDATER_PUBLIC_KEY = updater_public_key
    _LATEST_RELEASE_PAGE_URL = latest_release_page_url
    _main_process_exit_event = main_process_exit_event


def set_main_process_exit_event(event) -> None:
    global _main_process_exit_event
    _main_process_exit_event = event


def normalize_version_text(version: str) -> str:
    return update_checker.normalize_version_text(version)


def _parse_version_parts(version: str) -> tuple[int, ...]:
    return update_checker._parse_version_parts(version)


def is_newer_version(latest_version: str, current_version: str) -> bool:
    return update_checker.is_newer_version(latest_version, current_version)


def get_current_app_version() -> str:
    return update_checker.get_current_app_version(_Config)


def fetch_latest_release() -> dict:
    return update_checker.fetch_latest_release(_http_requests, _LATEST_RELEASE_API_URL, _Config)


def fetch_updater_metadata() -> dict | None:
    return update_checker.fetch_updater_metadata(_http_requests, _UPDATER_METADATA_URL, _logger, _Config)


def normalize_update_notes(notes: str) -> str:
    return update_checker.normalize_update_notes(notes)


def _linux_package_family() -> str:
    """Best-effort Linux package family detection for release asset selection."""
    os_release = Path('/etc/os-release')
    if not os_release.exists():
        return 'generic'

    try:
        text = os_release.read_text(encoding='utf-8', errors='ignore').lower()
    except Exception:
        return 'generic'

    if any(token in text for token in ('id_like=debian', 'id=debian', 'id=ubuntu', 'id=linuxmint')):
        return 'deb'
    if any(token in text for token in ('id_like="rhel fedora"', 'id_like=fedora', 'id=fedora', 'id=rhel', 'id=centos', 'id=opensuse', 'id=sles')):
        return 'rpm'
    return 'generic'


def _platform_update_targets() -> list[tuple[str, bool]]:
    machine = platform.machine().lower()
    if _IS_WINDOWS:
        return [
            ('windows-x86_64', False),
            ('windows-x86_64-nsis', False),
            ('windows-x86_64-portable', True),
        ]
    if _IS_MACOS:
        if 'arm' in machine or 'aarch64' in machine:
            return [
                ('darwin-aarch64', False),
                ('darwin-aarch64-portable', True),
            ]
        return [
            ('darwin-x86_64', False),
            ('darwin-x86_64-portable', True),
        ]

    package_family = _linux_package_family()
    if package_family == 'deb':
        return [
            ('linux-x86_64-deb', False),
            ('linux-x86_64', True),
            ('linux-x86_64-tar', True),
            ('linux-x86_64-rpm', False),
        ]
    if package_family == 'rpm':
        return [
            ('linux-x86_64-rpm', False),
            ('linux-x86_64', True),
            ('linux-x86_64-tar', True),
            ('linux-x86_64-deb', False),
        ]
    return [
        ('linux-x86_64', True),
        ('linux-x86_64-tar', True),
        ('linux-x86_64-deb', False),
        ('linux-x86_64-rpm', False),
    ]


def _infer_update_install_mode(asset_name: str, portable: bool) -> str:
    name = asset_name.lower()
    if portable:
        return 'portable'
    if name.endswith('.dmg'):
        return 'dmg'
    if name.endswith('.exe'):
        return 'installer'
    if name.endswith('.deb'):
        return 'deb'
    if name.endswith('.rpm'):
        return 'rpm'
    if name.endswith('.appimage'):
        return 'appimage'
    return 'download'


def _metadata_asset_payload(metadata: dict | None) -> dict | None:
    if not metadata:
        return None
    platforms = metadata.get('platforms') if isinstance(metadata.get('platforms'), dict) else {}
    for target, portable in _platform_update_targets():
        item = platforms.get(target)
        if not isinstance(item, dict) or not item.get('url'):
            continue
        url = str(item.get('url') or '')
        name = Path(urlparse(url).path).name
        if not name:
            continue
        return {
            'name': name,
            'url': url,
            'size': int(item.get('size') or 0),
            'digest': str(item.get('digest') or ''),
            'signature': str(item.get('signature') or ''),
            'portable': portable,
            'install_mode': _infer_update_install_mode(name, portable),
            'source': 'metadata',
        }
    return None


def _release_asset_payload(asset: dict | None, portable: bool = False, fallback_url: str = '') -> dict:
    if not asset:
        return {
            'name': '',
            'url': fallback_url,
            'size': 0,
            'portable': portable,
            'install_mode': 'browser',
        }

    name = str(asset.get('name') or '')
    return {
        'name': name,
        'url': str(asset.get('browser_download_url') or fallback_url),
        'size': int(asset.get('size') or 0),
        'digest': str(asset.get('digest') or ''),
        'signature': str(asset.get('signature') or ''),
        'portable': portable,
        'install_mode': _infer_update_install_mode(name, portable),
        'source': 'release',
    }


def _select_release_asset_info(release: dict) -> dict:
    assets = release.get('assets') or []
    machine = platform.machine().lower()
    current_is_portable = _Config.is_portable()

    preferred_suffixes: list[tuple[str, bool]] = []
    if _IS_WINDOWS:
        if current_is_portable:
            preferred_suffixes = [
                ('windows-x64-portable.zip', True),
                ('windows-x64-onefile.exe', True),
                ('windows-x64-installer.exe', False),
            ]
        else:
            preferred_suffixes = [
                ('windows-x64-installer.exe', False),
                ('windows-x64-portable.zip', True),
                ('windows-x64-onefile.exe', True),
            ]
    elif _IS_MACOS:
        if 'arm' in machine or 'aarch64' in machine:
            if current_is_portable:
                preferred_suffixes = [
                    ('macos-arm64-portable.zip', True),
                    ('macos-arm64.dmg', False),
                ]
            else:
                preferred_suffixes = [
                    ('macos-arm64.dmg', False),
                    ('macos-arm64-portable.zip', True),
                ]
        else:
            if current_is_portable:
                preferred_suffixes = [
                    ('macos-x64-portable.zip', True),
                    ('macos-intel-portable.zip', True),
                    ('macos-x64.dmg', False),
                    ('macos-intel.dmg', False),
                ]
            else:
                preferred_suffixes = [
                    ('macos-x64.dmg', False),
                    ('macos-intel.dmg', False),
                    ('macos-x64-portable.zip', True),
                    ('macos-intel-portable.zip', True),
                ]
    else:
        package_family = _linux_package_family()
        if package_family == 'deb':
            if current_is_portable:
                preferred_suffixes = [
                    ('linux-x64.appimage', True),
                    ('linux-x64.tar.gz', True),
                    ('linux-x64.deb', False),
                    ('linux-x64.rpm', False),
                ]
            else:
                preferred_suffixes = [
                    ('linux-x64.deb', False),
                    ('linux-x64.appimage', True),
                    ('linux-x64.tar.gz', True),
                    ('linux-x64.rpm', False),
                ]
        elif package_family == 'rpm':
            if current_is_portable:
                preferred_suffixes = [
                    ('linux-x64.appimage', True),
                    ('linux-x64.tar.gz', True),
                    ('linux-x64.rpm', False),
                    ('linux-x64.deb', False),
                ]
            else:
                preferred_suffixes = [
                    ('linux-x64.rpm', False),
                    ('linux-x64.appimage', True),
                    ('linux-x64.tar.gz', True),
                    ('linux-x64.deb', False),
                ]
        else:
            preferred_suffixes = [
                ('linux-x64.appimage', True),
                ('linux-x64.tar.gz', True),
                ('linux-x64.deb', False),
                ('linux-x64.rpm', False),
            ]

    normalized_assets = [
        {
            'name': str(asset.get('name') or ''),
            'name_lower': str(asset.get('name') or '').lower(),
            'url': str(asset.get('browser_download_url') or ''),
            'raw': asset,
        }
        for asset in assets
        if asset.get('browser_download_url')
    ]

    for suffix, portable in preferred_suffixes:
        for asset in normalized_assets:
            if asset['name_lower'].endswith(suffix):
                return _release_asset_payload(asset['raw'], portable)

    for asset in normalized_assets:
        name = asset['name_lower']
        if _IS_WINDOWS and name.endswith('.exe'):
            return _release_asset_payload(asset['raw'], 'portable' in name or 'onefile' in name)
        if _IS_MACOS and (name.endswith('.dmg') or name.endswith('.zip')):
            return _release_asset_payload(asset['raw'], 'portable' in name)
        if not _IS_WINDOWS and not _IS_MACOS and (name.endswith('.tar.gz') or name.endswith('.appimage') or name.endswith('.deb') or name.endswith('.rpm')):
            return _release_asset_payload(asset['raw'], name.endswith('.tar.gz') or name.endswith('.appimage'))

    return _release_asset_payload(None, False, str(release.get('html_url') or _LATEST_RELEASE_PAGE_URL))


def _select_release_asset(release: dict) -> tuple[str, bool]:
    asset = _select_release_asset_info(release)
    return str(asset.get('url') or ''), bool(asset.get('portable'))


def select_update_asset(release: dict | None = None, metadata: dict | None = None) -> dict:
    signed_asset = _metadata_asset_payload(metadata)
    if signed_asset:
        return signed_asset
    if release is None:
        release = fetch_latest_release()
    return _select_release_asset_info(release)


def _safe_update_filename(asset_name: str, release_version: str, download_url: str) -> str:
    filename = asset_name.strip()
    if not filename:
        filename = Path(urlparse(download_url).path).name
    if not filename:
        filename = f'better-douyin-v{release_version}'

    filename = re.sub(r'[^A-Za-z0-9._() -]+', '_', filename).strip(' ._')
    return filename or f'better-douyin-v{release_version}'


def _get_update_download_dir() -> Path:
    candidates = [
        Path.home() / 'Downloads' / 'better-douyin Updates',
        Path(tempfile.gettempdir()) / 'better-douyin-updates',
    ]

    for candidate in candidates:
        try:
            candidate.mkdir(parents=True, exist_ok=True)
            probe = candidate / '.write-test'
            probe.write_text('', encoding='utf-8')
            probe.unlink(missing_ok=True)
            return candidate
        except Exception:
            continue

    fallback = Path(tempfile.gettempdir())
    fallback.mkdir(parents=True, exist_ok=True)
    return fallback


def emit_update_event(event: str, payload: dict) -> None:
    try:
        _socketio.emit(event, payload)
    except Exception as exc:
        _logger.debug(f"发送更新事件失败 {event}: {exc}")


def _decode_tauri_public_key() -> tuple[bytes, bytes]:
    decoded = base64.b64decode(_UPDATER_PUBLIC_KEY).decode('utf-8')
    lines = [line.strip() for line in decoded.splitlines() if line.strip()]
    if len(lines) < 2:
        raise ValueError('更新公钥格式无效')
    raw = base64.b64decode(lines[1])
    if len(raw) != 42 or raw[:2] != b'Ed':
        raise ValueError('更新公钥不是受支持的 Ed25519 minisign 公钥')
    return raw[2:10], raw[10:]


def _decode_tauri_signature(signature_text: str) -> tuple[bytes, bytes]:
    text = str(signature_text or '').strip()
    if not text:
        raise ValueError('更新包缺少签名信息')

    try:
        decoded_text = base64.b64decode(text, validate=True).decode('utf-8')
    except Exception:
        decoded_text = text

    lines = [line.strip() for line in decoded_text.splitlines() if line.strip()]
    if len(lines) < 2:
        raise ValueError('更新包签名格式无效')
    raw = base64.b64decode(lines[1])
    if len(raw) != 74 or raw[:2] != b'ED':
        raise ValueError('更新包签名不是受支持的 Ed25519 minisign 签名')
    return raw[2:10], raw[10:]


def _verify_update_signature(file_path: Path, signature_text: str) -> None:
    expected_key_id, public_key = _decode_tauri_public_key()
    signature_key_id, signature = _decode_tauri_signature(signature_text)
    if signature_key_id != expected_key_id:
        raise ValueError('更新包签名密钥不匹配')

    try:
        from nacl.signing import VerifyKey
        from nacl.exceptions import BadSignatureError
    except Exception as exc:
        raise RuntimeError('缺少 PyNaCl，无法验证更新包签名') from exc

    try:
        digest = hashlib.blake2b(file_path.read_bytes(), digest_size=64).digest()
        VerifyKey(public_key).verify(digest, signature)
    except BadSignatureError as exc:
        raise ValueError('更新包签名校验失败，请稍后重试') from exc


def download_update_asset(
    download_url: str,
    asset_name: str,
    release_version: str,
    expected_digest: str = '',
    expected_signature: str = '',
) -> Path:
    if not download_url:
        raise ValueError('没有可下载的更新资源')

    filename = _safe_update_filename(asset_name, release_version, download_url)
    destination = _get_update_download_dir() / filename
    partial = destination.with_suffix(destination.suffix + '.part')

    headers = {
        'Accept': 'application/octet-stream',
        'User-Agent': f'better-douyin/{get_current_app_version()}',
    }
    downloaded = 0
    last_emit = 0.0
    started_at = time.monotonic()
    sha256 = hashlib.sha256()

    emit_update_event('update_download_progress', {
        'progress': 0,
        'downloaded': 0,
        'total': 0,
        'speed_bps': 0,
        'asset_name': filename,
    })

    with _http_requests.get(download_url, headers=headers, stream=True, timeout=(10, 60)) as response:
        response.raise_for_status()
        total = int(response.headers.get('Content-Length') or 0)

        with partial.open('wb') as fh:
            for chunk in response.iter_content(chunk_size=1024 * 256):
                if not chunk:
                    continue
                fh.write(chunk)
                sha256.update(chunk)
                downloaded += len(chunk)

                now = time.monotonic()
                elapsed = max(now - started_at, 0.001)
                speed_bps = int(downloaded / elapsed)
                if total > 0:
                    progress = min(99.0, downloaded * 100 / total)
                else:
                    progress = 0

                if now - last_emit >= 0.25 or (total > 0 and progress >= 99):
                    emit_update_event('update_download_progress', {
                        'progress': progress,
                        'downloaded': downloaded,
                        'total': total,
                        'speed_bps': speed_bps,
                        'asset_name': filename,
                    })
                    last_emit = now

    os.replace(partial, destination)

    normalized_digest = expected_digest.strip().lower()
    if normalized_digest.startswith('sha256:'):
        expected_sha256 = normalized_digest.split(':', 1)[1]
        actual_sha256 = sha256.hexdigest()
        if actual_sha256.lower() != expected_sha256:
            try:
                destination.unlink(missing_ok=True)
            except Exception:
                pass
            raise ValueError('更新包校验失败，请稍后重试')

    if expected_signature:
        try:
            _verify_update_signature(destination, expected_signature)
        except Exception:
            try:
                destination.unlink(missing_ok=True)
            except Exception:
                pass
            raise

    if destination.suffix.lower() == '.appimage':
        try:
            destination.chmod(destination.stat().st_mode | 0o755)
        except Exception:
            pass

    emit_update_event('update_download_progress', {
        'progress': 100,
        'downloaded': downloaded,
        'total': downloaded,
        'speed_bps': 0,
        'asset_name': filename,
    })
    return destination


def _ps_quote(value: str | Path) -> str:
    return "'" + str(value).replace("'", "''") + "'"


def _current_app_paths() -> dict:
    executable = Path(sys.executable).resolve()
    target_root = executable.parent
    launch_target = executable
    app_bundle = None

    if _IS_MACOS:
        app_bundle = next((parent for parent in executable.parents if parent.suffix == '.app'), None)
        if app_bundle:
            target_root = app_bundle
            launch_target = app_bundle

    return {
        'executable': executable,
        'target_root': target_root,
        'launch_target': launch_target,
        'app_bundle': app_bundle,
    }


def _write_update_script(name: str, content: str, suffix: str) -> Path:
    update_dir = _get_update_download_dir()
    script_path = update_dir / f'{name}-{uuid.uuid4().hex}{suffix}'
    script_path.write_text(content, encoding='utf-8')
    if not _IS_WINDOWS:
        try:
            script_path.chmod(script_path.stat().st_mode | 0o755)
        except Exception:
            pass
    return script_path


def _stage_windows_update(file_path: Path, install_mode: str, paths: dict) -> None:
    log_path = _get_update_download_dir() / 'update-helper.log'
    stage_dir = Path(tempfile.gettempdir()) / f'better-douyin-update-{uuid.uuid4().hex}'
    current_pid = os.getpid()
    target_root = paths['target_root']
    target_exe = paths['executable']
    package = file_path

    script = f"""$ErrorActionPreference = 'Stop'
$pidToWait = {current_pid}
$package = {_ps_quote(package)}
$targetRoot = {_ps_quote(target_root)}
$targetExe = {_ps_quote(target_exe)}
$stage = {_ps_quote(stage_dir)}
$log = {_ps_quote(log_path)}
function Write-UpdateLog($message) {{
  try {{ Add-Content -LiteralPath $log -Value ("[{0}] {1}" -f (Get-Date -Format s), $message) }} catch {{}}
}}
try {{
  Write-UpdateLog "killing app process tree $pidToWait"
  taskkill /T /F /PID $pidToWait 2>$null
  Start-Sleep -Seconds 2

  if ($package.ToLower().EndsWith('.zip')) {{
    Write-UpdateLog "extracting portable update"
    if (Test-Path -LiteralPath $stage) {{
      Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
    }}
    New-Item -ItemType Directory -Path $stage -Force | Out-Null
    Expand-Archive -LiteralPath $package -DestinationPath $stage -Force
    $exeName = Split-Path -Leaf $targetExe
    $sourceExe = Get-ChildItem -LiteralPath $stage -Recurse -Filter $exeName -File | Select-Object -First 1
    if (-not $sourceExe) {{ throw "Cannot find updated executable: $exeName" }}
    $sourceRoot = Split-Path -Parent $sourceExe.FullName
    Write-UpdateLog "copying portable update from $sourceRoot to $targetRoot"
    robocopy $sourceRoot $targetRoot /E /R:3 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) {{ throw "robocopy failed with code $LASTEXITCODE" }}
  }} elseif ($package.ToLower().EndsWith('.exe')) {{
    Write-UpdateLog "running installer silently"
    $args = @('/S', "/D=$targetRoot")
    Start-Process -FilePath $package -ArgumentList $args -Verb RunAs -Wait
  }} else {{
    throw "Unsupported Windows update package: $package"
  }}

  Write-UpdateLog "starting updated app"
  Start-Process -FilePath $targetExe -WorkingDirectory $targetRoot
}} catch {{
  Write-UpdateLog $_.Exception.ToString()
  try {{ Start-Process -FilePath $package }} catch {{}}
}} finally {{
  try {{
    if (Test-Path -LiteralPath $stage) {{
      Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
    }}
    Remove-Item -LiteralPath $MyInvocation.MyCommand.Path -Force -ErrorAction SilentlyContinue
  }} catch {{}}
}}
"""
    script_path = _write_update_script('windows-update-helper', script, '.ps1')
    subprocess.Popen(
        [
            'powershell.exe',
            '-NoProfile',
            '-ExecutionPolicy',
            'Bypass',
            '-WindowStyle',
            'Hidden',
            '-File',
            str(script_path),
        ],
        close_fds=True,
    )


def _stage_macos_update(file_path: Path, install_mode: str, paths: dict) -> None:
    if not paths.get('app_bundle'):
        raise RuntimeError('无法确定当前 .app 位置')

    current_pid = os.getpid()
    target_app = paths['app_bundle']
    package = file_path
    stage_dir = Path(tempfile.gettempdir()) / f'better-douyin-update-{uuid.uuid4().hex}'
    log_path = _get_update_download_dir() / 'update-helper.log'

    script = f"""#!/usr/bin/env bash
set -euo pipefail
pid={current_pid}
package={shlex.quote(str(package))}
target_app={shlex.quote(str(target_app))}
stage={shlex.quote(str(stage_dir))}
log={shlex.quote(str(log_path))}
mount_dir=""
log_msg() {{
  printf '[%s] %s\\n' "$(date '+%Y-%m-%dT%H:%M:%S')" "$1" >> "$log" 2>/dev/null || true
}}
cleanup() {{
  if [ -n "$mount_dir" ]; then
    /usr/bin/hdiutil detach "$mount_dir" -quiet >/dev/null 2>&1 || true
  fi
  rm -rf "$stage" "$0" 2>/dev/null || true
}}
trap cleanup EXIT
while kill -0 "$pid" >/dev/null 2>&1; do
  sleep 0.5
done
sleep 0.8
mkdir -p "$stage"
source_app=""
case "$package" in
  *.dmg)
    log_msg "mounting dmg"
    mount_dir="$(/usr/bin/hdiutil attach -nobrowse -readonly "$package" | awk '/\\/Volumes\\// {{print substr($0, index($0, "/Volumes/")); exit}}')"
    source_app="$(find "$mount_dir" -maxdepth 2 -name '*.app' -type d | head -n 1)"
    ;;
  *.zip)
    log_msg "extracting zip"
    /usr/bin/ditto -x -k "$package" "$stage"
    source_app="$(find "$stage" -maxdepth 4 -name '*.app' -type d | head -n 1)"
    ;;
  *)
    log_msg "unsupported package: $package"
    /usr/bin/open "$package" >/dev/null 2>&1 || true
    exit 0
    ;;
esac
if [ -z "$source_app" ]; then
  log_msg "cannot find app bundle in update package"
  /usr/bin/open "$package" >/dev/null 2>&1 || true
  exit 1
fi
tmp_target="${{target_app}}.updating"
old_target="${{target_app}}.old"
rm -rf "$tmp_target" "$old_target"
log_msg "copying app bundle"
/usr/bin/ditto "$source_app" "$tmp_target"
if [ -d "$target_app" ]; then
  mv "$target_app" "$old_target"
fi
mv "$tmp_target" "$target_app"
rm -rf "$old_target"
log_msg "starting updated app"
/usr/bin/open -n "$target_app"
"""
    script_path = _write_update_script('macos-update-helper', script, '.sh')
    subprocess.Popen(['/bin/bash', str(script_path)], close_fds=True)


def _stage_linux_update(file_path: Path, install_mode: str, paths: dict) -> None:
    current_pid = os.getpid()
    target_root = paths['target_root']
    target_exe = paths['executable']
    package = file_path
    stage_dir = Path(tempfile.gettempdir()) / f'better-douyin-update-{uuid.uuid4().hex}'
    log_path = _get_update_download_dir() / 'update-helper.log'

    script = f"""#!/usr/bin/env bash
set -euo pipefail
pid={current_pid}
package={shlex.quote(str(package))}
target_root={shlex.quote(str(target_root))}
target_exe={shlex.quote(str(target_exe))}
stage={shlex.quote(str(stage_dir))}
log={shlex.quote(str(log_path))}
log_msg() {{
  printf '[%s] %s\\n' "$(date '+%Y-%m-%dT%H:%M:%S')" "$1" >> "$log" 2>/dev/null || true
}}
cleanup() {{
  rm -rf "$stage" "$0" 2>/dev/null || true
}}
trap cleanup EXIT
while kill -0 "$pid" >/dev/null 2>&1; do
  sleep 0.5
done
sleep 0.8
case "$package" in
  *.tar.gz)
    mkdir -p "$stage"
    tar -xzf "$package" -C "$stage"
    exe_name="$(basename "$target_exe")"
    source_exe="$(find "$stage" -type f -name "$exe_name" | head -n 1)"
    if [ -z "$source_exe" ]; then
      log_msg "cannot find updated executable"
      xdg-open "$package" >/dev/null 2>&1 || true
      exit 1
    fi
    source_root="$(dirname "$source_exe")"
    cp -a "$source_root"/. "$target_root"/
    ;;
  *.deb)
    if command -v pkexec >/dev/null 2>&1; then
      pkexec dpkg -i "$package"
    else
      xdg-open "$package" >/dev/null 2>&1 || true
      exit 1
    fi
    ;;
  *.rpm)
    if command -v pkexec >/dev/null 2>&1; then
      pkexec rpm -Uvh "$package"
    else
      xdg-open "$package" >/dev/null 2>&1 || true
      exit 1
    fi
    ;;
  *)
    xdg-open "$package" >/dev/null 2>&1 || true
    exit 0
    ;;
esac
nohup "$target_exe" >/dev/null 2>&1 &
"""
    script_path = _write_update_script('linux-update-helper', script, '.sh')
    subprocess.Popen(['/bin/sh', str(script_path)], close_fds=True)


def stage_self_update(file_path: Path, install_mode: str) -> dict:
    if not getattr(sys, 'frozen', False):
        raise RuntimeError('源码运行模式不支持自动安装更新')

    paths = _current_app_paths()
    if _IS_WINDOWS:
        _stage_windows_update(file_path, install_mode, paths)
    elif _IS_MACOS:
        _stage_macos_update(file_path, install_mode, paths)
    else:
        _stage_linux_update(file_path, install_mode, paths)

    return {
        'success': True,
        'restart_required': False,
        'auto_relaunch': True,
        'message': '更新已下载，应用即将关闭并自动安装重启',
    }


def schedule_app_exit_for_update() -> None:
    def exit_app() -> None:
        try:
            _socketio.stop()
        except Exception:
            pass
        # 通知主进程退出（Flask 子进程无法直接终止主进程）
        if _main_process_exit_event is not None:
            _main_process_exit_event.set()
        # 退出 Flask 子进程自身
        os._exit(0)

    threading.Timer(1.2, exit_app).start()


def open_external_target(target: str) -> bool:
    if not target:
        return False

    try:
        if _IS_WINDOWS:
            os.startfile(target)
        elif sys.platform == 'darwin':
            subprocess.Popen(['open', target])
        else:
            subprocess.Popen(['xdg-open', target])
        return True
    except Exception:
        try:
            return bool(webbrowser.open(target))
        except Exception:
            return False


def open_update_file(file_path: Path, install_mode: str) -> bool:
    if not file_path.exists():
        return False

    target = file_path
    if install_mode == 'portable' and file_path.suffix.lower() not in ('.exe', '.appimage'):
        target = file_path.parent

    return open_external_target(str(target))


def update_download_message(file_path: Path, install_mode: str, opened: bool) -> str:
    location = str(file_path)
    if install_mode in ('installer', 'dmg', 'deb', 'rpm'):
        if opened:
            return '更新包已下载并打开，请按系统提示完成安装'
        return f'更新包已下载到 {location}，请手动打开安装'
    if install_mode == 'appimage':
        if opened:
            return '新版 AppImage 已下载并打开'
        return f'新版 AppImage 已下载到 {location}'
    if opened:
        return '便携版更新包已下载，已打开所在文件夹'
    return f'便携版更新包已下载到 {location}'
