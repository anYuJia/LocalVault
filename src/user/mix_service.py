"""合集视频逻辑拆分模块。

从 FavoritesService 中拆出的合集相关接口：收藏合集列表、合集内视频列表。
MixService 持有 FavoritesService 实例引用，复用 api、合集项构建、登录态
判断等辅助方法。原方法保留为薄代理，确保外部调用兼容。
"""


class MixService:
    """合集视频服务，封装收藏合集与合集视频查询。"""

    def __init__(self, favorites):
        self._fav = favorites

    @property
    def api(self):
        return self._fav.api

    @property
    def debug_mode(self) -> bool:
        return self._fav.debug_mode

    def _looks_like_login_error(self, error) -> bool:
        return self._fav._looks_like_login_error(error)

    def _login_required_message(self, feature: str) -> dict:
        return self._fav._login_required_message(feature)

    def _response_has_more(self, resp):
        return self._fav._response_has_more(resp)

    def _response_cursor(self, resp):
        return self._fav._response_cursor(resp)

    def _build_collection_video_item(self, post):
        return self._fav._build_collection_video_item(post)

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
