import asyncio
import logging
import os
import urllib.parse
from typing import List, Dict, Optional, Tuple, Union

from src.api.api import DouyinAPI
from src.config.config import Config
from src.downloader.downloader import DouyinDownloader, build_download_name
from src.user import media_selectors
from src.user import post_formatters
from src.user import user_stats
from src.user.favorites import FavoritesService
from src.user.download_workflows import DownloadWorkflows

# 移除增强下载器支持
ENHANCED_DOWNLOADER_AVAILABLE = False
EnhancedDouyinDownloader = None
logger = logging.getLogger(__name__)

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
            request_count = 18 if on_batch is None else min(50, max(18, limit - len(videos)))
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
            if on_batch and batch:
                on_batch(batch)
                # 让下载消费者有机会在下一页抓取前先处理已入队作品
                await asyncio.sleep(0)
                
            videos.extend(batch)
            max_cursor = resp.get('max_cursor', 0)
            has_more = resp.get('has_more', 0) == 1
            
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
        """从帖子数据中提取媒体信息 (URL, 类型)

        Args:
            post: 单个作品的字典数据

        Returns:
            一个元组，包含:
            - str: 媒体类型 ('video', 'image', 'live_photo', 'mixed', 'unknown')
            - list: 包含媒体URL和类型的字典列表
        """
        urls = []
        media_type = 'unknown'

        # 检查是否为图文帖
        if post.get("images"):
            images = post["images"]
            has_live = False
            has_image = False

            for img in images:
                # Live Photo: 包含video字段且有play_addr
                if img.get("video") and img["video"].get("play_addr"):
                    has_live = True
                    video_urls = img["video"]["play_addr"].get("url_list", [])
                    if video_urls:
                        urls.append({
                            'type': 'live_photo',
                            'url': video_urls[0]
                        })
                # 普通图片
                elif img.get("url_list"):
                    has_image = True
                    urls.append({
                        'type': 'image',
                        'url': img["url_list"][-1]  # 通常是最高质量的
                    })

            if has_live and has_image:
                media_type = 'mixed'
            elif has_live:
                media_type = 'live_photo'
            elif has_image:
                media_type = 'image'

        # 检查是否为视频帖
        elif post.get("video") and post["video"].get("play_addr"):
            video_urls = self._build_video_media_urls(post.get("video") or {})
            if video_urls:
                media_type = 'video'
                urls.extend(video_urls)

        return media_type, urls

    def _extract_bgm_url(self, post: dict) -> Optional[str]:
        """提取作品背景音乐地址。"""
        return post_formatters.extract_bgm_url(post)

    async def get_video_detail(self, aweme_id: str) -> Optional[dict]:
        """根据作品ID获取视频详情

        Args:
            aweme_id: 作品ID

        Returns:
            dict: 视频详情信息，包含媒体 URL 等
        """
        try:
            # 通过作品ID获取详情的API接口
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

            if isinstance(resp, dict) and (resp.get('_need_verify') or resp.get('_need_login')):
                return resp

            if not succ or not resp.get('aweme_detail'):
                logger.warning(f"获取视频详情失败: succ={succ}, aweme_id={aweme_id}")
                return None

            post = resp['aweme_detail']
            
            # 获取媒体信息
            media_type, urls = self.get_media_info(post)
            video_data = post.get('video') or {}
            play_url = self._first_url(video_data.get('play_addr'))
            selected_video_url = self._select_video_url(video_data)
            dash_video_url = self._select_dash_video_url(video_data)
            dash_audio_url = self._select_dash_audio_url(video_data)
            # 构建详情信息
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
                # 保留原始数据字段用于调试
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
            
            # 获取封面图
            if media_type == 'video':
                detail['cover_url'] = self._first_url(video_data.get('cover'))
            elif media_type in ['image', 'live_photo', 'mixed']:
                images = post.get('images', [])
                if images:
                    detail['cover_url'] = self._first_url(images[0])

            detail['bgm_url'] = dash_audio_url or self._extract_bgm_url(post)

            return detail
            
        except Exception as e:
             if self.debug_mode:
                 print(f"\033[91m[UserManager] 获取视频详情失败: {str(e)}\033[0m")
             return None

    async def parse_share_link(self, share_link: str) -> Optional[dict]:
        """解析抖音分享链接
        Args:
            share_link: 抖音分享链接
        Returns:
            dict: 视频信息
        """
        try:
            # 提取真实的视频链接
            import re
            import aiohttp
            # 从分享文本中提取URL
            url_pattern = r'https?://[^\s<>"]+|www\.[^\s<>"]+'
            match = re.search(url_pattern, share_link)
            if match:
                share_link = re.split(r'[，。！？；、,!;]', match.group(), maxsplit=1)[0].strip().rstrip('，。！？；、,.!;')
            else:
                share_link = re.split(r'[，。！？；、,!;]', share_link.strip(), maxsplit=1)[0].strip().rstrip('，。！？；、,.!;')
            if share_link.startswith('www.'):
                share_link = f'https://{share_link}'
            # 如果是短链接，需要先获取重定向后的真实链接
            if 'v.douyin.com' in share_link:
                try:
                    timeout = aiohttp.ClientTimeout(total=10)  # 设置10秒超时
                    # 创建SSL上下文，跳过证书验证
                    ssl_context = False  # 禁用SSL验证
                    connector = aiohttp.TCPConnector(ssl=ssl_context)
                    async with aiohttp.ClientSession(timeout=timeout, connector=connector) as session:
                        async with session.get(share_link, allow_redirects=False) as response:
                            if response.status in [301, 302]:
                                real_url = response.headers.get('Location', '')
                                if real_url:
                                    share_link = real_url
                except (aiohttp.ClientError, asyncio.TimeoutError) as e:
                    if self.debug_mode:
                        print(f"\033[93m[UserManager] 获取重定向链接失败: {str(e)}，使用原链接\033[0m")
                    # 如果重定向失败，继续使用原链接
            if self.debug_mode:
                print(f"\033[94m[UserManager] 重定向后的URL: {share_link}\033[0m")
            # 从链接中提取视频ID
            aweme_id_match = re.search(r'/video/(\d+)', share_link)
            if not aweme_id_match:
                # 尝试其他模式
                aweme_id_match = re.search(r'aweme_id=(\d+)', share_link)
                if not aweme_id_match:
                    aweme_id_match = re.search(r'modal_id=(\d+)', share_link)
            
            if not aweme_id_match:
                return None
                
            aweme_id = aweme_id_match.group(1)
            if self.debug_mode:
                print(f"\033[94m[UserManager] 提取的视频ID: {aweme_id}\033[0m")
            # 尝试获取完整详情
            detail = await self.get_video_detail(aweme_id)
            if detail:
                return detail

            # get_video_detail 失败时，返回基本信息
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
                '_incomplete': True,  # 标记为不完整数据
            }
            
        except Exception as e:
            if self.debug_mode:
                print(f"\033[91m[UserManager] 解析分享链接失败: {str(e)}\033[0m")
            return None

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
