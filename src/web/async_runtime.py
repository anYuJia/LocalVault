"""Shared asyncio runtime used by sync Flask routes."""
from __future__ import annotations

import asyncio
import concurrent.futures
import threading

_global_loop = None
_loop_thread = None
_logger = None


def setup_async_runtime(*, logger) -> None:
    global _logger
    _logger = logger


def get_or_create_loop():
    global _global_loop, _loop_thread
    if _global_loop is None:
        _global_loop = asyncio.new_event_loop()

        def _run_loop():
            try:
                asyncio.set_event_loop(_global_loop)
            except Exception:
                pass
            _global_loop.run_forever()

        _loop_thread = threading.Thread(target=_run_loop, daemon=True)
        _loop_thread.start()
        if _logger:
            _logger.info("Global asyncio loop started in background thread")
    return _global_loop


def run_async(coro, timeout: float | None = 120):
    """在全局循环中运行异步任务并等待结果。"""
    loop = get_or_create_loop()
    future = asyncio.run_coroutine_threadsafe(coro, loop)
    try:
        return future.result(timeout=timeout)
    except concurrent.futures.TimeoutError as exc:
        future.cancel()
        raise TimeoutError(f'异步任务执行超时（{timeout}s）') from exc
