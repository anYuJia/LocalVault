"""下载任务控制（取消/暂停/恢复）路由拆分模块。

从 downloads_routes.py 抽离的下载任务控制相关路由。路由仍注册到同一个
downloads_bp Blueprint，URL 不变；注入的依赖通过运行时读取
downloads_routes 模块属性获取，避免循环导入与 setup 时序问题。
"""
from __future__ import annotations

from flask import jsonify

from src.web.downloads_routes import downloads_bp


def _deps():
    """延迟读取 downloads_routes 注入的依赖。"""
    from src.web import downloads_routes as dr
    return dr


@downloads_bp.route('/api/cancel_download', methods=['POST'])
def cancel_download():
    """按任务ID取消下载"""
    dr = _deps()
    data = dr._request_json()
    task_id = data.get('task_id')
    dr._logger.info(f"Request to cancel task: {task_id}")

    info = dr._task_store.get_active(task_id)
    if info is not None:
        # 设置取消事件
        info["event"].set()
        dr._task_store.set_status(task_id, 'cancelled')
        return jsonify({'success': True, 'message': '正在取消任务...'})

    if dr._task_store.get(task_id) is not None:
        dr._task_store.set_status(task_id, 'cancelled')
        return jsonify({'success': True, 'message': '任务已标记为取消'})

    return jsonify({'success': False, 'message': '未找到活跃任务'})


@downloads_bp.route('/api/pause_download', methods=['POST'])
def pause_download():
    """按任务ID暂停下载"""
    dr = _deps()
    data = dr._request_json()
    task_id = data.get('task_id')
    dr._logger.info(f"Request to pause task: {task_id}")

    info = dr._task_store.get_active(task_id)
    if info is not None:
        if 'pause_event' in info:
            info['pause_event'].set()  # 设置暂停事件
            dr._task_store.set_status(task_id, 'paused')
            dr._socketio.emit('user_video_download_progress', {
                'task_id': task_id,
                'status': 'paused',
                'message': '已暂停',
                'type': 'info'
            })
            return jsonify({'success': True, 'message': '任务已暂停'})
        else:
            return jsonify({'success': False, 'message': '该任务不支持暂停'})

    return jsonify({'success': False, 'message': '未找到活跃任务'})


@downloads_bp.route('/api/resume_download', methods=['POST'])
def resume_download():
    """按任务ID恢复下载"""
    dr = _deps()
    data = dr._request_json()
    task_id = data.get('task_id')
    dr._logger.info(f"Request to resume task: {task_id}")

    info = dr._task_store.get_active(task_id)
    if info is not None:
        if 'pause_event' in info:
            info['pause_event'].clear()  # 清除暂停事件
            dr._task_store.set_status(task_id, 'downloading')
            dr._socketio.emit('user_video_download_progress', {
                'task_id': task_id,
                'status': 'downloading',
                'message': '继续下载',
                'type': 'info'
            })
            return jsonify({'success': True, 'message': '任务已恢复'})
        else:
            return jsonify({'success': False, 'message': '该任务不支持恢复'})

    return jsonify({'success': False, 'message': '未找到活跃任务'})
