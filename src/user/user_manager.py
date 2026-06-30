import asyncio
import os
import urllib.parse
from typing import List, Dict, Optional, Tuple, Union

from src.api.api import DouyinAPI
from src.downloader.downloader import DouyinDownloader
from src.user import media_selectors
from src.user import post_formatters
from src.user import user_stats
from src.user.favorites import FavoritesService
from src.user.download_workflows import DownloadWorkflows
from src.user.video_details import VideoDetailsService

# 移除增强下载器支持
ENHANCED_DOWNLOADER_AVAILABLE = False
EnhancedDouyinDownloader = None
USER_POST_PAGE_SIZE = 20

class DouyinUserManager:
    """抖音用户管理类"""
    def __init__(self, api: DouyinAPI, downloader: DouyinDownloader, socketio=None,cookie=None):
        self.api = api
        self.downloader = downloader
        self.socketio = socketio  # 添加WebSocket支持
        self.cookie = cookie
        # 用户详情缓存：{sec_user_id: (detail_dict, cached_at_monotonic)}
        self._user_detail_cache = {}
        self._user_detail_cache_ttl = 1800  # 30 分钟过期
        # 检查是否启用调试模式
        self.debug_mode = os.environ.get('DEBUG_MODE', '').lower() in ('true', '1', 'yes')
        if self.debug_mode:
            downloader_type = "Standard"
            print(f"\033[94m[UserManager] 调试模式已启用，使用 {downloader_type} 下载器\033[0m")
        # 点赞/收藏/合集服务（延迟初始化）
        self._favorites: FavoritesService | None = None
        # 用户作品下载流程服务（延迟初始化）
        self._download_workflows: DownloadWorkflows | None = None
        # 作品详情/分享链接服务（延迟初始化）
        self._video_details: VideoDetailsService | None = None

    @property
    def favorites(self) -> FavoritesService:
        """获取点赞/收藏/合集服务实例（懒加载）。"""
        if getattr(self, '_favorites', None) is None:
            self._favorites = FavoritesService(self)
        return self._favorites

    @property
    def download_workflows(self) -> DownloadWorkflows:
        """获取用户作品下载流程服务实例（懒加载）。"""
        if getattr(self, '_download_workflows', None) is None:
            self._download_workflows = DownloadWorkflows(self)
        return self._download_workflows

    @property
    def video_details(self) -> VideoDetailsService:
        """获取作品详情服务实例（懒加载）。"""
        if getattr(self, '_video_details', None) is None:
            self._video_details = VideoDetailsService(self)
        return self._video_details

    @staticmethod
    def _looks_like_login_error(error) -> bool:
        text = str(error or '').lower()
        return any(
            token in text
            for token in (
                '用户未登录',
                '未登录',
                '请先登录',
                '请先设置cookie',
                'cookie 为空',
                '登录态',
                '重新登录',
                'not login',
                'not logged in',
                'login required',
                'session expired',
            )
        )

    @staticmethod
    def _login_required_message(feature: str) -> dict:
        return {
            '_need_login': True,
            'message': f'请登录后获取{feature}',
        }

    def _count_value(self, value, default: int = 0) -> int:
        return user_stats.count_value(value, default)

    def _first_count(self, sources: list[dict], keys: tuple[str, ...]) -> int:
        return user_stats.first_count(sources, keys)

    def _search_user_needs_detail(self, user_info: dict, item: dict | None = None) -> bool:
        return user_stats.search_user_needs_detail(user_info, item)

    def _merge_user_detail(self, user_info: dict, detail: dict) -> None:
        user_stats.merge_user_detail(user_info, detail)

    async def _enrich_search_user_detail(self, item: dict, semaphore: asyncio.Semaphore) -> dict:
        user_info = item.get('user_info') if isinstance(item.get('user_info'), dict) else item
        if not isinstance(user_info, dict):
            return item
        sec_uid = str(user_info.get('sec_uid') or '').strip()
        if not sec_uid or not self._search_user_needs_detail(user_info, item):
            return item
        async with semaphore:
            try:
                detail = await self.get_user_detail(sec_uid)
                self._merge_user_detail(user_info, detail)
            except Exception as error:
                if self.debug_mode:
                    print(f"\033[93m[UserManager] 补全用户统计失败: {sec_uid}, {error}\033[0m")
        return item

    async def _enrich_search_users(self, users: list[dict]) -> list[dict]:
        if not users:
            return users
        semaphore = asyncio.Semaphore(3)
        return await asyncio.gather(
            *(self._enrich_search_user_detail(user, semaphore) for user in users)
        )

    def _first_url(self, value) -> str:
        return media_selectors.first_url(value)

    def _clean_video_download_url(self, url: str) -> str:
        return media_selectors.clean_video_download_url(url)

    def _is_watermark_url(self, url: str) -> bool:
        return media_selectors.is_watermark_url(url)

    def _video_download_quality(self) -> str:
        return media_selectors.video_download_quality()

    def _download_quality_target_height(self, quality: str) -> int:
        return media_selectors.download_quality_target_height(quality)

    def _quality_height_from_text(self, value) -> int:
        return media_selectors.quality_height_from_text(value)

    def _positive_int(self, value) -> int:
        return media_selectors.positive_int(value)

    def _nearest_standard_quality_height(self, value: int) -> int:
        return media_selectors.nearest_standard_quality_height(value)

    def _standard_quality_height_from_dimension(self, value: int) -> int:
        return media_selectors.standard_quality_height_from_dimension(value)

    def _long_side_quality_height(self, value: int) -> int:
        return media_selectors.long_side_quality_height(value)

    def _dimension_quality_height(self, width, height) -> int:
        return media_selectors.dimension_quality_height(width, height)

    def _bit_rate_metric(self, bit_rate: dict) -> int:
        return media_selectors.bit_rate_metric(bit_rate)

    def _bit_rate_height(self, bit_rate: dict) -> int:
        return media_selectors.bit_rate_height(bit_rate)

    def _collect_video_candidates(self, video_data: dict) -> list[dict]:
        return media_selectors.collect_video_candidates(video_data)

    def _is_dash_video_only_url(self, url: str) -> bool:
        return media_selectors.is_dash_video_only_url(url)

    def _select_video_url(self, video_data: dict) -> str:
        return media_selectors.select_video_url(video_data)

    def _select_dash_video_url(self, video_data: dict) -> str:
        return media_selectors.select_dash_video_url(video_data)

    def _select_dash_audio_url(self, video_data: dict) -> str:
        return media_selectors.select_dash_audio_url(video_data)

    def get_video_download_urls(self, video_data: dict) -> list[str]:
        return media_selectors.get_video_download_urls(video_data)

    def _build_video_media_urls(self, video_data: dict) -> list[dict]:
        return media_selectors.build_video_media_urls(video_data)

    def _available_video_quality_height(self, video_data: dict) -> int:
        return media_selectors.available_video_quality_height(video_data)

    def _video_quality_candidate_count(self, video_data: dict) -> int:
        return media_selectors.video_quality_candidate_count(video_data)

    def _bit_rate_download_key(self, bit_rate: dict) -> str:
        return media_selectors.bit_rate_download_key(bit_rate)

    def merge_video_download_candidates(self, primary: dict, secondary: dict) -> dict:
        merged = dict(primary or {})
        secondary = secondary or {}

        for key in (
            'play_addr',
            'preview_addr',
            'play_addr_h264',
            'play_addr_lowbr',
            'download_addr',
            'dash_addr',
            'audio_addr',
            'cover',
            'dynamic_cover',
            'origin_cover',
            'ratio',
        ):
            if not self._first_url(merged.get(key)) and self._first_url(secondary.get(key)):
                merged[key] = secondary.get(key)

        for key in ('width', 'height', 'duration'):
            try:
                current = int(merged.get(key) or 0)
            except (TypeError, ValueError):
                current = 0
            try:
                candidate = int(secondary.get(key) or 0)
            except (TypeError, ValueError):
                candidate = 0
            if current <= 0 and candidate > 0:
                merged[key] = secondary.get(key)

        bit_rates = [
            dict(item)
            for item in (merged.get('bit_rate') or [])
            if isinstance(item, dict)
        ]
        seen = {self._bit_rate_download_key(item) for item in bit_rates}
        for item in secondary.get('bit_rate') or []:
            if not isinstance(item, dict):
                continue
            key = self._bit_rate_download_key(item)
            if key and key not in seen:
                seen.add(key)
                bit_rates.append(dict(item))
        merged['bit_rate'] = bit_rates

        return merged

    def _video_display_url(self, video_data: dict, media_urls: list[dict] | None = None) -> str:
        return post_formatters.video_display_url(video_data, media_urls)

    def _normalize_duration_seconds(self, value) -> int:
        return post_formatters.normalize_duration_seconds(value)

    def _raw_duration_value(self, value) -> int:
        return post_formatters.raw_duration_value(value)

    def _extract_post_status(self, post: dict) -> dict:
        return post_formatters.extract_post_status(post)
        
    async def get_user_videos(self, user_id: str, offset: int = 0, limit: int = 1000, on_batch=None) -> Union[List[dict], Dict]:
        """获取用户视频列表
        Args:
            user_id: 用户的sec_uid
            offset: 偏移量 (内部通过max_cursor控制，offset用于控制返回数量)
            limit: 最大获取数量
            on_batch: 每获取一页数据时的回调函数，接收当前页的视频列表
        """
        videos = []
        max_cursor = 0
        has_more = True
        
        while has_more and len(videos) < limit:
            previous_cursor = max_cursor
            remaining = max(limit - len(videos), 1)
            request_count = min(USER_POST_PAGE_SIZE, remaining) if on_batch is not None else min(18, remaining)
            params = {
                "publish_video_strategy_type": 2,
                "max_cursor": max_cursor,
                "sec_user_id": user_id,
                "locate_query": False,
                'show_live_replay_strategy': 1,
                'need_time_list': 0,
                'time_list_query': 0,
                'whale_cut_token': '',
                'count': request_count
            }
            # 不再直接传递cookie，让API类处理cookie
            resp, succ = await self.api.common_request('/aweme/v1/web/aweme/post/', 
                                                     params, 
                                                     {}, skip_sign=True)
            if isinstance(resp, dict) and (resp.get('_need_verify') or resp.get('_need_login')):
                return resp
            if not succ:
                return {
                    '_error': True,
                    'message': (resp or {}).get('message') or (resp or {}).get('status_msg') or '获取用户作品失败，请检查 Cookie 或稍后重试',
                }
            
            batch = resp.get('aweme_list', [])
            next_cursor = resp.get('max_cursor', 0)
            next_has_more = resp.get('has_more', 0) == 1
            if not batch:
                if self.debug_mode:
                    print(f"\033[93m[UserManager] 用户作品分页返回空列表，停止继续抓取: user={user_id}, cursor={previous_cursor}, next_cursor={next_cursor}, has_more={next_has_more}\033[0m")
                break
            if on_batch and batch:
                on_batch(batch)
                # 让下载消费者有机会在下一页抓取前先处理已入队作品
                await asyncio.sleep(0)
                
            videos.extend(batch)
            max_cursor = next_cursor
            has_more = next_has_more
            if has_more and max_cursor == previous_cursor:
                if self.debug_mode:
                    print(f"\033[93m[UserManager] 用户作品分页游标未前进，停止继续抓取: user={user_id}, cursor={max_cursor}\033[0m")
                break
            
        return videos[:limit]

    async def get_user_detail(self, user_id: str, force_refresh: bool = False) -> dict:
        """获取用户详情"""
        import time
        if not force_refresh:
            cached = self._user_detail_cache.get(user_id)
            if cached is not None:
                detail, cached_at = cached
                if time.monotonic() - cached_at < self._user_detail_cache_ttl:
                    return dict(detail)
                else:
                    del self._user_detail_cache[user_id]

        params = {
            "sec_user_id": user_id,
            "personal_center_strategy": 1,
            "source": "channel_pc_web",
        }
        headers = {
            "Referer": "https://www.douyin.com/",
        }
        resp, succ = await self.api.common_request('/aweme/v1/web/user/profile/other/',
                                                 params, headers, skip_sign=True)
        if isinstance(resp, dict) and (resp.get('_need_verify') or resp.get('_need_login')):
            return resp
        if not succ:
            return {
                '_error': True,
                'message': (resp or {}).get('message') or (resp or {}).get('status_msg') or '获取用户详情失败，请检查 Cookie 或稍后重试',
            }
        result = resp.get('user', {}) if succ else {}
        if succ and isinstance(result, dict) and result:
            # follow_status 在 user 对象内: 0=未关注, 1=已关注, 2=互相关注
            # is_follow 字段可能不存在，用 follow_status 补全
            if not result.get('is_follow') and result.get('follow_status', 0):
                result['is_follow'] = True
            self._user_detail_cache[user_id] = (dict(result), time.monotonic())
        return result

    async def search_user(self, keyword: str) -> Optional[dict]:
        """搜索用户
        Returns:
            dict or list: URL搜索返回单个用户dict，关键词搜索返回用户列表
        """
        if self.debug_mode:
            print(f"\033[94m[UserManager] 开始搜索用户: {keyword}\033[0m")
        
        # 处理URL输入的情况
        if "https" in keyword:
            user_id = keyword.split("/")[-1].split("?")[0]
            if self.debug_mode:
                print(f"\033[93m[UserManager] 检测到URL输入，提取用户ID: {user_id}\033[0m")
            return {"sec_uid": user_id}
        
        # 处理抖音号搜索
        if keyword.startswith("@") or any(c.isdigit() for c in keyword):
            if self.debug_mode:
                print(f"\033[93m[UserManager] 检测到抖音号或包含数字的关键词，使用精确搜索\033[0m")
                
            params = {
                "keyword": keyword,
                "search_channel": 'aweme_user_web',
                "search_source": 'normal_search',
                "query_correct_type": '1',
                "is_filter_search": '0',
                'from_group_id': '',
                'offset': 0,
                'count': 1,
                'pc_search_top_1_params': '{"enable_ai_search_top_1":1}',
            }

            # 添加自定义请求头
            headers = {
                "Referer": "https://www.douyin.com/jingxuan/search/" + urllib.parse.quote(keyword) + "?type=user"
            }
            
            if self.debug_mode:
                print(f"\033[93m[UserManager] 发送抖音号搜索请求\033[0m")
                
            # 不再直接传递cookie，让API类处理cookie
            resp, succ = await self.api.common_request('/aweme/v1/web/discover/search/',
                                                     params,
                                                     headers, skip_sign=True)
                                                     
            if succ:
                user_list = self._extract_search_user_items(resp)
                if user_list:
                    user_list = await self._enrich_search_users(user_list)
                    if self.debug_mode:
                        print(f"\033[92m[UserManager] 搜索成功，找到用户\033[0m")
                    return user_list[0].get('user_info', user_list[0])  # 直接返回用户信息
                else:
                    if self.debug_mode:
                        print(f"\033[91m[UserManager] 搜索成功但未找到用户，响应: {resp}\033[0m")
            else:
                # 传递验证码信号
                if resp.get('_need_verify') or resp.get('_need_login'):
                    return resp
                if self.debug_mode:
                    print(f"\033[91m[UserManager] 搜索失败\033[0m")
            return None
            
        # 关键词搜索
        if self.debug_mode:
            print(f"\033[93m[UserManager] 使用关键词搜索: {keyword}\033[0m")
            
        params = {
            "keyword": keyword,
            "search_channel": 'aweme_user_web',
            "search_source": 'normal_search',
            "query_correct_type": '1',
            "is_filter_search": '0',
            'from_group_id': '',
            'offset': 0,
            'count': 10,
            'pc_search_top_1_params': '{"enable_ai_search_top_1":1}',
        }

        # 添加自定义请求头
        headers = {
            "Referer": "https://www.douyin.com/jingxuan/search/" + urllib.parse.quote(keyword) + "?type=user"
        }
        
        if self.debug_mode:
            print(f"\033[93m[UserManager] 发送关键词搜索请求\033[0m")

        resp, succ = await self.api.common_request('/aweme/v1/web/discover/search/',
                                                 params,
                                                 headers,
                                                 skip_sign=True)
        user_list = self._extract_search_user_items(resp) if succ else []
        if not succ or not user_list:
            # 传递验证码信号
            if resp.get('_need_verify') or resp.get('_need_login'):
                return resp
            if self.debug_mode:
                print(f"\033[91m[UserManager] 关键词搜索失败或未找到用户\033[0m")
            return None
        user_list = await self._enrich_search_users(user_list)
        
        if self.debug_mode:
            print(f"\033[92m[UserManager] 关键词搜索成功，找到 {len(user_list)} 个用户\033[0m")
        return user_list if user_list else None

    def _extract_search_user_items(self, resp: dict) -> list[dict]:
        """兼容 general/search/stream 与旧 discover/search 的用户列表结构。"""
        if not isinstance(resp, dict):
            return []

        users = resp.get('user_list')
        if isinstance(users, list):
            return [item for item in users if isinstance(item, dict)]

        result = []
        for group in resp.get('data') or []:
            if not isinstance(group, dict):
                continue
            group_users = group.get('user_list')
            if isinstance(group_users, list):
                result.extend(item for item in group_users if isinstance(item, dict))
        return result

    def _is_image_post(self, post: dict) -> bool:
        """判断是否为图片作品"""
        return post_formatters.is_image_post(post)

    def get_media_info(self, post: dict) -> Tuple[str, List[Dict[str, str]]]:
        return self.video_details.get_media_info(post)

    def _extract_bgm_url(self, post: dict) -> Optional[str]:
        """提取作品背景音乐地址。"""
        return post_formatters.extract_bgm_url(post)

    async def get_video_detail(self, aweme_id: str) -> Optional[dict]:
        return await self.video_details.get_video_detail(aweme_id)

    async def parse_share_link(self, share_link: str) -> Optional[dict]:
        return await self.video_details.parse_share_link(share_link)

    def _get_media_info(self, post: dict) -> tuple[str, list]:
        """兼容旧调用，返回与 get_media_info 相同的统一结构。"""
        return self.get_media_info(post)

    def _media_type_label(self, media_type: str, media_urls: list[dict]) -> str:
        return post_formatters.media_type_label(media_type, media_urls)

    async def download_user_videos(self, user_info: dict, auto_confirm: bool = False,web_socket: bool = False):
        return await self.download_workflows.download_user_videos(user_info, auto_confirm=auto_confirm, web_socket=web_socket)

    async def get_liked_videos(self, count=20, cursor=0, include_pagination=False):
        return await self.favorites.get_liked_videos(count, cursor, include_pagination)

    def _build_collection_video_item(self, post):
        return self.favorites._build_collection_video_item(post)

    @staticmethod
    def _boolish(value) -> bool:
        return FavoritesService._boolish(value)

    @classmethod
    def _post_boolish(cls, post: dict, *keys: str, default: bool = False) -> bool:
        return FavoritesService._post_boolish(post, *keys, default=default)

    async def set_video_liked(self, aweme_id: str, liked: bool) -> dict:
        return await self.favorites.set_video_liked(aweme_id, liked)

    async def set_user_followed(self, user_id: str, follow: bool) -> dict:
        return await self.favorites.set_user_followed(user_id, follow)

    async def set_video_collected(self, aweme_id: str, collected: bool) -> dict:
        return await self.favorites.set_video_collected(aweme_id, collected)

    @staticmethod
    def _response_has_more(resp):
        return FavoritesService._response_has_more(resp)

    @staticmethod
    def _response_cursor(resp):
        return FavoritesService._response_cursor(resp)

    async def get_collected_videos(self, count=20, cursor=0):
        return await self.favorites.get_collected_videos(count, cursor)

    async def get_collected_mixes(self, count=20, cursor=0):
        return await self.favorites.get_collected_mixes(count, cursor)

    async def get_mix_videos(self, series_id, count=20, cursor=0):
        return await self.favorites.get_mix_videos(series_id, count, cursor)

    async def download_liked_videos(self, count=20):
        return await self.favorites.download_liked_videos(count)

    async def get_liked_authors(self, count=20):
        return await self.favorites.get_liked_authors(count)

    async def download_liked_authors(self, count=20, selected_sec_uids=None):
        return await self.favorites.download_liked_authors(count, selected_sec_uids)
