"""Shared TLS verification helpers for packaged and source runs."""
from __future__ import annotations

import os
import ssl
from functools import lru_cache

import certifi


_FALSE_VALUES = {"0", "false", "no", "off", "disable", "disabled"}


def ssl_verification_enabled() -> bool:
    try:
        from src.config.config import Config

        return bool(getattr(Config, "SSL_VERIFY", True))
    except Exception:
        return True


def ca_bundle_path() -> str:
    path = certifi.where()
    if os.path.isfile(path):
        return path
    package_path = os.path.join(os.path.dirname(certifi.__file__), "cacert.pem")
    if os.path.isfile(package_path):
        return package_path
    return path


def _configured_ca_bundle_path() -> str:
    for env_name in ("REQUESTS_CA_BUNDLE", "SSL_CERT_FILE"):
        path = os.environ.get(env_name)
        if path and os.path.exists(path):
            return path
    return ca_bundle_path()


def apply_default_ca_env() -> None:
    """Point Python HTTP stacks at certifi unless the user already chose a CA."""
    path = ca_bundle_path()
    if not os.path.isfile(path):
        return
    os.environ.setdefault("SSL_CERT_FILE", path)
    os.environ.setdefault("REQUESTS_CA_BUNDLE", path)


def requests_verify_value():
    if not ssl_verification_enabled():
        return False
    path = _configured_ca_bundle_path()
    return path if os.path.isfile(path) else True


@lru_cache(maxsize=2)
def _cached_ssl_context(enabled: bool, cafile: str):
    if not enabled:
        return False
    if not os.path.isfile(cafile):
        return ssl.create_default_context()
    return ssl.create_default_context(cafile=cafile)


def aiohttp_ssl_context():
    if not ssl_verification_enabled():
        return False
    return _cached_ssl_context(True, _configured_ca_bundle_path())


def parse_ssl_verify(value, default: bool = True) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    text = str(value).strip().lower()
    if not text:
        return default
    return text not in _FALSE_VALUES
