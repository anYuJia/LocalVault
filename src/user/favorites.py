"""点赞/收藏/合集逻辑拆分模块。

将 UserManager 中点赞、收藏、合集相关的方法抽取到独立模块，
降低主文件复杂度。通过 FavoritesService 类持有 UserManager 实例引用。
"""
import asyncio
import logging

from src.config.config import Config
from src.user.mix_service import MixService

logger = logging.getLogger('user.favorites')


class FavoritesService:
    """点赞/收藏/合集服务，封装相关操作。"""

    def __init__(self, manager):
        """
        Args:
            manager: UserManager 实例，用于共享 api、downloader 等。
        """
        self._mgr = manager
        # 合集视频服务（延迟初始化）
        self._mix: MixService | None = None

    @property
    def mix(self) -> MixService:
        """获取合集视频服务实例（懒加载）。"""
        if self._mix is None:
            self._mix = MixService(self)
        return self._mix

    # ---------- 基础属性/方法委托 ----------

    @property
    def api(self):
        return self._mgr.api

    @property
    def downloader(self):
        return self._mgr.downloader

    @property
    def debug_mode(self) -> bool:
        return self._mgr.debug_mode

    def _looks_like_login_error(self, error) -> bool:
        return self._mgr._looks_like_login_error(error)

    def _login_required_message(self, feature: str) -> dict:
        return self._mgr._login_required_message(feature)

    def _first_url(self, value) -> str:
        return self._mgr._first_url(value)

    def _extract_bgm_url(self, post: dict):
        return self._mgr._extract_bgm_url(post)

    def _extract_post_status(self, post: dict) -> dict:
        return self._mgr._extract_post_status(post)

    def _raw_duration_value(self, value) -> int:
        return self._mgr._raw_duration_value(value)

    def _video_display_url(self, video_data: dict, media_urls=None) -> str:
        return self._mgr._video_display_url(video_data, media_urls)

    def _select_dash_video_url(self, video_data: dict) -> str:
        return self._mgr._select_dash_video_url(video_data)

    def _select_dash_audio_url(self, video_data: dict) -> str:
        return self._mgr._select_dash_audio_url(video_data)

    def get_media_info(self, post: dict):
        return self._mgr.get_media_info(post)

    def get_video_download_urls(self, video_data: dict) -> list[str]:
        return self._mgr.get_video_download_urls(video_data)

    async def get_user_detail(self, user_id: str, force_refresh: bool = False) -> dict:
        return await self._mgr.get_user_detail(user_id, force_refresh)

    async def download_user_videos(self, user_info: dict, auto_confirm: bool = False, web_socket: bool = False):
        return await self._mgr.download_user_videos(user_info, auto_confirm, web_socket)

    # ---------- 常量 ----------

    _FAVORITE_HEADERS = {'Referer': 'https://www.douyin.com/'}

    # ---------- 工具方法 ----------

    @staticmethod
    def _boolish(value) -> bool:
        if isinstance(value, bool):
            return value
        if isinstance(value, (int, float)):
            return value > 0
        if isinstance(value, str):
            return value.strip().lower() in ('1', 'true', 'yes')
        return False

    @classmethod
    def _post_boolish(cls, post: dict, *keys: str, default: bool = False) -> bool:
        if not isinstance(post, dict):
            return default
        saw_value = False
        for key in keys:
            if key not in post or post.get(key) is None:
                continue
            saw_value = True
            if cls._boolish(post.get(key)):
                return True
        return False if saw_value else default

    @staticmethod
    def _response_has_more(resp):
        return resp.get('has_more') in (1, True, '1', 'true', 'True')

    @staticmethod
    def _response_cursor(resp):
        return resp.get('cursor') or resp.get('max_cursor') or resp.get('min_cursor') or 0

    # ---------- 收藏视频构建 ----------

    def _build_collection_video_item(self, post):
        aweme_id = post.get('aweme_id')
        if not aweme_id:
            return None
        media_type, media_urls = self.get_media_info(post)
        video_data = post.get('video') or {}
        play_url = self._first_url(video_data.get('play_addr'))
        selected_video_url = self._video_display_url(video_data, media_urls)
        dash_video_url = self._select_dash_video_url(video_data)
        dash_audio_url = self._select_dash_audio_url(video_data)
        duration = self._raw_duration_value(video_data.get('duration', 0))
        cover_url = ""
        if video_data.get('cover'):
            cover_url = video_data['cover'].get('url_list', [''])[0]
        elif post.get('images'):
            cover_url = post['images'][0].get('url_list', [''])[-1]
        author = post.get('author', {}) or {}
        return {
            'aweme_id': aweme_id,
            'desc': post.get('desc', ''),
            'create_time': post.get('create_time', 0),
            'digg_count': post.get('statistics', {}).get('digg_count', 0),
            'comment_count': post.get('statistics', {}).get('comment_count', 0),
            'share_count': post.get('statistics', {}).get('share_count', 0),
            'is_liked': self._post_boolish(post, 'user_digged', 'is_liked', 'digg_status'),
            'is_collected': self._post_boolish(post, 'is_collected', 'is_collect', 'collect_status', 'collect_stat', default=True),
            'cover_url': cover_url,
            'duration': duration,
            'duration_unit': 'milliseconds',
            'media_type': media_type,
            'raw_media_type': media_type,
            'status': self._extract_post_status(post),
            'media_urls': media_urls,
            'bgm_url': self._extract_bgm_url(post) or dash_audio_url,
            'statistics': {
                'digg_count': post.get('statistics', {}).get('digg_count', 0),
                'comment_count': post.get('statistics', {}).get('comment_count', 0),
                'share_count': post.get('statistics', {}).get('share_count', 0),
                'play_count': post.get('statistics', {}).get('play_count', 0),
                'collect_count': post.get('statistics', {}).get('collect_count', 0),
            },
            'video': {
                'play_addr': selected_video_url,
                'dash_addr': dash_video_url,
                'audio_addr': dash_audio_url,
                'preview_addr': selected_video_url or play_url,
                'play_addr_h264': self._first_url(video_data.get('play_addr_h264')),
                'play_addr_lowbr': self._first_url(video_data.get('play_addr_lowbr')),
                'download_addr': self._first_url(video_data.get('download_addr')),
                'cover': cover_url,
                'dynamic_cover': self._first_url(video_data.get('dynamic_cover')) or cover_url,
                'origin_cover': self._first_url(video_data.get('origin_cover')) or cover_url,
                'width': video_data.get('width', 0),
                'height': video_data.get('height', 0),
                'duration': duration,
                'duration_unit': 'milliseconds',
                'ratio': video_data.get('ratio', ''),
                'bit_rate': video_data.get('bit_rate') or [],
            },
            'author': {
                'nickname': author.get('nickname', ''),
                'sec_uid': author.get('sec_uid', ''),
                'avatar_thumb': author.get('avatar_thumb', {}).get('url_list', [''])[0] if author.get('avatar_thumb') else ''
            }
        }

    # ---------- 点赞视频 ----------

    async def get_liked_videos(self, count=20, cursor=0, include_pagination=False):
        """获取点赞视频列表，直接从favorite API提取完整数据"""
        try:
            params = {
                "count": count,
                "max_cursor": cursor
            }

            resp, succ = await self.api.common_request('/aweme/v1/web/aweme/favorite/', params,
                                                     dict(self._FAVORITE_HEADERS),
                                                     skip_sign=True)
            if isinstance(resp, dict) and (resp.get('_need_verify') or resp.get('_need_login')):
                return resp
            if not succ:
                return {
                    '_error': True,
                    'message': (resp or {}).get('message') or (resp or {}).get('status_msg') or '获取点赞视频失败，请检查 Cookie 或稍后重试',
                }

            posts = resp.get('aweme_list') or []
            next_cursor = resp.get('max_cursor') or resp.get('cursor') or resp.get('min_cursor') or 0
            has_more = resp.get('has_more') in (1, True, '1', 'true', 'True')
            if not posts:
                if include_pagination:
                    return {
                        'data': [],
                        'cursor': next_cursor,
                        'has_more': bool(has_more),
                    }
                return []

            video_list = []
            for post in posts:
                aweme_id = post.get('aweme_id')
                if not aweme_id:
                    continue
                media_type, media_urls = self.get_media_info(post)
                video_data = post.get('video') or {}
                play_url = self._first_url(video_data.get('play_addr'))
                selected_video_url = self._video_display_url(video_data, media_urls)
                dash_video_url = self._select_dash_video_url(video_data)
                dash_audio_url = self._select_dash_audio_url(video_data)
                duration = self._raw_duration_value(video_data.get('duration', 0))
                cover_url = ""
                if video_data.get('cover'):
                    cover_url = video_data['cover'].get('url_list', [''])[0]
                elif post.get('images'):
                    cover_url = post['images'][0].get('url_list', [''])[-1]
                video_list.append({
                    'aweme_id': aweme_id,
                    'desc': post.get('desc', ''),
                    'create_time': post.get('create_time', 0),
                    'digg_count': post.get('statistics', {}).get('digg_count', 0),
                    'comment_count': post.get('statistics', {}).get('comment_count', 0),
                    'share_count': post.get('statistics', {}).get('share_count', 0),
                    'is_liked': self._post_boolish(post, 'user_digged', 'is_liked', 'digg_status', default=True),
                    'is_collected': self._post_boolish(post, 'is_collected', 'is_collect', 'collect_status', 'collect_stat'),
                    'cover_url': cover_url,
                    'duration': duration,
                    'duration_unit': 'milliseconds',
                    'media_type': media_type,
                    'raw_media_type': media_type,
                    'status': self._extract_post_status(post),
                    'media_urls': media_urls,
                    'bgm_url': self._extract_bgm_url(post) or dash_audio_url,
                    'statistics': {
                        'digg_count': post.get('statistics', {}).get('digg_count', 0),
                        'comment_count': post.get('statistics', {}).get('comment_count', 0),
                        'share_count': post.get('statistics', {}).get('share_count', 0),
                        'play_count': post.get('statistics', {}).get('play_count', 0),
                        'collect_count': post.get('statistics', {}).get('collect_count', 0),
                    },
                    'video': {
                        'play_addr': selected_video_url,
                        'dash_addr': dash_video_url,
                        'audio_addr': dash_audio_url,
                        'preview_addr': selected_video_url or play_url,
                        'play_addr_h264': self._first_url(video_data.get('play_addr_h264')),
                        'play_addr_lowbr': self._first_url(video_data.get('play_addr_lowbr')),
                        'download_addr': self._first_url(video_data.get('download_addr')),
                        'cover': cover_url,
                        'dynamic_cover': self._first_url(video_data.get('dynamic_cover')) or cover_url,
                        'origin_cover': self._first_url(video_data.get('origin_cover')) or cover_url,
                        'width': video_data.get('width', 0),
                        'height': video_data.get('height', 0),
                        'duration': duration,
                        'duration_unit': 'milliseconds',
                        'ratio': video_data.get('ratio', ''),
                        'bit_rate': video_data.get('bit_rate') or [],
                    },
                    'author': {
                        'nickname': post.get('author', {}).get('nickname', ''),
                        'sec_uid': post.get('author', {}).get('sec_uid', ''),
                        'avatar_thumb': post.get('author', {}).get('avatar_thumb', {}).get('url_list', [''])[0] if post.get('author', {}).get('avatar_thumb') else ''
                    }
                })

            if include_pagination:
                return {
                    'data': video_list,
                    'cursor': next_cursor,
                    'has_more': bool(has_more),
                }
            return video_list
        except Exception as e:
            if self.debug_mode:
                print(f"\033[91m[UserManager] 获取点赞视频时出错: {e}\033[0m")
            else:
                print(f"\033[91m获取点赞视频时出错: {e}\033[0m")
            if self._looks_like_login_error(e):
                return self._login_required_message('点赞视频')
            return []

    # ---------- 点赞/关注/收藏操作 ----------

    async def set_video_liked(self, aweme_id: str, liked: bool) -> dict:
        """点赞或取消点赞作品。"""
        aweme_id = str(aweme_id or '').strip()
        if not aweme_id:
            return {'_error': True, 'message': '作品ID不能为空'}

        resp, success = await self.api.signed_form_action_request(
            '/aweme/v1/web/commit/item/digg/',
            {
                'aweme_id': aweme_id,
                'item_type': '0',
                'type': '1' if liked else '0',
            },
            {
                'Referer': 'https://www.douyin.com/',
                'Origin': 'https://www.douyin.com',
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            },
            host='https://www-hj.douyin.com',
        )

        if not success:
            return resp if isinstance(resp, dict) else {'_error': True, 'message': '点赞失败'}

        return {
            'success': True,
            'aweme_id': aweme_id,
            'is_liked': liked,
            'raw': resp,
            'message': '点赞成功' if liked else '已取消点赞',
        }

    async def set_user_followed(self, user_id: str, follow: bool) -> dict:
        """关注或取消关注用户。"""
        user_id = str(user_id or '').strip()
        if not user_id:
            return {'_error': True, 'message': '用户ID不能为空'}

        resp, success = await self.api.signed_form_action_request(
            '/aweme/v1/web/commit/follow/user/',
            {
                'type': '1' if follow else '0',
                'user_id': user_id,
            },
            {
                'Referer': 'https://www.douyin.com/',
                'Origin': 'https://www.douyin.com',
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            },
            host='https://www-hj.douyin.com',
        )

        if not success:
            return resp if isinstance(resp, dict) else {'_error': True, 'message': '关注失败'}

        return {
            'success': True,
            'user_id': user_id,
            'is_follow': follow,
            'follow_status': int(resp.get('follow_status', 0)) if isinstance(resp, dict) else (1 if follow else 0),
            'raw': resp,
            'message': '关注成功' if follow else '已取消关注',
        }

    async def set_video_collected(self, aweme_id: str, collected: bool) -> dict:
        """收藏或取消收藏作品。"""
        aweme_id = str(aweme_id or '').strip()
        if not aweme_id:
            return {'_error': True, 'message': '作品ID不能为空'}

        resp, success = await self.api.signed_form_action_request(
            '/aweme/v1/web/aweme/collect/',
            {
                'action': '1' if collected else '0',
                'aweme_id': aweme_id,
                'aweme_type': '0',
            },
            {
                'Referer': 'https://www.douyin.com/',
                'Origin': 'https://www.douyin.com',
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            },
            host='https://www-hj.douyin.com',
        )

        if not success:
            return resp if isinstance(resp, dict) else {'_error': True, 'message': '收藏失败'}

        return {
            'success': True,
            'aweme_id': aweme_id,
            'is_collected': collected,
            'message': '收藏成功' if collected else '已取消收藏',
        }

    # ---------- 收藏视频/合集 ----------

    async def get_collected_videos(self, count=20, cursor=0):
        """获取收藏视频列表"""
        try:
            params = {
                'count': count,
                'cursor': cursor,
            }
            headers = {
                'Referer': 'https://www.douyin.com/user/self?from_tab_name=main&showTab=favorite_collection',
                'Origin': 'https://www.douyin.com',
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            }
            resp, succ = await self.api.common_request(
                '/aweme/v1/web/aweme/listcollection/',
                params,
                headers,
                method='POST',
            )
            if isinstance(resp, dict) and (resp.get('_need_verify') or resp.get('_need_login')):
                return resp
            if not succ:
                return {
                    '_error': True,
                    'message': (resp or {}).get('message') or (resp or {}).get('status_msg') or '获取收藏视频失败，请检查 Cookie 或稍后重试',
                }

            videos = [
                item for item in (self._build_collection_video_item(post) for post in (resp.get('aweme_list') or []))
                if item
            ]
            return {
                'data': videos,
                'cursor': self._response_cursor(resp),
                'has_more': self._response_has_more(resp),
            }
        except Exception as e:
            if self.debug_mode:
                print(f"\033[91m[UserManager] 获取收藏视频时出错: {e}\033[0m")
            if self._looks_like_login_error(e):
                return self._login_required_message('收藏视频')
            return {'_error': True, 'message': f'获取收藏视频失败: {e}'}

    async def get_collected_mixes(self, count=20, cursor=0):
        return await self.mix.get_collected_mixes(count, cursor)

    async def get_mix_videos(self, series_id, count=20, cursor=0):
        return await self.mix.get_mix_videos(series_id, count, cursor)

    # ---------- 下载点赞视频/作者 ----------

    async def download_liked_videos(self, count=20):
        return await self._mgr.download_workflows.download_liked_videos(count)

    async def get_liked_authors(self, count=20):
        """获取点赞作品的作者列表，返回与parse_share_link中user数据结构相同的格式"""
        try:
            params = {
                "count": count,
                "max_cursor": 0
            }

            resp, succ = await self.api.common_request('/aweme/v1/web/aweme/favorite/', params,
                                                     dict(self._FAVORITE_HEADERS),
                                                     skip_sign=True)
            if isinstance(resp, dict) and (resp.get('_need_verify') or resp.get('_need_login')):
                return resp
            if not succ:
                return {
                    '_error': True,
                    'message': (resp or {}).get('message') or (resp or {}).get('status_msg') or '获取点赞作者失败，请检查 Cookie 或稍后重试',
                }

            posts = resp.get('aweme_list', [])
            if not posts:
                return []

            unique_authors = []
            seen = set()
            for post in posts:
                author = post.get('author', {})
                sec_uid = author.get('sec_uid')
                if sec_uid and sec_uid not in seen:
                    seen.add(sec_uid)
                    unique_authors.append((sec_uid, author))

            detail_concurrency = max(1, min(int(getattr(Config, 'MAX_CONCURRENT', 3) or 1), 5))
            semaphore = asyncio.Semaphore(detail_concurrency)

            async def load_author_detail(sec_uid: str, author: dict) -> dict:
                async with semaphore:
                    user_detail = await self.get_user_detail(sec_uid)

                if user_detail:
                    return {
                        'nickname': user_detail.get('nickname', author.get('nickname', '')),
                        'unique_id': user_detail.get('unique_id', ''),
                        'follower_count': user_detail.get('follower_count', 0),
                        'following_count': user_detail.get('following_count', 0),
                        'total_favorited': user_detail.get('total_favorited', 0),
                        'aweme_count': user_detail.get('aweme_count', 0),
                        'signature': user_detail.get('signature', ''),
                        'sec_uid': sec_uid,
                        'avatar_thumb': user_detail.get('avatar_thumb', {}).get('url_list', [''])[0] if user_detail.get('avatar_thumb') else '',
                        'avatar_larger': user_detail.get('avatar_larger', {}).get('url_list', [''])[0] if user_detail.get('avatar_larger') else ''
                    }

                return {
                    'nickname': author.get('nickname', ''),
                    'unique_id': '',
                    'follower_count': 0,
                    'following_count': 0,
                    'total_favorited': 0,
                    'aweme_count': 0,
                    'signature': '',
                    'sec_uid': sec_uid,
                    'avatar_thumb': author.get('avatar_thumb', {}).get('url_list', [''])[0] if author.get('avatar_thumb') else '',
                }

            author_results = await asyncio.gather(
                *(load_author_detail(sec_uid, author) for sec_uid, author in unique_authors),
                return_exceptions=True,
            )

            authors = []
            for result in author_results:
                if isinstance(result, dict):
                    authors.append(result)

            return authors
        except Exception as e:
            if self.debug_mode:
                print(f"\033[91m[UserManager] 获取点赞作者时出错: {e}\033[0m")
            else:
                print(f"\033[91m获取点赞作者时出错: {e}\033[0m")
            return []

    async def download_liked_authors(self, count=20, selected_sec_uids=None):
        return await self._mgr.download_workflows.download_liked_authors(count, selected_sec_uids)
