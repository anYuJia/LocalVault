import asyncio
import json
import logging
import os
import urllib.parse
from typing import List, Dict, Optional, Tuple, Union

from src.api.api import DouyinAPI
from src.config.config import Config
from src.downloader.downloader import DouyinDownloader, build_download_name

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
        if isinstance(value, bool):
            return default
        if isinstance(value, (int, float)):
            return max(0, int(round(value)))
        if isinstance(value, str):
            text = value.strip().replace(',', '')
            if not text:
                return default
            multiplier = 1
            suffix = text[-1].lower()
            if suffix in ('w', '万'):
                multiplier = 10000
                text = text[:-1]
            elif suffix in ('k', '千'):
                multiplier = 1000
                text = text[:-1]
            try:
                return max(0, int(round(float(text) * multiplier)))
            except ValueError:
                return default
        return default

    def _first_count(self, sources: list[dict], keys: tuple[str, ...]) -> int:
        for source in sources:
            if not isinstance(source, dict):
                continue
            for key in keys:
                count = self._count_value(source.get(key), -1)
                if count >= 0:
                    return count
        return 0

    def _search_user_needs_detail(self, user_info: dict, item: dict | None = None) -> bool:
        item = item if isinstance(item, dict) else {}
        user_info = user_info if isinstance(user_info, dict) else {}
        sources = [
            user_info,
            user_info.get('stats') or {},
            user_info.get('card_info') or {},
            user_info.get('extra') or {},
            item,
            item.get('stats') or {},
            item.get('card_info') or {},
        ]
        aweme_count = self._first_count(sources, (
            'aweme_count',
            'aweme_count_str',
            'aweme_count_text',
            'work_count',
            'work_count_str',
            'works_count',
            'works_count_str',
            'video_count',
            'video_count_str',
        ))
        following_count = self._first_count(sources, (
            'following_count',
            'following_count_str',
            'following_count_text',
            'follow_count',
            'follow_count_str',
            'follow_count_text',
        ))
        return aweme_count <= 0 or following_count <= 0

    def _merge_user_detail(self, user_info: dict, detail: dict) -> None:
        if not isinstance(user_info, dict) or not isinstance(detail, dict):
            return
        if detail.get('_need_verify') or detail.get('_need_login') or detail.get('_error'):
            return

        for key in (
            'uid',
            'nickname',
            'unique_id',
            'sec_uid',
            'signature',
            'avatar_thumb',
            'avatar_medium',
            'avatar_larger',
            'is_follow',
            'follow_status',
            'verify_status',
        ):
            if detail.get(key) and not user_info.get(key):
                user_info[key] = detail.get(key)

        for key in (
            'follower_count',
            'following_count',
            'total_favorited',
            'aweme_count',
            'favoriting_count',
        ):
            detail_count = self._count_value(detail.get(key), -1)
            current_count = self._count_value(user_info.get(key), -1)
            if detail_count >= 0 and (current_count < 0 or detail_count > current_count):
                user_info[key] = detail_count

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
        if isinstance(value, str):
            return value.strip()

        if isinstance(value, dict):
            url_list = value.get('url_list')
            if isinstance(url_list, list):
                for item in url_list:
                    if isinstance(item, str) and item.strip():
                        return item.strip()
            for key in (
                'url',
                'main_url',
                'backup_url',
                'fallback_url',
                'play_addr',
                'play_url',
                'download_addr',
                'download_url',
                'display_url',
                'uri',
            ):
                nested = value.get(key)
                if nested is not None and nested is not value:
                    url = self._first_url(nested)
                    if key == 'uri' and not url.lower().startswith(('http://', 'https://')):
                        continue
                    if url:
                        return url

        if isinstance(value, list):
            for item in value:
                url = self._first_url(item)
                if url:
                    return url

        return ''

    def _clean_video_download_url(self, url: str) -> str:
        normalized_url = str(url or '').strip()
        if not normalized_url:
            return ''
        return (
            normalized_url
            .replace('watermark=1', 'watermark=0')
            .replace('playwm', 'play')
        )

    def _is_watermark_url(self, url: str) -> bool:
        normalized_url = str(url or '').strip().lower()
        if not normalized_url:
            return False
        return (
            'playwm' in normalized_url
            or 'watermark=1' in normalized_url
            or '/aweme/v1/playwm' in normalized_url
        )

    def _video_download_quality(self) -> str:
        return Config.normalize_download_quality(getattr(Config, 'DOWNLOAD_QUALITY', 'auto'))

    def _download_quality_target_height(self, quality: str) -> int:
        return {
            '480p': 480,
            '720p': 720,
            '1080p': 1080,
            '2k': 1440,
            '1440p': 1440,
            '4k': 2160,
            '2160p': 2160,
        }.get(str(quality or '').strip().lower(), 0)

    def _quality_height_from_text(self, value) -> int:
        text = str(value or '').strip().lower()
        if not text:
            return 0
        if '4k' in text or 'uhd' in text or '2160' in text:
            return 2160
        if '2k' in text or 'qhd' in text or '1440' in text:
            return 1440

        for token in ''.join(ch if ch.isalnum() else ' ' for ch in text).split():
            raw = token[:-1] if token.endswith('p') else token
            try:
                height = int(raw)
            except (TypeError, ValueError):
                continue
            if 240 <= height <= 4320:
                return height
        return 0

    def _positive_int(self, value) -> int:
        try:
            number = int(value or 0)
        except (TypeError, ValueError):
            return 0
        return number if number > 0 else 0

    def _nearest_standard_quality_height(self, value: int) -> int:
        value = self._positive_int(value)
        if value <= 0:
            return 0

        standard_heights = (4320, 2160, 1440, 1080, 720, 540, 480, 360, 240)
        nearest = min(standard_heights, key=lambda height: abs(height - value))
        tolerance = max(24, int(nearest * 0.12))
        if abs(nearest - value) <= tolerance:
            return nearest

        return value if 240 <= value <= 4320 else 0

    def _standard_quality_height_from_dimension(self, value: int) -> int:
        value = self._positive_int(value)
        if value <= 0:
            return 0

        standard_heights = (4320, 2160, 1440, 1080, 720, 540, 480, 360, 240)
        nearest = min(standard_heights, key=lambda height: abs(height - value))
        tolerance = max(16, int(nearest * 0.04))
        return nearest if abs(nearest - value) <= tolerance else 0

    def _long_side_quality_height(self, value: int) -> int:
        value = self._positive_int(value)
        if value <= 0:
            return 0

        long_side_to_quality = (
            (3840, 2160),
            (2560, 1440),
            (1920, 1080),
            (1280, 720),
            (960, 540),
            (854, 480),
            (852, 480),
        )
        for long_side, quality_height in long_side_to_quality:
            if abs(value - long_side) <= max(24, int(long_side * 0.04)):
                return quality_height
        return 0

    def _dimension_quality_height(self, width, height) -> int:
        width = self._positive_int(width)
        height = self._positive_int(height)

        if width > 0 and height > 0:
            candidates = [
                self._standard_quality_height_from_dimension(width),
                self._standard_quality_height_from_dimension(height),
                self._long_side_quality_height(width),
                self._long_side_quality_height(height),
            ]
            measured = [candidate for candidate in candidates if candidate > 0]
            if measured:
                return max(measured)
            return self._nearest_standard_quality_height(max(width, height))

        value = width or height
        if value <= 0:
            return 0

        return (
            self._standard_quality_height_from_dimension(value)
            or self._long_side_quality_height(value)
            or self._nearest_standard_quality_height(value)
        )

    def _bit_rate_metric(self, bit_rate: dict) -> int:
        for key in ('data_size', 'bit_rate', 'quality_type'):
            try:
                value = int(bit_rate.get(key) or 0)
            except (TypeError, ValueError):
                value = 0
            if value > 0:
                return value

        try:
            width = int(bit_rate.get('width') or 0)
            height = int(bit_rate.get('height') or 0)
        except (TypeError, ValueError):
            return 0
        return width * height if width > 0 and height > 0 else 0

    def _bit_rate_height(self, bit_rate: dict) -> int:
        heights = []
        gear_height = self._quality_height_from_text(bit_rate.get('gear_name'))
        if gear_height > 0:
            heights.append(gear_height)

        try:
            quality_type = int(bit_rate.get('quality_type') or 0)
        except (TypeError, ValueError):
            quality_type = 0
        if quality_type in (72, 73):
            heights.append(2160)

        dimension_height = self._dimension_quality_height(
            bit_rate.get('width'),
            bit_rate.get('height'),
        )
        if dimension_height > 0:
            heights.append(dimension_height)

        return max(heights, default=0)

    def _collect_video_candidates(self, video_data: dict) -> list[dict]:
        candidates = []
        seen = set()

        top_level_height = max(
            self._dimension_quality_height(video_data.get('width'), video_data.get('height')),
            self._quality_height_from_text(video_data.get('ratio')),
        )
        lowbr_height = min(top_level_height, 480) if top_level_height > 0 else 480

        def push_candidate(
            url: str,
            metric: int,
            height: int = 0,
            is_h264: bool = False,
            is_quality_candidate: bool = False,
            is_download_addr: bool = False,
            is_lowbr: bool = False,
        ) -> None:
            normalized_url = self._clean_video_download_url(url)
            if (
                not normalized_url
                or normalized_url in seen
                or self._is_dash_video_only_url(normalized_url)
            ):
                return
            seen.add(normalized_url)
            candidates.append({
                'url': normalized_url,
                'metric': int(metric or 0),
                'height': int(height or 0),
                'is_h264': bool(is_h264),
                'is_quality_candidate': bool(is_quality_candidate),
                'is_download_addr': bool(is_download_addr),
                'is_lowbr': bool(is_lowbr),
                'is_watermark': self._is_watermark_url(normalized_url),
            })

        push_candidate(self._first_url(video_data.get('download_addr')), 0, top_level_height, False, False, True, False)
        push_candidate(self._first_url(video_data.get('play_addr_h264')), 0, top_level_height, True, False, False, False)
        push_candidate(self._first_url(video_data.get('play_addr_lowbr')), 1, lowbr_height, True, False, False, True)

        for bit_rate in video_data.get('bit_rate') or []:
            if not isinstance(bit_rate, dict):
                continue
            metric = self._bit_rate_metric(bit_rate)
            height = self._bit_rate_height(bit_rate)
            h264_metric = metric + 1 if metric > 0 else 0
            push_candidate(self._first_url(bit_rate.get('play_addr_h264')), h264_metric, height, True, True, False, False)
            push_candidate(
                self._first_url(bit_rate.get('play_addr')),
                metric,
                height,
                not bool(bit_rate.get('is_h265')),
                True,
                False,
                False,
            )

        push_candidate(self._first_url(video_data.get('preview_addr')), 0, top_level_height, False, False, False, False)
        push_candidate(self._first_url(video_data.get('play_addr')), 0, top_level_height, False, False, False, False)
        return candidates

    def _is_dash_video_only_url(self, url: str) -> bool:
        text = str(url or '').lower()
        return 'media-video' in text or 'media_video' in text

    def _select_video_url(self, video_data: dict) -> str:
        urls = self.get_video_download_urls(video_data)
        return urls[0] if urls else ''

    def _select_dash_video_url(self, video_data: dict) -> str:
        for bit_rate in (video_data or {}).get('bit_rate') or []:
            if not isinstance(bit_rate, dict) or bit_rate.get('format') != 'dash' or bit_rate.get('is_h265'):
                continue
            urls = (bit_rate.get('play_addr') or {}).get('url_list') or []
            for url in urls:
                text = str(url or '').strip()
                if text and 'media-video' in text:
                    return text
            for url in urls:
                text = str(url or '').strip()
                if text:
                    return text
        return ''

    def _select_dash_audio_url(self, video_data: dict) -> str:
        for audio_rate in (video_data or {}).get('bit_rate_audio') or []:
            url_list = ((audio_rate or {}).get('audio_meta') or {}).get('url_list') or {}
            for key in ('main_url', 'backup_url', 'fallback_url'):
                text = str(url_list.get(key) or '').strip()
                if text:
                    return text
        return ''

    def get_video_download_urls(self, video_data: dict) -> list[str]:
        candidates = self._collect_video_candidates(video_data or {})
        if not candidates:
            return []

        clean_candidates = [candidate for candidate in candidates if not candidate['is_watermark']]
        if not clean_candidates:
            return []

        ordered = []
        seen = set()

        def push(candidate) -> None:
            if not candidate:
                return
            url = candidate.get('url', '')
            if url and url not in seen:
                seen.add(url)
                ordered.append(url)

        download_addr = next((candidate for candidate in clean_candidates if candidate['is_download_addr']), None)
        h264_candidates = [
            candidate for candidate in clean_candidates
            if candidate['is_h264'] and not candidate['is_lowbr']
        ]
        h264_best = max(h264_candidates, key=lambda item: item['metric'], default=None)
        quality_candidates = [
            candidate for candidate in clean_candidates
            if candidate['metric'] > 0 and not candidate['is_download_addr'] and not candidate['is_lowbr']
        ]
        highest_metric = max(quality_candidates, key=lambda item: item['metric'], default=None)
        lowbr = next((candidate for candidate in clean_candidates if candidate['is_lowbr']), None)
        metric_candidates = [candidate for candidate in clean_candidates if candidate['metric'] > 0]
        smallest_metric = min(metric_candidates, key=lambda item: item['metric'], default=None)
        first = clean_candidates[0] if clean_candidates else None

        def best_target_candidate(target_height: int):
            explicit_measured = [
                candidate for candidate in clean_candidates
                if candidate.get('is_quality_candidate')
                and int(candidate.get('height') or 0) > 0
                and not candidate['is_download_addr']
            ]
            measured = explicit_measured or [
                candidate for candidate in clean_candidates
                if int(candidate.get('height') or 0) > 0 and not candidate['is_download_addr']
            ]
            lower_or_equal = [
                candidate for candidate in measured
                if int(candidate.get('height') or 0) <= target_height
            ]
            if lower_or_equal:
                return max(
                    lower_or_equal,
                    key=lambda item: (
                        int(item.get('height') or 0),
                        1 if item.get('is_h264') else 0,
                        int(item.get('metric') or 0),
                    ),
                )

            higher = [
                candidate for candidate in measured
                if int(candidate.get('height') or 0) > target_height
            ]
            if higher:
                return min(
                    higher,
                    key=lambda item: (
                        int(item.get('height') or 0),
                        0 if item.get('is_h264') else 1,
                        -int(item.get('metric') or 0),
                    ),
                )
            return None

        quality = self._video_download_quality()
        target_height = self._download_quality_target_height(quality)
        if target_height > 0:
            target_best = best_target_candidate(target_height)
            target_h264 = None
            if target_best:
                selected_height = int(target_best.get('height') or 0)
                target_h264 = next(
                    (
                        candidate for candidate in clean_candidates
                        if candidate['is_h264']
                        and int(candidate.get('height') or 0) == selected_height
                        and not candidate['is_lowbr']
                        and not candidate['is_download_addr']
                    ),
                    None,
                )
            for candidate in (target_best, target_h264, highest_metric, h264_best, download_addr, first):
                push(candidate)
        elif quality == 'highest':
            for candidate in (highest_metric, h264_best, download_addr, first):
                push(candidate)
        elif quality == 'h264':
            for candidate in (h264_best, highest_metric, download_addr, first):
                push(candidate)
        elif quality == 'smallest':
            for candidate in (lowbr, smallest_metric, h264_best, first):
                push(candidate)
        else:
            for candidate in (h264_best, highest_metric, download_addr, first):
                push(candidate)

        if target_height > 0:
            rest = sorted(
                clean_candidates,
                key=lambda item: (
                    abs(int(item.get('height') or 0) - target_height)
                    if int(item.get('height') or 0) > 0
                    else 99999,
                    -int(item.get('height') or 0),
                    -int(item.get('metric') or 0),
                ),
            )
        else:
            rest = sorted(clean_candidates, key=lambda item: item['metric'], reverse=True)
        for candidate in rest:
            push(candidate)

        return ordered

    def _build_video_media_urls(self, video_data: dict) -> list[dict]:
        video_data = video_data or {}
        selected_url = self._select_video_url(video_data)
        return [{'type': 'video', 'url': selected_url}] if selected_url else []

    def _available_video_quality_height(self, video_data: dict) -> int:
        return max(
            (
                int(candidate.get('height') or 0)
                for candidate in self._collect_video_candidates(video_data or {})
                if not candidate.get('is_watermark')
                and not candidate.get('is_download_addr')
                and not candidate.get('is_lowbr')
                and int(candidate.get('height') or 0) > 0
            ),
            default=0,
        )

    def _video_quality_candidate_count(self, video_data: dict) -> int:
        return sum(
            1
            for candidate in self._collect_video_candidates(video_data or {})
            if not candidate.get('is_watermark')
            and candidate.get('is_quality_candidate')
            and not candidate.get('is_download_addr')
            and not candidate.get('is_lowbr')
        )

    def _bit_rate_download_key(self, bit_rate: dict) -> str:
        url_key = '|'.join(
            url for url in (
                self._first_url(bit_rate.get('play_addr_h264')),
                self._first_url(bit_rate.get('play_addr')),
            )
            if url
        )
        if url_key:
            return url_key
        return json.dumps([
            bit_rate.get('gear_name') or '',
            bit_rate.get('format') or '',
            bit_rate.get('quality_type') or 0,
            bit_rate.get('width') or 0,
            bit_rate.get('height') or 0,
            bit_rate.get('data_size') or 0,
        ], ensure_ascii=False, separators=(',', ':'))

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
        selected_url = self._select_video_url(video_data or {})
        if selected_url:
            return selected_url

        for item in media_urls or []:
            if not isinstance(item, dict):
                continue
            url = self._first_url(item.get('url') or item.get('play_addr') or item.get('download_addr'))
            if url and str(item.get('type') or '').lower() == 'video':
                return self._clean_video_download_url(url)

        for item in media_urls or []:
            if not isinstance(item, dict):
                continue
            url = self._first_url(item.get('url') or item.get('play_addr') or item.get('download_addr'))
            if url:
                return self._clean_video_download_url(url)

        return ''

    def _normalize_duration_seconds(self, value) -> int:
        try:
            duration = float(value or 0)
        except (TypeError, ValueError):
            return 0
        if duration > 1000:
            return int(round(duration / 1000))
        return int(round(duration))

    def _raw_duration_value(self, value) -> int:
        try:
            duration = float(value or 0)
        except (TypeError, ValueError):
            return 0
        return int(round(duration)) if duration > 0 else 0

    def _extract_post_status(self, post: dict) -> dict:
        status = post.get('status') or {}
        return {
            'is_delete': bool(status.get('is_delete', False)),
            'private_status': int(status.get('private_status') or 0),
            'review_status': int(status.get('review_status') or 0),
            'with_goods': bool(status.get('with_goods', False)),
            'is_prohibited': bool(status.get('is_prohibited', False)),
        }
        
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
        return post.get("images") is not None and len(post.get("images", [])) > 0

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
        bgm_url = None

        if post.get('music'):
            music_data = post['music']
            if isinstance(music_data.get('play_url'), dict):
                play_urls = music_data['play_url'].get('url_list', [])
                bgm_url = play_urls[0] if play_urls else None
            elif isinstance(music_data.get('play_url'), str):
                bgm_url = music_data['play_url']

            if not bgm_url:
                bgm_url = music_data.get('h5_url', '') or music_data.get('web_url', '')

            if not bgm_url and music_data.get('music_file'):
                if isinstance(music_data['music_file'], dict):
                    file_urls = music_data['music_file'].get('url_list', [])
                    bgm_url = file_urls[0] if file_urls else None
                elif isinstance(music_data['music_file'], str):
                    bgm_url = music_data['music_file']

        return bgm_url

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
        if media_type == 'mixed':
            live_count = sum(1 for item in media_urls if item.get('type') == 'live_photo')
            img_count = sum(1 for item in media_urls if item.get('type') == 'image')
            return f'图片({img_count}张)+Live图({live_count}张)'
        return {
            'video': '视频',
            'image': f'图片({len(media_urls)}张)',
            'live_photo': f'Live图({len(media_urls)}张)',
            'unknown': '未知'
        }.get(media_type, '未知')

    async def download_user_videos(self, user_info: dict, auto_confirm: bool = False,web_socket: bool = False):
        """下载用户视频
        Args:
            user_info: 用户信息
            auto_confirm: 是否自动确认下载（不需要用户输入）
            web_socket: 是否使用WebSocket返回下载进度
        """
        user_id = user_info['sec_uid']
        nickname = user_info.get('nickname', 'unknown')
        
        # 获取视频列表
        posts = await self.get_user_videos(user_id, limit=200)
        if isinstance(posts, dict):
            error_msg = posts.get('message') or f"未找到用户 {nickname} 的作品"
            if web_socket and self.socketio:
                self.socketio.emit('download_error', {'message': error_msg})
            else:
                print(f"\033[91m{error_msg}\033[0m")
            raise Exception(error_msg)
        if not posts:
            error_msg = f"未找到用户 {nickname} 的作品"
            if web_socket and self.socketio:
                self.socketio.emit('download_error', {'message': error_msg})
            else:
                print(f"\033[91m{error_msg}\033[0m")
            raise Exception(error_msg)

        # 过滤出磁盘上仍然存在的已下载作品；如果用户删除了文件，允许重新下载。
        new_posts = [
            post for post in posts
            if not self.downloader._is_aweme_downloaded(post['aweme_id'], nickname)
        ]
        
        if not new_posts:
            info_msg = f"用户 {nickname} 没有新作品需要下载"
            if web_socket and self.socketio:
                self.socketio.emit('download_info', {'message': info_msg})
            else:
                print(f"\033[93m{info_msg}\033[0m")
            return
            
        found_msg = f"找到 {len(new_posts)} 个新作品"
        if web_socket and self.socketio:
            self.socketio.emit('download_info', {'message': found_msg})
        else:
            print(f"\n\033[36m{found_msg}\033[0m")
        
        # 如果是自动确认模式或WebSocket模式，直接下载所有作品
        if auto_confirm or web_socket:
            selected_posts = new_posts
        else:
            # 显示作品列表
            for i, post in enumerate(new_posts):
                media_type, urls = self._get_media_info(post)
                type_str = self._media_type_label(media_type, urls)
                
                print(f"\033[36m{i}. [{type_str}] {post['desc']}\033[0m")

            # 处理用户输入
            str_sub = input("\033[31m请输入要下载的序号\n1. 单个数字下载单个作品，多个数字用空格隔开下载多个作品\n2. 片段用-隔开\n3. 直接回车下载全部\033[0m\n")
            
            selected_posts = []
            if str_sub:
                for part in str_sub.split():
                    if '-' in part:
                        start, end = map(int, part.split('-'))
                        selected_posts.extend(new_posts[start:end+1])
                    else:
                        selected_posts.append(new_posts[int(part)])
            else:
                selected_posts = new_posts

        # 下载选中的作品
        for i, post in enumerate(selected_posts, 1):
            media_type, urls = self._get_media_info(post)
            type_str = self._media_type_label(media_type, urls)
            
            progress_msg = f"正在下载第 {i}/{len(selected_posts)} 个 [{type_str}]"
            if web_socket and self.socketio:
                self.socketio.emit('download_progress', {
                    'current': i,
                    'total': len(selected_posts),
                    'message': progress_msg,
                    'type': type_str
                })
            else:
                print(f"\033[36m{progress_msg}\033[0m")
            
            aweme_id = post['aweme_id']
            name = build_download_name(
                nickname,
                post.get('desc', ''),
                aweme_id,
                media_type=media_type,
                create_time=post.get('create_time'),
            )
            
            if not urls:
                error_msg = f"无法获取媒体URL: {post['desc']}"
                if web_socket and self.socketio:
                    self.socketio.emit('download_error', {'message': error_msg})
                else:
                    print(f"\033[91m{error_msg}\033[0m")
                continue
            
            if media_type in ['mixed', 'live_photo', 'image']:
                success = await asyncio.to_thread(
                    self.downloader.download_media_group,
                    urls,
                    name,
                    aweme_id,
                )
                if success:
                    success_msg = f"作品 {name} 下载完成"
                    if web_socket and self.socketio:
                        self.socketio.emit('download_success', {'message': success_msg})
                    else:
                        print(f"\033[92m{success_msg}\033[0m")
                else:
                    error_msg = f"作品 {name} 下载失败"
                    if web_socket and self.socketio:
                        self.socketio.emit('download_error', {'message': error_msg})
                    else:
                        print(f"\033[91m{error_msg}\033[0m")
                
            elif media_type == 'video':
                fallback_urls = self.get_video_download_urls(post.get('video') or {})
                success = await asyncio.to_thread(
                    self.downloader.download_video,
                    urls[0]['url'],
                    name,
                    aweme_id,
                    fallback_urls=fallback_urls,
                )
                if success:
                    success_msg = f"作品 {name} 下载完成"
                    if web_socket and self.socketio:
                        self.socketio.emit('download_success', {'message': success_msg})
                    else:
                        print(f"\033[92m{success_msg}\033[0m")
                else:
                    error_msg = f"作品 {name} 下载失败"
                    if web_socket and self.socketio:
                        self.socketio.emit('download_error', {'message': error_msg})
                    else:
                        print(f"\033[91m{error_msg}\033[0m")
            else:
                error_msg = f"未知的媒体类型: {post['desc']}"
                if web_socket and self.socketio:
                    self.socketio.emit('download_error', {'message': error_msg})
                else:
                    print(f"\033[91m{error_msg}\033[0m")

    # 点赞接口不需要签名
    _FAVORITE_HEADERS = {'Referer': 'https://www.douyin.com/'}

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
                    'bgm_url': dash_audio_url or self._extract_bgm_url(post),
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
            'bgm_url': dash_audio_url or self._extract_bgm_url(post),
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
                # Douyin web uses type=1 for digg and type=0 for cancel.
                # The response field is_digg is not reliable for persistence.
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

    @staticmethod
    def _response_has_more(resp):
        return resp.get('has_more') in (1, True, '1', 'true', 'True')

    @staticmethod
    def _response_cursor(resp):
        return resp.get('cursor') or resp.get('max_cursor') or resp.get('min_cursor') or 0

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
        """获取收藏合集列表"""
        try:
            params = {
                'count': count,
                'cursor': cursor,
            }
            headers = {
                'Referer': 'https://www.douyin.com/user/self?from_tab_name=main&showTab=favorite_collection',
            }
            resp, succ = await self.api.common_request(
                '/aweme/v1/web/mix/listcollection/',
                params,
                headers,
            )
            if isinstance(resp, dict) and (resp.get('_need_verify') or resp.get('_need_login')):
                return resp
            if not succ:
                return {
                    '_error': True,
                    'message': (resp or {}).get('message') or (resp or {}).get('status_msg') or '获取收藏合集失败，请检查 Cookie 或稍后重试',
                }

            mixes = []
            for item in resp.get('mix_infos', []) or []:
                mix_id = item.get('mix_id')
                if not mix_id:
                    continue
                author = item.get('author', {}) or {}
                statis = item.get('statis', {}) or {}
                cover_url = ''
                if item.get('cover_url'):
                    cover_url = item['cover_url'].get('url_list', [''])[0]
                mixes.append({
                    'mix_id': mix_id,
                    'mix_name': item.get('mix_name', ''),
                    'desc': item.get('desc', ''),
                    'cover_url': cover_url,
                    'author': {
                        'nickname': author.get('nickname', ''),
                        'sec_uid': author.get('sec_uid', ''),
                        'avatar_thumb': author.get('avatar_thumb', {}).get('url_list', [''])[0] if author.get('avatar_thumb') else '',
                    },
                    'statis': {
                        'collect_vv': statis.get('collect_vv', 0),
                        'play_vv': statis.get('play_vv', 0),
                        'updated_to_episode': statis.get('updated_to_episode', 0),
                    },
                    'create_time': item.get('create_time', 0),
                    'update_time': item.get('update_time', 0),
                    'mix_type': item.get('mix_type', 0),
                })

            return {
                'data': mixes,
                'cursor': self._response_cursor(resp),
                'has_more': self._response_has_more(resp),
            }
        except Exception as e:
            if self.debug_mode:
                print(f"\033[91m[UserManager] 获取收藏合集时出错: {e}\033[0m")
            if self._looks_like_login_error(e):
                return self._login_required_message('收藏合集')
            return {'_error': True, 'message': f'获取收藏合集失败: {e}'}

    async def get_mix_videos(self, series_id, count=20, cursor=0):
        """获取收藏合集内的视频列表"""
        try:
            params = {
                'series_id': series_id,
                'pull_type': 2,
                'cursor': cursor,
                'count': count,
            }
            headers = {
                'Referer': 'https://www.douyin.com/user/self?from_tab_name=main&showTab=favorite_collection',
            }
            resp, succ = await self.api.common_request(
                '/aweme/v1/web/series/aweme/',
                params,
                headers,
            )
            if isinstance(resp, dict) and (resp.get('_need_verify') or resp.get('_need_login')):
                return resp
            if not succ:
                return {
                    '_error': True,
                    'message': (resp or {}).get('message') or (resp or {}).get('status_msg') or '获取合集视频失败，请检查 Cookie 或稍后重试',
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
                print(f"\033[91m[UserManager] 获取合集视频时出错: {e}\033[0m")
            return {'_error': True, 'message': f'获取合集视频失败: {e}'}

    async def download_liked_videos(self, count=20):
        """下载点赞视频"""
        try:
            videos = await self.get_liked_videos(count)
            if isinstance(videos, dict):
                return 0
            if not videos:
                return 0

            max_workers = max(1, int(getattr(Config, 'MAX_CONCURRENT', 3) or 1))
            semaphore = asyncio.Semaphore(max_workers)

            async def download_one(video: dict) -> int:
                aweme_id = video.get('aweme_id')
                media_type = video.get('media_type', 'unknown')
                media_urls = video.get('media_urls') or []
                if not aweme_id or not media_urls:
                    return 0

                author_name = (video.get('author') or {}).get('nickname') or 'liked'
                name = build_download_name(
                    author_name,
                    video.get('desc', ''),
                    aweme_id,
                    media_type=media_type,
                    create_time=video.get('create_time'),
                )

                async with semaphore:
                    if media_type == 'video' and len(media_urls) == 1:
                        fallback_urls = self.get_video_download_urls((video.get('video') or {}))
                        success = await asyncio.to_thread(
                            self.downloader.download_video,
                            media_urls[0]['url'],
                            name,
                            aweme_id,
                            fallback_urls=fallback_urls,
                        )
                    else:
                        success = await asyncio.to_thread(
                            self.downloader.download_media_group,
                            media_urls,
                            name,
                            aweme_id,
                        )

                return 1 if success else 0

            results = await asyncio.gather(*(download_one(video) for video in videos), return_exceptions=True)
            return sum(result for result in results if isinstance(result, int))
        except Exception as e:
            print(f"\033[91m下载点赞视频时出错: {e}\033[0m")
            return 0

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
        """下载点赞作品的作者的所有作品"""
        try:
            authors = await self.get_liked_authors(count)
            if isinstance(authors, dict):
                return 0
            if not authors:
                return 0

            selected = set(selected_sec_uids or [])
            selected_authors = [
                author for author in authors
                if not selected or author.get('sec_uid') in selected
            ]

            max_workers = max(1, int(getattr(Config, 'MAX_CONCURRENT', 3) or 1))
            semaphore = asyncio.Semaphore(max_workers)

            async def download_one_author(author: dict) -> int:
                async with semaphore:
                    print(f"\n\033[36m正在处理作者: {author['nickname']}\033[0m")
                    await self.download_user_videos(author, auto_confirm=True)
                return 1

            results = await asyncio.gather(
                *(download_one_author(author) for author in selected_authors),
                return_exceptions=True,
            )
            return sum(result for result in results if isinstance(result, int))

        except Exception as e:
            print(f"\033[91m处理失败：{str(e)}\033[0m")
            return 0
