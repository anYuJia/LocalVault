"""评论接口逻辑拆分模块。

将 DouyinAPI 中评论相关的方法抽取到独立模块，降低主文件复杂度。
通过 CommentClient 类持有 DouyinAPI 实例引用，共享 cookie、headers 等状态。
"""
from src.api.comment_actions import CommentActions
from src.api.comment_readers import CommentReaders


class CommentClient:
    """评论客户端，封装所有评论相关操作。"""

    def __init__(self, api):
        """
        Args:
            api: DouyinAPI 实例，用于共享 cookie、headers、公共方法等。
        """
        self._api = api
        self._actions: CommentActions | None = None
        self._readers: CommentReaders | None = None

    @property
    def actions(self) -> CommentActions:
        """获取评论动作服务实例（懒加载）。"""
        if self._actions is None:
            self._actions = CommentActions(self)
        return self._actions

    @property
    def readers(self) -> CommentReaders:
        """获取评论读取服务实例（懒加载）。"""
        if self._readers is None:
            self._readers = CommentReaders(self)
        return self._readers

    # ---------- 基础工具方法（委托给 api） ----------

    @property
    def cookie(self) -> str:
        return self._api.cookie

    @property
    def common_headers(self) -> dict:
        return self._api.common_headers

    @property
    def common_params(self) -> dict:
        return self._api.common_params

    @property
    def debug_mode(self) -> bool:
        return self._api.debug_mode

    def _cookies_to_dict(self, cookie_str: str) -> dict:
        return self._api._cookies_to_dict(cookie_str)

    def _looks_like_logged_out_error(self, data: dict) -> bool:
        return self._api._looks_like_logged_out_error(data)

    def _build_login_required_error(self, data: dict | None = None) -> dict:
        return self._api._build_login_required_error(data)

    def _looks_like_login_or_verify_error(self, uri: str, data: dict) -> bool:
        return self._api._looks_like_login_or_verify_error(uri, data)

    def _build_verify_hint(self, uri: str, params: dict, response=None) -> tuple[dict, bool]:
        return self._api._build_verify_hint(uri, params, response)

    def _extract_api_message(self, data: dict, fallback: str = '请求失败') -> str:
        return self._api._extract_api_message(data, fallback)

    def _ticket_guard_headers_from_cookie(self) -> dict:
        return self._api._ticket_guard_headers_from_cookie()

    def _spider_ticket_guard_headers(self, path: str) -> dict:
        return self._api._spider_ticket_guard_headers(path)

    def _relation_ticket_guard_headers(self, path: str) -> dict:
        return self._api._relation_ticket_guard_headers(path)

    def _relation_dtrait(self) -> str:
        return self._api._relation_dtrait()

    def _generate_s_v_web_id(self) -> str:
        return self._api._generate_s_v_web_id()

    def _generate_fake_webid(self, random_length: int = 19) -> str:
        return self._api._generate_fake_webid(random_length)

    def _get_ms_token(self) -> str:
        return self._api._get_ms_token()

    async def _get_webid(self, headers: dict, url: str = '') -> str:
        return await self._api._get_webid(headers, url)

    async def _get_csrf_token(self, headers: dict, force_refresh: bool = False) -> str:
        return await self._api._get_csrf_token(headers, force_refresh)

    async def _deal_params(self, params: dict, headers: dict) -> dict:
        return await self._api._deal_params(params, headers)

    async def common_request(self, uri, params, headers, host=None, skip_sign=False, method='GET'):
        return await self._api.common_request(uri, params, headers, host, skip_sign, method)

    async def signed_form_action_request(self, uri, params, headers, host=None, query_overrides=None):
        return await self._api.signed_form_action_request(uri, params, headers, host, query_overrides)

    async def get_current_user(self, strict_profile: bool = False) -> tuple[dict, bool]:
        return await self._api.get_current_user(strict_profile)

    # ---------- 评论接口 ----------

    async def set_comment_liked(self, aweme_id: str, comment_id: str, liked: bool, level: int = 1) -> tuple[dict, bool]:
        """点赞或取消点赞评论。"""
        return await self.actions.set_comment_liked(aweme_id, comment_id, liked, level)

    async def publish_comment(
        self,
        aweme_id: str,
        text: str,
        reply_id: str = '',
        reply_to_reply_id: str = '',
    ) -> tuple[dict, bool]:
        """发布一级评论或回复评论。"""
        return await self.actions.publish_comment(aweme_id, text, reply_id, reply_to_reply_id)

    async def get_comments(self, aweme_id: str, count: int = 20, cursor: int = 0, insert_ids: str = '') -> tuple[dict, bool]:
        """获取视频评论列表。"""
        return await self.readers.get_comments(aweme_id, count, cursor, insert_ids)

    async def get_comment_replies(self, aweme_id: str, comment_id: str, count: int = 6, cursor: int = 0) -> tuple[dict, bool]:
        """获取评论的二级回复列表。"""
        return await self.readers.get_comment_replies(aweme_id, comment_id, count, cursor)
