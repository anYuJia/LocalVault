"""IM 私信相关逻辑拆分模块。

将 DouyinAPI 中 IM 相关的方法抽取到独立模块，降低主文件复杂度。
通过 IMClient 类持有 DouyinAPI 实例引用，共享 cookie、headers 等状态。
"""
import asyncio
import base64
import binascii
import hashlib
import hmac
import json
import logging
import random
import re
import string
import time
import urllib.parse
import uuid

from src.api import douyin_im_proto
from src.api import sign as douyin_sign
from src.api.http_client import (
    api_get as _api_get,
    api_post as _api_post,
)
from src.api.im_formatters import (
    collect_sec_uid_records,
    collect_spotlight_sec_user_ids,
    first_url,
    normalize_share_friends,
    share_sorted_sec_uids,
)
from src.api import im_uploads

logger = logging.getLogger('api.im')


class IMClient:
    """IM 私信客户端，封装所有私信相关操作。"""

    def __init__(self, api):
        """
        Args:
            api: DouyinAPI 实例，用于共享 cookie、headers、公共方法等。
        """
        self._api = api

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
    def host(self) -> str:
        return self._api.host

    async def _deal_params(self, params: dict, headers: dict) -> dict:
        return await self._api._deal_params(params, headers)

    def _cookies_to_dict(self, cookie_str: str) -> dict:
        return self._api._cookies_to_dict(cookie_str)

    def _looks_like_logged_out_error(self, data: dict) -> bool:
        return self._api._looks_like_logged_out_error(data)

    def _build_login_required_error(self, data: dict | None = None) -> dict:
        return self._api._build_login_required_error(data)

    def _get_ms_token(self) -> str:
        return self._api._get_ms_token()

    def _generate_s_v_web_id(self) -> str:
        return self._api._generate_s_v_web_id()

    def _relation_ticket_guard_headers(self, path: str) -> dict:
        return self._api._relation_ticket_guard_headers(path)

    async def common_request(self, uri, params, headers, host=None, skip_sign=False, method='GET'):
        return await self._api.common_request(uri, params, headers, host, skip_sign, method)

    # ---------- IM 专属 headers ----------

    def _im_common_headers(self, path: str) -> dict:
        headers = dict(self.common_headers)
        headers.update({
            "Cookie": self.cookie,
            "Referer": "https://www.douyin.com/",
            "Origin": "https://www.douyin.com",
            "sec-fetch-site": "same-site",
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            "x-secsdk-csrf-token": "DOWNGRADE",
        })
        cookie_dict = self._cookies_to_dict(self.cookie)
        uifid = cookie_dict.get('UIFID')
        if uifid:
            headers['uifid'] = uifid
        if '/im/' in path:
            headers.update({
                "sec-ch-ua": '"Chromium";v="148", "Microsoft Edge";v="148", "Not/A)Brand";v="99"',
                "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36 Edg/148.0.0.0",
            })
        return headers

    # ---------- IM HTTP 请求 ----------

    async def _request_im(self, uri: str, endpoint_params: dict | None = None, body_params: dict | None = None, method: str = 'GET') -> tuple[dict, bool]:
        endpoint_params = dict(endpoint_params or {})
        body_params = dict(body_params or {})
        params = dict(self.common_params)
        params.update({
            "update_version_code": "170400",
            "version_code": "170400",
            "version_name": "17.4.0",
            "browser_version": "148.0.0.0",
            "engine_version": "148.0.0.0",
            "round_trip_time": "0",
        })
        params.update(endpoint_params)
        headers = self._im_common_headers(uri)
        if method.upper() == 'GET':
            headers.pop("Content-Type", None)

        params = await self._deal_params(params, headers)
        query = urllib.parse.urlencode(params)
        try:
            params["a_bogus"] = douyin_sign.sign_detail(query, headers["User-Agent"])
        except Exception as e:
            return {
                'status_code': -1,
                'status_msg': '签名生成失败',
                'message': f'签名生成失败: {e}',
            }, False

        url = f'https://www-hj.douyin.com{uri}'
        try:
            if method.upper() == 'POST':
                response = await asyncio.to_thread(
                    _api_post,
                    url,
                    params=params,
                    data=body_params,
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
        except Exception as e:
            return {
                'status_code': -1,
                'status_msg': '网络请求失败',
                'message': f'网络请求失败: {e}',
            }, False

        if response.status_code != 200 or len(response.content) == 0:
            return {
                'status_code': response.status_code,
                'status_msg': '请求失败',
                'message': f'IM接口请求失败（HTTP {response.status_code}）',
            }, False

        try:
            data = response.json()
        except Exception:
            return {'status_code': -1, 'status_msg': 'JSON解析失败', 'message': 'IM接口返回解析失败'}, False

        if data.get('status_code', 0) != 0:
            if self._looks_like_logged_out_error(data):
                return self._build_login_required_error(data), False
            return data, False

        return data, True

    # ---------- IM 好友/关系 ----------

    async def get_im_spotlight_relation_sec_user_ids(self, limit: int = 500, include_all_users: bool = False) -> tuple[list[str], bool, dict]:
        params = {
            "count": "100",
            "source": "coldup",
            "max_time": str(int(time.time() * 1000)),
            "min_time": "0",
            "need_remove_share_panel": "true",
            "need_sorted_info": "true",
            "with_fstatus": "1",
        }
        response, success = await self._request_im('/aweme/v1/web/im/spotlight/relation/', params, method='GET')
        if not success:
            return [], False, response
        return collect_spotlight_sec_user_ids(response, include_all_users, limit), True, response

    async def get_following_sec_user_ids(self, user_id: str, sec_uid: str, limit: int = 500, mutual_only: bool = False) -> tuple[list[str], bool, dict]:
        """获取关注列表的 sec_user_id，作为 spotlight relation 的 fallback。"""
        ids: list[str] = []
        seen: set[str] = set()
        max_time = "0"
        for _ in range(20):
            params = {
                "user_id": user_id,
                "sec_user_id": sec_uid,
                "count": "100",
                "max_time": max_time,
                "min_time": "0",
                "source_type": "1",
            }
            resp, success = await self.common_request(
                '/aweme/v1/web/user/following/list/',
                params,
                {'Referer': 'https://www.douyin.com/'},
                skip_sign=True,
            )
            if not success:
                return ids, False, resp

            for item in resp.get('followings') or resp.get('user_list') or resp.get('data') or []:
                if not isinstance(item, dict):
                    continue
                if mutual_only and int(item.get('follower_status') or 0) <= 0:
                    continue
                sec = str(item.get('sec_uid') or item.get('sec_user_id') or '').strip()
                if sec and sec not in seen:
                    seen.add(sec)
                    ids.append(sec)
                    if len(ids) >= limit:
                        return ids, True, resp

            has_more = resp.get('has_more')
            if isinstance(has_more, bool) and not has_more:
                break
            if isinstance(has_more, (int, str)) and str(has_more) != '1':
                break

            next_max_time = resp.get('max_time')
            next_max_time = str(next_max_time) if next_max_time is not None else ''
            if not next_max_time or next_max_time == max_time:
                break
            max_time = next_max_time

        return ids, True, {}

    async def get_im_share_friends(self, limit: int = 50) -> tuple[dict, bool]:
        safe_limit = max(1, min(int(limit or 50), 100))
        params = {
            "count": str(safe_limit),
            "source": "coldup",
            "max_time": str(int(time.time() * 1000)),
            "min_time": "0",
            "need_remove_share_panel": "true",
            "need_sorted_info": "true",
            "with_fstatus": "1",
        }
        response, success = await self._request_im('/aweme/v1/web/im/spotlight/relation/', params, method='GET')
        if not success:
            return response, False
        known_sec_uids = {
            str(item.get('sec_uid') or item.get('sec_user_id') or '').strip()
            for item in response.get('followings') or []
            if isinstance(item, dict)
        }
        missing_sec_uids = [
            sec_uid
            for sec_uid in share_sorted_sec_uids(response, safe_limit)
            if sec_uid and sec_uid not in known_sec_uids
        ]
        if missing_sec_uids:
            followings = response.setdefault('followings', [])
            for index in range(0, len(missing_sec_uids), 20):
                user_info, user_success = await self.get_im_user_info(missing_sec_uids[index:index + 20])
                if not user_success:
                    continue
                for record in collect_sec_uid_records(user_info):
                    sec_uid = str(record.get('sec_uid') or record.get('sec_user_id') or '').strip()
                    if sec_uid and sec_uid not in known_sec_uids:
                        known_sec_uids.add(sec_uid)
                        followings.append(record)
        friends = normalize_share_friends(response, safe_limit)
        return {
            'status_code': 0,
            'message': '获取分享好友成功',
            'friends': friends,
            'count': len(friends),
            'has_more': bool(response.get('has_more')),
        }, True

    async def get_im_user_info(self, sec_user_ids: list[str]) -> tuple[dict, bool]:
        ids = [str(value).strip() for value in sec_user_ids if str(value).strip()]
        if not ids:
            return {'message': '好友ID不能为空'}, False
        return await self._request_im(
            '/aweme/v1/web/im/user/info/',
            body_params={'sec_user_ids': json.dumps(ids, ensure_ascii=False)},
            method='POST',
        )

    async def get_im_user_active_status(self, sec_user_ids: list[str], conv_ids: list[str] | None = None) -> tuple[dict, bool]:
        ids = [str(value).strip() for value in sec_user_ids if str(value).strip()]
        if not ids:
            return {'message': '好友ID不能为空'}, False
        conv_ids = [str(value).strip() for value in (conv_ids or []) if str(value).strip()]
        return await self._request_im(
            '/aweme/v1/web/im/user/active/status/',
            body_params={
                'conv_ids': json.dumps(conv_ids, ensure_ascii=False),
                'sec_user_ids': json.dumps(ids, ensure_ascii=False),
                'source': 'heartbeat',
            },
            method='POST',
        )

    async def get_im_device_id(self) -> tuple[str, bool, dict]:
        response, success = await self.common_request(
            '/aweme/v1/web/query/user',
            {'publish_video_strategy_type': '2'},
            {'Referer': 'https://www.douyin.com/discover'},
        )
        if not success:
            return '', False, response
        device_id = str(response.get('id') or '').strip()
        if not device_id:
            return '', False, {'message': '未获取到 IM device_id', 'raw': response}
        return device_id, True, response

    # ---------- IM proto 签名/构建 ----------

    def _im_proto_signer(self) -> dict | None:
        try:
            from src.config.config import Config
            signer = Config.RELATION_SIGNER if isinstance(Config.RELATION_SIGNER, dict) else None
        except Exception:
            signer = None
        if not signer:
            return None

        ticket = str(signer.get('ticket') or '').strip()
        ts_sign = str(signer.get('ts_sign') or '').strip()
        client_cert = str(signer.get('client_cert') or '').strip()
        private_key = str(signer.get('private_key') or '').strip()
        if not ticket or not ts_sign or not client_cert or not private_key:
            return None
        return signer

    def _ecdsa_request_sign(self, value: str, private_key: str) -> tuple[str, str | None]:
        try:
            from cryptography.hazmat.primitives import hashes, serialization
            from cryptography.hazmat.primitives.asymmetric import ec
        except Exception:
            return '', '缺少 cryptography 依赖，请先安装 requirements.txt 后重试'

        pem = str(private_key or '').strip().replace('\\n', '\n')
        try:
            key = serialization.load_pem_private_key(pem.encode('utf-8'), password=None)
            signature = key.sign(value.encode('utf-8'), ec.ECDSA(hashes.SHA256()))
        except Exception as error:
            return '', f'私信签名生成失败: {error}'
        return base64.b64encode(signature).decode('ascii'), None

    def _build_im_request_common_headers(self, signer: dict, extra_headers: dict[str, str] | None = None) -> dict[str, str]:
        cookie_dict = self._cookies_to_dict(self.cookie)
        headers = {
            'session_aid': '6383',
            'session_did': '0',
            'app_name': 'douyin_pc',
            'priority_region': 'cn',
            'user_agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
            'cookie_enabled': 'true',
            'browser_language': 'zh-CN',
            'browser_platform': 'MacIntel',
            'browser_name': 'Mozilla',
            'browser_version': '5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
            'browser_online': 'true',
            'screen_width': '1680',
            'screen_height': '1050',
            'referer': 'https://www.douyin.com/jingxuan',
            'timezone_name': 'Asia/Shanghai',
            'deviceId': '0',
            'webid': cookie_dict.get('webid') or cookie_dict.get('ttwid') or '',
            'fp': cookie_dict.get('s_v_web_id') or self._generate_s_v_web_id(),
            'is-retry': '0',
        }
        for key, value in (extra_headers or {}).items():
            text = str(value or '').strip()
            if key and text:
                headers[str(key)] = text
        return headers

    def _build_im_proto_request(
        self,
        *,
        cmd: int,
        body: bytes,
        request_sign: str,
        signer: dict,
        sdk_version: str = "1.1.3",
        build_number: str = "5fa6ff1:Detached: 5fa6ff1111fd53aafc4c753505d3c93daad74d27",
        extra_headers: dict[str, str] | None = None,
    ) -> bytes:
        sdk_cert = str(signer.get('client_cert') or '')
        return douyin_im_proto.build_request(
            cmd=cmd,
            token=str(signer.get('ticket') or ''),
            ts_sign=str(signer.get('ts_sign') or ''),
            sdk_cert=base64.b64encode(sdk_cert.encode('utf-8')).decode('ascii'),
            request_sign=request_sign,
            body=body,
            headers=self._build_im_request_common_headers(signer, extra_headers),
            sequence_id=random.randint(10000, 11000),
            sdk_version=sdk_version,
            build_number=build_number,
        )

    def _build_im_pc_proto_request(
        self,
        *,
        cmd: int,
        body: bytes,
        signer: dict,
        request_sign: str = '',
        extra_headers: dict[str, str] | None = None,
    ) -> bytes:
        return self._build_im_proto_request(
            cmd=cmd,
            body=body,
            request_sign=request_sign,
            signer=signer,
            sdk_version='0.1.6',
            build_number='fef1a80:p/lzg/store',
            extra_headers=extra_headers,
        )

    @staticmethod
    def _media_uri_from_url(url: str) -> str:
        text = str(url or '').strip()
        if not text:
            return ''
        try:
            parsed = urllib.parse.urlparse(text)
            path = urllib.parse.unquote(parsed.path or '').lstrip('/')
        except Exception:
            path = text.split('?', 1)[0].lstrip('/')
        if not path:
            return ''
        if path.startswith('aweme/'):
            path = path[len('aweme/'):]
        if path.startswith('img/'):
            path = path[len('img/'):]
        path = path.split('~', 1)[0]
        for suffix in ('.webp', '.jpeg', '.jpg', '.png'):
            if path.endswith(suffix):
                path = path[:-len(suffix)]
                break
        return path

    # ---------- IM 安全凭证 ----------

    async def get_im_identity_security_token(self) -> tuple[dict, bool]:
        uri = '/passport/safe/get_identity_security_token/'
        trace_id = uuid.uuid4().hex[:8]
        params = {
            'passport_jssdk_version': '4.2.3',
            'passport_jssdk_type': 'lite',
            'is_from_ttaccountsdk': '1',
            'aid': '6383',
            'language': 'zh',
            'scene': 'web_im',
            'auto_retry_req': '0',
            'skip_verify': 'false',
            'identity_token_force_get_tag': '0',
            'biz_trace_id': trace_id,
            'id_token_version': '1.2.10',
        }
        headers = {
            **self.common_headers,
            'accept': 'application/json, text/javascript',
            'referer': 'https://www.douyin.com/',
            'priority': 'u=1, i',
            'sec-fetch-dest': 'empty',
            'sec-fetch-mode': 'cors',
            'sec-fetch-site': 'same-origin',
            'x-tt-passport-trace-id': trace_id,
        }
        cookie_dict = self._cookies_to_dict(self.cookie)
        csrf_token = cookie_dict.get('passport_csrf_token') or cookie_dict.get('passport_csrf_token_default') or ''
        if csrf_token:
            headers['x-tt-passport-csrf-token'] = csrf_token
        headers.update(self._relation_ticket_guard_headers(uri))
        params = await self._deal_params(params, headers)
        query = urllib.parse.urlencode(params)
        params['a_bogus'] = douyin_sign.sign_detail(query, headers.get('User-Agent') or '')

        try:
            response = await asyncio.to_thread(
                _api_get,
                f'{self.host}{uri}',
                params=params,
                headers=headers,
                cookies=cookie_dict,
                timeout=(10, 30),
            )
        except Exception as error:
            return {'message': f'获取分享安全凭证失败: {error}'}, False
        if response.status_code != 200:
            return {'message': f'获取分享安全凭证失败（HTTP {response.status_code}）'}, False
        try:
            payload = response.json()
        except Exception:
            return {'message': '获取分享安全凭证失败：响应无法解析'}, False
        if str(payload.get('message') or '').lower() not in ('success', 'ok', ''):
            return {'message': str(payload.get('message') or '获取分享安全凭证失败'), 'raw': payload}, False
        data = payload.get('data') if isinstance(payload.get('data'), dict) else {}
        token = str(data.get('identity_security_token') or '').strip()
        device_id = str(data.get('device_id') or '').strip()
        if not token or not device_id:
            return {'message': '获取分享安全凭证失败：缺少 token 或 device_id', 'raw': payload}, False
        return {
            'identity_security_token': token,
            'device_id': device_id,
        }, True

    # ---------- IM proto 发送 ----------

    async def _post_im_proto(self, url: str, payload: bytes, with_signed_query: bool = False) -> tuple[dict, bool]:
        headers = {
            'User-Agent': self.common_headers.get('User-Agent', ''),
            'accept': 'application/x-protobuf',
            'content-type': 'application/x-protobuf',
            'referer': 'https://www.douyin.com/',
            'origin': 'https://www.douyin.com',
        }
        params = None
        if with_signed_query:
            cookie_dict = self._cookies_to_dict(self.cookie)
            fp = cookie_dict.get('s_v_web_id') or self._generate_s_v_web_id()
            params = {
                'verifyFp': fp,
                'fp': fp,
                'msToken': self._get_ms_token(),
            }
            query = urllib.parse.urlencode(params)
            params['a_bogus'] = douyin_sign.sign_detail(query, headers['User-Agent'])

        try:
            response = await asyncio.to_thread(
                _api_post,
                url,
                params=params,
                headers=headers,
                cookies=self._cookies_to_dict(self.cookie),
                data=payload,
                timeout=(10, 30),
            )
        except Exception as e:
            return {'message': f'网络请求失败: {e}'}, False

        if response.status_code != 200 or not response.content:
            return {'message': f'IM protobuf 接口失败（HTTP {response.status_code}）'}, False

        parsed = douyin_im_proto.parse_response(response.content)
        body_keys = list((parsed.get('body') or {}).keys()) if isinstance(parsed.get('body'), dict) else []
        logger.info(
            'Douyin IM protobuf response: url=%s http=%s cmd=%s seq=%s error=%s message=%s body_keys=%s body_len=%s',
            url,
            response.status_code,
            parsed.get('cmd'),
            parsed.get('sequence_id'),
            parsed.get('error_desc') or '',
            parsed.get('message') or '',
            body_keys,
            len(response.content),
        )
        response_message = str(parsed.get('message') or '').strip()
        message_is_error = response_message and response_message.lower() not in ('ok', 'success')
        if parsed.get('error_desc') or message_is_error:
            message = parsed.get('error_desc') or parsed.get('message') or 'IM protobuf 接口返回错误'
            return {'message': message, 'raw': parsed}, False
        return parsed, True

    # ---------- IM 会话/消息发送 ----------

    async def create_im_conversation(self, to_user_id: str | int) -> tuple[dict, bool]:
        signer = self._im_proto_signer()
        if not signer:
            return {'message': '私信安全参数未采集完整，请在设置中重新登录 Cookie 后重试'}, False

        current_user, current_success = await self._api.get_current_user()
        if not current_success:
            return current_user, False

        try:
            to_uid = int(str(to_user_id).strip())
            my_uid = int(str(current_user.get('uid') or '').strip())
        except Exception:
            return {'message': '缺少可用的数字 uid，无法创建私信会话'}, False
        if not to_uid or not my_uid:
            return {'message': '缺少可用的数字 uid，无法创建私信会话'}, False

        sign_data = f'avatar_url=&idempotent_id=&name=&participants={to_uid},{my_uid}'
        request_sign, sign_error = self._ecdsa_request_sign(sign_data, str(signer.get('private_key') or ''))
        if sign_error:
            return {'message': sign_error}, False
        body = douyin_im_proto.build_create_conversation_body(to_uid, my_uid)
        payload = self._build_im_proto_request(
            cmd=609,
            body=body,
            request_sign=request_sign,
            signer=signer,
        )
        response, success = await self._post_im_proto('https://imapi.douyin.com/v2/conversation/create', payload)
        if not success:
            return response, False
        conversation = douyin_im_proto.first_conversation(response)
        if not conversation:
            return {'message': '创建会话成功但未返回会话信息', 'raw': response}, False
        return {
            'conversation_id': conversation.conversation_id,
            'conversation_short_id': conversation.conversation_short_id,
            'conversation_type': conversation.conversation_type,
            'ticket': conversation.ticket,
            'raw': response,
        }, True

    async def send_im_text_message(self, to_user_id: str | int, content: str) -> tuple[dict, bool]:
        message = str(content or '').strip()
        if not message:
            return {'message': '消息内容不能为空'}, False
        msg_content = json.dumps({
            'mention_users': [],
            'aweType': 700,
            'richTextInfos': [],
            'text': message,
        }, ensure_ascii=False, separators=(',', ':'))
        return await self._send_im_content_message(to_user_id, msg_content, message_type=7)

    async def send_im_video_share_message(self, to_user_id: str | int, video: dict) -> tuple[dict, bool]:
        if not isinstance(video, dict):
            return {'message': '缺少视频信息，无法分享'}, False
        aweme_id = str(video.get('aweme_id') or video.get('itemId') or '').strip()
        if not aweme_id:
            return {'message': '缺少作品 ID，无法分享'}, False
        author = video.get('author') if isinstance(video.get('author'), dict) else {}
        video_data = video.get('video') if isinstance(video.get('video'), dict) else {}
        cover = (
            video.get('cover_url')
            or video.get('cover')
            or video_data.get('cover')
            or video_data.get('origin_cover')
            or video_data.get('dynamic_cover')
        )
        cover_url = first_url(cover)
        author_avatar = first_url(
            author.get('avatar_thumb')
            or author.get('avatar_medium')
            or author.get('avatar_larger')
        )
        cover_uri = self._media_uri_from_url(cover_url)
        author_avatar_uri = self._media_uri_from_url(author_avatar)
        content = {
            'aweType': 800,
            'content_title': str(video.get('desc') or aweme_id),
            'cover_height': int(video_data.get('height') or video.get('height') or 0),
            'cover_width': int(video_data.get('width') or video.get('width') or 0),
            'itemId': aweme_id,
            'cover_url': {
                'url_list': [cover_url] if cover_url else [],
                'uri': cover_uri,
            },
            'content_thumb': {
                'url_list': [author_avatar] if author_avatar else [],
                'uri': author_avatar_uri,
            },
            'uid': str(author.get('uid') or video.get('uid') or ''),
        }
        security, security_success = await self.get_im_identity_security_token()
        if not security_success:
            return security, False
        extra_headers = {
            'identity_security_token': json.dumps(
                {'token': security['identity_security_token']},
                ensure_ascii=False,
                separators=(',', ':'),
            ),
            'identity_security_device_id': security['device_id'],
            'identity_security_aid': '6383',
        }
        msg_content = json.dumps(content, ensure_ascii=False, separators=(',', ':'))
        return await self._send_im_content_message(
            to_user_id,
            msg_content,
            message_type=8,
            extra_headers=extra_headers,
        )

    # ---------- AWS VOD 签名（IM 图片上传用） ----------

    @staticmethod
    # ---------- IM 图片上传（委托到 im_uploads 模块） ----------

    async def _get_im_image_upload_config(self) -> tuple[dict, bool]:
        return await im_uploads.get_im_image_upload_config(self.common_request)

    async def _apply_im_image_upload(self, config: dict, file_size: int) -> tuple[dict, bool]:
        return await im_uploads.apply_im_image_upload(config, file_size)

    async def _upload_im_image_bytes(
        self,
        upload_address: dict,
        image_bytes: bytes,
        crc32_hex: str,
    ) -> tuple[dict, bool]:
        return await im_uploads.upload_im_image_bytes(upload_address, image_bytes, crc32_hex)

    async def _commit_im_image_upload(self, config: dict, session_key: str) -> tuple[dict, bool]:
        return await im_uploads.commit_im_image_upload(config, session_key)

    async def send_im_image_message(
        self,
        to_user_id: str | int,
        image_data_url: str,
        width: int = 0,
        height: int = 0,
        file_name: str = '',
        mime_type: str = '',
    ) -> tuple[dict, bool]:
        trimmed = str(image_data_url or '').strip()
        if not trimmed:
            return {'message': '图片内容不能为空'}, False
        inline_pic = trimmed.split(',', 1)[1] if ',' in trimmed else trimmed
        inline_pic = re.sub(r'[\r\n\s]+', '', inline_pic)
        if not inline_pic:
            return {'message': '图片内容不能为空'}, False
        try:
            image_bytes = base64.b64decode(inline_pic, validate=True)
        except Exception:
            return {'message': '图片数据解析失败'}, False
        if not image_bytes:
            return {'message': '图片内容不能为空'}, False

        image_md5 = hashlib.md5(image_bytes).hexdigest()
        crc32_hex = f'{binascii.crc32(image_bytes) & 0xffffffff:08x}'
        file_size = len(image_bytes)

        config, config_success = await self._get_im_image_upload_config()
        if not config_success:
            return config, False
        upload_address, apply_success = await self._apply_im_image_upload(config, file_size)
        if not apply_success:
            return upload_address, False
        upload_result, upload_success = await self._upload_im_image_bytes(upload_address, image_bytes, crc32_hex)
        if not upload_success:
            return upload_result, False
        commit_result, commit_success = await self._commit_im_image_upload(config, upload_address.get('SessionKey'))
        if not commit_success:
            return commit_result, False

        encryption = commit_result.get('Encryption') or {}
        extra = encryption.get('Extra') if isinstance(encryption.get('Extra'), dict) else {}
        oid = encryption.get('Uri')
        skey = encryption.get('SecretKey')
        source_md5 = encryption.get('SourceMd5') or image_md5
        try:
            cover_width = int(extra.get('img_width') or width or 0)
        except Exception:
            cover_width = int(width or 0)
        try:
            cover_height = int(extra.get('img_height') or height or 0)
        except Exception:
            cover_height = int(height or 0)
        try:
            data_size = int(extra.get('img_size') or file_size)
        except Exception:
            data_size = file_size
        if not oid or not skey:
            return {'message': '图片上传完成但缺少资源 oid/skey', 'raw': {'has_encryption': bool(encryption)}}, False

        msg_content = json.dumps({
            'resource_url': {
                'oid': oid,
                'skey': skey,
                'data_size': data_size,
                'md5': source_md5,
            },
            'cover_height': cover_height,
            'cover_width': cover_width,
            'check_pics': [],
            'md5': source_md5,
            'from_gallery': 1,
            'aweType': 2702,
        }, ensure_ascii=False, separators=(',', ':'))
        return await self._send_im_content_message(to_user_id, msg_content, message_type=27)

    # ---------- IM 消息发送核心 ----------

    async def _send_im_content_message(
        self,
        to_user_id: str | int,
        msg_content: str,
        message_type: int = 7,
        extra_headers: dict[str, str] | None = None,
    ) -> tuple[dict, bool]:
        conversation, success = await self.create_im_conversation(to_user_id)
        if not success:
            return conversation, False

        signer = self._im_proto_signer()
        if not signer:
            return {'message': '私信安全参数未采集完整，请在设置中重新登录 Cookie 后重试'}, False

        client_message_id = str(uuid.uuid4())
        sign_data = (
            f'content={msg_content}'
            f'&conversation_id={conversation["conversation_id"]}'
            f'&conversation_short_id={conversation["conversation_short_id"]}'
        )
        request_sign, sign_error = self._ecdsa_request_sign(sign_data, str(signer.get('private_key') or ''))
        if sign_error:
            return {'message': sign_error}, False
        body = douyin_im_proto.build_send_message_body(
            conversation_id=conversation['conversation_id'],
            conversation_short_id=int(conversation['conversation_short_id']),
            ticket=conversation['ticket'],
            content=msg_content,
            client_message_id=client_message_id,
            now_ms=int(time.time() * 1000),
            message_type=message_type,
        )
        payload = self._build_im_pc_proto_request(
            cmd=100,
            body=body,
            request_sign=request_sign,
            signer=signer,
            extra_headers=extra_headers,
        )
        response, send_success = await self._post_im_proto(
            'https://imapi.douyin.com/v1/message/send',
            payload,
            with_signed_query=True,
        )
        if not send_success:
            return response, False
        sent_message = douyin_im_proto.sent_message(response)
        if not sent_message:
            logger.info('Douyin IM send returned OK without inline message ack: %s', response)
            return {
                'message': '发送请求已提交，等待私信通道确认',
                'client_message_id': client_message_id,
                'pending_ack': True,
                'conversation': conversation,
                'raw': response,
            }, True
        return {
            'message': '发送成功',
            'client_message_id': client_message_id,
            'message_id': sent_message.server_message_id,
            'conversation_id': sent_message.conversation_id,
            'conversation_short_id': sent_message.conversation_short_id,
            'conversation': conversation,
            'raw': response,
        }, True

    # ---------- IM 消息历史 ----------

    @staticmethod
    def _normalize_im_messages(messages: list[dict]) -> list[dict]:
        normalized = []
        for item in messages or []:
            if not isinstance(item, dict):
                continue
            text = ''
            content = str(item.get('content') or '')
            is_system_command = False
            try:
                parsed_content = json.loads(content)
                if isinstance(parsed_content, dict):
                    if 'command_type' in parsed_content or parsed_content.get('command_type') == 6:
                        is_system_command = True
                        ext_data = parsed_content.get('ext_data') or []
                        for ext_item in ext_data:
                            if isinstance(ext_item, dict) and ext_item.get('key') == 'a:consecutive_chat_data':
                                text = "🔥 连续聊天火花已亮起"
                                is_system_command = False
                                val_str = ext_item.get('value') or '{}'
                                try:
                                    val_json = json.loads(val_str)
                                    count_info = val_json.get('consecutive_count_info') or {}
                                    count = count_info.get('consecutive_count') or 1
                                    text = f"🔥 连续聊天火花已亮起（第 {count} 天）"
                                except Exception:
                                    pass
                        if is_system_command:
                            continue
                    else:
                        text = str(parsed_content.get('text') or parsed_content.get('tips') or parsed_content.get('hint_text') or '')
                else:
                    text = content
            except Exception:
                text = content
            ext = item.get('ext')
            if isinstance(ext, str):
                try:
                    ext = json.loads(ext)
                except Exception:
                    ext = {}
            if not isinstance(ext, dict):
                ext = {}
            create_time = item.get('create_time') or 0
            if not create_time and ext:
                raw_time = ext.get('s:server_message_create_time') or ext.get('server_message_create_time') or 0
                try:
                    create_time = int(raw_time or 0)
                except Exception:
                    create_time = 0
            if not create_time:
                create_time = item.get('version') or item.get('group_version') or 0
                if create_time > 0 and create_time < 10000000000:
                    create_time *= 1000
            if not create_time:
                import time as _time
                create_time = int(_time.time() * 1000)
            normalized.append({
                'conversation_id': item.get('conversation_id') or '',
                'conversation_short_id': item.get('conversation_short_id') or 0,
                'conversation_type': item.get('conversation_type') or 0,
                'server_message_id': item.get('server_message_id') or 0,
                'index_in_conversation': item.get('index_in_conversation') or 0,
                'sender_uid': str(item.get('sender') or ''),
                'content': text,
                'raw_content': content,
                'message_type': item.get('message_type') or 0,
                'create_time': create_time,
            })
        return normalized

    async def _get_im_recent_user_messages(self, cursor: int = 0) -> tuple[dict, bool]:
        signer = self._im_proto_signer()
        if not signer:
            return {'message': '私信安全参数未采集完整，请在设置中重新登录 Cookie 后重试'}, False
        payload = self._build_im_pc_proto_request(
            cmd=128,
            body=douyin_im_proto.build_get_user_message_body(max(0, int(cursor or 0))),
            signer=signer,
        )
        response, success = await self._post_im_proto(
            'https://imapi.douyin.com/v1/message/get_user_message',
            payload,
        )
        if not success:
            return response, False
        body = response.get('body', {}).get('get_user_message_body', {})
        messages = body.get('messages') if isinstance(body, dict) else []
        return {
            'message': '获取历史消息成功',
            'messages': self._normalize_im_messages(messages),
            'next_cursor': body.get('next_cursor') if isinstance(body, dict) else 0,
            'has_more': bool(body.get('has_more')) if isinstance(body, dict) else False,
        }, True

    async def get_im_history_messages(
        self,
        cursor: int = 0,
        to_user_id: str | int | None = None,
        conversation_id: str | None = None,
        conversation_short_id: int | None = None,
        conversation_type: int = 1,
    ) -> tuple[dict, bool]:
        signer = self._im_proto_signer()
        if not signer:
            return {'message': '私信安全参数未采集完整，请在设置中重新登录 Cookie 后重试'}, False

        conversation = None
        if conversation_id and conversation_short_id:
            conversation = {
                'conversation_id': str(conversation_id),
                'conversation_short_id': int(conversation_short_id or 0),
                'conversation_type': int(conversation_type or 1),
            }
        elif to_user_id:
            conversation, created = await self.create_im_conversation(to_user_id)
            if not created:
                return conversation, False

        if not conversation:
            return await self._get_im_recent_user_messages(cursor)

        payload = self._build_im_pc_proto_request(
            cmd=301,
            body=douyin_im_proto.build_get_by_conversation_body(
                conversation_id=str(conversation.get('conversation_id') or ''),
                conversation_short_id=int(conversation.get('conversation_short_id') or 0),
                conversation_type=int(conversation.get('conversation_type') or 1),
                cursor=max(0, int(cursor or 0)),
                count=20,
            ),
            signer=signer,
        )
        response, success = await self._post_im_proto(
            'https://imapi.douyin.com/v1/message/get_by_conversation',
            payload,
        )
        if not success:
            return response, False
        body = response.get('body', {}).get('get_by_conversation_body', {})
        messages = body.get('messages') if isinstance(body, dict) else []
        return {
            'message': '获取历史消息成功',
            'messages': self._normalize_im_messages(messages),
            'next_cursor': body.get('next_cursor') if isinstance(body, dict) else 0,
            'has_more': bool(body.get('has_more')) if isinstance(body, dict) else False,
            'conversation': {
                'conversation_id': conversation.get('conversation_id') or '',
                'conversation_short_id': conversation.get('conversation_short_id') or 0,
                'conversation_type': conversation.get('conversation_type') or 0,
            },
        }, True
