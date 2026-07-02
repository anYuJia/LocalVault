"""Async media download helpers for web download tasks."""
from __future__ import annotations

import asyncio
import os
import time
from datetime import datetime
from typing import Iterable

import aiohttp

from src.config.config import Config
from src.downloader.progress import PROGRESS_EMIT_INTERVAL_SECONDS
from src.downloader.downloader import _is_dash_video_only_url
from src.utils.download_history_index import remove_download_history_entries, upsert_download_history_entries
from src.utils.ssl_utils import aiohttp_ssl_context


def _response_size(headers) -> int:
    content_length = headers.get('Content-Length')
    if content_length and str(content_length).isdigit():
        return int(content_length)
    content_range = headers.get('Content-Range', '')
    if '/' in content_range:
        total = content_range.rsplit('/', 1)[-1]
        if total.isdigit():
            return int(total)
    return 0


class _HeaderResponse:
    def __init__(self, headers):
        self.headers = headers


async def _wait_if_paused(pause_event=None, cancel_event=None):
    if not pause_event:
        return
    while pause_event.is_set() and not (cancel_event and cancel_event.is_set()):
        await asyncio.sleep(0.2)


def _cancelled(cancel_event=None) -> bool:
    return bool(cancel_event and cancel_event.is_set())


async def _open_response(session: aiohttp.ClientSession, urls: Iterable[str], headers: dict):
    last_error = None
    for candidate_url in urls:
        candidate_url = str(candidate_url or '').strip()
        if not candidate_url or _is_dash_video_only_url(candidate_url):
            continue
        try:
            response = await session.get(candidate_url, headers=headers, timeout=aiohttp.ClientTimeout(sock_connect=10, sock_read=120))
            if response.status >= 400:
                text = await response.text()
                response.release()
                raise RuntimeError(f'HTTP {response.status}: {text[:120]}')
            return response, candidate_url
        except Exception as error:
            last_error = error
    raise last_error or RuntimeError('没有可用的下载地址')


async def download_video_async(
    downloader,
    url: str,
    name: str,
    aweme_id: str,
    *,
    cancel_event=None,
    socketio=None,
    task_id=None,
    progress_callback=None,
    pause_event=None,
    check_existing: bool = True,
    fallback_urls=None,
) -> bool:
    user_dir, filename = downloader._split_download_name(name)
    if check_existing and downloader._is_aweme_downloaded(aweme_id, user_dir):
        print(f"\033[93m作品已下载，跳过：{user_dir}/{filename}\033[0m")
        return True
    if _cancelled(cancel_event):
        return False

    headers = downloader._get_download_headers()
    candidate_urls = [url, *(fallback_urls or [])]
    response = None
    filepath = ''
    try:
        connector = aiohttp.TCPConnector(ssl=aiohttp_ssl_context())
        async with aiohttp.ClientSession(auto_decompress=False, connector=connector) as session:
            response, selected_url = await _open_response(session, candidate_urls, headers)
            response_size = _response_size(response.headers)
            file_started_at = time.monotonic()

            user_path = os.path.join(downloader.download_dir, user_dir)
            os.makedirs(user_path, exist_ok=True)
            extension = downloader._extension_for_media('video', selected_url, _HeaderResponse(response.headers))
            filepath = downloader._unique_filepath(user_path, filename, extension)

            downloader._emit_download_progress(
                socketio, task_id, progress_callback,
                progress=0,
                completed=0,
                total=1,
                status='downloading',
                file_index=1,
                file_total=1,
                file_progress=0,
                bytes_downloaded=0,
                bytes_total=response_size,
                speed_bps=0,
                eta_seconds=None,
                file_type='video',
                file_type_display='视频',
            )

            downloaded_size = 0
            last_emit_time = time.monotonic()
            with open(filepath, 'wb') as file:
                async for chunk in response.content.iter_chunked(Config.CHUNK_SIZE):
                    await _wait_if_paused(pause_event, cancel_event)
                    if _cancelled(cancel_event):
                        raise asyncio.CancelledError()
                    if not chunk:
                        continue
                    file.write(chunk)
                    downloaded_size += len(chunk)
                    now = time.monotonic()
                    elapsed = max(now - file_started_at, 0.001)
                    progress = (downloaded_size / response_size * 100) if response_size > 0 else 0
                    progress = min(100, max(0, progress))
                    speed_bps = downloaded_size / elapsed
                    eta_seconds = ((response_size - downloaded_size) / speed_bps) if response_size > 0 and speed_bps > 0 else None
                    if now - last_emit_time >= PROGRESS_EMIT_INTERVAL_SECONDS or (response_size > 0 and downloaded_size >= response_size):
                        downloader._emit_download_progress(
                            socketio, task_id, progress_callback,
                            progress=progress,
                            completed=0,
                            total=1,
                            status='downloading',
                            file_index=1,
                            file_total=1,
                            file_progress=progress,
                            bytes_downloaded=downloaded_size,
                            bytes_total=response_size,
                            speed_bps=speed_bps,
                            eta_seconds=eta_seconds,
                            file_type='video',
                            file_type_display='视频',
                        )
                        last_emit_time = now

            upsert_download_history_entries([filepath])
            print(f"\033[93m下载视频成功：{user_dir}/{os.path.basename(filepath)}\033[0m")
            final_size = os.path.getsize(filepath) if os.path.exists(filepath) else response_size
            elapsed = max(time.monotonic() - file_started_at, 0.001)
            downloader._emit_download_progress(
                socketio, task_id, progress_callback,
                progress=100,
                completed=1,
                total=1,
                status='completed',
                file_index=1,
                file_total=1,
                file_progress=100,
                bytes_downloaded=final_size,
                bytes_total=response_size or final_size,
                speed_bps=final_size / elapsed,
                eta_seconds=0,
                file_type='video',
                file_type_display='视频',
            )
            downloader._save_download_record(user_dir, aweme_id)
            return True
    except asyncio.CancelledError:
        if filepath and os.path.exists(filepath):
            os.remove(filepath)
            remove_download_history_entries([filepath])
        return False
    except Exception as error:
        print(f"\033[91m下载视频失败：{error}\033[0m")
        if filepath and os.path.exists(filepath):
            try:
                os.remove(filepath)
            except Exception:
                pass
        return False
    finally:
        if response is not None:
            response.release()


async def download_media_group_async(
    downloader,
    urls: list[dict],
    name: str,
    aweme_id: str | None = None,
    *,
    socketio=None,
    task_id=None,
    cancel_event=None,
    progress_callback=None,
    pause_event=None,
    check_existing: bool = True,
) -> bool:
    socketio = socketio or downloader.socketio
    user_dir, filename = downloader._split_download_name(name)
    if check_existing and aweme_id and downloader._is_aweme_downloaded(aweme_id, user_dir):
        print(f"\033[93m作品已下载，跳过：{user_dir}/{filename}\033[0m")
        return True
    if _cancelled(cancel_event):
        return False

    headers = downloader._get_download_headers()
    user_path = os.path.join(downloader.download_dir, user_dir)
    os.makedirs(user_path, exist_ok=True)
    media_types = {str(item.get('type') or '') for item in urls if isinstance(item, dict)}
    live_pair_count = min(
        sum(1 for item in urls if isinstance(item, dict) and item.get('type') == 'live_photo'),
        sum(1 for item in urls if isinstance(item, dict) and item.get('type') == 'image'),
    ) if media_types.issubset({'live_photo', 'image'}) else 0
    use_live_pair_stems = live_pair_count > 0
    live_pair_positions = {'live_photo': 0, 'image': 0}
    downloaded_files: list[str] = []

    try:
        connector = aiohttp.TCPConnector(ssl=aiohttp_ssl_context())
        async with aiohttp.ClientSession(auto_decompress=False, connector=connector) as session:
            for index, url_info in enumerate(urls):
                await _wait_if_paused(pause_event, cancel_event)
                if _cancelled(cancel_event):
                    raise asyncio.CancelledError()

                file_type = url_info['type']
                url = url_info['url']
                file_type_display = {
                    'video': '视频',
                    'image': '图片',
                    'live_photo': 'Live Photo',
                }.get(file_type, '文件')
                file_started_at = time.monotonic()
                media_count = len(urls)
                if socketio and task_id:
                    socketio.emit('download_log', {
                        'task_id': task_id,
                        'message': f'正在下载第 {index + 1}/{media_count} 个文件 ({file_type_display})',
                        'timestamp': datetime.now().strftime('%H:%M:%S'),
                    })

                response = None
                try:
                    candidate_urls = [url, *(url_info.get('fallback_urls') or [])]
                    response, selected_url = await _open_response(session, candidate_urls, headers)
                    response_size = _response_size(response.headers)

                    if use_live_pair_stems and file_type in live_pair_positions:
                        pair_index = live_pair_positions[file_type]
                        live_pair_positions[file_type] += 1
                        if live_pair_count > 1:
                            index_suffix = f"_{pair_index + 1:02d}"
                            protected_suffix = index_suffix
                            if aweme_id and filename.endswith(f"_{aweme_id}"):
                                protected_suffix = f"_{aweme_id}{index_suffix}"
                            filename_with_index = downloader._sanitize_filename(f"{filename}{index_suffix}", protected_suffix=protected_suffix)
                        else:
                            filename_with_index = downloader._sanitize_filename(filename)
                    elif media_count == 1:
                        filename_with_index = downloader._sanitize_filename(filename)
                    else:
                        index_suffix = f"_{index + 1:02d}"
                        protected_suffix = index_suffix
                        if aweme_id and filename.endswith(f"_{aweme_id}"):
                            protected_suffix = f"_{aweme_id}{index_suffix}"
                        filename_with_index = downloader._sanitize_filename(f"{filename}{index_suffix}", protected_suffix=protected_suffix)

                    extension = 'mp4' if use_live_pair_stems and file_type == 'live_photo' else downloader._extension_for_media(file_type, selected_url, _HeaderResponse(response.headers))
                    filepath = downloader._unique_filepath(user_path, filename_with_index, extension)
                    filename_with_index = os.path.splitext(os.path.basename(filepath))[0]
                    downloaded_files.append(filepath)

                    downloaded_size = 0
                    last_emit_time = time.monotonic()
                    with open(filepath, 'wb') as file:
                        async for chunk in response.content.iter_chunked(Config.CHUNK_SIZE):
                            await _wait_if_paused(pause_event, cancel_event)
                            if _cancelled(cancel_event):
                                raise asyncio.CancelledError()
                            if not chunk:
                                continue
                            file.write(chunk)
                            downloaded_size += len(chunk)
                            now = time.monotonic()
                            elapsed = max(now - file_started_at, 0.001)
                            file_progress = (downloaded_size / response_size * 100) if response_size > 0 else 0
                            file_progress = min(100, max(0, file_progress))
                            progress = ((index + file_progress / 100) / media_count) * 100
                            speed_bps = downloaded_size / elapsed
                            eta_seconds = ((response_size - downloaded_size) / speed_bps) if response_size > 0 and speed_bps > 0 else None
                            if now - last_emit_time >= PROGRESS_EMIT_INTERVAL_SECONDS or (response_size > 0 and downloaded_size >= response_size):
                                downloader._emit_download_progress(
                                    socketio, task_id, progress_callback,
                                    progress=progress,
                                    completed=index,
                                    total=media_count,
                                    status='downloading',
                                    file_index=index + 1,
                                    file_total=media_count,
                                    file_progress=file_progress,
                                    bytes_downloaded=downloaded_size,
                                    bytes_total=response_size,
                                    speed_bps=speed_bps,
                                    eta_seconds=eta_seconds,
                                    file_type=file_type,
                                    file_type_display=file_type_display,
                                )
                                last_emit_time = now

                    upsert_download_history_entries([filepath])
                    print(f"\033[93m下载{file_type_display} ({index + 1}/{media_count}) 成功：{user_dir}/{filename_with_index}.{extension}\033[0m")
                    downloader._emit_download_progress(
                        socketio, task_id, progress_callback,
                        progress=((index + 1) / media_count) * 100,
                        completed=index + 1,
                        total=media_count,
                        status='downloading',
                        file_index=index + 1,
                        file_total=media_count,
                        file_progress=100,
                        bytes_downloaded=os.path.getsize(filepath) if os.path.exists(filepath) else response_size,
                        bytes_total=response_size,
                        speed_bps=0,
                        eta_seconds=0,
                        file_type=file_type,
                        file_type_display=file_type_display,
                    )
                finally:
                    if response is not None:
                        response.release()

        if aweme_id:
            downloader._save_download_record(user_dir, aweme_id)
        return True
    except asyncio.CancelledError:
        for filepath in downloaded_files:
            if os.path.exists(filepath):
                os.remove(filepath)
        remove_download_history_entries(downloaded_files)
        return False
    except Exception as error:
        print(f"\033[91m下载失败：{error}\033[0m")
        for filepath in downloaded_files:
            if os.path.exists(filepath):
                try:
                    os.remove(filepath)
                except Exception:
                    pass
        remove_download_history_entries(downloaded_files)
        return False
