"""作品详情与分享链接解析服务。"""
import asyncio
import logging
import re
from typing import Optional, Tuple, List, Dict

import aiohttp

logger = logging.getLogger(__name__)


class VideoDetailsService:
    """封装作品媒体信息、详情读取与分享链接解析。"""

    def __init__(self, manager):
        self._mgr = manager

    @property
    def api(self):
        return self._mgr.api

    @property
    def debug_mode(self) -> bool:
        return self._mgr.debug_mode

    def _first_url(self, value) -> str:
        return self._mgr._first_url(value)

    def _build_video_media_urls(self, video_data: dict) -> list[dict]:
        return self._mgr._build_video_media_urls(video_data)

    def _select_video_url(self, video_data: dict) -> str:
        return self._mgr._select_video_url(video_data)

    def _select_dash_video_url(self, video_data: dict) -> str:
        return self._mgr._select_dash_video_url(video_data)

    def _select_dash_audio_url(self, video_data: dict) -> str:
        return self._mgr._select_dash_audio_url(video_data)

    def _raw_duration_value(self, value) -> int:
        return self._mgr._raw_duration_value(value)

    def _extract_post_status(self, post: dict) -> dict:
        return self._mgr._extract_post_status(post)

    def _extract_bgm_url(self, post: dict) -> Optional[str]:
        return self._mgr._extract_bgm_url(post)

    def _post_boolish(self, post: dict, *keys: str, default: bool = False) -> bool:
        return self._mgr._post_boolish(post, *keys, default=default)

    def get_media_info(self, post: dict) -> Tuple[str, List[Dict[str, str]]]:
        """从帖子数据中提取媒体信息 (URL, 类型)。"""
        urls = []
        media_type = 'unknown'

        if post.get("images"):
            images = post["images"]
            has_live = False
            has_image = False

            for img in images:
                if img.get("video") and img["video"].get("play_addr"):
                    has_live = True
                    video_urls = img["video"]["play_addr"].get("url_list", [])
                    if video_urls:
                        urls.append({
                            'type': 'live_photo',
                            'url': video_urls[0]
                        })
                elif img.get("url_list"):
                    has_image = True
                    urls.append({
                        'type': 'image',
                        'url': img["url_list"][-1]
                    })

            if has_live and has_image:
                media_type = 'mixed'
            elif has_live:
                media_type = 'live_photo'
            elif has_image:
                media_type = 'image'

        elif post.get("video") and post["video"].get("play_addr"):
            video_urls = self._build_video_media_urls(post.get("video") or {})
            if video_urls:
                media_type = 'video'
                urls.extend(video_urls)

        return media_type, urls

    async def get_video_detail(self, aweme_id: str) -> Optional[dict]:
        """根据作品ID获取视频详情。"""
        try:
            params = {
                "aweme_id": aweme_id,
                "aid": "1128",
                "version_name": "23.5.0",
                "device_platform": "webapp",
                "os": "windows"
            }

            resp, succ = await self.api.common_request('/aweme/v1/web/aweme/detail/',
                                                     params,
                                                     {}, skip_sign=True)
            if not succ or not (isinstance(resp, dict) and resp.get('aweme_detail')):
                resp, succ = await self.api.common_request('/aweme/v1/web/aweme/detail/',
                                                         params,
                                                         {}, skip_sign=False)

            # 对抗偶发风控/限流：再重试一次（带短退避）。
            if (not succ or not (isinstance(resp, dict) and resp.get('aweme_detail'))) and not (isinstance(resp, dict) and (resp.get('_need_verify') or resp.get('_need_login'))):
                import asyncio as _asyncio
                await _asyncio.sleep(0.8)
                resp, succ = await self.api.common_request('/aweme/v1/web/aweme/detail/',
                                                         params,
                                                         {}, skip_sign=False)

            if isinstance(resp, dict) and (resp.get('_need_verify') or resp.get('_need_login')):
                return resp

            if not succ or not resp.get('aweme_detail'):
                logger.warning(f"获取视频详情失败: succ={succ}, aweme_id={aweme_id}")
                return None

            post = resp['aweme_detail']

            media_type, urls = self.get_media_info(post)
            video_data = post.get('video') or {}
            play_url = self._first_url(video_data.get('play_addr'))
            selected_video_url = self._select_video_url(video_data)
            dash_video_url = self._select_dash_video_url(video_data)
            dash_audio_url = self._select_dash_audio_url(video_data)
            detail = {
                'aweme_id': post.get('aweme_id', ''),
                'desc': post.get('desc', ''),
                'create_time': post.get('create_time', 0),
                'duration': self._raw_duration_value(video_data.get('duration', 0)),
                'duration_unit': 'milliseconds',
                'digg_count': post.get('statistics', {}).get('digg_count', 0),
                'comment_count': post.get('statistics', {}).get('comment_count', 0),
                'share_count': post.get('statistics', {}).get('share_count', 0),
                'is_liked': self._post_boolish(post, 'user_digged', 'is_liked', 'digg_status'),
                'is_collected': self._post_boolish(post, 'is_collected', 'is_collect', 'collect_status', 'collect_stat'),
                'author': {
                    'nickname': post.get('author', {}).get('nickname', ''),
                    'unique_id': post.get('author', {}).get('uid', ''),
                    'sec_uid': post.get('author', {}).get('sec_uid', ''),
                    'avatar_thumb': post.get('author', {}).get('avatar_thumb', {}).get('url_list', [''])[0] if post.get('author', {}).get('avatar_thumb') else ''
                },
                'statistics': {
                    'digg_count': post.get('statistics', {}).get('digg_count', 0),
                    'comment_count': post.get('statistics', {}).get('comment_count', 0),
                    'share_count': post.get('statistics', {}).get('share_count', 0),
                    'play_count': post.get('statistics', {}).get('play_count', 0),
                    'collect_count': post.get('statistics', {}).get('collect_count', 0),
                },
                'media_type': media_type,
                'media_urls': urls,
                'raw_media_type': media_type,
                'status': self._extract_post_status(post),
                'cover_url': self._first_url(video_data.get('cover')),
                'images': post.get('images'),
                'videos': urls,
                'video': {
                    'play_addr': selected_video_url,
                    'dash_addr': dash_video_url,
                    'audio_addr': dash_audio_url,
                    'preview_addr': play_url or self._first_url(video_data.get('preview_addr')) or selected_video_url,
                    'play_addr_h264': self._first_url(video_data.get('play_addr_h264')),
                    'play_addr_lowbr': self._first_url(video_data.get('play_addr_lowbr')),
                    'download_addr': self._first_url(video_data.get('download_addr')),
                    'cover': self._first_url(video_data.get('cover')),
                    'dynamic_cover': self._first_url(video_data.get('dynamic_cover')),
                    'origin_cover': self._first_url(video_data.get('origin_cover')),
                    'width': video_data.get('width', 0),
                    'height': video_data.get('height', 0),
                    'duration': self._raw_duration_value(video_data.get('duration', 0)),
                    'duration_unit': 'milliseconds',
                    'ratio': video_data.get('ratio', ''),
                    'bit_rate': video_data.get('bit_rate') or [],
                }
            }

            if media_type == 'video':
                detail['cover_url'] = self._first_url(video_data.get('cover'))
            elif media_type in ['image', 'live_photo', 'mixed']:
                images = post.get('images', [])
                if images:
                    detail['cover_url'] = self._first_url(images[0])

            detail['bgm_url'] = self._extract_bgm_url(post) or dash_audio_url

            return detail

        except Exception as e:
            if self.debug_mode:
                print(f"\033[91m[UserManager] 获取视频详情失败: {str(e)}\033[0m")
            return None

    async def parse_share_link(self, share_link: str) -> Optional[dict]:
        """解析抖音分享链接。"""
        try:
            url_pattern = r'https?://[^\s<>"]+|www\.[^\s<>"]+'
            match = re.search(url_pattern, share_link)
            if match:
                share_link = re.split(r'[，。！？；、,!;]', match.group(), maxsplit=1)[0].strip().rstrip('，。！？；、,.!;')
            else:
                share_link = re.split(r'[，。！？；、,!;]', share_link.strip(), maxsplit=1)[0].strip().rstrip('，。！？；、,.!;')
            if share_link.startswith('www.'):
                share_link = f'https://{share_link}'

            if 'v.douyin.com' in share_link:
                try:
                    timeout = aiohttp.ClientTimeout(total=10)
                    connector = aiohttp.TCPConnector(ssl=False)
                    async with aiohttp.ClientSession(timeout=timeout, connector=connector) as session:
                        async with session.get(share_link, allow_redirects=False) as response:
                            if response.status in [301, 302]:
                                real_url = response.headers.get('Location', '')
                                if real_url:
                                    share_link = real_url
                except (aiohttp.ClientError, asyncio.TimeoutError) as e:
                    if self.debug_mode:
                        print(f"\033[93m[UserManager] 获取重定向链接失败: {str(e)}，使用原链接\033[0m")
            if self.debug_mode:
                print(f"\033[94m[UserManager] 重定向后的URL: {share_link}\033[0m")

            aweme_id_match = re.search(r'/video/(\d+)', share_link)
            if not aweme_id_match:
                aweme_id_match = re.search(r'aweme_id=(\d+)', share_link)
                if not aweme_id_match:
                    aweme_id_match = re.search(r'modal_id=(\d+)', share_link)

            if not aweme_id_match:
                return None

            aweme_id = aweme_id_match.group(1)
            if self.debug_mode:
                print(f"\033[94m[UserManager] 提取的视频ID: {aweme_id}\033[0m")

            detail = await self.get_video_detail(aweme_id)
            if detail:
                return detail

            return {
                'aweme_id': aweme_id,
                'desc': f'视频 {aweme_id}',
                'create_time': 0,
                'digg_count': 0,
                'comment_count': 0,
                'share_count': 0,
                'cover_url': '',
                'media_type': 'unknown',
                'media_urls': [],
                'author': {'nickname': '', 'sec_uid': '', 'avatar_thumb': ''},
                '_incomplete': True,
            }

        except Exception as e:
            if self.debug_mode:
                print(f"\033[91m[UserManager] 解析分享链接失败: {str(e)}\033[0m")
            return None
