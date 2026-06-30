"""媒体代理相关路由（/api/media/proxy、/api/debug/seek、/api/download_music）。

从 web_app.py 抽离。模块内部依赖通过 setup 注入，
外部调用方（web_app.py）需要在导入本模块后调用 setup_media_proxy(...)。
"""
from __future__ import annotations

import time
from collections import OrderedDict
from typing import Any, Callable

import requests as http_requests
from requests.adapters import HTTPAdapter
from flask import Blueprint, Response, request

media_proxy_bp = Blueprint("media_proxy", __name__)

_MEDIA_PROXY_RANGE_CACHE_MAX_ENTRIES = 96
_MEDIA_PROXY_RANGE_CACHE_MAX_BYTES = 4 * 1024 * 1024
_MEDIA_PROXY_RANGE_CACHE: OrderedDict[tuple[str, str, str], tuple[int, dict, bytes]] = OrderedDict()
_MEDIA_PROXY_IMAGE_CACHE_MAX_ENTRIES = 384
_MEDIA_PROXY_IMAGE_CACHE_MAX_BYTES = 2 * 1024 * 1024
_MEDIA_PROXY_IMAGE_CACHE: OrderedDict[str, tuple[int, dict, bytes]] = OrderedDict()
_MEDIA_PROXY_SESSION = http_requests.Session()
_MEDIA_PROXY_ADAPTER = HTTPAdapter(pool_connections=64, pool_maxsize=64, max_retries=0)
_MEDIA_PROXY_SESSION.mount('https://', _MEDIA_PROXY_ADAPTER)
_MEDIA_PROXY_SESSION.mount('http://', _MEDIA_PROXY_ADAPTER)

# 注入的依赖
_logger = None
_sanitize_download_filename: Callable[..., str] | None = None
_allowed_media_request_origin: Callable[[], tuple[bool, str | None]] | None = None
_is_allowed_media_url: Callable[[str], bool] | None = None
_cap_media_range_header: Callable[[str, str], str] | None = None
_MEDIA_PROXY_REDIRECT_CACHE: dict | None = None
_MEDIA_PROXY_MAX_RETRIES: int = 3
_media_url_label: Callable[[str], str] | None = None
_should_forward_douyin_cookie: Callable[[str], bool] | None = None
_resolve_media_redirect_target: Callable[[str, str], str | None] | None = None
_remember_media_redirect: Callable[[str | None, str], None] | None = None
_guess_audio_content_type: Callable[..., str] | None = None
_build_content_disposition: Callable[..., str | None] | None = None
_guess_image_content_type_from_bytes: Callable[[bytes], str] | None = None
_guess_audio_extension: Callable[[str, str], str] | None = None


def setup_media_proxy(
    *,
    logger,
    sanitize_download_filename: Callable[..., str],
    allowed_media_request_origin: Callable[[], tuple[bool, str | None]],
    is_allowed_media_url: Callable[[str], bool],
    cap_media_range_header: Callable[[str, str], str],
    media_proxy_redirect_cache: dict,
    media_proxy_max_retries: int,
    media_url_label: Callable[[str], str],
    should_forward_douyin_cookie: Callable[[str], bool],
    resolve_media_redirect_target: Callable[[str, str], str | None],
    remember_media_redirect: Callable[[str | None, str], None],
    guess_audio_content_type: Callable[..., str],
    build_content_disposition: Callable[..., str | None],
    guess_image_content_type_from_bytes: Callable[[bytes], str],
    guess_audio_extension: Callable[[str, str], str],
) -> None:
    """注入 web_app 模块的全局对象，避免循环导入。"""
    global _logger, _sanitize_download_filename, _allowed_media_request_origin
    global _is_allowed_media_url, _cap_media_range_header, _MEDIA_PROXY_REDIRECT_CACHE
    global _MEDIA_PROXY_MAX_RETRIES, _media_url_label, _should_forward_douyin_cookie
    global _resolve_media_redirect_target, _remember_media_redirect
    global _guess_audio_content_type, _build_content_disposition
    global _guess_image_content_type_from_bytes, _guess_audio_extension
    _logger = logger
    _sanitize_download_filename = sanitize_download_filename
    _allowed_media_request_origin = allowed_media_request_origin
    _is_allowed_media_url = is_allowed_media_url
    _cap_media_range_header = cap_media_range_header
    _MEDIA_PROXY_REDIRECT_CACHE = media_proxy_redirect_cache
    _MEDIA_PROXY_MAX_RETRIES = media_proxy_max_retries
    _media_url_label = media_url_label
    _should_forward_douyin_cookie = should_forward_douyin_cookie
    _resolve_media_redirect_target = resolve_media_redirect_target
    _remember_media_redirect = remember_media_redirect
    _guess_audio_content_type = guess_audio_content_type
    _build_content_disposition = build_content_disposition
    _guess_image_content_type_from_bytes = guess_image_content_type_from_bytes
    _guess_audio_extension = guess_audio_extension


def _range_cache_key(original_url: str, upstream_url: str, range_value: str | None, media_type: str) -> tuple[str, str, str] | None:
    if media_type not in ('audio', 'video') or not range_value:
        return None
    return (upstream_url or original_url, range_value, media_type)


def _get_range_cache(key: tuple[str, str, str] | None):
    if key is None:
        return None
    cached = _MEDIA_PROXY_RANGE_CACHE.get(key)
    if cached is None:
        return None
    _MEDIA_PROXY_RANGE_CACHE.move_to_end(key)
    return cached


def _remember_range_cache(key: tuple[str, str, str] | None, status_code: int, headers: dict, body: bytes) -> None:
    if key is None or status_code != 206 or not body or len(body) > _MEDIA_PROXY_RANGE_CACHE_MAX_BYTES:
        return
    _MEDIA_PROXY_RANGE_CACHE[key] = (status_code, dict(headers), body)
    _MEDIA_PROXY_RANGE_CACHE.move_to_end(key)
    while len(_MEDIA_PROXY_RANGE_CACHE) > _MEDIA_PROXY_RANGE_CACHE_MAX_ENTRIES:
        _MEDIA_PROXY_RANGE_CACHE.popitem(last=False)


def _get_image_cache(key: str | None):
    if not key:
        return None
    cached = _MEDIA_PROXY_IMAGE_CACHE.get(key)
    if cached is None:
        return None
    _MEDIA_PROXY_IMAGE_CACHE.move_to_end(key)
    return cached


def _remember_image_cache(key: str | None, status_code: int, headers: dict, body: bytes) -> None:
    if not key or status_code != 200 or not body or len(body) > _MEDIA_PROXY_IMAGE_CACHE_MAX_BYTES:
        return
    _MEDIA_PROXY_IMAGE_CACHE[key] = (status_code, dict(headers), body)
    _MEDIA_PROXY_IMAGE_CACHE.move_to_end(key)
    while len(_MEDIA_PROXY_IMAGE_CACHE) > _MEDIA_PROXY_IMAGE_CACHE_MAX_ENTRIES:
        _MEDIA_PROXY_IMAGE_CACHE.popitem(last=False)


@media_proxy_bp.route('/api/media/proxy')
def media_proxy():
    """代理抖音媒体资源，限制来源并安全处理重定向。"""

    url = request.args.get('url', '').strip()
    requested_filename = _sanitize_download_filename(request.args.get('filename', '').strip(), default='')
    requested_media_type = request.args.get('media_type', '').strip().lower()
    image_skey = request.args.get('skey', '').strip()
    allow_origin, origin_value = _allowed_media_request_origin()

    if not allow_origin:
        return 'Forbidden', 403
    if not _is_allowed_media_url(url):
        return 'Invalid URL', 400

    request_range = request.headers.get('Range')
    request_range_str = request_range or ''
    should_seed_video_range = False
    upstream_range_value = _cap_media_range_header(request_range, requested_media_type)
    cache_key = url if '/aweme/v1/play/' in url else None
    upstream_url = _MEDIA_PROXY_REDIRECT_CACHE.get(cache_key, url) if cache_key else url
    upstream_label = _media_url_label(upstream_url)
    image_cache_key = url if requested_media_type == 'image' and not image_skey else None
    cached_image = _get_image_cache(image_cache_key)
    if cached_image is not None:
        status_code, cached_headers, cached_body = cached_image
        headers = dict(cached_headers)
        headers['Access-Control-Allow-Origin'] = origin_value or '*'
        headers['Cache-Control'] = 'public, max-age=3600'
        return Response(cached_body, status=status_code, headers=headers)
    range_cache_key = _range_cache_key(url, upstream_url, upstream_range_value, requested_media_type)
    cached_range = _get_range_cache(range_cache_key)
    if cached_range is not None:
        status_code, cached_headers, cached_body = cached_range
        headers = dict(cached_headers)
        headers['Access-Control-Allow-Origin'] = origin_value or '*'
        headers['Cache-Control'] = 'public, max-age=3600'
        return Response(cached_body, status=status_code, headers=headers)

    retry_count = 0
    redirect_hops = 0
    start_time = time.time()
    resp = None

    try:
        while True:
            if not _is_allowed_media_url(upstream_url):
                if cache_key:
                    _MEDIA_PROXY_REDIRECT_CACHE.pop(cache_key, None)
                return 'Invalid URL', 400
            upstream_label = _media_url_label(upstream_url)

            headers = {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
                'Referer': 'https://www.douyin.com/',
                'Accept': '*/*',
                'Accept-Encoding': 'identity;q=1, *;q=0',
            }

            if _should_forward_douyin_cookie(upstream_url):
                from src.web import web_app
                if web_app.api and web_app.api.cookie:
                    headers['Cookie'] = web_app.api.cookie
            if upstream_range_value:
                headers['Range'] = upstream_range_value

            try:
                resp = _MEDIA_PROXY_SESSION.get(
                    upstream_url,
                    headers=headers,
                    stream=True,
                    timeout=(6, 8) if requested_media_type == 'image' else (10, 45),
                    allow_redirects=False,
                )
            except Exception as e:
                if retry_count < _MEDIA_PROXY_MAX_RETRIES:
                    retry_count += 1
                    _logger.warning(
                        '[media_proxy] 网络错误，准备重试 %s/%s: url=%s error=%s',
                        retry_count,
                        _MEDIA_PROXY_MAX_RETRIES,
                        upstream_label,
                        e,
                    )
                    time.sleep(0.5 * retry_count)
                    continue

                if cache_key:
                    _MEDIA_PROXY_REDIRECT_CACHE.pop(cache_key, None)
                _logger.error(
                    '[media_proxy] 请求失败, elapsed=%sms seeded_range=%s range="%s" url=%s error=%s',
                    int((time.time() - start_time) * 1000),
                    should_seed_video_range,
                    request_range_str,
                    upstream_label,
                    e,
                )
                return 'Proxy error', 502

            if 300 <= resp.status_code < 400:
                location = resp.headers.get('Location', '')
                next_url = _resolve_media_redirect_target(resp.url, location)
                resp.close()

                if not location or redirect_hops >= 4 or not next_url or not _is_allowed_media_url(next_url):
                    if cache_key:
                        _MEDIA_PROXY_REDIRECT_CACHE.pop(cache_key, None)
                    return 'Invalid redirect URL', 400

                redirect_hops += 1
                upstream_url = next_url
                continue

            if 500 <= resp.status_code < 600 and retry_count < _MEDIA_PROXY_MAX_RETRIES:
                retry_count += 1
                _logger.warning(
                    '[media_proxy] 上游服务错误，准备重试 %s/%s: status=%s url=%s',
                    retry_count,
                    _MEDIA_PROXY_MAX_RETRIES,
                    resp.status_code,
                    upstream_label,
                )
                resp.close()
                time.sleep(0.5 * retry_count)
                continue

            break

        if cache_key and upstream_url != url:
            _remember_media_redirect(cache_key, upstream_url)

        range_cache_key = _range_cache_key(url, upstream_url, upstream_range_value, requested_media_type)
        cached_range = _get_range_cache(range_cache_key)
        if cached_range is not None:
            status_code, cached_headers, cached_body = cached_range
            headers = dict(cached_headers)
            headers['Access-Control-Allow-Origin'] = origin_value or '*'
            headers['Cache-Control'] = 'public, max-age=3600'
            resp.close()
            return Response(cached_body, status=status_code, headers=headers)

        _logger.debug(
            '[media_proxy] 上游响应耗时 %.2fs, status=%s, seeded_range=%s, range="%s", url=%s',
            time.time() - start_time,
            resp.status_code,
            should_seed_video_range,
            request_range_str,
            upstream_label,
        )

        resp_headers = {}
        for key in ['Content-Type', 'Content-Range', 'Accept-Ranges']:
            if key in resp.headers:
                resp_headers[key] = resp.headers[key]

        upstream_content_type = resp.headers.get('Content-Type', '')
        normalized_content_type = upstream_content_type.split(';', 1)[0].strip().lower() if upstream_content_type else ''
        content_length = resp.headers.get('Content-Length', '')
        if content_length:
            resp_headers['Content-Length'] = content_length

        inferred_name = requested_filename or upstream_url
        if requested_media_type == 'audio':
            resp_headers['Content-Type'] = _guess_audio_content_type(inferred_name, normalized_content_type)
        elif not normalized_content_type or normalized_content_type == 'application/octet-stream':
            if '.mp4' in upstream_url or '/play/' in upstream_url or requested_media_type == 'video':
                resp_headers['Content-Type'] = 'video/mp4'
            elif '.jpg' in upstream_url or '.jpeg' in upstream_url:
                resp_headers['Content-Type'] = 'image/jpeg'
            elif '.png' in upstream_url:
                resp_headers['Content-Type'] = 'image/png'
            elif '.webp' in upstream_url:
                resp_headers['Content-Type'] = 'image/webp'

        if requested_media_type in ('audio', 'video') and 'Accept-Ranges' not in resp_headers:
            resp_headers['Accept-Ranges'] = 'bytes'

        content_disposition = _build_content_disposition(requested_filename, 'inline')
        if content_disposition:
            resp_headers['Content-Disposition'] = content_disposition

        resp_headers['Access-Control-Allow-Origin'] = origin_value or '*'
        resp_headers['Cache-Control'] = 'public, max-age=3600'

        if requested_media_type == 'image' and image_skey:
            try:
                from cryptography.hazmat.primitives.ciphers.aead import AESGCM
                encrypted = resp.content
                resp.close()
                key = bytes.fromhex(image_skey)
                if len(key) != 32 or len(encrypted) <= 28:
                    raise ValueError('invalid encrypted image payload')
                decrypted = AESGCM(key).decrypt(encrypted[:12], encrypted[12:], None)
                decrypted_headers = {
                    'Content-Type': _guess_image_content_type_from_bytes(decrypted),
                    'Content-Length': str(len(decrypted)),
                    'Access-Control-Allow-Origin': origin_value or '*',
                    'Cache-Control': 'public, max-age=3600',
                }
                if content_disposition:
                    decrypted_headers['Content-Disposition'] = content_disposition
                return Response(decrypted, status=resp.status_code, headers=decrypted_headers)
            except Exception as decrypt_error:
                _logger.warning(
                    '[media_proxy] 图片解密失败，将返回原始响应: url=%s error=%s',
                    upstream_label,
                    decrypt_error,
                )

        should_cache_image = (
            image_cache_key is not None
            and resp.status_code == 200
            and (int(content_length) if str(content_length or '').isdigit() else _MEDIA_PROXY_IMAGE_CACHE_MAX_BYTES + 1) <= _MEDIA_PROXY_IMAGE_CACHE_MAX_BYTES
        )
        if should_cache_image:
            try:
                body = resp.content
                resp.close()
                _remember_image_cache(image_cache_key, resp.status_code, resp_headers, body)
                return Response(body, status=resp.status_code, headers=resp_headers)
            except Exception as cache_error:
                _logger.debug('[media_proxy] 图片缓存读取失败，将改用流式转发: %s', cache_error)

        should_cache_range = (
            range_cache_key is not None
            and resp.status_code == 206
            and (int(content_length) if str(content_length or '').isdigit() else _MEDIA_PROXY_RANGE_CACHE_MAX_BYTES + 1) <= _MEDIA_PROXY_RANGE_CACHE_MAX_BYTES
        )

        if should_cache_range:
            try:
                body = resp.content
                resp.close()
                _remember_range_cache(range_cache_key, resp.status_code, resp_headers, body)
                return Response(body, status=resp.status_code, headers=resp_headers)
            except Exception as cache_error:
                _logger.debug('[media_proxy] range缓存读取失败，将改用流式转发: %s', cache_error)

        def generate():
            total = 0
            stream_start = time.time()
            try:
                for chunk in resp.iter_content(chunk_size=65536):
                    if chunk:
                        total += len(chunk)
                        yield chunk
            finally:
                try:
                    resp.close()
                except Exception:
                    pass
                _logger.debug(
                    '[media_proxy] 传输完成, 共 %.2fMB, 耗时 %.2fs, url=%s',
                    total / 1048576,
                    time.time() - stream_start,
                    upstream_label,
                )

        return Response(generate(), status=resp.status_code, headers=resp_headers)

    except Exception as e:
        _logger.error(f"[media_proxy] Proxy error: {e}")
        if resp is not None:
            try:
                resp.close()
            except Exception:
                pass
        return f'Proxy error: {str(e)}', 502


@media_proxy_bp.route('/api/debug/seek')
def debug_seek():
    _logger.info(
        '[player_seek] phase=%s target=%s before=%s after=%s duration=%s ready_state=%s network_state=%s paused=%s src=%s',
        request.args.get('phase', ''),
        request.args.get('target', ''),
        request.args.get('before', ''),
        request.args.get('after', ''),
        request.args.get('duration', ''),
        request.args.get('ready_state', ''),
        request.args.get('network_state', ''),
        request.args.get('paused', ''),
        request.args.get('src', '')[:160],
    )
    return 'ok'


@media_proxy_bp.route('/api/download_music')
def download_music():
    """代理下载音乐，并显式设置文件名。"""
    url = request.args.get('url', '').strip()
    requested_filename = request.args.get('filename', '').strip()
    allow_origin, origin_value = _allowed_media_request_origin()

    if not allow_origin:
        return 'Forbidden', 403
    if not _is_allowed_media_url(url):
        return 'Invalid URL', 400

    resp = None
    try:
        upstream_url = url
        redirect_hops = 0
        while True:
            if not _is_allowed_media_url(upstream_url):
                return 'Invalid URL', 400

            headers = {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
                'Referer': 'https://www.douyin.com/',
                'Accept': '*/*',
                'Accept-Encoding': 'identity;q=1, *;q=0',
            }

            if _should_forward_douyin_cookie(upstream_url):
                from src.web import web_app
                if web_app.api and web_app.api.cookie:
                    headers['Cookie'] = web_app.api.cookie

            resp = http_requests.get(
                upstream_url,
                headers=headers,
                stream=True,
                timeout=(10, 120),
                allow_redirects=False,
            )

            if 300 <= resp.status_code < 400:
                location = resp.headers.get('Location', '')
                next_url = _resolve_media_redirect_target(resp.url, location)
                resp.close()
                resp = None

                if not location or redirect_hops >= 4 or not next_url or not _is_allowed_media_url(next_url):
                    return 'Invalid redirect URL', 400

                redirect_hops += 1
                upstream_url = next_url
                continue

            resp.raise_for_status()
            break

        content_type = (resp.headers.get('Content-Type') or 'audio/mpeg').split(';', 1)[0].strip()
        filename = _sanitize_download_filename(requested_filename)
        extension = _guess_audio_extension(upstream_url, content_type)
        if not filename.lower().endswith(('.mp3', '.m4a', '.aac', '.wav', '.ogg')):
            filename = f'{filename}{extension}'

        resp_headers = {
            'Content-Type': _guess_audio_content_type(filename or upstream_url, content_type),
            'Access-Control-Allow-Origin': origin_value or '*',
            'Cache-Control': 'no-store'
        }

        content_disposition = _build_content_disposition(filename, 'attachment')
        if content_disposition:
            resp_headers['Content-Disposition'] = content_disposition

        if 'Content-Length' in resp.headers:
            resp_headers['Content-Length'] = resp.headers['Content-Length']
        if 'Accept-Ranges' in resp.headers:
            resp_headers['Accept-Ranges'] = resp.headers['Accept-Ranges']
        else:
            resp_headers['Accept-Ranges'] = 'bytes'

        def generate():
            try:
                for chunk in resp.iter_content(chunk_size=65536):
                    if chunk:
                        yield chunk
            finally:
                try:
                    resp.close()
                except Exception:
                    pass

        return Response(generate(), status=resp.status_code, headers=resp_headers)

    except Exception as e:
        _logger.error(f"音乐下载代理失败: {e}")
        if resp is not None:
            try:
                resp.close()
            except Exception:
                pass
        return f'Download error: {str(e)}', 502
