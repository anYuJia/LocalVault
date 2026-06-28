"""批量下载路由拆分模块。

从 downloads_routes.py 抽离的批量下载相关路由：下载点赞视频、下载点赞作者
作品、通过 aweme_id 下载视频。路由仍注册到同一个 downloads_bp Blueprint，
URL 不变；注入的依赖通过运行时读取 downloads_routes 模块属性获取，
避免循环导入与 setup 时序问题。
"""
from __future__ import annotations

import asyncio
import uuid
from datetime import datetime

from flask import jsonify

from src.web.downloads_routes import downloads_bp


def _deps():
    """延迟读取 downloads_routes 注入的依赖。"""
    from src.web import downloads_routes as dr
    return dr


@downloads_bp.route('/api/download_liked', methods=['POST'])
def download_liked():
    """下载点赞视频"""
    dr = _deps()
    try:
        data = dr._request_json()
        count = dr._coerce_int(data.get('count'), 20, 1, 100)
        if not dr._Config.COOKIE:
            return jsonify({'success': False, 'message': '下载点赞视频需要设置Cookie'}), 400

        user_manager = dr._get_user_manager()
        if not user_manager:
            return jsonify({'success': False, 'message': '请先初始化'}), 400

        # 生成任务ID
        task_id = str(uuid.uuid4())
        dr._task_store.store(task_id, {
            'status': 'running',
            'type': 'liked_videos',
            'start_time': datetime.now()
        })

        # 在全局 Loop 中运行异步下载协程
        async def do_download_liked():
            try:
                dr._socketio.emit('download_started', {
                    'task_id': task_id,
                    'type': 'liked_videos'
                })

                completed = await user_manager.download_liked_videos(count)

                dr._task_store.set_status(task_id, 'completed', end_time=datetime.now())

                dr._socketio.emit('download_completed', {
                    'task_id': task_id,
                    'message': f'点赞视频下载完成，共处理 {completed} 个作品'
                })
            except Exception as e:
                dr._logger.error(f"Download liked error: {e}")
                dr._task_store.set_status(task_id, 'failed')
                dr._socketio.emit('download_failed', {'task_id': task_id, 'message': f'任务出错: {str(e)}'})

        loop = dr._get_or_create_loop()
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
    dr = _deps()
    try:
        data = dr._request_json()
        count = dr._coerce_int(data.get('count'), 20, 1, 100)
        selected_sec_uids = data.get('selected_sec_uids') or data.get('sec_uids') or []
        if not dr._Config.COOKIE:
            return jsonify({'success': False, 'message': '下载点赞作者作品需要设置Cookie'}), 400

        user_manager = dr._get_user_manager()
        if not user_manager:
            return jsonify({'success': False, 'message': '请先初始化'}), 400

        # 生成任务ID
        task_id = str(uuid.uuid4())
        dr._task_store.store(task_id, {
            'status': 'running',
            'type': 'liked_authors',
            'start_time': datetime.now()
        })

        # 在全局 Loop 中运行异步下载协程
        async def do_download_liked_authors():
            try:
                dr._socketio.emit('download_started', {
                    'task_id': task_id,
                    'type': 'liked_authors'
                })

                completed = await user_manager.download_liked_authors(count=count, selected_sec_uids=selected_sec_uids)

                dr._task_store.set_status(task_id, 'completed', end_time=datetime.now())

                dr._socketio.emit('download_completed', {
                    'task_id': task_id,
                    'message': f'点赞作者作品下载完成，共处理 {completed} 个作者'
                })
            except Exception as e:
                dr._logger.error(f"Download liked authors error: {e}")
                dr._task_store.set_status(task_id, 'failed')
                dr._socketio.emit('download_failed', {'task_id': task_id, 'message': f'任务出错: {str(e)}'})

        loop = dr._get_or_create_loop()
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
    dr = _deps()
    try:
        data = dr._request_json()
        aweme_id = data.get('aweme_id', '').strip()

        if not aweme_id:
            return jsonify({'success': False, 'message': 'aweme_id 参数不能为空'}), 400

        user_manager = dr._get_user_manager()
        if not user_manager:
            return jsonify({'success': False, 'message': '请先初始化'}), 400

        # 使用统一的 API 接口获取视频详情
        detail = dr._run_async(user_manager.get_video_detail(aweme_id))

        if not detail:
            return jsonify({'success': False, 'message': '获取视频详情失败'}), 500

        # 获取媒体信息
        media_type = detail.get('media_type', 'video')
        media_urls = dr._normalize_download_media_urls(detail.get('media_urls', []), media_type)
        video_fallback_urls = user_manager.get_video_download_urls((detail.get('video') or {}))
        if media_type == 'video':
            selected_video_urls = dr._normalize_download_media_urls(
                user_manager._build_video_media_urls(detail.get('video') or {}),
                'video',
            )
            if selected_video_urls:
                media_urls = selected_video_urls

        if not media_urls:
            return jsonify({'success': False, 'message': '无法获取视频下载地址'}), 500

        # 生成文件名
        author_name = detail.get('author', {}).get('nickname', '未知作者')
        name = dr._build_download_name(
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
                        dr._socketio,
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
                        dr._socketio,
                        task_id,
                        asyncio.Event(),
                        None,
                        None,
                        False,
                    )

                if success:
                    dr._socketio.emit('download_complete', {
                        'task_id': task_id,
                        'aweme_id': aweme_id,
                        'message': f'{name} 下载完成'
                    })
                else:
                    dr._socketio.emit('download_error', {
                        'task_id': task_id,
                        'aweme_id': aweme_id,
                        'message': f'{name} 下载失败'
                    })
            except Exception as e:
                dr._logger.error(f"下载视频失败: {e}")
                dr._socketio.emit('download_error', {
                    'task_id': task_id,
                    'aweme_id': aweme_id,
                    'message': f'下载失败: {str(e)}'
                })

        # 在后台线程执行下载
        loop = dr._get_or_create_loop()
        asyncio.run_coroutine_threadsafe(do_download(), loop)

        return jsonify({'success': True, 'task_id': task_id, 'message': '已添加到下载队列'})

    except Exception as e:
        dr._logger.exception(f"下载视频异常: {e}")
        return jsonify({'success': False, 'message': f'下载失败: {str(e)}'}), 500


@downloads_bp.route('/api/download_videos', methods=['POST'])
def download_videos():
    """批量下载指定的视频列表，支持WebSocket进度反馈"""
    import time
    from src.web.download_task_store import ThreadPauseEvent
    dr = _deps()
    try:
        data = dr._request_json()
        videos = data.get('videos', [])
        name = data.get('name', '').strip() or '批量下载'

        if not videos:
            return jsonify({'success': False, 'message': '视频列表不能为空'}), 400

        user_manager = dr._get_user_manager()
        if not user_manager:
            return jsonify({'success': False, 'message': '请先设置Cookie'}), 400

        # 生成任务ID
        task_id = str(uuid.uuid4())
        cancel_event = asyncio.Event()
        pause_event = asyncio.Event()

        display_name = f'{name} 全部作品' if name else '批量下载'
        dr._task_store.store(task_id, {
            'status': 'running',
            'title': display_name,
            'filename': display_name,
            'display_name': display_name,
            'isBatch': True,
            'total_videos': len(videos),
            'current_downloaded': 0,
            'processed': 0,
            'progress': 0,
            'overall_progress': 0,
            'start_time': datetime.now()
        })

        # 在全局 Loop 中运行异步下载协程
        async def do_download_task():
            try:
                # 发送开始信号
                dr._socketio.emit('download_started', {
                    'task_id': task_id,
                    'nickname': name,
                    'user': name,
                    'total_videos': len(videos),
                    'message': f'开始下载 {name} 的 {len(videos)} 个作品'
                })

                total_videos = len(videos)
                total_processed = 0
                total_succeeded = 0
                total_skipped = 0
                total_failed = 0
                batch_started_at = time.monotonic()

                def update_task_snapshot(**fields):
                    dr._task_store.update_fields(task_id, **fields)

                def emit_batch_progress(**payload):
                    dr._socketio.emit('user_video_download_progress', payload)
                    current_task = dr._task_store.get(task_id)
                    update_task_snapshot(
                        status=payload.get('status') or (current_task or {}).get('status', 'running'),
                        progress=payload.get('overall_progress'),
                        overall_progress=payload.get('overall_progress'),
                        processed=payload.get('processed'),
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
                dr._socketio.emit('download_info', {
                    'task_id': task_id,
                    'total_videos': total_videos,
                    'current_downloaded': 0,
                    'processed': 0,
                    'overall_progress': 0,
                    'remaining': total_videos,
                    'message': f'准备开始下载，共发现 {total_videos} 个作品'
                })

                # 开始下载列表中的每一个作品
                for idx, video_val in enumerate(videos):
                    if cancel_event.is_set():
                        break

                    aweme_id = video_val.get('aweme_id', '').strip()
                    desc = video_val.get('desc', '').strip() or '未知作品'
                    author_name = video_val.get('author_name', '').strip() or '未知作者'
                    media_urls = video_val.get('media_urls', [])
                    raw_media_type = video_val.get('media_type', 'video')

                    # 规范化下载名
                    video_name = dr._build_download_name(
                        author_name,
                        desc,
                        aweme_id,
                        media_type=raw_media_type,
                        create_time=video_val.get('create_time'),
                        default_title_prefix='未知作品'
                    )

                    try:
                        media_urls = dr._normalize_download_media_urls(media_urls, raw_media_type)
                        video_fallback_urls = []
                        payload_video_data = video_val.get('video') if isinstance(video_val.get('video'), dict) else {}

                        should_refresh_video_media = (
                            raw_media_type == 'video'
                            or (raw_media_type not in ('image', 'live_photo', 'mixed') and any(item.get('type') == 'video' for item in media_urls))
                            or not media_urls
                        )
                        if should_refresh_video_media and payload_video_data:
                            payload_video_urls = user_manager._build_video_media_urls(payload_video_data)
                            if payload_video_urls:
                                media_urls = dr._normalize_download_media_urls(payload_video_urls, 'video')
                                raw_media_type = 'video'
                                video_fallback_urls = user_manager.get_video_download_urls(payload_video_data)

                        if should_refresh_video_media and aweme_id:
                            detail = dr._run_async(user_manager.get_video_detail(aweme_id))
                            if detail and not isinstance(detail, dict) or (isinstance(detail, dict) and not detail.get('_need_verify') and not detail.get('_need_login')):
                                detail_media_type = detail.get('raw_media_type') or detail.get('media_type') or raw_media_type
                                detail_media_urls = dr._normalize_download_media_urls(detail.get('media_urls', []), detail_media_type)
                                if detail_media_urls:
                                    media_urls = detail_media_urls
                                    raw_media_type = detail_media_type
                                if detail_media_type == 'video':
                                    detail_video_urls = dr._normalize_download_media_urls(user_manager._build_video_media_urls(detail.get('video') or {}), 'video')
                                    if detail_video_urls:
                                        media_urls = detail_video_urls
                                    video_fallback_urls = user_manager.get_video_download_urls(detail.get('video') or {})

                        if not media_urls:
                            raise Exception("没有可用的媒体URL")

                        # 检查本地是否已下载
                        from src.web.download_tasks import _check_local_exists
                        local_files, file_size = _check_local_exists(user_manager, aweme_id)
                        if local_files:
                            total_skipped += 1
                            total_processed += 1
                            progress_pct = int((total_processed / total_videos) * 100)
                            emit_batch_progress(
                                task_id=task_id,
                                overall_progress=progress_pct,
                                current_downloaded=total_processed,
                                total_videos=total_videos,
                                processed=total_processed,
                                succeeded=total_succeeded,
                                skipped=total_skipped,
                                failed=total_failed,
                                remaining=total_videos - total_processed,
                                eta_seconds=estimate_batch_eta(total_processed, total_videos),
                                status='running',
                                message=f'跳过已存在 ({total_processed}/{total_videos}): {video_name[:10]}'
                            )
                            continue

                        # 开始下载单个作品
                        if len(media_urls) == 1 and media_urls[0].get('type') == 'video':
                            success = await asyncio.to_thread(
                                user_manager.downloader.download_video,
                                media_urls[0]['url'],
                                video_name,
                                aweme_id,
                                cancel_event,
                                None,
                                None,
                                None,
                                pause_control,
                                False,
                                fallback_urls=video_fallback_urls,
                            )
                        else:
                            success = await asyncio.to_thread(
                                user_manager.downloader.download_media_group,
                                media_urls,
                                video_name,
                                aweme_id,
                                None,
                                None,
                                cancel_event,
                                None,
                                pause_control,
                                False,
                            )

                        if success:
                            total_succeeded += 1
                        else:
                            total_failed += 1

                    except Exception as ex:
                        dr._logger.error(f"Download single video {aweme_id} in batch failed: {ex}")
                        total_failed += 1

                    total_processed += 1
                    progress_pct = int((total_processed / total_videos) * 100)
                    emit_batch_progress(
                        task_id=task_id,
                        overall_progress=progress_pct,
                        current_downloaded=total_processed,
                        total_videos=total_videos,
                        processed=total_processed,
                        succeeded=total_succeeded,
                        skipped=total_skipped,
                        failed=total_failed,
                        remaining=total_videos - total_processed,
                        eta_seconds=estimate_batch_eta(total_processed, total_videos),
                        status='running',
                        message=f'完成 ({total_processed}/{total_videos}): {video_name[:10]}'
                    )

                # 下载结束
                if cancel_event.is_set():
                    dr._task_store.set_status(task_id, 'cancelled', end_time=datetime.now())
                    dr._socketio.emit('download_cancelled', {
                        'task_id': task_id,
                        'message': f'下载已取消，已完成 {total_succeeded} 个视频'
                    })
                else:
                    dr._task_store.set_status(task_id, 'completed', end_time=datetime.now())
                    dr._socketio.emit('download_completed', {
                        'task_id': task_id,
                        'total_videos': total_videos,
                        'completed': total_processed,
                        'succeeded': total_succeeded,
                        'skipped': total_skipped,
                        'failed': total_failed,
                        'processed': total_processed,
                        'message': f'下载完成: {total_succeeded} 个成功, {total_skipped} 个跳过, {total_failed} 个失败'
                    })

            except Exception as e:
                dr._logger.error(f"Batch download route task error: {e}")
                dr._task_store.set_status(task_id, 'failed')
                dr._socketio.emit('download_failed', {'task_id': task_id, 'message': f'任务出错: {str(e)}'})
            finally:
                dr._task_store.pop_active(task_id)

        # 启动任务
        loop = dr._get_or_create_loop()
        future = asyncio.run_coroutine_threadsafe(do_download_task(), loop)
        dr._task_store.add_active(task_id, {
            "future": future,
            "event": cancel_event,
            "pause_event": pause_event
        })

        return jsonify({
            'success': True,
            'task_id': task_id,
            'message': f'开始批量下载 {len(videos)} 个视频',
            'nickname': name,
            'total_videos': len(videos)
        })

    except Exception as e:
        return jsonify({'success': False, 'message': f'批量下载启动失败: {str(e)}'}), 500
