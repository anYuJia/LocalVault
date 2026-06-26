"""下载任务状态与活跃任务存储。

这层负责封装 download_tasks / active_tasks 的并发访问，避免路由模块直接操作全局 dict。
"""
from __future__ import annotations

import time
import threading
from datetime import datetime
from typing import Any

TERMINAL_TASK_STATUSES = {'completed', 'failed', 'error', 'cancelled', 'canceled'}


class ThreadPauseEvent:
    """Thread-compatible pause guard backed by an asyncio.Event."""

    def __init__(self, event):
        self.event = event

    def is_set(self):
        return self.event.is_set()

    def wait_while_set(self, cancel_event=None, interval=0.2):
        while self.event.is_set() and not (cancel_event and cancel_event.is_set()):
            time.sleep(interval)


class WebDownloadProgress:
    """Web 下载进度回调。"""

    def __init__(self, task_id, socketio, desc=None):
        self.task_id = task_id
        self.socketio = socketio
        self.total_files = 0
        self.completed_files = 0
        self.desc = desc
        self.display_name = '下载任务'
        if desc and desc.strip():
            self.display_name = ' '.join(str(desc).split()).strip()

    def set_total_files(self, total):
        self.total_files = total
        self.emit_progress()

    def file_completed(self, filename):
        self.completed_files += 1
        self.emit_progress()
        self.socketio.emit('download_log', {
            'task_id': self.task_id,
            'message': f'下载完成: {filename}',
            'timestamp': datetime.now().strftime('%H:%M:%S'),
        })

    def emit_progress(self):
        progress = (self.completed_files / self.total_files * 100) if self.total_files > 0 else 0
        self.socketio.emit('download_progress', {
            'task_id': self.task_id,
            'progress': progress,
            'completed': self.completed_files,
            'total': self.total_files,
            'desc': self.desc,
            'display_name': self.display_name,
        })


class DownloadTaskStore:
    """Thread-safe store for persisted and active download task state."""

    def __init__(self, *, history_max_size: int = 200):
        self.history_max_size = history_max_size
        self.tasks: dict[str, dict] = {}
        self.active_tasks: dict[str, dict[str, Any]] = {}
        self.lock = threading.Lock()

    def _task_sort_timestamp(self, task: dict) -> float:
        for key in ('end_time', 'start_time'):
            value = task.get(key)
            if isinstance(value, datetime):
                return value.timestamp()
            try:
                return float(value)
            except (TypeError, ValueError):
                continue
        return 0.0

    def prune(self) -> None:
        with self.lock:
            overflow = len(self.tasks) - self.history_max_size
            if overflow <= 0:
                return

            removable = [
                (task_id, task)
                for task_id, task in self.tasks.items()
                if task_id not in self.active_tasks
                and str(task.get('status') or '').lower() in TERMINAL_TASK_STATUSES
            ]
            removable.sort(key=lambda item: self._task_sort_timestamp(item[1]))

            for task_id, _ in removable[:overflow]:
                self.tasks.pop(task_id, None)

    def store(self, task_id: str, task: dict) -> None:
        with self.lock:
            self.tasks[task_id] = task
        self.prune()

    def set_status(self, task_id: str, status: str, **extra) -> None:
        """Atomically update a task status and optional fields."""
        with self.lock:
            task = self.tasks.get(task_id)
            if task is None:
                return
            task['status'] = status
            for key, value in extra.items():
                task[key] = value

    def update_fields(self, task_id: str, **fields) -> None:
        with self.lock:
            task = self.tasks.get(task_id)
            if task is not None:
                task.update(fields)

    def get(self, task_id: str) -> dict | None:
        with self.lock:
            task = self.tasks.get(task_id)
            return dict(task) if task is not None else None

    def list(self) -> list[tuple[str, dict]]:
        with self.lock:
            return [(tid, dict(task)) for tid, task in self.tasks.items()]

    def add_active(self, task_id: str, info: dict[str, Any]) -> None:
        with self.lock:
            self.active_tasks[task_id] = info

    def pop_active(self, task_id: str) -> dict[str, Any] | None:
        with self.lock:
            return self.active_tasks.pop(task_id, None)

    def get_active(self, task_id: str) -> dict[str, Any] | None:
        with self.lock:
            return self.active_tasks.get(task_id)

    def has_active(self, task_id: str) -> bool:
        with self.lock:
            return task_id in self.active_tasks
