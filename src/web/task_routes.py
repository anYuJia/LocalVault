"""下载任务状态查询路由。

从 web_app.py 抽离。模块内部依赖通过 setup_task_routes(...) 注入。
"""
from __future__ import annotations

from datetime import datetime

from flask import Blueprint, jsonify

task_routes_bp = Blueprint("task_routes", __name__)

_task_store = None


def setup_task_routes(
    *,
    task_store,
) -> None:
    """注入 web_app 模块的全局对象，避免循环导入。"""
    global _task_store
    _task_store = task_store


def _serialize_task(task_id: str, task: dict) -> dict:
    normalized = dict(task)
    if 'start_time' in normalized and isinstance(normalized['start_time'], datetime):
        normalized['start_time'] = int(normalized['start_time'].timestamp() * 1000)
    if 'end_time' in normalized and isinstance(normalized['end_time'], datetime):
        normalized['end_time'] = int(normalized['end_time'].timestamp() * 1000)
    normalized.setdefault('id', task_id)
    if normalized.get('isBatch') or normalized.get('total_videos') is not None:
        normalized.setdefault('title', normalized.get('display_name') or normalized.get('filename') or '批量下载')
        normalized.setdefault('filename', normalized.get('title'))
        normalized.setdefault('progress', normalized.get('overall_progress', 0))
        normalized.setdefault('total_files', normalized.get('total_videos'))
        normalized.setdefault('completed_files', normalized.get('processed') or normalized.get('current_downloaded') or 0)
    return normalized


@task_routes_bp.route('/api/tasks', methods=['GET'])
def get_tasks():
    """获取下载任务列表。"""
    _task_store.prune()
    normalized_tasks = {
        task_id: _serialize_task(task_id, task)
        for task_id, task in _task_store.list()
    }
    return jsonify({
        'success': True,
        'tasks': normalized_tasks,
    })
