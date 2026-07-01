"""Utilities for choosing a local web server port."""
from __future__ import annotations

import os
import random
import socket
from collections.abc import Iterable

DEFAULT_PORT_START = 5001
DEFAULT_PORT_END = 5999
MAX_RANDOM_PORT_ATTEMPTS = 200


def _parse_port(value: object) -> int | None:
    try:
        port = int(str(value or "").strip())
    except (TypeError, ValueError):
        return None
    if 1 <= port <= 65535:
        return port
    return None


def is_port_available(host: str, port: int) -> bool:
    """Return whether the app can bind to host:port right now."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.bind((host, port))
        return True
    except OSError:
        return False


def _candidate_ports(
    preferred: int | None,
    start: int,
    end: int,
    exclude: set[int] | None = None,
) -> Iterable[int]:
    seen: set[int] = set(exclude or set())
    if preferred is not None:
        if preferred not in seen:
            seen.add(preferred)
            yield preferred

    for port in range(start, end + 1):
        if port not in seen:
            seen.add(port)
            yield port

    for _ in range(MAX_RANDOM_PORT_ATTEMPTS):
        port = random.randint(6000, 65535)
        if port not in seen:
            seen.add(port)
            yield port


def find_available_port(
    *,
    host: str = "127.0.0.1",
    preferred: int | None = None,
    start: int | None = None,
    end: int | None = None,
    exclude: set[int] | None = None,
) -> int:
    """Find an available local port without falling back to an occupied one."""
    host = (host or "127.0.0.1").strip() or "127.0.0.1"
    preferred_port = preferred
    if preferred_port is None:
        preferred_port = (
            _parse_port(os.environ.get("BETTER_DOUYIN_PORT"))
            or _parse_port(os.environ.get("PORT"))
        )

    start_port = start or _parse_port(os.environ.get("BETTER_DOUYIN_PORT_START")) or DEFAULT_PORT_START
    end_port = end or _parse_port(os.environ.get("BETTER_DOUYIN_PORT_END")) or DEFAULT_PORT_END
    if end_port < start_port:
        start_port, end_port = end_port, start_port

    for port in _candidate_ports(preferred_port, start_port, end_port, exclude):
        if is_port_available(host, port):
            return port

    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.bind((host, 0))
            return int(sock.getsockname()[1])
    except OSError as exc:
        raise RuntimeError(f"无法找到可用端口: {exc}") from exc
