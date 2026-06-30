import asyncio
import requests
import urllib.parse
import os
import json
import logging
from src.api import sign as douyin_sign
from src.api import douyin_im_proto
from src.api.http_client import (
    api_get as _api_get,
    api_post as _api_post,
    api_post_stateless as _api_post_stateless,
    get_api_session as _get_api_session,
    redact_headers as _redact_headers,
    redact_params as _redact_params,
    sign_spider_a_bogus as _sign_spider_a_bogus,
    splice_params as _splice_params,
)
from src.api.im_formatters import (
    collect_sec_uid_records,
    collect_spotlight_sec_user_ids,
    first_url,
    normalize_share_friends,
    share_sorted_sec_uids,
)
from src.api import temp_cookie
from src.api.im_client import IMClient
from src.api.comment_client import CommentClient
from src.api.api_errors import ApiErrors
from src.api.ticket_guard import TicketGuard
from src.api.feed_client import FeedClient
from src.api.notice_client import NoticeClient

logger = logging.getLogger('api')

class DouyinAPI:
    """抖音API封装类"""
    
    def __init__(self, cookie: str):
        self.cookie = cookie
        self.host = 'https://www.douyin.com'
        self._cached_webid = None
        self._webid_time = 0
        self._cached_csrf_token = None
        self._csrf_time = 0

        # 检查是否启用调试模式
        self.debug_mode = os.environ.get('DEBUG_MODE', '').lower() in ('true', '1', 'yes')
        if self.debug_mode:
            print("\033[93m[API] 调试模式已启用\033[0m")
        # 通用请求参数
        self.common_params = {
            'device_platform': 'webapp',
            'aid': '6383',
            'channel': 'channel_pc_web',
            'update_version_code': '0',
            'pc_client_type': '1',
            'version_code': '190600',
            'version_name': '19.6.0',
            'cookie_enabled': 'true',
            'screen_width': '1680',
            'screen_height': '1050',
            'browser_language': 'zh-CN',
            'browser_platform': 'MacIntel',
            'browser_name': 'Edge',
            'browser_version': '145.0.0.0',
            'browser_online': 'true',
            'engine_name': 'Blink',
            'engine_version': '145.0.0.0',
            'os_name': 'Mac OS',
            'os_version': '10.15.7',
            'cpu_core_num': '8',
            'device_memory': '8',
            'platform': 'PC',
            'downlink': '10',
            'effective_type': '4g',
            'round_trip_time': '50',
            'pc_libra_divert': 'Mac',
            'support_h265': '1',
            'support_dash': '1',
            'disable_rs': '0',
            'need_filter_settings': '1',
            'list_type': 'single',
        }

        # 通用请求头
        self.common_headers = {
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36 Edg/145.0.0.0",
            "sec-fetch-site": "same-origin",
            "sec-fetch-mode": "cors",
            "sec-fetch-dest": "empty",
            "sec-ch-ua-platform": '"macOS"',
            "sec-ch-ua-mobile": "?0",
            "sec-ch-ua": '"Not:A-Brand";v="99", "Microsoft Edge";v="145", "Chromium";v="145"',
            "referer": "https://www.douyin.com/",
            "priority": "u=1, i",
            "accept-language": "zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6",
            "accept": "application/json, text/plain, */*",
        }

        # IM 客户端（延迟初始化）
        self._im_client: IMClient | None = None
        # 评论客户端（延迟初始化）
        self._comment_client: CommentClient | None = None
        # 请求错误/登录态/验证态判断服务（延迟初始化）
        self._api_errors: ApiErrors | None = None
        # Ticket Guard/签名/鉴权辅助服务（延迟初始化）
        self._ticket_guard: TicketGuard | None = None
        # 推荐流接口服务（延迟初始化）
        self._feed_client: FeedClient | None = None
        # 通知消息接口服务（延迟初始化）
        self._notice_client: NoticeClient | None = None

    @property
    def im(self) -> IMClient:
        """获取 IM 客户端实例（懒加载）。"""
        if self._im_client is None:
            self._im_client = IMClient(self)
        return self._im_client

    @property
    def comment(self) -> CommentClient:
        """获取评论客户端实例（懒加载）。"""
        if self._comment_client is None:
            self._comment_client = CommentClient(self)
        return self._comment_client

    @property
    def api_errors(self) -> ApiErrors:
        """获取请求错误/登录态/验证态判断服务实例（懒加载）。"""
        if self._api_errors is None:
            self._api_errors = ApiErrors(self)
        return self._api_errors

    @property
    def ticket_guard(self) -> TicketGuard:
        """获取 Ticket Guard/签名/鉴权辅助服务实例（懒加载）。"""
        if self._ticket_guard is None:
            self._ticket_guard = TicketGuard(self)
        return self._ticket_guard

    @property
    def feed(self) -> FeedClient:
        """获取推荐流接口服务实例（懒加载）。"""
        if self._feed_client is None:
            self._feed_client = FeedClient(self)
        return self._feed_client

    @property
    def notice(self) -> NoticeClient:
        """获取通知消息接口服务实例（懒加载）。"""
        if self._notice_client is None:
            self._notice_client = NoticeClient(self)
        return self._notice_client

    async def _get_webid(self, headers: dict, url: str = '') -> str:
        return await self.ticket_guard._get_webid(headers, url)

    def _generate_fake_webid(self, random_length: int = 19) -> str:
        return self.ticket_guard._generate_fake_webid(random_length)

    async def _get_csrf_token(self, headers: dict, force_refresh: bool = False) -> str:
        return await self.ticket_guard._get_csrf_token(headers, force_refresh)

    async def _deal_params(self, params: dict, headers: dict) -> dict:
        return await self.ticket_guard._deal_params(params, headers)

    def _cookies_to_dict(self, cookie_str: str) -> dict:
        return self.ticket_guard._cookies_to_dict(cookie_str)

    def _ticket_guard_headers_from_cookie(self) -> dict:
        return self.ticket_guard._ticket_guard_headers_from_cookie()

    def _decode_relation_ecdh_key(self, value: str) -> bytes | None:
        return self.ticket_guard._decode_relation_ecdh_key(value)

    def _relation_ticket_guard_headers(self, path: str) -> dict:
        return self.ticket_guard._relation_ticket_guard_headers(path)

    def _spider_ticket_guard_headers(self, path: str) -> dict:
        return self.ticket_guard._spider_ticket_guard_headers(path)

    def _relation_uid_hash(self) -> str:
        return self.ticket_guard._relation_uid_hash()

    def _relation_dtrait(self) -> str:
        return self.ticket_guard._relation_dtrait()

    def _get_ms_token(self) -> str:
        return self.ticket_guard._get_ms_token()

    def _generate_s_v_web_id(self) -> str:
        return self.ticket_guard._generate_s_v_web_id()

    def _build_verify_hint(self, uri: str, params: dict, response=None) -> tuple[dict, bool]:
        return self.api_errors._build_verify_hint(uri, params, response)

    def _extract_api_message(self, data: dict, fallback: str = '请求失败') -> str:
        return self.api_errors._extract_api_message(data, fallback)

    def _looks_like_logged_out_error(self, data: dict) -> bool:
        return self.api_errors._looks_like_logged_out_error(data)

    def _build_login_required_error(self, data: dict | None = None) -> dict:
        return self.api_errors._build_login_required_error(data)

    def _looks_like_login_or_verify_error(self, uri: str, data: dict) -> bool:
        return self.api_errors._looks_like_login_or_verify_error(uri, data)

    async def common_request(self, uri: str, params: dict, headers: dict, host: str = None, skip_sign: bool = False, method: str = 'GET') -> tuple[dict, bool]:
        """
        请求 douyin
        :param uri: 请求路径
        :param params: 请求参数
        :param headers: 请求头
        :param host: 可选的自定义host
        :param skip_sign: 跳过a_bogus签名（部分接口不需要）
        :param method: 请求方法 ('GET' 或 'POST')
        :return: 返回数据和是否成功
        """
        base_host = host or self.host
        url = f'{base_host}{uri}'
        params.update(self.common_params)
        # 先应用通用头，再用自定义头覆盖
        merged_headers = dict(self.common_headers)
        merged_headers.update(headers)
        headers = merged_headers
        params = await self._deal_params(params, headers)

        if not skip_sign:
            query = '&'.join([f'{k}={urllib.parse.quote(str(v))}' for k, v in params.items()])
            try:
                if 'reply' in uri:
                    a_bogus = douyin_sign.sign_reply(query, headers["User-Agent"])
                else:
                    a_bogus = douyin_sign.sign_detail(query, headers["User-Agent"])
            except Exception as e:
                if self.debug_mode:
                    print(f"\033[91m[API] 生成 a_bogus 失败: {e}\033[0m")
                return {
                    'status_code': -1,
                    'status_msg': '签名生成失败',
                    'message': f'签名生成失败: {e}',
                }, False
            params["a_bogus"] = a_bogus

        if self.debug_mode:
            print(f'\033[94m[API] 请求URL: {url}\033[0m')
            print(f'\033[94m[API] 请求方法: {method}\033[0m')
            print(f'\033[94m[API] 请求参数: {_redact_params(params)}\033[0m')
            print(f'\033[94m[API] 请求头: {_redact_headers(headers)}\033[0m')

        try:
            # 根据方法选择 GET 或 POST
            if method.upper() == 'POST':
                response = await asyncio.to_thread(
                    _api_post,
                    url,
                    data=params,
                    headers=headers,
                    timeout=(10, 30),
                )
            else:
                response = await asyncio.to_thread(
                    _api_get,
                    url,
                    params=params,
                    headers=headers,
                    timeout=(10, 30),
                )
        except requests.RequestException as e:
            if self.debug_mode:
                print(f'\033[91m[API] 网络请求异常: {e}\033[0m')
            return {
                'status_code': -1,
                'status_msg': '网络请求失败',
                'message': f'网络请求失败: {e}',
            }, False
        if self.debug_mode:
            print(f'\033[94m[API] 响应状态码: {response.status_code}\033[0m')
            print(f'\033[94m[API] 响应内容长度: {len(response.text)}, 前500字符: {response.text[:500]}\033[0m')

        response_content_type = response.headers.get('Content-Type', '').lower()
        response_url = getattr(response, 'url', '') or ''
        looks_like_verify = (
            response.status_code in (401, 403)
            or 'passport' in response_url.lower()
            or 'login' in response_url.lower()
            or ('text/html' in response_content_type and len(response.content) > 0)
        )

        if looks_like_verify:
            if self.debug_mode:
                print(f'\033[93m[API] 检测到验证/登录页响应，提示用户手动完成验证\033[0m')
            if response.status_code == 401:
                return self._build_login_required_error({
                    'status_code': response.status_code,
                    'status_msg': '用户未登录',
                }), False
            return self._build_verify_hint(uri, params, response)

        if response.status_code != 200 or len(response.content) == 0:
            if self.debug_mode:
                print(
                    f"\033[91m[API] 普通请求失败: status={response.status_code}, empty={len(response.content) == 0}\033[0m"
                )
            failure_payload = {
                'status_code': response.status_code,
                'status_msg': '请求失败',
                'message': '请求失败，请检查 Cookie 或稍后重试',
            }
            if self._looks_like_login_or_verify_error(uri, failure_payload):
                verify_hint, _ = self._build_verify_hint(uri, params, response)
                verify_hint.update(failure_payload)
                return verify_hint, False
            return failure_payload, False
            
        try:
            json_response = response.json()
        except Exception:
            try:
                text = response.text.lstrip()
                starts = [idx for idx in (text.find('{'), text.find('[')) if idx >= 0]
                if not starts:
                    raise ValueError('no json object found')
                decoder = json.JSONDecoder()
                json_response, _ = decoder.raw_decode(text[min(starts):])
            except Exception as e:
                if self.debug_mode:
                    print(f'\033[91m[API] JSON解析失败: {e}\033[0m')
                return {}, False
        except Exception as e:
            if self.debug_mode:
                print(f'\033[91m[API] JSON解析失败: {e}\033[0m')
            return {}, False

        # 检测验证码拦截 - 只有当user_list也为空时才认为需要验证
        nil_info = json_response.get('search_nil_info', {})
        user_list = json_response.get('user_list', [])
        if nil_info.get('search_nil_type') == 'verify_check' and len(user_list) == 0:
            if self.debug_mode:
                print(f'\033[91m[API] 触发滑块验证！返回验证标记由上层处理...\033[0m')

            # 返回验证标记和搜索验证URL，由上层打开浏览器让用户完成验证
            json_response['_need_verify'] = True
            keyword = params.get('keyword', '')
            if keyword:
                json_response['_verify_url'] = f"https://www.douyin.com/jingxuan/search/{urllib.parse.quote(str(keyword))}?type=user"
            return json_response, False

        # 检测视频详情接口返回空数据（可能是视频不存在或 API 限流）
        if uri and 'aweme/detail' in uri and json_response.get('aweme_detail') is None:
            filter_detail = json_response.get('filter_detail', {})
            filter_reason = filter_detail.get('filter_reason', 'unknown')
            if self.debug_mode:
                print(f'\033[91m[API] 视频详情接口返回空数据：filter_reason={filter_reason}\033[0m')
            return json_response, False

        if json_response.get('status_code', 0) != 0:
            if self.debug_mode:
                print(f'\033[91m[API] API返回错误: status_code={json_response.get("status_code")}, msg={json_response.get("status_msg", "")}\033[0m')
            if self._looks_like_logged_out_error(json_response):
                return self._build_login_required_error(json_response), False
            if self._looks_like_login_or_verify_error(uri, json_response):
                verify_hint, _ = self._build_verify_hint(uri, params, response)
                api_message = self._extract_api_message(json_response)
                verify_hint.update({
                    'status_code': json_response.get('status_code'),
                    'status_msg': json_response.get('status_msg', ''),
                    'message': f'{api_message}，请完成验证或重新获取 Cookie 后重试',
                })
                return verify_hint, False
            return json_response, False

        return json_response, True

    async def signed_form_action_request(
        self,
        uri: str,
        body_params: dict,
        headers: dict,
        host: str = None,
        query_overrides: dict | None = None,
    ) -> tuple[dict, bool]:
        """POST 动作接口：公共参数放 query 并签名，动作参数放 form body。"""
        base_host = host or self.host
        url = f'{base_host}{uri}'
        query_params = dict(self.common_params)
        if (
            'aweme/v1/web/commit/item/digg' in uri
            or 'aweme/v1/web/aweme/collect' in uri
            or 'aweme/v1/web/comment/digg' in uri
            or 'aweme/v1/web/commit/follow/user' in uri
        ):
            query_params.update({
                'update_version_code': '170400',
                'version_code': '170400',
                'version_name': '17.4.0',
                'browser_name': 'Chrome',
                'browser_version': '148.0.0.0',
                'engine_version': '148.0.0.0',
                'device_memory': '16',
            })
            if 'aweme/v1/web/commit/item/digg' in uri:
                uid_hash = self._relation_uid_hash()
                if uid_hash:
                    query_params['uid'] = uid_hash
        if query_overrides:
            query_params.update({str(key): str(value) for key, value in query_overrides.items()})
        merged_headers = dict(self.common_headers)
        merged_headers.update(headers or {})
        merged_headers.update({
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
            'sec-ch-ua': '"Chromium";v="148", "Google Chrome";v="148", "Not/A)Brand";v="99"',
        })
        merged_headers.update(self._relation_ticket_guard_headers(uri))
        is_relation_action = (
            'aweme/v1/web/commit/item/digg' in uri
            or 'aweme/v1/web/aweme/collect' in uri
            or 'aweme/v1/web/comment/digg' in uri
            or 'aweme/v1/web/commit/follow/user' in uri
        )
        dtrait = self._relation_dtrait()
        if is_relation_action and not dtrait:
            return {
                'status_code': -1,
                'status_msg': 'RELATION_DTRAIT_MISSING',
                'message': '点赞安全参数未采集完整，请重新登录 Cookie 后重试',
                '_security_blocked': True,
            }, False
        if dtrait:
            merged_headers['x-tt-session-dtrait'] = dtrait
        headers = merged_headers
        query_params = await self._deal_params(query_params, headers)
        query_params.update({
            'browser_name': 'Chrome',
            'browser_version': '148.0.0.0',
            'engine_version': '148.0.0.0',
            'device_memory': '16',
        })
        headers['x-secsdk-csrf-token'] = 'DOWNGRADE'
        # www.douyin.com → www-hj.douyin.com 是同站跨源，浏览器发送 same-site
        headers['sec-fetch-site'] = 'same-site'

        query = urllib.parse.urlencode(query_params)
        try:
            query_params['a_bogus'] = douyin_sign.sign_detail(query, headers["User-Agent"])
        except Exception as e:
            if self.debug_mode:
                print(f"\033[91m[API] 生成动作接口 a_bogus 失败: {e}\033[0m")
            return {
                'status_code': -1,
                'status_msg': '签名生成失败',
                'message': f'签名生成失败: {e}',
            }, False

        relation_uid = str(query_params.get('uid') or '')
        try:
            from src.config.config import Config
            signer_present = isinstance(Config.RELATION_SIGNER, dict)
        except Exception:
            signer_present = False
        logger.debug(
            'Douyin relation action request: path=%s query_keys=%s uid_present=%s uid_prefix=%s body_keys=%s signer_present=%s ticket_guard_cookie=%s ticket_guard_header=%s csrf_present=%s dtrait_present=%s',
            uri,
            ','.join(sorted(query_params.keys())),
            bool(relation_uid),
            relation_uid[:8],
            ','.join(sorted(body_params.keys())),
            signer_present,
            'bd_ticket_guard_client_data' in (self.cookie or ''),
            'bd-ticket-guard-client-data' in headers,
            'x-secsdk-csrf-token' in headers,
            'x-tt-session-dtrait' in headers,
        )

        if self.debug_mode:
            print(f'\033[94m[API] 动作请求URL: {url}\033[0m')
            print(f'\033[94m[API] 动作请求Query: {_redact_params(query_params)}\033[0m')
            print(f'\033[94m[API] 动作请求Body: {body_params}\033[0m')
            print(f'\033[94m[API] 动作请求头: {_redact_headers(headers)}\033[0m')

        try:
            response = await asyncio.to_thread(
                _api_post,
                url,
                params=query_params,
                data=body_params,
                headers=headers,
                timeout=(10, 30),
            )
        except requests.RequestException as e:
            return {
                'status_code': -1,
                'status_msg': '网络请求失败',
                'message': f'网络请求失败: {e}',
            }, False

        if response.status_code != 200 or len(response.content) == 0:
            logger.warning(
                'Douyin relation action rejected before JSON: path=%s http_status=%s content_length=%s headers=%s',
                uri,
                response.status_code,
                len(response.content or b''),
                {
                    'bd-ticket-guard-result': response.headers.get('bd-ticket-guard-result') or '',
                    'bd_passport_security_gateway': response.headers.get('bd_passport_security_gateway') or '',
                },
            )
            ticket_guard_result = response.headers.get('bd-ticket-guard-result') or ''
            passport_security_gateway = response.headers.get('bd_passport_security_gateway') or ''
            if response.status_code == 403 and (ticket_guard_result or passport_security_gateway == '1'):
                return {
                    'status_code': response.status_code,
                    'status_msg': 'SECURITY_GATEWAY_BLOCKED',
                    'message': (
                        f'抖音安全校验拒绝了本次操作（HTTP 403'
                        f'{", TicketGuard " + ticket_guard_result if ticket_guard_result else ""}），'
                        '当前 Cookie 仍会保留，请稍后重试，或先在抖音网页/客户端完成一次同类操作。'
                    ),
                    '_security_blocked': True,
                }, False
            return {
                'status_code': response.status_code,
                'status_msg': '请求失败',
                'message': '请求失败，请检查 Cookie 或稍后重试',
            }, False

        try:
            json_response = response.json()
        except Exception as e:
            return {
                'status_code': -1,
                'status_msg': 'JSON解析失败',
                'message': f'JSON解析失败: {e}',
            }, False

        logger.debug(
            'Douyin relation action response: path=%s status_code=%s status_msg=%s',
            uri,
            json_response.get('status_code', 0),
            json_response.get('status_msg') or json_response.get('message') or '',
        )

        if json_response.get('status_code', 0) != 0:
            status_code = json_response.get('status_code')
            api_message = self._extract_api_message(json_response)
            if status_code == 8 or '未登录' in api_message:
                return {
                    'status_code': status_code,
                    'status_msg': json_response.get('status_msg', ''),
                    'message': (
                        f'抖音动作接口未接受当前网页登录凭据（{api_message}），'
                        '当前 Cookie 仍会保留。请稍后重试，或先在抖音网页/客户端完成一次同类操作。'
                    ),
                    '_security_blocked': True,
                }, False
            if self._looks_like_logged_out_error(json_response):
                return self._build_login_required_error(json_response), False
            if self._looks_like_login_or_verify_error(uri, json_response):
                verify_hint, _ = self._build_verify_hint(uri, query_params, response)
                verify_hint.update({
                    'status_code': json_response.get('status_code'),
                    'status_msg': json_response.get('status_msg', ''),
                    'message': f'{api_message}，请完成验证或重新获取 Cookie 后重试',
                })
                return verify_hint, False
            return json_response, False

        return json_response, True

    # ---------- IM 薄代理（委托给 im_client.IMClient） ----------

    async def get_im_spotlight_relation_sec_user_ids(self, limit: int = 500, include_all_users: bool = False) -> tuple[list[str], bool, dict]:
        return await self.im.get_im_spotlight_relation_sec_user_ids(limit, include_all_users)

    async def get_following_sec_user_ids(self, user_id: str, sec_uid: str, limit: int = 500, mutual_only: bool = False) -> tuple[list[str], bool, dict]:
        return await self.im.get_following_sec_user_ids(user_id, sec_uid, limit, mutual_only)

    async def get_im_share_friends(self, limit: int = 50) -> tuple[dict, bool]:
        return await self.im.get_im_share_friends(limit)

    async def get_im_user_info(self, sec_user_ids: list[str]) -> tuple[dict, bool]:
        return await self.im.get_im_user_info(sec_user_ids)

    async def get_im_user_active_status(self, sec_user_ids: list[str], conv_ids: list[str] | None = None) -> tuple[dict, bool]:
        return await self.im.get_im_user_active_status(sec_user_ids, conv_ids)

    async def get_im_device_id(self) -> tuple[str, bool, dict]:
        return await self.im.get_im_device_id()

    async def get_im_identity_security_token(self) -> tuple[dict, bool]:
        return await self.im.get_im_identity_security_token()

    async def create_im_conversation(self, to_user_id: str | int) -> tuple[dict, bool]:
        return await self.im.create_im_conversation(to_user_id)

    async def send_im_text_message(self, to_user_id: str | int, content: str) -> tuple[dict, bool]:
        return await self.im.send_im_text_message(to_user_id, content)

    async def send_im_video_share_message(self, to_user_id: str | int, video: dict) -> tuple[dict, bool]:
        return await self.im.send_im_video_share_message(to_user_id, video)

    async def send_im_image_message(
        self,
        to_user_id: str | int,
        image_data_url: str,
        width: int = 0,
        height: int = 0,
        file_name: str = '',
        mime_type: str = '',
    ) -> tuple[dict, bool]:
        return await self.im.send_im_image_message(
            to_user_id, image_data_url, width, height, file_name, mime_type,
        )

    async def get_im_history_messages(
        self,
        cursor: int = 0,
        to_user_id: str | int | None = None,
        conversation_id: str | None = None,
        conversation_short_id: int | None = None,
        conversation_type: int = 1,
    ) -> tuple[dict, bool]:
        return await self.im.get_im_history_messages(
            cursor, to_user_id, conversation_id, conversation_short_id, conversation_type,
        )

    async def get_current_user(self, strict_profile: bool = False) -> tuple[dict, bool]:
        """获取当前登录用户，用于强校验 Cookie 是否仍被抖音服务端认可。"""
        resp, success = await self.common_request(
            '/aweme/v1/web/user/profile/self/',
            {},
            {'Referer': 'https://www.douyin.com/'},
            skip_sign=True,
        )

        if not success:
            if strict_profile:
                return resp, False
            logger.warning(
                'Douyin profile/self current user lookup failed, falling back to query/user: %s',
                resp.get('message') if isinstance(resp, dict) else resp,
            )
            return await self._get_current_user_from_query_user()

        user = resp.get('user') if isinstance(resp, dict) else None
        if not isinstance(user, dict) or not user:
            if strict_profile:
                return {
                    '_need_login': True,
                    'message': '登录态校验失败：抖音未返回当前用户，请重新登录获取 Cookie',
                }, False
            logger.warning('Douyin profile/self returned no user, falling back to query/user')
            return await self._get_current_user_from_query_user()

        return user, True

    async def _get_current_user_from_query_user(self) -> tuple[dict, bool]:
        resp, success = await self.common_request(
            '/aweme/v1/web/query/user',
            {'publish_video_strategy_type': '2'},
            {'Referer': 'https://www.douyin.com/discover'},
        )
        if not success:
            return resp, False
        uid = str(resp.get('user_uid') or resp.get('uid') or resp.get('id') or '').strip()
        if not uid:
            return {
                '_need_login': True,
                'message': '登录态校验失败：抖音未返回当前用户，请重新登录获取 Cookie',
                'raw': resp,
            }, False
        return {
            'uid': uid,
            'sec_uid': str(resp.get('sec_user_id') or resp.get('sec_uid') or '').strip(),
            'nickname': str(resp.get('nickname') or '抖音用户').strip() or '抖音用户',
            'avatar_thumb': {},
            'avatar_medium': {},
            'avatar_larger': {},
        }, True

    async def get_recommended_feed(self, count: int = 20, cursor: int = 0, feed_type: str = 'featured') -> tuple[dict, bool]:
        return await self.feed.get_recommended_feed(count, cursor, feed_type)

    async def get_home_recommended_feed(self, count: int = 20, cursor: int = 0) -> tuple[dict, bool]:
        return await self.feed.get_home_recommended_feed(count, cursor)

    async def _hydrate_home_recommended_aweme_details(self, aweme_list: list) -> list:
        return await self.feed._hydrate_home_recommended_aweme_details(aweme_list)

    async def set_comment_liked(self, aweme_id: str, comment_id: str, liked: bool, level: int = 1) -> tuple[dict, bool]:
        return await self.comment.set_comment_liked(aweme_id, comment_id, liked, level)

    async def publish_comment(
        self,
        aweme_id: str,
        text: str,
        reply_id: str = '',
        reply_to_reply_id: str = '',
    ) -> tuple[dict, bool]:
        return await self.comment.publish_comment(aweme_id, text, reply_id, reply_to_reply_id)

    async def get_comments(self, aweme_id: str, count: int = 20, cursor: int = 0, insert_ids: str = '') -> tuple[dict, bool]:
        return await self.comment.get_comments(aweme_id, count, cursor, insert_ids)

    async def get_comment_replies(self, aweme_id: str, comment_id: str, count: int = 6, cursor: int = 0) -> tuple[dict, bool]:
        return await self.comment.get_comment_replies(aweme_id, comment_id, count, cursor)

    async def get_temp_cookie(self) -> dict:
        return await temp_cookie.get_temp_cookie(self.common_headers, self.debug_mode)

    async def _get_temp_cookie_http(self) -> str:
        return await temp_cookie.get_temp_cookie_http(self.common_headers, self.debug_mode)

    @staticmethod
    def get_browser_cookies() -> dict:
        return temp_cookie.get_browser_cookies()
