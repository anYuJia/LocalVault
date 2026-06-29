"""版本检查逻辑。

负责版本号解析、比较、获取当前版本、拉取远端版本信息等。
updater.py 通过委托方式使用此模块，保持对外接口不变。
"""
import os
import re
import sys
import subprocess
from pathlib import Path


def normalize_version_text(version: str) -> str:
    return str(version or '').strip().lstrip('vV')


def _parse_version_parts(version: str) -> tuple[int, ...]:
    parts = [int(part) for part in re.findall(r'\d+', normalize_version_text(version))]
    return tuple(parts) if parts else (0,)


def is_newer_version(latest_version: str, current_version: str) -> bool:
    latest = _parse_version_parts(latest_version)
    current = _parse_version_parts(current_version)
    max_len = max(len(latest), len(current))
    latest += (0,) * (max_len - len(latest))
    current += (0,) * (max_len - len(current))
    return latest > current


def get_current_app_version(Config=None) -> str:
    env_version = normalize_version_text(os.environ.get('APP_VERSION') or os.environ.get('GITHUB_REF_NAME') or '')
    if env_version:
        return env_version

    config_version = normalize_version_text(getattr(Config, 'APP_VERSION', '') if Config else '')
    if config_version:
        return config_version

    try:
        creationflags = 0x08000000 if sys.platform == 'win32' else 0
        result = subprocess.run(
            ['git', 'describe', '--tags', '--always', '--dirty'],
            capture_output=True,
            text=True,
            timeout=5,
            cwd=str(Path(__file__).resolve().parents[2]),
            creationflags=creationflags,
        )
        if result.returncode == 0 and result.stdout.strip():
            return normalize_version_text(result.stdout.strip())
    except Exception:
        pass

    return '0.0.13'


def fetch_latest_release(http_requests, latest_release_api_url: str, Config=None) -> dict:
    response = http_requests.get(
        latest_release_api_url,
        headers={
            'Accept': 'application/vnd.github+json',
            'User-Agent': f'better-douyin/{get_current_app_version(Config)}',
        },
        timeout=(5, 15),
    )
    response.raise_for_status()
    payload = response.json()
    if not isinstance(payload, dict):
        raise ValueError('GitHub release payload invalid')
    return payload


def fetch_updater_metadata(http_requests, updater_metadata_url: str, logger=None, Config=None) -> dict | None:
    try:
        response = http_requests.get(
            updater_metadata_url,
            headers={
                'Accept': 'application/json',
                'User-Agent': f'better-douyin/{get_current_app_version(Config)}',
            },
            timeout=(5, 15),
        )
        if response.status_code == 404:
            return None
        response.raise_for_status()
        payload = response.json()
        return payload if isinstance(payload, dict) else None
    except Exception as exc:
        if logger:
            logger.debug(f"读取更新签名元数据失败，回退到 GitHub Release API: {exc}")
        return None


def normalize_update_notes(notes: str) -> str:
    text = str(notes or '').strip()
    if not text:
        return ''
    for pattern in (r'\n##\s*下载建议\b', r'\n##\s*Download\b'):
        match = re.search(pattern, text, flags=re.IGNORECASE)
        if match:
            text = text[:match.start()].strip()
            break
    return text
