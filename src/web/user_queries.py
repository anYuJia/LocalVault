"""用户数据查询路由（搜索、详情、点赞/收藏/合集、用户作品列表）。

从 web_app.py 抽离。模块内部依赖通过 setup 注入。
"""
from __future__ import annotations

import json
import os
from typing import Any, Callable

from flask import Blueprint, jsonify

from src.web.cookie_login import _verify_native_cookie_login

user_queries_bp = Blueprint("user_queries", __name__)

# 注入的依赖
_logger = None
_Config = None
_request_json: Callable[[], dict] | None = None
_coerce_int: Callable[..., int] | None = None
_run_async: Callable[..., Any] | None = None
_api_message: Callable[..., str] | None = None
_verify_error_response: Callable[..., dict] | None = None
_login_error_response: Callable[..., dict] | None = None
_verify_error_response_without_login_check: Callable[..., dict] | None = None
_verify_or_request_error_response: Callable[..., dict] | None = None
_feature_login_error_response: Callable[[str], dict] | None = None
_search_user_payload: Callable[..., dict] | None = None
_user_detail_payload: Callable[..., dict] | None = None
_safe_get_url: Callable[..., str] | None = None
_extract_music_info: Callable[[dict], dict] | None = None
_raw_duration_value: Callable[..., Any] | None = None


def setup_user_queries(
    *,
    logger,
    Config,
    request_json: Callable[[], dict],
    coerce_int: Callable[..., int],
    run_async: Callable[..., Any],
    api_message: Callable[..., str],
    verify_error_response: Callable[..., dict],
    login_error_response: Callable[..., dict],
    verify_error_response_without_login_check: Callable[..., dict],
    verify_or_request_error_response: Callable[..., dict],
    feature_login_error_response: Callable[[str], dict],
    search_user_payload: Callable[..., dict],
    user_detail_payload: Callable[..., dict],
    safe_get_url: Callable[..., str],
    extract_music_info: Callable[[dict], dict],
    raw_duration_value: Callable[..., Any],
) -> None:
    """注入 web_app 模块的全局对象，避免循环导入。"""
    global _logger, _Config, _request_json, _coerce_int, _run_async, _api_message
    global _verify_error_response, _login_error_response
    global _verify_error_response_without_login_check, _verify_or_request_error_response
    global _feature_login_error_response, _search_user_payload, _user_detail_payload
    global _safe_get_url, _extract_music_info, _raw_duration_value
    _logger = logger
    _Config = Config
    _request_json = request_json
    _coerce_int = coerce_int
    _run_async = run_async
    _api_message = api_message
    _verify_error_response = verify_error_response
    _login_error_response = login_error_response
    _verify_error_response_without_login_check = verify_error_response_without_login_check
    _verify_or_request_error_response = verify_or_request_error_response
    _feature_login_error_response = feature_login_error_response
    _search_user_payload = search_user_payload
    _user_detail_payload = user_detail_payload
    _safe_get_url = safe_get_url
    _extract_music_info = extract_music_info
    _raw_duration_value = raw_duration_value


def _get_user_manager():
    """延迟读取 web_app.user_manager，避免 setup 时还未初始化。"""
    from src.web import web_app
    return web_app.user_manager


@user_queries_bp.route('/api/search_user', methods=['POST'])
def search_user():
    """搜索用户"""
    try:
        data = _request_json()
        keyword = data.get('keyword', '').strip()

        if not keyword:
            return jsonify({'success': False, 'message': '请输入搜索关键词'}), 400

        user_manager = _get_user_manager()
        if not user_manager:
            return jsonify({'success': False, 'message': '请先设置Cookie'}), 400

        # 使用全局 run_async 运行异步任务
        users = _run_async(user_manager.search_user(keyword))

        if users is None:
            return jsonify({'success': False, 'message': '未找到用户'})

        # 检测验证码
        if isinstance(users, dict) and users.get('_need_verify'):
            return jsonify(_verify_error_response(users, '需要完成滑块验证'))
        if isinstance(users, dict) and users.get('_need_login'):
            return jsonify(_login_error_response(users))

        if isinstance(users, dict):  # 单个用户
            return jsonify({
                'success': True,
                'type': 'single',
                'user': _search_user_payload(users)
            })
        else:  # 多个用户
            user_list = []
            for user in users:
                user_info = user['user_info']
                user_list.append(_search_user_payload(user_info, user))

            return jsonify({
                'success': True,
                'type': 'multiple',
                'users': user_list
            })

    except Exception as e:
        return jsonify({'success': False, 'message': f'搜索失败: {str(e)}'}), 500


@user_queries_bp.route('/api/user_detail', methods=['POST'])
def get_user_detail():
    """获取用户详情"""
    try:
        data = _request_json()
        sec_uid = data.get('sec_uid', '').strip()
        fallback_nickname = (data.get('nickname') or '').strip()

        if not sec_uid:
            return jsonify({'success': False, 'message': '用户ID不能为空'}), 400

        user_manager = _get_user_manager()
        if not user_manager:
            return jsonify({'success': False, 'message': '请先设置Cookie'}), 400

        # 使用全局 run_async 运行异步任务
        user_detail = _run_async(user_manager.get_user_detail(sec_uid))

        if isinstance(user_detail, dict) and user_detail.get('_need_verify'):
            return jsonify(_verify_or_request_error_response(
                user_detail,
                '获取用户详情失败，抖音用户接口暂时拒绝请求，请稍后重试',
            ))
        if isinstance(user_detail, dict) and (user_detail.get('_need_login') or user_detail.get('_error')):
            if user_detail.get('_need_login'):
                return jsonify(_login_error_response(user_detail))
            return jsonify({
                'success': True,
                'detail_unavailable': True,
                'message': user_detail.get('message') or '用户详情暂不可用',
                'user': {
                    'nickname': fallback_nickname,
                    'unique_id': '',
                    'follower_count': 0,
                    'following_count': 0,
                    'total_favorited': 0,
                    'aweme_count': 0,
                    'signature': '',
                    'sec_uid': sec_uid,
                    'avatar_thumb': '',
                    'avatar_larger': '',
                }
            })

        if not user_detail:
            return jsonify({
                'success': True,
                'detail_unavailable': True,
                'message': '用户详情暂不可用',
                'user': {
                    'nickname': fallback_nickname,
                    'unique_id': '',
                    'follower_count': 0,
                    'following_count': 0,
                    'total_favorited': 0,
                    'aweme_count': 0,
                    'signature': '',
                    'sec_uid': sec_uid,
                    'avatar_thumb': '',
                    'avatar_larger': '',
                }
            })

        return jsonify({
            'success': True,
            'user': _user_detail_payload(user_detail, sec_uid, fallback_nickname)
        })

    except Exception as e:
        return jsonify({
            'success': True,
            'detail_unavailable': True,
            'message': f'用户详情暂不可用: {str(e)}',
            'user': {
                'nickname': fallback_nickname if 'fallback_nickname' in locals() else '',
                'unique_id': '',
                'follower_count': 0,
                'following_count': 0,
                'total_favorited': 0,
                'aweme_count': 0,
                'signature': '',
                'sec_uid': sec_uid if 'sec_uid' in locals() else '',
                'avatar_thumb': '',
                'avatar_larger': '',
            }
        })


@user_queries_bp.route('/api/get_liked_videos', methods=['POST'])
def get_liked_videos_api():
    """获取点赞视频列表"""
    try:
        data = _request_json()
        count = _coerce_int(data.get('count'), 20, 1, 100)
        cursor = _coerce_int(data.get('cursor') or data.get('max_cursor'), 0, 0)
        user_manager = _get_user_manager()
        if not user_manager or not (_Config.COOKIE or '').strip():
            return jsonify(_feature_login_error_response('点赞视频')), 200
        result = _run_async(user_manager.get_liked_videos(count, cursor, include_pagination=True))
        if isinstance(result, dict):
            if result.get('_need_login'):
                return jsonify(_feature_login_error_response('点赞视频'))
            if result.get('_need_verify'):
                return jsonify(_verify_error_response_without_login_check(result, '获取点赞视频失败，请完成验证后重试'))
            if 'data' in result:
                videos = result.get('data') or []
                return jsonify({
                    'success': True,
                    'data': videos,
                    'count': len(videos),
                    'cursor': result.get('cursor') or 0,
                    'has_more': bool(result.get('has_more')),
                })
            return jsonify({
                'success': False,
                'message': _api_message(result, '获取点赞视频失败，请检查 Cookie 或稍后重试'),
            })
        videos = result or []
        return jsonify({
            'success': True,
            'data': videos,
            'count': len(videos),
            'cursor': 0,
            'has_more': False,
        })
    except Exception as e:
        return jsonify({'success': False, 'message': f'获取点赞视频失败: {str(e)}'}), 500


@user_queries_bp.route('/api/get_liked_authors', methods=['POST'])
def get_liked_authors_api():
    """获取点赞作者列表"""
    try:
        data = _request_json()
        count = _coerce_int(data.get('count'), 20, 1, 100)

        user_manager = _get_user_manager()
        if not user_manager or not (_Config.COOKIE or '').strip():
            return jsonify(_feature_login_error_response('点赞作者')), 200

        authors = _run_async(user_manager.get_liked_authors(count))

        if isinstance(authors, dict):
            if authors.get('_need_login'):
                return jsonify(_feature_login_error_response('点赞作者'))
            if authors.get('_need_verify'):
                return jsonify(_verify_error_response_without_login_check(authors, '获取点赞作者失败，请完成验证后重试'))
            return jsonify({
                'success': False,
                'message': _api_message(authors, '获取点赞作者失败，请检查 Cookie 或稍后重试'),
            })

        if not authors:
            login_status = _verify_native_cookie_login(_Config.COOKIE or '')
            if not login_status.get('success'):
                return jsonify(_feature_login_error_response('点赞作者'))
            return jsonify({
                'success': True,
                'data': [],
                'count': 0,
            })

        return jsonify({
            'success': True,
            'data': authors,
            'count': len(authors)
        })
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)}), 500


@user_queries_bp.route('/api/get_collected_videos', methods=['POST'])
def get_collected_videos_api():
    """获取收藏视频列表"""
    try:
        data = _request_json()
        count = _coerce_int(data.get('count'), 20, 1, 100)
        cursor = _coerce_int(data.get('cursor'), 0, 0)
        user_manager = _get_user_manager()
        if not user_manager or not (_Config.COOKIE or '').strip():
            return jsonify(_feature_login_error_response('收藏视频')), 200

        result = _run_async(user_manager.get_collected_videos(count, cursor))
        if isinstance(result, dict):
            if result.get('_need_login'):
                return jsonify(_feature_login_error_response('收藏视频'))
            if result.get('_need_verify'):
                return jsonify(_verify_error_response_without_login_check(result, '获取收藏视频失败，请完成验证后重试'))
            if 'data' in result:
                videos = result.get('data') or []
                return jsonify({
                    'success': True,
                    'data': videos,
                    'count': len(videos),
                    'cursor': result.get('cursor') or 0,
                    'has_more': bool(result.get('has_more')),
                })
            return jsonify({
                'success': False,
                'message': _api_message(result, '获取收藏视频失败，请检查 Cookie 或稍后重试'),
            })
        return jsonify({'success': False, 'message': '获取收藏视频失败'}), 500
    except Exception as e:
        return jsonify({'success': False, 'message': f'获取收藏视频失败: {str(e)}'}), 500


@user_queries_bp.route('/api/get_collected_mixes', methods=['POST'])
def get_collected_mixes_api():
    """获取收藏合集列表"""
    try:
        data = _request_json()
        count = _coerce_int(data.get('count'), 20, 1, 100)
        cursor = _coerce_int(data.get('cursor'), 0, 0)
        user_manager = _get_user_manager()
        if not user_manager or not (_Config.COOKIE or '').strip():
            return jsonify(_feature_login_error_response('收藏合集')), 200

        result = _run_async(user_manager.get_collected_mixes(count, cursor))
        if isinstance(result, dict):
            if result.get('_need_login'):
                return jsonify(_feature_login_error_response('收藏合集'))
            if result.get('_need_verify'):
                return jsonify(_verify_error_response_without_login_check(result, '获取收藏合集失败，请完成验证后重试'))
            if 'data' in result:
                mixes = result.get('data') or []
                return jsonify({
                    'success': True,
                    'data': mixes,
                    'count': len(mixes),
                    'cursor': result.get('cursor') or 0,
                    'has_more': bool(result.get('has_more')),
                })
            return jsonify({
                'success': False,
                'message': _api_message(result, '获取收藏合集失败，请检查 Cookie 或稍后重试'),
            })
        return jsonify({'success': False, 'message': '获取收藏合集失败'}), 500
    except Exception as e:
        return jsonify({'success': False, 'message': f'获取收藏合集失败: {str(e)}'}), 500


@user_queries_bp.route('/api/get_mix_videos', methods=['POST'])
def get_mix_videos_api():
    """获取收藏合集内的视频列表"""
    try:
        data = _request_json()
        series_id = (data.get('series_id') or data.get('seriesId') or '').strip()
        count = _coerce_int(data.get('count'), 20, 1, 100)
        cursor = _coerce_int(data.get('cursor'), 0, 0)
        if not series_id:
            return jsonify({'success': False, 'message': '合集ID不能为空'}), 400
        user_manager = _get_user_manager()
        if not user_manager:
            return jsonify({'success': False, 'message': '请先设置Cookie'}), 400

        result = _run_async(user_manager.get_mix_videos(series_id, count, cursor))
        if isinstance(result, dict):
            if result.get('_need_verify'):
                return jsonify(_verify_error_response(result, '获取合集视频失败，请完成验证后重试'))
            if result.get('_need_login'):
                return jsonify(_login_error_response(result))
            if 'data' in result:
                videos = result.get('data') or []
                return jsonify({
                    'success': True,
                    'data': videos,
                    'count': len(videos),
                    'cursor': result.get('cursor') or 0,
                    'has_more': bool(result.get('has_more')),
                })
            return jsonify({
                'success': False,
                'message': _api_message(result, '获取合集视频失败，请检查 Cookie 或稍后重试'),
            })
        return jsonify({'success': False, 'message': '获取合集视频失败'}), 500
    except Exception as e:
        return jsonify({'success': False, 'message': f'获取合集视频失败: {str(e)}'}), 500


@user_queries_bp.route('/api/user_videos', methods=['POST'])
def get_user_videos():
    """获取用户视频列表（支持分页渐进加载）"""
    try:
        data = _request_json()
        sec_uid = data.get('sec_uid', '').strip()
        cursor = _coerce_int(data.get('cursor'), 0, 0)  # 分页游标
        count = _coerce_int(data.get('count'), 18, 1, 100)   # 每页数量

        if not sec_uid:
            return jsonify({'success': False, 'message': '用户ID不能为空'}), 400

        user_manager = _get_user_manager()
        if not user_manager:
            return jsonify({'success': False, 'message': '请先设置Cookie'}), 400

        def run_get_page():
            params = {
                "publish_video_strategy_type": 2,
                "max_cursor": cursor,
                "sec_user_id": sec_uid,
                "locate_query": False,
                'show_live_replay_strategy': 1,
                'need_time_list': 0,
                'time_list_query': 0,
                'whale_cut_token': '',
                'count': count
            }
            return _run_async(
                user_manager.api.common_request('/aweme/v1/web/aweme/post/', params, {}, skip_sign=True)
            )

        resp, succ = run_get_page()

        # 检测验证码
        if isinstance(resp, dict) and resp.get('_need_verify'):
            return jsonify(_verify_or_request_error_response(
                resp,
                '获取作品列表失败，抖音作品接口暂时拒绝请求，请稍后重试',
            ))
        if isinstance(resp, dict) and resp.get('_need_login'):
            return jsonify(_login_error_response(resp))

        if not succ:
            return jsonify({
                'success': False,
                'message': _api_message(resp, '获取作品列表失败，请检查 Cookie 或稍后重试'),
            })

        if not resp.get('aweme_list'):
            return jsonify({
                'success': True,
                'videos': [],
                'has_more': False,
                'cursor': 0,
                'total_count': 0
            })

        videos = resp.get('aweme_list', [])
        has_more = resp.get('has_more', 0) == 1
        next_cursor = resp.get('max_cursor', 0)

        video_list = []
        for video in videos:
            aweme_id = video.get('aweme_id')
            if not aweme_id:
                continue
            cover_url = ""
            if video.get('video') and video['video'].get('cover'):
                cover_url = _safe_get_url(video['video']['cover'])
            elif video.get('images'):
                cover_url = _safe_get_url(video['images'][0])
            media_type, media_urls = user_manager.get_media_info(video)
            video_data = video.get('video') or {}
            play_addr = _safe_get_url(video_data.get('play_addr'))
            selected_video_url = user_manager._select_video_url(video_data) or play_addr
            play_addr_h264 = _safe_get_url(video_data.get('play_addr_h264'))
            play_addr_lowbr = _safe_get_url(video_data.get('play_addr_lowbr'))
            download_addr = _safe_get_url(video_data.get('download_addr'))
            dynamic_cover = _safe_get_url(video_data.get('dynamic_cover')) or cover_url
            origin_cover = _safe_get_url(video_data.get('origin_cover')) or cover_url

            music_info = _extract_music_info(video.get('music') or {})
            bgm_url = music_info['play_url']
            if video.get('music') and os.environ.get('DEBUG_MODE', '').lower() in ('true', '1', 'yes'):
                _logger.debug(f"Music 数据结构：{json.dumps(video.get('music'), ensure_ascii=False)[:500]}")
            if not bgm_url and video.get('video') and video['video'].get('play_addr'):
                # 如果没有独立音乐，使用视频的播放地址作为 BGM
                bgm_url = _safe_get_url(video['video']['play_addr'])

            video_list.append({
                'aweme_id': aweme_id,
                'desc': video.get('desc', ''),
                'create_time': video.get('create_time', 0),
                'duration': _raw_duration_value((video.get('video') or {}).get('duration', 0)),
                'duration_unit': 'milliseconds',
                'digg_count': video.get('statistics', {}).get('digg_count', 0),
                'comment_count': video.get('statistics', {}).get('comment_count', 0),
                'share_count': video.get('statistics', {}).get('share_count', 0),
                'cover_url': cover_url,
                'media_type': media_type,
                'raw_media_type': media_type,
                'media_urls': media_urls,
                'bgm_url': bgm_url,
                'images': video.get('images') or [],
                'live_photos': video.get('live_photos') or video.get('live_photo_urls') or [],
                'music': music_info,
                'music_title': music_info['title'],
                'music_author': music_info['author'],
                'music_url': music_info['play_url'],
                'music_duration': music_info['duration'],
                'video': {
                    'cover': cover_url,
                    'dynamic_cover': dynamic_cover,
                    'origin_cover': origin_cover,
                    'preview_addr': selected_video_url or play_addr_lowbr or play_addr_h264 or (media_urls[0].get('url') if media_urls else ''),
                    'play_addr': selected_video_url or (media_urls[0].get('url') if media_urls else ''),
                    'play_addr_h264': play_addr_h264,
                    'play_addr_lowbr': play_addr_lowbr,
                    'download_addr': download_addr,
                    'width': video_data.get('width', 0),
                    'height': video_data.get('height', 0),
                    'duration': _raw_duration_value(video_data.get('duration', 0)),
                    'duration_unit': 'milliseconds',
                    'ratio': video_data.get('ratio', ''),
                    'bit_rate': video_data.get('bit_rate') or [],
                },
                'author': {
                    'nickname': video.get('author', {}).get('nickname', ''),
                    'avatar_thumb': _safe_get_url(video.get('author', {}).get('avatar_thumb', {})),
                    'sec_uid': video.get('author', {}).get('sec_uid', '')
                }
            })

        return jsonify({
            'success': True,
            'videos': video_list,
            'has_more': has_more,
            'cursor': next_cursor,
            'total_count': len(video_list)
        })
    except Exception as e:
        _logger.error(f" 获取用户视频列表失败: {str(e)}")
        return jsonify({'success': False, 'message': f'获取用户视频列表失败: {str(e)}'}), 500
