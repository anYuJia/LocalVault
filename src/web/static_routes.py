"""Frontend static asset routes."""
from __future__ import annotations

from pathlib import Path

from flask import Blueprint, abort, send_file, send_from_directory

static_assets_bp = Blueprint("static_assets", __name__)

_get_resource_path = None


def setup_static_routes(*, get_resource_path) -> None:
    global _get_resource_path
    _get_resource_path = get_resource_path


def get_react_dist_dir() -> Path:
    return Path(_get_resource_path('src/web/react_dist')).resolve()


def get_frontend_public_dir() -> Path:
    return Path(_get_resource_path('frontend/public')).resolve()


def find_frontend_asset(filename: str) -> Path | None:
    for directory in (get_react_dist_dir(), get_frontend_public_dir()):
        candidate = directory / filename
        if candidate.exists() and candidate.is_file():
            return candidate
    return None


def send_frontend_asset(filename: str, mimetype: str):
    asset = find_frontend_asset(filename)
    if asset is None:
        abort(404)
    return send_file(asset, mimetype=mimetype, max_age=86400)


def has_react_frontend() -> bool:
    react_index = get_react_dist_dir() / 'index.html'
    return react_index.exists() and react_index.is_file()


@static_assets_bp.route('/favicon.ico')
def favicon():
    """Serve favicon to avoid noisy 404s in browsers."""
    return send_frontend_asset('favicon.svg', 'image/svg+xml')


@static_assets_bp.route('/favicon.svg')
def favicon_svg():
    return send_frontend_asset('favicon.svg', 'image/svg+xml')


@static_assets_bp.route('/animated_icon.svg')
def animated_icon():
    return send_frontend_asset('animated_icon.svg', 'image/svg+xml')


@static_assets_bp.route('/socket.io.min.js')
def socket_io_client():
    return send_frontend_asset('socket.io.min.js', 'application/javascript')


@static_assets_bp.route('/default-avatar.svg')
def default_avatar():
    return send_frontend_asset('default-avatar.svg', 'image/svg+xml')


@static_assets_bp.route('/assets/<path:filename>')
def react_assets(filename: str):
    react_assets_dir = get_react_dist_dir() / 'assets'
    if not react_assets_dir.exists():
        abort(404)
    return send_from_directory(react_assets_dir, filename, max_age=86400)


@static_assets_bp.route('/default-cover.svg')
def default_cover():
    return send_frontend_asset('default-cover.svg', 'image/svg+xml')


@static_assets_bp.route('/qq-group.jpg')
def qq_group():
    return send_frontend_asset('qq-group.jpg', 'image/jpeg')
