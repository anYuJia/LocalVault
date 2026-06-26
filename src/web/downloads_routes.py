"""下载相关路由。

从 web_app.py 抽离。模块内部依赖通过 setup 注入，
外部调用方（web_app.py）需要在导入本模块后调用 setup_downloads_routes(...)。
"""
from __future__ import annotations

import asyncio
import time
import uuid
from datetime import datetime
from typing import Any, Callable

from flask import Blueprint, jsonify
from src.web.download_task_store import ThreadPauseEvent

downloads_bp = Blueprint("downloads", __name__)

# 注入的依赖
_logger = None
_Config = None
_socketio = None
_request_json: Callable[[], dict] | None = None
_coerce_int: Callable[..., int] | None = None
_run_async: Callable[..., Any] | None = None
_api_message: Callable[..., str] | None = None
_verify_error_response: Callable[..., dict] | None = None
_login_error_response: Callable[..., dict] | None = None
_normalize_download_media_urls: Callable[..., list] | None = None
_build_download_title: Callable[..., str] | None = None
_build_download_name: Callable[..., str] | None = None
_get_or_create_loop: Callable[..., Any] | None = None
_task_store = None


def setup_downloads_routes(
    *,
    logger,
    Config,
    socketio,
    request_json: Callable[[], dict],
    coerce_int: Callable[..., int],
    run_async: Callable[..., Any],
    api_message: Callable[..., str],
    verify_error_response: Callable[..., dict],
    login_error_response: Callable[..., dict],
    normalize_download_media_urls: Callable[..., list],
    build_download_title: Callable[..., str],
    build_download_name: Callable[..., str],
    get_or_create_loop: Callable[..., Any],
    task_store,
) -> None:
    """注入 web_app 模块的全局对象，避免循环导入。"""
    global _logger, _Config, _socketio, _request_json, _coerce_int, _run_async
    global _api_message, _verify_error_response, _login_error_response
    global _normalize_download_media_urls, _build_download_title, _build_download_name
    global _get_or_create_loop
    global _task_store
    _logger = logger
    _Config = Config
    _socketio = socketio
    _request_json = request_json
    _coerce_int = coerce_int
    _run_async = run_async
    _api_message = api_message
    _verify_error_response = verify_error_response
    _login_error_response = login_error_response
    _normalize_download_media_urls = normalize_download_media_urls
    _build_download_title = build_download_title
    _build_download_name = build_download_name
    _get_or_create_loop = get_or_create_loop
    _task_store = task_store


def _get_user_manager():
    """延迟读取 web_app.user_manager，避免 setup 时还未初始化。"""
    from src.web import web_app
    return web_app.user_manager


def _get_downloader():
    """延迟读取 web_app.downloader，避免 setup 时还未初始化。"""
    from src.web import web_app
    return web_app.downloader


@downloads_bp.route('/api/download_single_video', methods=['POST'])
def download_single_video():
    """下载单个作品（视频、图集或Live Photo）"""
    try:
        data = _request_json()
        aweme_id = data.get('aweme_id', '').strip()
        video_desc = data.get('desc', '未知作品')
        video_create_time = data.get('create_time', 0)
        media_urls = data.get('media_urls', [])
        raw_media_type = data.get('raw_media_type', 'video')
        author_name = data.get('author_name', '未知作者')

        if not aweme_id:
            return jsonify({'success': False, 'message': '作品ID不能为空'}), 400

        user_manager = _get_user_manager()
        downloader = _get_downloader()
        if not user_manager or not downloader:
            return jsonify({'success': False, 'message': '服务未完全初始化'}), 500

        media_urls = _normalize_download_media_urls(media_urls, raw_media_type)
        video_fallback_urls = []
        payload_video_data = data.get('video') if isinstance(data.get('video'), dict) else {}

        should_refresh_video_media = (
            raw_media_type == 'video'
            or (
                raw_media_type not in ('image', 'live_photo', 'mixed')
                and any(item.get('type') == 'video' for item in media_urls)
            )
            or not media_urls
        )
        payload_video_urls = []
        if should_refresh_video_media and payload_video_data:
            payload_video_urls = user_manager._build_video_media_urls(payload_video_data)
            if payload_video_urls:
                media_urls = _normalize_download_media_urls(payload_video_urls, 'video')
                raw_media_type = 'video'
                video_fallback_urls = user_manager.get_video_download_urls(payload_video_data)

        if should_refresh_video_media and aweme_id:
            detail = _run_async(user_manager.get_video_detail(aweme_id))
            if isinstance(detail, dict) and detail.get('_need_verify'):
                return jsonify(_verify_error_response(detail, '需要完成滑块验证'))
            if isinstance(detail, dict) and detail.get('_need_login'):
                return jsonify(_login_error_response(detail))

            if detail:
                video_create_time = detail.get('create_time') or video_create_time
                detail_media_type = detail.get('raw_media_type') or detail.get('media_type') or raw_media_type
                detail_media_urls = _normalize_download_media_urls(detail.get('media_urls', []), detail_media_type)
                detail_video_urls = []
                detail_video_data = {}
                if detail_media_type == 'video':
                    detail_video_data = detail.get('video') or {}
                    if payload_video_data:
                        detail_height = user_manager._available_video_quality_height(detail_video_data)
                        payload_height = user_manager._available_video_quality_height(payload_video_data)
                        detail_video_data = user_manager.merge_video_download_candidates(
                            detail_video_data,
                            payload_video_data,
                        )
                        _logger.info(
                            "下载质量候选合并: aweme_id=%s detail_height=%s payload_height=%s combined_height=%s combined_count=%s",
                            aweme_id,
                            detail_height,
                            payload_height,
                            user_manager._available_video_quality_height(detail_video_data),
                            user_manager._video_quality_candidate_count(detail_video_data),
                        )
                    detail_video_urls = user_manager._build_video_media_urls(detail_video_data)
                if detail_video_urls:
                    media_urls = _normalize_download_media_urls(detail_video_urls, 'video')
                    raw_media_type = 'video'
                elif detail_media_urls:
                    media_urls = detail_media_urls
                    raw_media_type = detail_media_type
                if detail_video_urls or detail_media_urls:
                    video_desc = detail.get('desc') or video_desc
                    author_name = detail.get('author', {}).get('nickname') or author_name
                    video_fallback_urls = user_manager.get_video_download_urls(
                        detail_video_data or (detail.get('video') or {})
                    )

        if not media_urls:
            return jsonify({'success': False, 'message': '没有可用的媒体URL'}), 400

        task_id = str(uuid.uuid4())

        # 在全局 Loop 中运行下载任务
        async def do_single_download():
            try:
                _logger.debug(f" 开始下载任务: {task_id}")
                _logger.debug(f" 作品ID: {aweme_id}")
                _logger.debug(f" 媒体类型: {raw_media_type}")
                _logger.debug(f" 媒体URL数量: {len(media_urls)}")
                _logger.debug(f" 媒体URLs: {media_urls}")

                download_title = _build_download_title(
                    video_desc,
                    aweme_id,
                    author=author_name,
                    media_type=raw_media_type,
                    create_time=video_create_time,
                )

                # 发送下载开始事件
                try:
                    _logger.debug(f" 发送WebSocket下载开始事件: task_id={task_id}")
                    media_count = len(media_urls)
                    _socketio.emit('download_started', {
                        'task_id': task_id,
                        'desc': video_desc,
                        'type': 'single_video',
                        'aweme_id': aweme_id,
                        'media_type': raw_media_type,
                        'media_count': media_count
                    })
                    _logger.debug(f" WebSocket事件已发送")
                except Exception as e:
                    _logger.error(f" 发送WebSocket事件失败: {str(e)}")

                # 发送进度更新 - 开始
                display_name = download_title or "下载任务"
                _socketio.emit('download_progress', {
                    'task_id': task_id,
                    'progress': 0,
                    'completed': 0,
                    'total': len(media_urls),
                    'status': 'starting',
                    'desc': video_desc,
                    'display_name': display_name
                })

                # 提取URL列表，处理不同的数据格式
                urls = media_urls

                _logger.debug(f" 提取的URL列表: {urls}")

                if not urls:
                    raise ValueError("没有有效的媒体URL")

                # 使用配置的目录模板和文件模板生成下载路径
                file_path = _build_download_name(
                    author_name,
                    video_desc,
                    aweme_id,
                    media_type=raw_media_type,
                    create_time=video_create_time,
                )
                _logger.debug(f" 文件路径: {file_path}")

                # 统一下载处理，不再区分媒体类型
                _logger.debug(f" 开始统一下载: {len(urls)} 个文件")
                _socketio.emit('download_progress', {
                    'task_id': task_id,
                    'progress': 10,
                    'completed': 0,
                    'total': len(urls),
                    'status': 'downloading',
                    'desc': video_desc,
                    'display_name': display_name
                })
                _socketio.emit('download_log', {
                    'task_id': task_id,
                    'message': f'正在下载媒体文件: {len(urls)} 个文件',
                    'timestamp': datetime.now().strftime('%H:%M:%S')
                })

                success = False

                try:
                    # 统一下载处理，直接传入urls参数
                    _logger.debug(f" 开始下载: {len(urls)} 个文件")
                    if len(urls) == 1 and urls[0].get('type') == 'video':
                        success = await asyncio.to_thread(
                            downloader.download_video,
                            urls[0]['url'],
                            file_path,
                            aweme_id,
                            None,
                            _socketio,
                            task_id,
                            None,
                            None,
                            False,
                            fallback_urls=video_fallback_urls,
                        )
                    else:
                        success = await asyncio.to_thread(
                            downloader.download_media_group,
                            urls,
                            file_path,
                            aweme_id,
                            _socketio,
                            task_id,
                            None,
                            None,
                            None,
                            False,
                        )

                    if success:
                        _socketio.emit('download_progress', {
                            'task_id': task_id,
                            'progress': 100,
                            'completed': len(urls),
                            'total': len(urls),
                            'status': 'completed',
                            'desc': video_desc,
                            'display_name': display_name
                        })
                        _socketio.emit('download_log', {
                            'task_id': task_id,
                            'message': f'✅ 下载完成: {len(urls)} 个文件',
                            'timestamp': datetime.now().strftime('%H:%M:%S')
                        })
                    else:
                        raise Exception('下载失败')

                except Exception as e:
                    success = False
                    _logger.error(f" 下载失败: {str(e)}")
                    if 'progress' not in locals() or 'download_progress' not in str(e):
                        _socketio.emit('download_progress', {
                            'task_id': task_id,
                            'progress': 0,
                            'completed': 0,
                            'total': len(urls),
                            'status': 'failed',
                            'desc': video_desc,
                            'display_name': display_name
                        })
                        _socketio.emit('download_log', {
                            'task_id': task_id,
                            'message': f'❌ 下载失败: {str(e)}',
                            'timestamp': datetime.now().strftime('%H:%M:%S')
                        })
                    raise e

                _logger.debug(f" 下载任务完成，结果: {success}")

                # 发送最终完成事件（统一处理）
                if success:
                    _socketio.emit('download_completed', {
                        'task_id': task_id,
                        'message': f'下载成功: {video_desc}',
                        'aweme_id': aweme_id,
                        'media_type': raw_media_type,
                        'file_count': len(media_urls)
                    })
                    _logger.debug(f" 发送下载完成事件: task_id={task_id}")
                else:
                    raise Exception('下载失败')

            except Exception as e:
                error_msg = f"下载失败: {str(e)}"
                _logger.error(f" {error_msg}")
                _socketio.emit('download_failed', {'task_id': task_id, 'error': error_msg})
            finally:
                pass

        loop = _get_or_create_loop()
        asyncio.run_coroutine_threadsafe(do_single_download(), loop)

        return jsonify({'success': True, 'task_id': task_id, 'message': '下载任务已启动'})

    except Exception as e:
        return jsonify({'success': False, 'message': f'下载启动失败: {str(e)}'}), 500


@downloads_bp.route('/api/download_user_video', methods=['POST'])
def download_user_video():
    """通过sec_uid下载用户所有视频，支持WebSocket进度反馈"""
    _logger.debug("Received download_user_video request")
    try:
        data = _request_json()
        sec_uid = data.get('sec_uid')
        nickname = data.get('nickname', '')  # 前端传来，跳过详情接口
        aweme_count = _coerce_int(data.get('aweme_count'), 0, 0) # 获取作品总数

        if not sec_uid:
            return jsonify({'success': False, 'message': 'sec_uid参数不能为空'}), 400

        user_manager = _get_user_manager()
        if not user_manager:
            return jsonify({'success': False, 'message': '请先设置Cookie'}), 400

        # 生成任务ID
        task_id = str(uuid.uuid4())
        cancel_event = asyncio.Event()
        pause_event = asyncio.Event()  # 暂停事件，默认不暂停

        display_name = f'{nickname or "用户"} 全部作品'
        _task_store.store(task_id, {
            'status': 'running',
            'sec_uid': sec_uid,
            'nickname': nickname,
            'title': display_name,
            'filename': display_name,
            'display_name': display_name,
            'isBatch': True,
            'total_videos': aweme_count,
            'current_downloaded': 0,
            'processed': 0,
            'progress': 0,
            'overall_progress': 0,
            'start_time': datetime.now()
        })

        # 在全局 Loop 中运行异步下载协程
        async def do_download_task():
            try:
                # 使用前端传来的nickname，不再调用get_user_detail

                _nickname = nickname if nickname else 'unknown'

                # 发送开始信号
                _socketio.emit('download_started', {
                    'task_id': task_id,
                    'user': _nickname,
                    'nickname': _nickname,
                    'sec_uid': sec_uid,
                    'total_videos': aweme_count,
                    'message': f'开始下载 {_nickname} 的 {aweme_count} 个作品'
                })

                # 增量下载队列
                download_queue = asyncio.Queue()
                fetching_done = asyncio.Event()
                total_discovered = [0]
                total_processed = [0] # 包含已跳过的
                total_succeeded = [0]
                total_skipped = [0]
                total_failed = [0]
                total_videos = aweme_count # 初始总量
                consumer_count = max(1, int(getattr(_Config, 'MAX_CONCURRENT', 3) or 1))
                pause_control = ThreadPauseEvent(pause_event)
                batch_started_at = time.monotonic()

                def update_task_snapshot(**fields):
                    _task_store.update_fields(task_id, **fields)

                def emit_batch_progress(**payload):
                    current_task = _task_store.get(task_id)
                    _socketio.emit('user_video_download_progress', payload)
                    update_task_snapshot(
                        status=payload.get('status') or (current_task or {}).get('status', 'running'),
                        progress=payload.get('overall_progress'),
                        overall_progress=payload.get('overall_progress'),
                        processed=payload.get('processed') if payload.get('processed') is not None else payload.get('current_downloaded'),
                        current_downloaded=payload.get('current_downloaded'),
                        total_videos=payload.get('total_videos'),
                        skipped=payload.get('skipped'),
                        failed=payload.get('failed'),
                        succeeded=payload.get('succeeded'),
                        eta_seconds=payload.get('eta_seconds'),
                        current_name=payload.get('message'),
                    )

                def estimate_batch_eta(processed_count, total_count):
                    if processed_count <= 0 or total_count <= 0 or processed_count >= total_count:
                        return None
                    elapsed = max(time.monotonic() - batch_started_at, 0.001)
                    return int(max(1, ((total_count - processed_count) * elapsed) / processed_count))

                # 发送初始总量信息
                if total_videos > 0:
                    _socketio.emit('download_info', {
                        'task_id': task_id,
                        'total_videos': total_videos,
                        'current_downloaded': 0,
                        'processed': 0,
                        'overall_progress': 0,
                        'remaining': total_videos,
                        'message': f'准备开始下载，共发现 {total_videos} 个作品'
                    })

                def on_batch(batch):
                    if cancel_event.is_set():
                        return
                    for post in batch:
                        if user_manager.downloader._is_aweme_downloaded(post['aweme_id']):
                            total_processed[0] += 1
                            total_skipped[0] += 1
                            # 发送跳过进度更新
                            overall_progress = int((total_processed[0] / max(total_videos, total_processed[0], 1)) * 100)
                            emit_batch_progress(**{
                                'task_id': task_id,
                                'total_videos': max(total_videos, total_processed[0]),
                                'current_downloaded': total_processed[0],
                                'processed': total_processed[0],
                                'skipped': total_skipped[0],
                                'failed': total_failed[0],
                                'remaining': max(total_videos - total_processed[0], 0),
                                'overall_progress': overall_progress,
                                'message': f'跳过已下载: {post.get("desc", post["aweme_id"])[:10]}...',
                                'type': 'progress'
                            })
                        else:
                            download_queue.put_nowait(post)
                            total_discovered[0] += 1

                    # 更新总量感
                    current_total = max(total_videos, total_processed[0] + download_queue.qsize())
                    _socketio.emit('download_info', {
                        'task_id': task_id,
                        'total_videos': current_total,
                        'current_downloaded': total_processed[0],
                        'processed': total_processed[0],
                        'skipped': total_skipped[0],
                        'failed': total_failed[0],
                        'overall_progress': int((total_processed[0] / max(total_videos, current_total, 1)) * 100),
                        'remaining': current_total - total_processed[0],
                        'message': f'正在抓取作品列表... 已发现 {total_discovered[0]} 个新作品'
                    })

                async def downloader_consumer():
                    while not (fetching_done.is_set() and download_queue.empty()):
                        # 检查取消
                        if cancel_event.is_set():
                            _logger.info(f"Task {task_id} consumer cancelled")
                            # 清空队列
                            while not download_queue.empty():
                                try:
                                    download_queue.get_nowait()
                                except:
                                    break
                            break

                        # 检查暂停 - 如果暂停事件被设置，则等待恢复
                        if pause_event.is_set():
                            # 发送暂停状态
                            _socketio.emit('user_video_download_progress', {
                                'task_id': task_id,
                                'message': '已暂停',
                                'type': 'info'
                            })
                            # 等待 pause_event 被清除（恢复）
                            while pause_event.is_set() and not cancel_event.is_set():
                                await asyncio.sleep(0.5)

                        try:
                            # 等待队列中的新作品
                            post = await asyncio.wait_for(download_queue.get(), timeout=1.0)
                        except asyncio.TimeoutError:
                            continue

                        # 检查取消信号（开始下载前）
                        if cancel_event.is_set():
                            _logger.info(f"Task {task_id} cancelled before download")
                            break

                        aweme_id = post['aweme_id']
                        media_type, urls = user_manager.get_media_info(post)
                        name = _build_download_name(
                            _nickname,
                            post.get('desc', ''),
                            aweme_id,
                            media_type=media_type,
                            create_time=post.get('create_time'),
                        )

                        def current_total_count():
                            return max(total_videos, total_discovered[0] + total_skipped[0], total_processed[0] + download_queue.qsize())

                        def emit_current_video_progress(current_progress=0, status='downloading', message=None, current_downloaded=None,
                                                        completed_files=0, total_files=1, speed_bps=None, eta_seconds=None,
                                                        file_index=1, file_total=1, bytes_downloaded=0, bytes_total=0):
                            processed_count = total_processed[0] if current_downloaded is None else current_downloaded
                            current_total = current_total_count()
                            progress_ratio = max(0, min(current_progress, 100)) / 100
                            current_weight = progress_ratio if status not in ('completed', 'failed') else 0
                            overall_progress = int(((processed_count + current_weight) / max(current_total, 1)) * 100)

                            emit_batch_progress(**{
                                'task_id': task_id,
                                'total_videos': current_total,
                                'current_downloaded': processed_count,
                                'processed': processed_count,
                                'skipped': total_skipped[0],
                                'failed': total_failed[0],
                                'remaining': max(current_total - processed_count, 0),
                                'overall_progress': min(100, max(0, overall_progress)),
                                'current_progress': max(0, min(current_progress, 100)),
                                'eta_seconds': estimate_batch_eta(processed_count, current_total),
                                'message': message or f'正在下载: {desc}',
                                'type': 'progress',
                                'current_video': {
                                    'aweme_id': aweme_id,
                                    'desc': desc,
                                    'status': status,
                                    'progress': max(0, min(current_progress, 100)),
                                    'completed_files': completed_files,
                                    'total_files': total_files,
                                    'file_index': file_index,
                                    'file_total': file_total,
                                    'speed_bps': speed_bps,
                                    'eta_seconds': eta_seconds,
                                    'bytes_downloaded': bytes_downloaded,
                                    'bytes_total': bytes_total
                                }
                            })

                        # 发送进度预览
                        emit_current_video_progress(
                            current_progress=0,
                            status='starting',
                            message=f'正在下载: {desc}',
                            current_downloaded=total_processed[0],
                            completed_files=0,
                            total_files=1,
                            file_index=1,
                            file_total=1
                        )

                        # 执行下载
                        try:
                            if not urls:
                                total_failed[0] += 1
                                total_processed[0] += 1
                                current_total = current_total_count()
                                overall_progress = int((total_processed[0] / max(total_videos, current_total, 1)) * 100)
                                emit_batch_progress(**{
                                    'task_id': task_id,
                                    'total_videos': current_total,
                                    'current_downloaded': total_processed[0],
                                    'processed': total_processed[0],
                                    'succeeded': total_succeeded[0],
                                    'skipped': total_skipped[0],
                                    'failed': total_failed[0],
                                    'remaining': max(current_total - total_processed[0], 0),
                                    'overall_progress': min(100, max(0, overall_progress)),
                                    'eta_seconds': estimate_batch_eta(total_processed[0], current_total),
                                    'message': f'无可下载媒体: {desc}',
                                    'type': 'progress'
                                })
                                continue

                            success = False
                            def progress_callback(progress_data):
                                pause_control.wait_while_set(cancel_event)
                                if cancel_event.is_set():
                                    raise RuntimeError('下载已取消')
                                emit_current_video_progress(
                                    current_progress=progress_data.get('progress', 0),
                                    status=progress_data.get('status', 'downloading'),
                                    message=f'正在下载: {desc}',
                                    current_downloaded=total_processed[0],
                                    completed_files=progress_data.get('completed', 0),
                                    total_files=progress_data.get('total', len(urls) if urls else 1),
                                    speed_bps=progress_data.get('speed_bps'),
                                    eta_seconds=progress_data.get('eta_seconds'),
                                    file_index=progress_data.get('file_index', 1),
                                    file_total=progress_data.get('file_total', len(urls) if urls else 1),
                                    bytes_downloaded=progress_data.get('bytes_downloaded', 0),
                                    bytes_total=progress_data.get('bytes_total', 0)
                                )

                            if media_type == 'video' and len(urls) == 1:
                                fallback_urls = user_manager.get_video_download_urls((post.get('video') or {}))
                                success = await asyncio.to_thread(
                                    user_manager.downloader.download_video,
                                    urls[0]['url'],
                                    name,
                                    aweme_id,
                                    cancel_event,
                                    None,
                                    None,
                                    progress_callback,
                                    pause_control,
                                    fallback_urls=fallback_urls,
                                )
                            else:
                                success = await asyncio.to_thread(
                                    user_manager.downloader.download_media_group,
                                    urls,
                                    name,
                                    aweme_id,
                                    None,
                                    None,
                                    cancel_event,
                                    progress_callback,
                                    pause_control,
                                )

                            if success:
                                total_succeeded[0] += 1
                                total_processed[0] += 1
                                _socketio.emit('download_success', {'task_id': task_id, 'message': f'作品 {desc} 下载完成'})
                                emit_current_video_progress(
                                    current_progress=100,
                                    status='completed',
                                    message=f'完成处理: {desc}',
                                    current_downloaded=total_processed[0],
                                    completed_files=len(urls),
                                    total_files=len(urls),
                                    file_index=len(urls),
                                    file_total=len(urls),
                                    eta_seconds=0
                                )
                            else:
                                total_failed[0] += 1
                                total_processed[0] += 1

                            # 检查取消状态
                            if cancel_event.is_set():
                                _logger.info(f"下载被用户取消: {task_id}")
                                break
                        except Exception as e:
                            total_failed[0] += 1
                            total_processed[0] += 1
                            _logger.error(f"Download error for {aweme_id}: {e}")

                        # 更新总进度
                        current_total = current_total_count()
                        overall_progress = int((total_processed[0] / max(total_videos, current_total, 1)) * 100)
                        emit_batch_progress(**{
                            'task_id': task_id,
                            'total_videos': current_total,
                            'current_downloaded': total_processed[0],
                            'processed': total_processed[0],
                            'succeeded': total_succeeded[0],
                            'skipped': total_skipped[0],
                            'failed': total_failed[0],
                            'remaining': max(current_total - total_processed[0], 0),
                            'overall_progress': overall_progress,
                            'eta_seconds': estimate_batch_eta(total_processed[0], current_total),
                            'message': f'完成处理: {desc}',
                            'type': 'progress'
                        })

                # 获取视频抓取任务（需要能响应取消）
                fetch_coro = user_manager.get_user_videos(sec_uid, limit=1000, on_batch=on_batch)
                fetch_task = asyncio.create_task(fetch_coro)
                consume_tasks = [
                    asyncio.create_task(downloader_consumer())
                    for _ in range(consumer_count)
                ]

                # 循环检查取消
                while not fetch_task.done():
                    if cancel_event.is_set():
                        fetch_task.cancel()
                        break
                    await asyncio.sleep(0.5)

                fetching_done.set()
                await asyncio.gather(*consume_tasks, return_exceptions=True)
                fetch_result = None
                if fetch_task.done() and not fetch_task.cancelled():
                    fetch_result = fetch_task.result()
                if isinstance(fetch_result, dict):
                    raise Exception(_api_message(fetch_result, '获取用户作品失败，请检查 Cookie 或稍后重试'))

                if cancel_event.is_set():
                    _task_store.set_status(task_id, 'cancelled')
                    _socketio.emit('download_cancelled', {'task_id': task_id, 'message': '下载任务已取消'})
                else:
                    _task_store.set_status(task_id, 'completed', end_time=datetime.now())
                    _socketio.emit('download_completed', {
                        'task_id': task_id,
                        'message': f'用户 {_nickname} 的作品全部处理完成',
                        'total_videos': max(total_videos, total_processed[0]),
                        'current_downloaded': total_processed[0],
                        'processed': total_processed[0],
                        'completed': total_processed[0],
                        'succeeded': total_succeeded[0],
                        'skipped': total_skipped[0],
                        'failed': total_failed[0],
                        'remaining': 0
                    })
            except asyncio.CancelledError:
                _task_store.set_status(task_id, 'cancelled')
                _socketio.emit('download_cancelled', {'task_id': task_id, 'message': '下载任务已取消'})
            except Exception as e:
                _logger.error(f"Task {task_id} error: {e}")
                _task_store.set_status(task_id, 'failed')
                _socketio.emit('download_failed', {'task_id': task_id, 'message': f'任务出错: {str(e)}'})
            finally:
                _task_store.pop_active(task_id)

        # 启动任务
        loop = _get_or_create_loop()
        future = asyncio.run_coroutine_threadsafe(do_download_task(), loop)
        _task_store.add_active(task_id, {
            "future": future,
            "event": cancel_event,
            "pause_event": pause_event
        })

        return jsonify({
            'success': True,
            'task_id': task_id,
            'message': '用户视频下载任务已开始',
            'nickname': nickname,
            'total_videos': aweme_count
        })

    except Exception as e:
        return jsonify({'success': False, 'message': f'下载失败: {str(e)}'}), 500


@downloads_bp.route('/api/cancel_download', methods=['POST'])
def cancel_download():
    """按任务ID取消下载"""
    data = _request_json()
    task_id = data.get('task_id')
    _logger.info(f"Request to cancel task: {task_id}")

    info = _task_store.get_active(task_id)
    if info is not None:
        # 设置取消事件
        info["event"].set()
        _task_store.set_status(task_id, 'cancelled')
        return jsonify({'success': True, 'message': '正在取消任务...'})

    if _task_store.get(task_id) is not None:
        _task_store.set_status(task_id, 'cancelled')
        return jsonify({'success': True, 'message': '任务已标记为取消'})

    return jsonify({'success': False, 'message': '未找到活跃任务'})


@downloads_bp.route('/api/pause_download', methods=['POST'])
def pause_download():
    """按任务ID暂停下载"""
    data = _request_json()
    task_id = data.get('task_id')
    _logger.info(f"Request to pause task: {task_id}")

    info = _task_store.get_active(task_id)
    if info is not None:
        if 'pause_event' in info:
            info['pause_event'].set()  # 设置暂停事件
            _task_store.set_status(task_id, 'paused')
            _socketio.emit('user_video_download_progress', {
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
    data = _request_json()
    task_id = data.get('task_id')
    _logger.info(f"Request to resume task: {task_id}")

    info = _task_store.get_active(task_id)
    if info is not None:
        if 'pause_event' in info:
            info['pause_event'].clear()  # 清除暂停事件
            _task_store.set_status(task_id, 'running')
            _socketio.emit('user_video_download_progress', {
                'task_id': task_id,
                'status': 'downloading',
                'message': '继续下载',
                'type': 'info'
            })
            return jsonify({'success': True, 'message': '任务已恢复'})
        else:
            return jsonify({'success': False, 'message': '该任务不支持恢复'})

    return jsonify({'success': False, 'message': '未找到活跃任务'})


@downloads_bp.route('/api/download_liked', methods=['POST'])
def download_liked():
    """下载点赞视频"""
    try:
        data = _request_json()
        count = _coerce_int(data.get('count'), 20, 1, 100)
        if not _Config.COOKIE:
            return jsonify({'success': False, 'message': '下载点赞视频需要设置Cookie'}), 400

        user_manager = _get_user_manager()
        if not user_manager:
            return jsonify({'success': False, 'message': '请先初始化'}), 400

        # 生成任务ID
        task_id = str(uuid.uuid4())
        _task_store.store(task_id, {
            'status': 'running',
            'type': 'liked_videos',
            'start_time': datetime.now()
        })

        # 在全局 Loop 中运行异步下载协程
        async def do_download_liked():
            try:
                _socketio.emit('download_started', {
                    'task_id': task_id,
                    'type': 'liked_videos'
                })

                completed = await user_manager.download_liked_videos(count)

                _task_store.set_status(task_id, 'completed', end_time=datetime.now())

                _socketio.emit('download_completed', {
                    'task_id': task_id,
                    'message': f'点赞视频下载完成，共处理 {completed} 个作品'
                })
            except Exception as e:
                _logger.error(f"Download liked error: {e}")
                _task_store.set_status(task_id, 'failed')
                _socketio.emit('download_failed', {'task_id': task_id, 'message': f'任务出错: {str(e)}'})

        loop = _get_or_create_loop()
        asyncio.run_coroutine_threadsafe(do_download_liked(), loop)

        return jsonify({
            'success': True,
            'task_id': task_id,
            'message': '点赞视频下载任务已开始'
        })

    except Exception as e:
        return jsonify({'success': False, 'message': f'下载失败: {str(e)}'}), 500


@downloads_bp.route('/api/download_liked_authors', methods=['POST'])
def download_liked_authors():
    """下载点赞作者作品"""
    try:
        data = _request_json()
        count = _coerce_int(data.get('count'), 20, 1, 100)
        selected_sec_uids = data.get('selected_sec_uids') or data.get('sec_uids') or []
        if not _Config.COOKIE:
            return jsonify({'success': False, 'message': '下载点赞作者作品需要设置Cookie'}), 400

        user_manager = _get_user_manager()
        if not user_manager:
            return jsonify({'success': False, 'message': '请先初始化'}), 400

        # 生成任务ID
        task_id = str(uuid.uuid4())
        _task_store.store(task_id, {
            'status': 'running',
            'type': 'liked_authors',
            'start_time': datetime.now()
        })

        # 在全局 Loop 中运行异步下载协程
        async def do_download_liked_authors():
            try:
                _socketio.emit('download_started', {
                    'task_id': task_id,
                    'type': 'liked_authors'
                })

                completed = await user_manager.download_liked_authors(count=count, selected_sec_uids=selected_sec_uids)

                _task_store.set_status(task_id, 'completed', end_time=datetime.now())

                _socketio.emit('download_completed', {
                    'task_id': task_id,
                    'message': f'点赞作者作品下载完成，共处理 {completed} 个作者'
                })
            except Exception as e:
                _logger.error(f"Download liked authors error: {e}")
                _task_store.set_status(task_id, 'failed')
                _socketio.emit('download_failed', {'task_id': task_id, 'message': f'任务出错: {str(e)}'})

        loop = _get_or_create_loop()
        asyncio.run_coroutine_threadsafe(do_download_liked_authors(), loop)

        return jsonify({
            'success': True,
            'task_id': task_id,
            'message': '点赞作者作品下载任务已开始'
        })

    except Exception as e:
        return jsonify({'success': False, 'message': f'下载失败: {str(e)}'}), 500


@downloads_bp.route('/api/download_video', methods=['POST'])
def download_video_by_aweme_id():
    """通过 aweme_id 下载视频"""
    try:
        data = _request_json()
        aweme_id = data.get('aweme_id', '').strip()

        if not aweme_id:
            return jsonify({'success': False, 'message': 'aweme_id 参数不能为空'}), 400

        user_manager = _get_user_manager()
        if not user_manager:
            return jsonify({'success': False, 'message': '请先初始化'}), 400

        # 使用统一的 API 接口获取视频详情
        detail = _run_async(user_manager.get_video_detail(aweme_id))

        if not detail:
            return jsonify({'success': False, 'message': '获取视频详情失败'}), 500

        # 获取媒体信息
        media_type = detail.get('media_type', 'video')
        media_urls = _normalize_download_media_urls(detail.get('media_urls', []), media_type)
        video_fallback_urls = user_manager.get_video_download_urls((detail.get('video') or {}))
        if media_type == 'video':
            selected_video_urls = _normalize_download_media_urls(
                user_manager._build_video_media_urls(detail.get('video') or {}),
                'video',
            )
            if selected_video_urls:
                media_urls = selected_video_urls

        if not media_urls:
            return jsonify({'success': False, 'message': '无法获取视频下载地址'}), 500

        # 生成文件名
        author_name = detail.get('author', {}).get('nickname', '未知作者')
        name = _build_download_name(
            author_name,
            detail.get('desc', ''),
            aweme_id,
            media_type=media_type,
            create_time=detail.get('create_time'),
            default_title_prefix='未知作品',
        )

        # 添加到下载队列
        task_id = str(uuid.uuid4())

        async def do_download():
            try:
                if len(media_urls) == 1 and media_urls[0].get('type') == 'video':
                    success = await asyncio.to_thread(
                        user_manager.downloader.download_video,
                        media_urls[0]['url'],
                        name,
                        aweme_id,
                        asyncio.Event(),
                        _socketio,
                        task_id,
                        None,
                        None,
                        False,
                        fallback_urls=video_fallback_urls,
                    )
                else:
                    success = await asyncio.to_thread(
                        user_manager.downloader.download_media_group,
                        media_urls,
                        name,
                        aweme_id,
                        _socketio,
                        task_id,
                        asyncio.Event(),
                        None,
                        None,
                        False,
                    )

                if success:
                    _socketio.emit('download_complete', {
                        'task_id': task_id,
                        'aweme_id': aweme_id,
                        'message': f'{name} 下载完成'
                    })
                else:
                    _socketio.emit('download_error', {
                        'task_id': task_id,
                        'aweme_id': aweme_id,
                        'message': f'{name} 下载失败'
                    })
            except Exception as e:
                _logger.error(f"下载视频失败: {e}")
                _socketio.emit('download_error', {
                    'task_id': task_id,
                    'aweme_id': aweme_id,
                    'message': f'下载失败: {str(e)}'
                })

        # 在后台线程执行下载
        loop = _get_or_create_loop()
        asyncio.run_coroutine_threadsafe(do_download(), loop)

        return jsonify({'success': True, 'task_id': task_id, 'message': '已添加到下载队列'})

    except Exception as e:
        _logger.exception(f"下载视频异常: {e}")
        return jsonify({'success': False, 'message': f'下载失败: {str(e)}'}), 500
