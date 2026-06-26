"""推荐视频流路由。

从 web_app.py 抽离。模块内部依赖通过 setup_recommended_feed(...) 注入。
"""
from __future__ import annotations

from typing import Any, Callable

from flask import Blueprint, jsonify

recommended_feed_bp = Blueprint("recommended_feed", __name__)

_logger = None
_Config = None
_request_json: Callable[[], dict] | None = None
_coerce_int: Callable[..., int] | None = None
_run_async: Callable[..., Any] | None = None
_api_message: Callable[..., str] | None = None
_verify_error_response: Callable[..., dict] | None = None
_login_error_response: Callable[..., dict] | None = None
_media_url_utils = None
_audio_helpers = None
_get_api: Callable[[], Any] | None = None


def setup_recommended_feed(
    *,
    logger,
    Config,
    request_json: Callable[[], dict],
    coerce_int: Callable[..., int],
    run_async: Callable[..., Any],
    api_message: Callable[..., str],
    verify_error_response: Callable[..., dict],
    login_error_response: Callable[..., dict],
    media_url_utils,
    audio_helpers,
    get_api: Callable[[], Any],
) -> None:
    """注入 web_app 模块的全局对象，避免循环导入。"""
    global _logger, _Config, _request_json, _coerce_int, _run_async
    global _api_message, _verify_error_response, _login_error_response
    global _media_url_utils, _audio_helpers, _get_api
    _logger = logger
    _Config = Config
    _request_json = request_json
    _coerce_int = coerce_int
    _run_async = run_async
    _api_message = api_message
    _verify_error_response = verify_error_response
    _login_error_response = login_error_response
    _media_url_utils = media_url_utils
    _audio_helpers = audio_helpers
    _get_api = get_api


def _normalize_feed_type(value: str) -> str:
    feed_type = str(value or 'featured').strip().lower()
    if feed_type in ('recommend', 'tab', 'home', 'feed'):
        return 'recommended'
    if feed_type not in ('featured', 'recommended'):
        return 'featured'
    return feed_type


def _format_recommended_video(aweme: dict) -> dict | None:
    video_data = aweme.get('video') or {}
    if not isinstance(video_data, dict):
        _logger.debug(f"跳过视频 {aweme.get('aweme_id')}: 缺少视频信息")
        return None

    play_addr = _media_url_utils._media_first_url(video_data.get('play_addr'))
    selected_video_url = _media_url_utils._select_recommended_video_url(video_data, play_addr)
    dash_video_url = _media_url_utils._select_dash_video_url(video_data)
    dash_audio_url = _media_url_utils._select_dash_audio_url(video_data)

    if not selected_video_url:
        _logger.debug(f"跳过视频 {aweme.get('aweme_id')}: 无播放地址")
        return None

    cover = _media_url_utils._media_first_url(video_data.get('cover'))
    if not cover:
        _logger.debug(f"跳过视频 {aweme.get('aweme_id')}: 无封面")
        return None

    author_data = aweme.get('author') or {}
    author_key = (
        author_data.get('sec_uid')
        or author_data.get('uid')
        or author_data.get('unique_id')
        or author_data.get('nickname')
        or ''
    )
    if not aweme.get('aweme_id') or not author_key:
        _logger.debug(f"跳过视频 {aweme.get('aweme_id')}: 缺少作品或作者信息")
        return None

    dynamic_cover = _media_url_utils._media_first_url(video_data.get('dynamic_cover'))
    origin_cover = _media_url_utils._media_first_url(video_data.get('origin_cover')) or cover
    play_addr_h264 = _media_url_utils._media_first_url(video_data.get('play_addr_h264'))
    play_addr_lowbr = _media_url_utils._media_first_url(video_data.get('play_addr_lowbr'))
    download_addr = _media_url_utils._media_first_url(video_data.get('download_addr'))
    avatar_thumb = _media_url_utils._media_first_url(author_data.get('avatar_thumb'))
    music_info = _audio_helpers.extract_music_info(aweme.get('music') or {})

    return {
        'aweme_id': aweme.get('aweme_id', ''),
        'desc': aweme.get('desc', ''),
        'create_time': aweme.get('create_time', 0),
        'media_type': 'video',
        'raw_media_type': 'video',
        'media_urls': [{'type': 'video', 'url': selected_video_url}],
        'bgm_url': dash_audio_url or music_info.get('play_url', ''),
        'cover_url': cover,
        'author': {
            'uid': author_data.get('uid', ''),
            'nickname': author_data.get('nickname', ''),
            'avatar_thumb': avatar_thumb,
            'sec_uid': author_data.get('sec_uid', ''),
        },
        'statistics': {
            'digg_count': (aweme.get('statistics') or {}).get('digg_count', 0),
            'comment_count': (aweme.get('statistics') or {}).get('comment_count', 0),
            'share_count': (aweme.get('statistics') or {}).get('share_count', 0),
            'play_count': (aweme.get('statistics') or {}).get('play_count', 0),
            'collect_count': (aweme.get('statistics') or {}).get('collect_count', 0),
        },
        'status': _audio_helpers.extract_post_status(aweme),
        'video': {
            'cover': cover,
            'dynamic_cover': dynamic_cover,
            'origin_cover': origin_cover or cover,
            'play_addr': selected_video_url,
            'dash_addr': dash_video_url,
            'audio_addr': dash_audio_url,
            'preview_addr': _media_url_utils._media_first_url(video_data.get('preview_addr')) or selected_video_url,
            'play_addr_h264': play_addr_h264,
            'play_addr_lowbr': play_addr_lowbr,
            'download_addr': download_addr,
            'width': video_data.get('width', 0),
            'height': video_data.get('height', 0),
            'duration': _audio_helpers.raw_duration_value(video_data.get('duration', 0)),
            'duration_unit': 'milliseconds',
            'ratio': video_data.get('ratio', ''),
            'bit_rate': video_data.get('bit_rate') or [],
        },
        'music': {
            **music_info,
            'cover': _media_url_utils._media_first_url((aweme.get('music') or {}).get('cover_large')),
        },
    }


@recommended_feed_bp.route('/api/recommended_feed', methods=['POST'])
def get_recommended_feed():
    """获取推荐视频流 - 直接调用 DouyinAPI，不使用子进程。"""
    try:
        data = _request_json()
        count = _coerce_int(data.get('count'), 20, 1, 100)
        cursor = _coerce_int(data.get('cursor'), 0, 0)
        feed_type = _normalize_feed_type(data.get('feed_type') or data.get('feedType'))

        if not _get_api():
            return jsonify({'success': False, 'message': '服务未初始化'})

        _logger.debug(f"[推荐视频] 请求 {count} 个视频, feed_type={feed_type}, cursor={cursor}")

        async def fetch_recommended():
            resp, success = await _get_api().get_recommended_feed(count, cursor, feed_type)
            return resp, success

        resp, success = _run_async(fetch_recommended())

        if isinstance(resp, dict) and resp.get('_need_verify'):
            return jsonify(_verify_error_response(resp, '获取推荐视频失败，请完成验证后重试'))
        if isinstance(resp, dict) and resp.get('_need_login'):
            return jsonify(_login_error_response(resp))

        if not success or not resp.get('aweme_list'):
            _logger.error(f"获取推荐视频失败: {resp}")
            return jsonify({
                'success': False,
                'message': _api_message(resp, '获取推荐视频失败，请稍后重试'),
            })

        aweme_list = resp.get('aweme_list', [])
        _logger.debug(f"[推荐视频] API 返回 {len(aweme_list)} 个视频")

        videos = []
        skipped_count = 0
        for aweme in aweme_list:
            try:
                video_info = _format_recommended_video(aweme)
                if video_info is None:
                    skipped_count += 1
                    continue
                videos.append(video_info)
            except Exception as e:
                _logger.exception(f"解析视频信息失败: {e}")
                continue

        _logger.debug(f"[推荐视频] 返回 {len(videos)} 个有效视频, 跳过 {skipped_count} 个无效视频")

        has_more = resp.get('has_more', False)
        has_more_bool = has_more == 1 or has_more is True
        next_cursor = (
            resp.get('cursor')
            or resp.get('max_cursor')
            or resp.get('min_cursor')
            or (cursor + 1 if has_more_bool else cursor)
        )

        return jsonify({
            'success': True,
            'videos': videos,
            'cursor': next_cursor,
            'has_more': has_more_bool,
            'count': len(videos),
            'feed_type': feed_type,
        })

    except Exception as e:
        _logger.exception(f"获取推荐视频异常: {e}")
        return jsonify({
            'success': False,
            'message': f'获取失败: {str(e)}',
        })
