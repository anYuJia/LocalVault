from __future__ import annotations

import asyncio
import requests
import requests.adapters
import urllib3.util.retry
import urllib.parse
import urllib.request
import os
import re
import json
import base64
import binascii
import sys
import random
import string
import threading
import time
import hmac
import hashlib
import logging
import uuid
from src.api import sign as douyin_sign
from src.api import douyin_im_proto

logger = logging.getLogger('api')

# Configure a session with retry/SSL resilience
_retry = urllib3.util.retry.Retry(total=3, backoff_factor=0.5, status_forcelist=[502, 503, 504])
_thread_local = threading.local()


def _splice_params(params: dict) -> str:
    parts = []
    for key, value in params.items():
        if value is None:
            value = ''
        parts.append(f'{key}={urllib.parse.quote(str(value))}')
    return '&'.join(parts)


def _sign_spider_a_bogus(query: str, data: str) -> str:
    """Use the Spider request shape for endpoints whose body participates in a_bogus."""
    return douyin_sign.sign_spider_publish(query, data)


def _create_api_session():
    session = requests.Session()
    session.mount('https://', requests.adapters.HTTPAdapter(max_retries=_retry))
    return session


def _get_api_session():
    session = getattr(_thread_local, 'api_session', None)
    if session is None:
        session = _create_api_session()
        _thread_local.api_session = session
    return session


def _api_get(*args, **kwargs):
    return _get_api_session().get(*args, **kwargs)


def _api_post(*args, **kwargs):
    return _get_api_session().post(*args, **kwargs)


def _redact_headers(headers: dict) -> dict:
    redacted = dict(headers or {})
    for key in list(redacted.keys()):
        if key.lower() in ('cookie', 'authorization'):
            redacted[key] = '<redacted>'
    return redacted


def _redact_params(params: dict) -> dict:
    redacted = dict(params or {})
    for key in ('msToken', 'a_bogus', 'verifyFp', 'fp', 'webid', 'uifid'):
        if key in redacted:
            redacted[key] = '<redacted>'
    return redacted



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

    async def _get_webid(self, headers: dict, url: str = '') -> str:
        """获取webid（缓存10分钟）"""
        import time
        if self._cached_webid and (time.time() - self._webid_time) < 600:
            return self._cached_webid
        try:
            url = url or 'https://www.douyin.com/?recommend=1'
            h = headers.copy()
            h['sec-fetch-dest'] = 'document'
            h['sec-fetch-mode'] = 'navigate'
            h['sec-fetch-site'] = 'none'
            h['accept'] = 'text/html,application/xhtml+xml'
            h['upgrade-insecure-requests'] = '1'
            if self.cookie:
                h['Cookie'] = self.cookie

            response = await asyncio.to_thread(_api_get, url, headers=h, timeout=10, verify=False)
            if self.debug_mode:
                print(f"\033[93m[API] _get_webid 响应状态: {response.status_code}, 内容长度: {len(response.text)}\033[0m")
            if response.status_code != 200 or not response.text:
                if self.debug_mode:
                    print(f"\033[91m[API] 获取webid失败: {response.status_code}\033[0m")
                return None

            # Try multiple patterns
            for pattern in [
                r'\\"user_unique_id\\":\\"(\d+)\\"',
                r'"user_unique_id":"(\d+)"',
                r'"webid":"(\d+)"',
                r'webid=(\d+)',
            ]:
                match = re.search(pattern, response.text)
                if match:
                    webid = match.group(1)
                    self._cached_webid = webid
                    self._webid_time = time.time()
                    if self.debug_mode:
                        print(f"\033[93m[API] 获取到webid: {webid}\033[0m")
                    return webid

            if self.debug_mode:
                print(f"\033[91m[API] 未能从页面提取webid\033[0m")
        except Exception as e:
            if self.debug_mode:
                print(f"\033[91m[API] 获取webid异常: {e}\033[0m")
        return None

    def _generate_fake_webid(self, random_length: int = 19) -> str:
        """生成 Spider 同款兜底 webid。"""
        return ''.join(random.choices(string.digits, k=random_length))

    async def _get_csrf_token(self, headers: dict, force_refresh: bool = False) -> str:
        """获取抖音动作接口需要的 csrf token（缓存10分钟）。"""
        import time
        if not force_refresh and self._cached_csrf_token and (time.time() - self._csrf_time) < 600:
            return self._cached_csrf_token

        h = dict(headers or {})
        h.update({
            'accept': '*/*',
            'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6',
            'cache-control': 'no-cache',
            'pragma': 'no-cache',
            'priority': 'u=1, i',
            'referer': 'https://www.douyin.com/?recommend=1',
            'sec-ch-ua': '"Microsoft Edge";v="125", "Chromium";v="125", "Not.A/Brand";v="24"',
            'sec-ch-ua-mobile': '?0',
            'sec-ch-ua-platform': '"Windows"',
            'sec-fetch-dest': 'empty',
            'sec-fetch-mode': 'cors',
            'sec-fetch-site': 'same-origin',
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
            'x-secsdk-csrf-request': '1',
            'x-secsdk-csrf-version': '1.2.22',
        })
        h.pop('content-type', None)
        h.pop('Content-Type', None)
        try:
            response = await asyncio.to_thread(
                _get_api_session().head,
                'https://www.douyin.com/service/2/abtest_config/',
                headers=h,
                timeout=(10, 30),
            )
            raw_token = response.headers.get('x-ware-csrf-token') or response.headers.get('X-Ware-Csrf-Token') or ''
            parts = [part.strip() for part in raw_token.split(',')]
            token = parts[1] if len(parts) > 1 and parts[1] else next((part for part in parts if len(part) > 16), '')
            if token:
                self._cached_csrf_token = token
                self._csrf_time = time.time()
                return token
        except Exception as e:
            if self.debug_mode:
                print(f"\033[91m[API] 获取 csrf token 失败: {e}\033[0m")

        return ''
    
    async def _deal_params(self, params: dict, headers: dict) -> dict:
        """处理请求参数"""
        try:
            # 添加cookie到headers
            if self.cookie:
                headers['Cookie'] = self.cookie

            cookie = headers.get('cookie') or headers.get('Cookie')
            if not cookie:
                return params

            cookie_dict = self._cookies_to_dict(cookie)

            # 从cookie中提取参数
            params['msToken'] = self._get_ms_token()
            params['screen_width'] = cookie_dict.get('dy_swidth', params.get('screen_width', 1680))
            params['screen_height'] = cookie_dict.get('dy_sheight', params.get('screen_height', 1050))
            params['cpu_core_num'] = cookie_dict.get('device_web_cpu_core', params.get('cpu_core_num', 8))
            params['device_memory'] = cookie_dict.get('device_web_memory_size', params.get('device_memory', 8))
            s_v_web_id = cookie_dict.get('s_v_web_id') or self._generate_s_v_web_id()
            params['verifyFp'] = s_v_web_id
            params['fp'] = s_v_web_id

            # 从cookie中提取uifid并添加到header和参数
            uifid = cookie_dict.get('UIFID', '')
            if uifid:
                headers['uifid'] = uifid
                params['uifid'] = uifid

            # Spider 在提取失败时会生成 19 位数字 webid，动作接口不能省略它。
            params['webid'] = await self._get_webid(headers) or self._generate_fake_webid()

            return params
        except Exception as e:
            if self.debug_mode:
                print(f"\033[91m[API] 处理参数失败: {e}\033[0m")
            return params

    def _cookies_to_dict(self, cookie_str: str) -> dict:
        """将cookie字符串转换为字典"""
        cookie_dict = {}
        if not cookie_str:
            return cookie_dict
        
        try:
            for item in cookie_str.split(';'):
                if '=' in item:
                    key, value = item.strip().split('=', 1)
                    cookie_dict[key] = value
        except Exception as e:
            if self.debug_mode:
                print(f"\033[91m[API] 解析cookie失败: {e}\033[0m")
        
        return cookie_dict

    def _ticket_guard_headers_from_cookie(self) -> dict:
        cookie_dict = self._cookies_to_dict(self.cookie)
        raw_legacy_client_data = cookie_dict.get('bd_ticket_guard_client_data') or ''
        raw_client_data_v2 = cookie_dict.get('bd_ticket_guard_client_data_v2') or ''
        raw_client_data = raw_client_data_v2 or cookie_dict.get('bd_ticket_guard_client_data') or ''
        if not raw_client_data:
            return {}

        headers = {}
        if raw_client_data_v2 and raw_legacy_client_data:
            try:
                legacy_decoded = urllib.parse.unquote(raw_legacy_client_data)
                legacy_payload = json.loads(base64.b64decode(legacy_decoded).decode('utf-8'))
                for key, value in legacy_payload.items():
                    if key.startswith('bd-ticket-guard-'):
                        headers[key] = str(value)
            except Exception:
                pass

        try:
            decoded_cookie = urllib.parse.unquote(raw_client_data)
            payload = json.loads(base64.b64decode(decoded_cookie).decode('utf-8'))
        except Exception:
            return {}

        if raw_client_data_v2:
            headers['bd-ticket-guard-client-data'] = decoded_cookie
        for key, value in payload.items():
            if key.startswith('bd-ticket-guard-'):
                headers[key] = str(value)
        if 'bd-ticket-guard-ree-public-key' not in headers and payload.get('ree_public_key'):
            headers['bd-ticket-guard-ree-public-key'] = str(payload['ree_public_key'])
        headers.setdefault('bd-ticket-guard-web-sign-type', '1' if raw_client_data_v2 else '0')
        return headers

    def _decode_relation_ecdh_key(self, value: str) -> bytes | None:
        text = str(value or '').strip()
        if not text:
            return None
        try:
            if len(text) == 64 and re.fullmatch(r'[0-9a-fA-F]+', text):
                return bytes.fromhex(text)
            return base64.b64decode(text)
        except Exception:
            return None

    def _relation_ticket_guard_headers(self, path: str) -> dict:
        try:
            from src.config.config import Config
            signer = Config.RELATION_SIGNER if isinstance(Config.RELATION_SIGNER, dict) else None
        except Exception:
            signer = None

        if not signer:
            return self._ticket_guard_headers_from_cookie()

        ticket = str(signer.get('ticket') or '').strip()
        ts_sign = str(signer.get('ts_sign') or '').strip()
        public_key = str(signer.get('public_key') or signer.get('ree_public_key') or '').strip()
        ecdh_key = self._decode_relation_ecdh_key(str(signer.get('ecdh_key') or ''))
        if not ticket or not ts_sign or not public_key or not ecdh_key:
            if self.debug_mode:
                print('\033[93m[API] 关系动作 signer 不完整，降级使用 Cookie 中的 TicketGuard 头\033[0m')
            return self._ticket_guard_headers_from_cookie()

        timestamp = int(time.time())
        sign_data = f'ticket={ticket}&path={path}&timestamp={timestamp}'
        req_sign = base64.b64encode(
            hmac.new(ecdh_key, sign_data.encode('utf-8'), hashlib.sha256).digest()
        ).decode('ascii')
        client_data = base64.b64encode(json.dumps({
            'ts_sign': ts_sign,
            'req_content': 'ticket,path,timestamp',
            'req_sign': req_sign,
            'timestamp': timestamp,
        }, separators=(',', ':'), ensure_ascii=False).encode('utf-8')).decode('ascii')

        return {
            'bd-ticket-guard-ree-public-key': public_key,
            'bd-ticket-guard-web-version': '2',
            'bd-ticket-guard-web-sign-type': '1',
            'bd-ticket-guard-version': '2',
            'bd-ticket-guard-iteration-version': '1',
            'bd-ticket-guard-client-data': client_data,
        }

    def _spider_ticket_guard_headers(self, path: str) -> dict:
        """TicketGuard headers exactly like Douyin_Spider Header.with_bd."""
        try:
            from src.config.config import Config
            signer = Config.RELATION_SIGNER if isinstance(Config.RELATION_SIGNER, dict) else None
        except Exception:
            signer = None

        if not signer:
            return {}

        ticket = str(signer.get('ticket') or '').strip()
        ts_sign = str(signer.get('ts_sign') or '').strip()
        private_key = str(signer.get('private_key') or '').strip().replace('\\n', '\n')
        if not ticket or not ts_sign or not private_key:
            return {}

        timestamp = int(time.time())
        sign_data = f'ticket={ticket}&path={path}&timestamp={timestamp}'
        client_data = base64.urlsafe_b64encode(json.dumps({
            'ts_sign': ts_sign,
            'req_content': 'ticket,path,timestamp',
            'req_sign': douyin_sign.get_req_sign(sign_data, private_key),
            'timestamp': timestamp,
        }, separators=(',', ':'), ensure_ascii=False).encode('utf-8')).decode('utf-8')

        return {
            'bd-ticket-guard-client-data': client_data,
            'bd-ticket-guard-iteration-version': '1',
            'bd-ticket-guard-ree-public-key': douyin_sign.get_ree_key(private_key),
            'bd-ticket-guard-version': '2',
            'bd-ticket-guard-web-version': '1',
        }

    def _relation_uid_hash(self) -> str:
        try:
            from src.config.config import Config
            signer = Config.RELATION_SIGNER if isinstance(Config.RELATION_SIGNER, dict) else None
        except Exception:
            signer = None
        uid = str((signer or {}).get('uid') or '').strip()
        if not uid:
            cookie_dict = self._cookies_to_dict(self.cookie)
            uid = str(cookie_dict.get('uid_tt') or cookie_dict.get('uid_tt_ss') or '').strip()
        if not uid:
            return ''
        if len(uid) == 32 and re.fullmatch(r'[0-9a-fA-F]+', uid):
            return uid.lower()
        return hashlib.md5(uid.encode('utf-8')).hexdigest()

    def _relation_dtrait(self) -> str:
        try:
            from src.config.config import Config
            signer = Config.RELATION_SIGNER if isinstance(Config.RELATION_SIGNER, dict) else None
        except Exception:
            signer = None
        dtrait = str((signer or {}).get('dtrait') or '').strip()
        if dtrait:
            return dtrait

        for key in ('DOUYIN_RELATION_DTRAIT', 'DOUYIN_DTRAIT', 'X_TT_SESSION_DTRAIT'):
            dtrait = str(os.environ.get(key) or '').strip()
            if dtrait:
                return dtrait

        try:
            config_path = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', 'data', 'sign_config.json'))
            if os.path.exists(config_path):
                with open(config_path, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                dtrait = str(data.get('x_tt_session_dtrait') or data.get('dtrait') or '').strip()
                if dtrait:
                    return dtrait
        except Exception:
            pass

        return ''

    def _get_ms_token(self) -> str:
        """生成msToken"""
        return ''.join(random.choices(string.ascii_letters + string.digits, k=107))

    def _generate_s_v_web_id(self) -> str:
        """生成s_v_web_id (verifyFp)"""
        charset = string.ascii_lowercase + string.digits
        random_str = ''.join(random.choices(charset, k=16))
        return f"verify_0{random_str}"

    def _build_verify_hint(self, uri: str, params: dict, response=None) -> tuple[dict, bool]:
        """构造统一的验证提示结果。"""
        verify_url = 'https://www.douyin.com/'

        try:
            if uri and ('discover/search' in uri or 'general/search' in uri):
                keyword = params.get('keyword', '')
                if keyword:
                    verify_url = f"https://www.douyin.com/jingxuan/search/{urllib.parse.quote(str(keyword))}?type=user"
            elif uri and 'user/profile' in uri:
                sec_uid = params.get('sec_user_id', '')
                if sec_uid:
                    verify_url = f'https://www.douyin.com/user/{sec_uid}'
            elif uri and 'aweme/post' in uri:
                sec_uid = params.get('sec_user_id', '')
                if sec_uid:
                    verify_url = f'https://www.douyin.com/user/{sec_uid}'
            elif uri and 'aweme/favorite' in uri:
                verify_url = 'https://www.douyin.com/'
            elif uri and 'module/feed' in uri:
                verify_url = 'https://www.douyin.com/?recommend=1'
            elif uri and 'aweme/detail' in uri:
                aweme_id = params.get('aweme_id', '')
                if aweme_id:
                    verify_url = f'https://www.douyin.com/video/{aweme_id}'
            elif uri and 'comment/list' in uri:
                aweme_id = params.get('aweme_id', '')
                if aweme_id:
                    verify_url = f'https://www.douyin.com/video/{aweme_id}'
        except Exception:
            pass

        message = '需要完成验证后重试'
        if response is not None:
            try:
                if getattr(response, 'status_code', 0):
                    message = f'请求被拒绝（HTTP {response.status_code}），请完成验证后重试'
            except Exception:
                pass

        return {
            '_need_verify': True,
            '_verify_url': verify_url,
            'message': message,
        }, False

    def _extract_api_message(self, data: dict, fallback: str = '请求失败') -> str:
        if not isinstance(data, dict):
            return fallback

        for key in ('message', 'status_msg', 'log_pb'):
            value = data.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()

        return fallback

    def _looks_like_logged_out_error(self, data: dict) -> bool:
        if not isinstance(data, dict):
            return False

        status_code = data.get('status_code')
        if status_code in (8, '8'):
            return True

        text_parts = []
        for key in ('message', 'status_msg', 'prompts', 'status_msg_extra'):
            value = data.get(key)
            if isinstance(value, str):
                text_parts.append(value)
            elif value is not None:
                text_parts.append(str(value))

        text = ' '.join(text_parts).lower()
        return any(
            token in text
            for token in (
                '用户未登录',
                '未登录',
                '登录态',
                '重新登录',
                'session expired',
                'not login',
                'not logged in',
                'login required',
            )
        )

    def _build_login_required_error(self, data: dict | None = None) -> dict:
        data = data if isinstance(data, dict) else {}
        api_message = self._extract_api_message(data, '用户未登录')
        return {
            '_need_login': True,
            'status_code': data.get('status_code'),
            'status_msg': data.get('status_msg', ''),
            'message': f'{api_message}，请在设置中重新登录并刷新 Cookie',
        }

    def _looks_like_login_or_verify_error(self, uri: str, data: dict) -> bool:
        if not isinstance(data, dict):
            return False

        text_parts = []
        for key in ('message', 'status_msg', 'prompts', 'status_msg_extra'):
            value = data.get(key)
            if isinstance(value, str):
                text_parts.append(value)
            elif value is not None:
                text_parts.append(str(value))

        filter_detail = data.get('filter_detail')
        if isinstance(filter_detail, dict):
            text_parts.extend(str(value) for value in filter_detail.values() if value is not None)

        text = ' '.join(text_parts).lower()
        if not text:
            return False

        if any(token in text for token in ('verify', 'captcha', 'passport', 'login')):
            return True
        if any(token in text for token in ('验证', '登录', 'cookie', '风控', '访问频繁', '请稍后重试')):
            return True

        sensitive_uri = any(
            fragment in (uri or '')
            for fragment in ('aweme/post', 'aweme/favorite', 'module/feed', 'user/profile', 'comment/list')
        )
        return sensitive_uri and '请求失败' in text

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
            print(f'[DEBUG] response.status_code={response.status_code}, len(response.content)={len(response.content)}, len(response.text)={len(response.text)}')
            sys.stderr.write(f'*** [API] 普通请求响应：status={response.status_code}, content_len={len(response.content)} ***\n')
            sys.stderr.flush()
        
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
        logger.info(
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

        logger.info(
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
        except requests.RequestException as e:
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

    @staticmethod
    def _collect_spotlight_sec_user_ids(response: dict, include_all_users: bool, limit: int) -> list[str]:
        ids = []
        seen = set()

        def push_id(item):
            if not isinstance(item, dict):
                return
            for key in ('sec_uid', 'sec_user_id'):
                value = str(item.get(key) or '').strip()
                if value and value not in seen:
                    seen.add(value)
                    ids.append(value)
                    return

        for item in response.get('followings') or []:
            if not isinstance(item, dict):
                continue
            is_mutual = int(item.get('follow_status') or 0) > 0 and int(item.get('follower_status') or 0) > 0
            if include_all_users or is_mutual:
                push_id(item)

        for item in response.get('sorted_info') or []:
            if isinstance(item, dict) and int(item.get('conv_type') or 0) == 0:
                push_id(item)

        if include_all_users:
            for key in ('mix_recent_share_day_sort', 'mix_recent_share_users', 'single_recent_share_users'):
                for item in response.get(key) or []:
                    push_id(item)
            recent_share_users = response.get('recent_share_users')
            if isinstance(recent_share_users, dict):
                for item in recent_share_users.get('data') or []:
                    push_id(item)

        return ids[:limit]

    @staticmethod
    def _collect_sec_uid_records(value) -> list[dict]:
        records = []
        seen = set()

        def visit(item):
            if isinstance(item, list):
                for child in item:
                    visit(child)
                return
            if not isinstance(item, dict):
                return
            sec_uid = str(item.get('sec_uid') or item.get('sec_user_id') or '').strip()
            if sec_uid and sec_uid not in seen:
                seen.add(sec_uid)
                records.append(item)
            for child in item.values():
                if isinstance(child, (dict, list)):
                    visit(child)

        visit(value)
        return records

    @staticmethod
    def _share_sorted_sec_uids(response: dict, limit: int) -> list[str]:
        ids = []
        seen = set()
        for item in response.get('sorted_info') or []:
            if not isinstance(item, dict) or int(item.get('conv_type') or 0) != 0:
                continue
            sec_uid = str(item.get('sec_uid') or item.get('sec_user_id') or '').strip()
            if sec_uid and sec_uid not in seen:
                seen.add(sec_uid)
                ids.append(sec_uid)
            if len(ids) >= limit:
                break
        return ids

    @staticmethod
    def _first_url(value) -> str:
        if isinstance(value, str):
            return value.strip()
        if isinstance(value, dict):
            url_list = value.get('url_list')
            if isinstance(url_list, list):
                for item in url_list:
                    url = DouyinAPI._first_url(item)
                    if url:
                        return url
            for key in ('url', 'uri', 'src', 'download_url'):
                url = DouyinAPI._first_url(value.get(key))
                if url:
                    return url
        if isinstance(value, list):
            for item in value:
                url = DouyinAPI._first_url(item)
                if url:
                    return url
        return ''

    @staticmethod
    def _normalize_share_friends(response: dict, limit: int) -> list[dict]:
        users_by_sec_uid = {}
        recent_meta = {}
        order = []
        seen_order = set()

        def remember_order(sec_uid: str):
            sec_uid = str(sec_uid or '').strip()
            if sec_uid and sec_uid not in seen_order:
                seen_order.add(sec_uid)
                order.append(sec_uid)

        def read_sec_uid(item: dict) -> str:
            if not isinstance(item, dict):
                return ''
            return str(item.get('sec_uid') or item.get('sec_user_id') or '').strip()

        for item in response.get('followings') or []:
            if not isinstance(item, dict):
                continue
            sec_uid = read_sec_uid(item)
            if not sec_uid:
                continue
            users_by_sec_uid[sec_uid] = item
            remember_order(sec_uid)

        for key in ('mix_recent_share_day_sort', 'mix_recent_share_users', 'single_recent_share_users'):
            for item in response.get(key) or []:
                if not isinstance(item, dict):
                    continue
                sec_uid = read_sec_uid(item)
                if not sec_uid:
                    continue
                meta = recent_meta.setdefault(sec_uid, {})
                meta['is_recent_share'] = True
                if item.get('conv_id'):
                    meta['conv_id'] = str(item.get('conv_id'))
                if item.get('conv_type') is not None:
                    meta['conv_type'] = int(item.get('conv_type') or 0)
                if item.get('share_day_cnt') is not None:
                    meta['share_day_count'] = int(item.get('share_day_cnt') or 0)
                if item.get('last_share_timestamp') is not None:
                    meta['last_share_timestamp'] = int(item.get('last_share_timestamp') or 0)
                elif item.get('timestamp') is not None:
                    meta['last_share_timestamp'] = int(item.get('timestamp') or 0)

        sorted_order = []
        sorted_seen = set()
        for item in response.get('sorted_info') or []:
            if not isinstance(item, dict) or int(item.get('conv_type') or 0) != 0:
                continue
            sec_uid = read_sec_uid(item)
            if sec_uid and sec_uid not in sorted_seen:
                sorted_seen.add(sec_uid)
                sorted_order.append(sec_uid)

        ordered_ids = [sec_uid for sec_uid in sorted_order if sec_uid in users_by_sec_uid]
        ordered_ids.extend([sec_uid for sec_uid in order if sec_uid in users_by_sec_uid and sec_uid not in set(ordered_ids)])

        friends = []
        seen = set()
        for sec_uid in ordered_ids:
            if sec_uid in seen:
                continue
            seen.add(sec_uid)
            user = users_by_sec_uid.get(sec_uid) or {}
            nickname = str(user.get('nickname') or user.get('remark_name') or user.get('unique_id') or user.get('short_id') or '').strip()
            if not nickname:
                continue
            friend = {
                'uid': str(user.get('uid') or ''),
                'sec_uid': sec_uid,
                'nickname': nickname,
                'avatar_thumb': DouyinAPI._first_url(user.get('avatar_thumb') or user.get('avatar_small')),
                'avatar_medium': DouyinAPI._first_url(user.get('avatar_medium') or user.get('avatar_168x168') or user.get('avatar_small')),
                'unique_id': str(user.get('unique_id') or ''),
                'short_id': str(user.get('short_id') or ''),
                'follow_status': int(user.get('follow_status') or 0),
                'follower_status': int(user.get('follower_status') or 0),
                **recent_meta.get(sec_uid, {}),
            }
            friends.append(friend)
            if len(friends) >= limit:
                break

        return friends

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
        return self._collect_spotlight_sec_user_ids(response, include_all_users, limit), True, response

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
            for sec_uid in self._share_sorted_sec_uids(response, safe_limit)
            if sec_uid and sec_uid not in known_sec_uids
        ]
        if missing_sec_uids:
            followings = response.setdefault('followings', [])
            for index in range(0, len(missing_sec_uids), 20):
                user_info, user_success = await self.get_im_user_info(missing_sec_uids[index:index + 20])
                if not user_success:
                    continue
                for record in self._collect_sec_uid_records(user_info):
                    sec_uid = str(record.get('sec_uid') or record.get('sec_user_id') or '').strip()
                    if sec_uid and sec_uid not in known_sec_uids:
                        known_sec_uids.add(sec_uid)
                        followings.append(record)
        friends = self._normalize_share_friends(response, safe_limit)
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
        except requests.RequestException as error:
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
        except requests.RequestException as e:
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

    async def create_im_conversation(self, to_user_id: str | int) -> tuple[dict, bool]:
        signer = self._im_proto_signer()
        if not signer:
            return {'message': '私信安全参数未采集完整，请在设置中重新登录 Cookie 后重试'}, False

        current_user, current_success = await self.get_current_user()
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
        cover_url = self._first_url(cover)
        author_avatar = self._first_url(
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

    @staticmethod
    def _aws_quote(value) -> str:
        return urllib.parse.quote(str(value), safe='-_.~')

    @classmethod
    def _aws_canonical_query(cls, params: dict) -> str:
        pairs = []
        for key, value in sorted((str(k), str(v)) for k, v in (params or {}).items()):
            pairs.append(f'{cls._aws_quote(key)}={cls._aws_quote(value)}')
        return '&'.join(pairs)

    @staticmethod
    def _aws_signing_key(secret_access_key: str, date_stamp: str, region: str = 'cn-north-1', service: str = 'vod') -> bytes:
        k_date = hmac.new(('AWS4' + secret_access_key).encode('utf-8'), date_stamp.encode('utf-8'), hashlib.sha256).digest()
        k_region = hmac.new(k_date, region.encode('utf-8'), hashlib.sha256).digest()
        k_service = hmac.new(k_region, service.encode('utf-8'), hashlib.sha256).digest()
        return hmac.new(k_service, b'aws4_request', hashlib.sha256).digest()

    def _aws_vod_auth_headers(
        self,
        method: str,
        query_params: dict,
        access_key_id: str,
        secret_access_key: str,
        session_token: str,
        payload_hash: str,
        extra_signed_headers: dict | None = None,
    ) -> tuple[str, dict]:
        now = time.gmtime()
        amz_date = time.strftime('%Y%m%dT%H%M%SZ', now)
        date_stamp = time.strftime('%Y%m%d', now)
        token = str(session_token or '').split('|', 1)[0]
        signed_header_values = {
            'x-amz-date': amz_date,
            'x-amz-security-token': token,
        }
        for key, value in (extra_signed_headers or {}).items():
            signed_header_values[str(key).lower()] = str(value)

        canonical_headers = ''.join(
            f'{key}:{signed_header_values[key].strip()}\n'
            for key in sorted(signed_header_values.keys())
        )
        signed_headers = ';'.join(sorted(signed_header_values.keys()))
        canonical_request = '\n'.join([
            method.upper(),
            '/',
            self._aws_canonical_query(query_params),
            canonical_headers,
            signed_headers,
            payload_hash,
        ])
        credential_scope = f'{date_stamp}/cn-north-1/vod/aws4_request'
        string_to_sign = '\n'.join([
            'AWS4-HMAC-SHA256',
            amz_date,
            credential_scope,
            hashlib.sha256(canonical_request.encode('utf-8')).hexdigest(),
        ])
        signature = hmac.new(
            self._aws_signing_key(secret_access_key, date_stamp),
            string_to_sign.encode('utf-8'),
            hashlib.sha256,
        ).hexdigest()
        headers = {
            'authorization': (
                'AWS4-HMAC-SHA256 '
                f'Credential={access_key_id}/{credential_scope}, '
                f'SignedHeaders={signed_headers}, '
                f'Signature={signature}'
            ),
            'x-amz-date': amz_date,
            'x-amz-security-token': token,
        }
        for key, value in (extra_signed_headers or {}).items():
            headers[str(key).lower()] = str(value)
        return self._aws_canonical_query(query_params), headers

    async def _get_im_image_upload_config(self) -> tuple[dict, bool]:
        params = {
            'update_version_code': '170400',
            'version_code': '170400',
            'version_name': '17.4.0',
            'browser_name': 'Chrome',
            'browser_version': '148.0.0.0',
            'engine_version': '148.0.0.0',
            'round_trip_time': '150',
        }
        headers = {
            'Referer': 'https://www.douyin.com/jingxuan',
            'sec-fetch-site': 'same-origin',
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
            'sec-ch-ua': '"Chromium";v="148", "Google Chrome";v="148", "Not/A)Brand";v="99"',
        }
        response, success = await self.common_request('/aweme/v1/web/im/upload/config/v2', params, headers)
        if not success:
            return response, False
        config = response.get('public_image_config_v2') or response.get('public_image_config') or {}
        required = ('access_key_id', 'secret_access_key', 'session_token', 'space_name')
        if not all(config.get(key) for key in required):
            return {
                'message': '抖音未返回完整图片上传配置，请刷新 Cookie 后重试',
                'raw_keys': sorted(response.keys()) if isinstance(response, dict) else [],
            }, False
        return config, True

    async def _apply_im_image_upload(self, config: dict, file_size: int) -> tuple[dict, bool]:
        query_params = {
            'Action': 'ApplyUploadInner',
            'Version': '2020-11-19',
            'SpaceName': config['space_name'],
            'FileType': 'image',
            'IsInner': '1',
            'NeedFallback': 'true',
            'FileSize': str(file_size),
            's': 'r' + ''.join(random.choices(string.ascii_lowercase + string.digits, k=10)),
        }
        empty_hash = hashlib.sha256(b'').hexdigest()
        query, auth_headers = self._aws_vod_auth_headers(
            'GET',
            query_params,
            config['access_key_id'],
            config['secret_access_key'],
            config['session_token'],
            empty_hash,
        )
        headers = {
            'accept': '*/*',
            'origin': 'https://www.douyin.com',
            'referer': 'https://www.douyin.com/',
            'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
            **auth_headers,
        }
        url = f'https://vod.bytedanceapi.com/?{query}'
        try:
            response = await asyncio.to_thread(_api_get, url, headers=headers, timeout=(10, 60))
            data = response.json()
        except Exception as e:
            return {'message': f'申请图片上传失败: {e}'}, False
        if response.status_code != 200 or not isinstance(data, dict) or data.get('ResponseMetadata', {}).get('Error'):
            return {'message': '申请图片上传失败', 'status_code': response.status_code, 'raw': data}, False
        upload_address = (data.get('Result') or {}).get('UploadAddress') or {}
        if not upload_address.get('StoreInfos') or not upload_address.get('UploadHosts') or not upload_address.get('SessionKey'):
            return {'message': '申请图片上传成功但返回缺少上传地址', 'raw': data}, False
        return upload_address, True

    async def _upload_im_image_bytes(
        self,
        upload_address: dict,
        image_bytes: bytes,
        crc32_hex: str,
    ) -> tuple[dict, bool]:
        store_info = (upload_address.get('StoreInfos') or [{}])[0]
        host = (upload_address.get('UploadHosts') or [''])[0]
        store_uri = str(store_info.get('StoreUri') or '').strip()
        auth = str(store_info.get('Auth') or '').strip()
        if not host or not store_uri or not auth:
            return {'message': '图片上传地址不完整'}, False
        storage_header = store_info.get('StorageHeader') if isinstance(store_info.get('StorageHeader'), dict) else {}
        headers = {
            'accept': '*/*',
            'authorization': auth,
            'content-crc32': crc32_hex,
            'content-disposition': 'attachment; filename="undefined"',
            'content-type': 'application/octet-stream',
            'origin': 'https://www.douyin.com',
            'referer': 'https://www.douyin.com/',
            'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
        }
        user_id = storage_header.get('USER_ID') or storage_header.get('user_id')
        if user_id:
            headers['x-storage-u'] = str(user_id)
        url = f'https://{host}/upload/v1/{store_uri}'
        try:
            response = await asyncio.to_thread(_api_post, url, data=image_bytes, headers=headers, timeout=(10, 120))
            data = response.json()
        except Exception as e:
            return {'message': f'上传图片文件失败: {e}'}, False
        if response.status_code != 200 or data.get('code') not in (2000, '2000'):
            return {'message': '上传图片文件失败', 'status_code': response.status_code, 'raw': data}, False
        return data, True

    async def _commit_im_image_upload(self, config: dict, session_key: str) -> tuple[dict, bool]:
        query_params = {
            'Action': 'CommitUploadInner',
            'Version': '2020-11-19',
            'SpaceName': config['space_name'],
        }
        body = json.dumps({
            'SessionKey': session_key,
            'Functions': [{
                'name': 'Encryption',
                'input': {
                    'Config': {'copies': 'cipher_v2'},
                    'PolicyParams': {'policy-set': 'check,thumb,medium,large'},
                },
            }],
        }, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
        body_hash = hashlib.sha256(body).hexdigest()
        query, auth_headers = self._aws_vod_auth_headers(
            'POST',
            query_params,
            config['access_key_id'],
            config['secret_access_key'],
            config['session_token'],
            body_hash,
            {'x-amz-content-sha256': body_hash},
        )
        headers = {
            'accept': '*/*',
            'content-type': 'text/plain;charset=UTF-8',
            'origin': 'https://www.douyin.com',
            'referer': 'https://www.douyin.com/',
            'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
            **auth_headers,
        }
        url = f'https://vod.bytedanceapi.com/?{query}'
        try:
            response = await asyncio.to_thread(_api_post, url, data=body, headers=headers, timeout=(10, 60))
            data = response.json()
        except Exception as e:
            return {'message': f'提交图片上传失败: {e}'}, False
        if response.status_code != 200 or not isinstance(data, dict) or data.get('ResponseMetadata', {}).get('Error'):
            return {'message': '提交图片上传失败', 'status_code': response.status_code, 'raw': data}, False
        results = (data.get('Result') or {}).get('Results') or []
        if not results or not results[0].get('Encryption'):
            return {'message': '提交图片上传成功但未返回加密资源信息', 'raw': data}, False
        return results[0], True

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

    @staticmethod
    def _normalize_im_messages(messages: list[dict]) -> list[dict]:
        normalized = []
        for item in messages or []:
            if not isinstance(item, dict):
                continue
            text = ''
            content = str(item.get('content') or '')
            try:
                parsed_content = json.loads(content)
                if isinstance(parsed_content, dict):
                    text = str(parsed_content.get('text') or parsed_content.get('tips') or parsed_content.get('hint_text') or '')
            except Exception:
                text = content
            ext = item.get('ext') if isinstance(item.get('ext'), dict) else {}
            create_time = item.get('create_time') or 0
            if not create_time and isinstance(ext, dict):
                raw_time = ext.get('s:server_message_create_time') or ext.get('server_message_create_time') or 0
                try:
                    create_time = int(raw_time or 0)
                except Exception:
                    create_time = 0
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

    async def get_recommended_feed(self, count: int = 20, cursor: int = 0) -> tuple[dict, bool]:
        """获取推荐视频流
        
        Args:
            count: 获取数量
            cursor: 分页游标
            
        Returns:
            tuple[dict, bool]: (响应数据, 是否成功)
        """
        if self.debug_mode:
            print(f"\033[94m[API] 获取推荐视频流: count={count}, cursor={cursor}\033[0m")
        
        # 准备请求参数 - 使用真实浏览器捕获的参数
        params = {
            'module_id': '3003101',  # 推荐模块ID
            'count': str(count),
            'pull_type': '0',  # 刷新类型
            'refresh_index': '1',  # 刷新索引
            'refer_type': '10',  # 引用类型
            'filterGids': '',
            'presented_ids': '',
            'refer_id': '',
            'tag_id': '',
            'use_lite_type': '2',
            'Seo-Flag': '0',
            'pre_log_id': '',
            'pre_item_ids': '',
            'pre_room_ids': '',
            'pre_item_from': 'sati',
            'xigua_user': '0',
            'awemePcRecRawData': '{"is_xigua_user":0,"danmaku_switch_status":0,"is_client":false}',
        }
        
        # 自定义请求头
        headers = {
            "Referer": "https://www.douyin.com/?recommend=1"
        }
        
        # 使用 POST 请求 - 重要！
        # 推荐接口需要 POST 请求，不是 GET
        resp = {}
        success = False
        for skip_sign in (False, True):
            try:
                resp, success = await self.common_request(
                    '/aweme/v2/web/module/feed/',
                    dict(params),
                    dict(headers),
                    skip_sign=skip_sign,
                    method='POST'  # 使用 POST 方法
                )
            except Exception as error:
                if self.debug_mode:
                    print(f"\033[91m[API] 推荐接口请求异常(skip_sign={skip_sign}): {error}\033[0m")
                resp, success = {'message': str(error)}, False

            if success or (isinstance(resp, dict) and resp.get('_need_verify')):
                break

        if success and resp.get('aweme_list'):
            aweme_count = len(resp.get('aweme_list', []))
            if self.debug_mode:
                print(f"\033[92m[API] 获取推荐视频成功: {aweme_count} 个\033[0m")

            # 检查是否有视频没有播放地址
            valid_count = 0
            for aweme in resp.get('aweme_list', []):
                video_data = aweme.get('video', {})
                play_addr = video_data.get('play_addr', {})
                if isinstance(play_addr, dict):
                    url_list = play_addr.get('url_list', [])
                    if url_list and url_list[0]:
                        valid_count += 1

            if self.debug_mode and valid_count < aweme_count:
                print(f"\033[93m[API] 有效视频: {valid_count}/{aweme_count}\033[0m")

            return resp, True

        if self.debug_mode:
            print(f"\033[91m[API] 获取推荐视频失败\033[0m")
            if resp:
                print(f"\033[91m[API] 响应: {resp}\033[0m")

        return resp, False

    async def set_comment_liked(self, aweme_id: str, comment_id: str, liked: bool, level: int = 1) -> tuple[dict, bool]:
        """点赞或取消点赞评论。"""
        aweme_id = str(aweme_id or '').strip()
        comment_id = str(comment_id or '').strip()
        if not aweme_id:
            return {'message': '作品ID不能为空'}, False
        if not comment_id:
            return {'message': '评论ID不能为空'}, False

        return await self.signed_form_action_request(
            '/aweme/v1/web/comment/digg',
            {},
            {
                'Referer': 'https://www.douyin.com/',
                'Origin': 'https://www.douyin.com',
                'sec-fetch-mode': 'cors',
                'sec-fetch-dest': 'empty',
                'priority': 'u=1, i',
            },
            host='https://www-hj.douyin.com',
            query_overrides={
                'cid': comment_id,
                'aweme_id': aweme_id,
                'digg_type': '1' if liked else '2',
                'channel_id': '0',
                'app_name': 'aweme',
                'item_type': '0',
                'level': str(max(1, int(level or 1))),
                'enter_from': 'discover',
                'previous_page': 'discover',
            },
        )

    async def publish_comment(
        self,
        aweme_id: str,
        text: str,
        reply_id: str = '',
        reply_to_reply_id: str = '',
    ) -> tuple[dict, bool]:
        """发布一级评论或回复评论，按 Douyin_Spider 的 comment_publish 请求形态构造。"""
        aweme_id = str(aweme_id or '').strip()
        text = str(text or '').strip()
        reply_id = str(reply_id or '').strip()
        reply_to_reply_id = str(reply_to_reply_id or '').strip()
        if not aweme_id:
            return {'message': '作品ID不能为空'}, False
        if not text:
            return {'message': '评论内容不能为空'}, False

        current_user, logged_in = await self.get_current_user(strict_profile=True)
        if not logged_in:
            return self._build_login_required_error(current_user if isinstance(current_user, dict) else None), False

        uri = '/aweme/v1/web/comment/publish'
        url = f'https://www.douyin.com{uri}'
        referer = f'https://www.douyin.com/discover?modal_id={aweme_id}'
        headers = {
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/117.0',
            'cache-control': 'no-cache',
            'pragma': 'no-cache',
            'sec-ch-ua': '"Microsoft Edge";v="125", "Chromium";v="125", "Not.A/Brand";v="24"',
            'sec-ch-ua-mobile': '?0',
            'sec-ch-ua-platform': '"Windows"',
            'sec-fetch-dest': 'empty',
            'sec-fetch-mode': 'cors',
            'sec-fetch-site': 'same-origin',
            'priority': 'u=1, i',
            'accept': 'application/json, text/plain, */*',
            'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6',
            'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'Origin': 'https://www.douyin.com',
            'referer': referer,
        }
        query_params = {
            'app_name': 'aweme',
            'enter_from': 'discover',
            'previous_page': 'discover',
            'device_platform': 'webapp',
            'aid': '6383',
            'channel': 'channel_pc_web',
            'pc_client_type': '1',
            'update_version_code': '170400',
            'version_code': '170400',
            'version_name': '17.4.0',
            'cookie_enabled': 'true',
            'screen_width': '1707',
            'screen_height': '960',
            'browser_language': 'zh-CN',
            'browser_platform': 'Win32',
            'browser_name': 'Edge',
            'browser_version': '125.0.0.0',
            'browser_online': 'true',
            'engine_name': 'Blink',
            'engine_version': '125.0.0.0',
            'os_name': 'Windows',
            'os_version': '10',
            'cpu_core_num': '32',
            'device_memory': '8',
            'platform': 'PC',
            'downlink': '10',
            'effective_type': '4g',
            'round_trip_time': '100',
        }
        cookie_dict = self._cookies_to_dict(self.cookie)
        query_params['webid'] = await self._get_webid(headers, referer) or self._generate_fake_webid()
        query_params['msToken'] = cookie_dict.get('msToken') or self._get_ms_token()
        cookie_dict['msToken'] = query_params['msToken']
        cookie_str_with_ms_token = '; '.join([f'{key}={value}' for key, value in cookie_dict.items()])
        headers.update(self._spider_ticket_guard_headers(uri))
        csrf_headers = dict(headers)
        csrf_headers['cookie'] = cookie_str_with_ms_token
        csrf_token = await self._get_csrf_token(csrf_headers, force_refresh=True)
        if csrf_token:
            headers['x-secsdk-csrf-token'] = csrf_token
        verify_fp = cookie_dict.get('s_v_web_id') or self._generate_s_v_web_id()

        body_params = {
            'aweme_id': aweme_id,
            'comment_send_celltime': random.randint(1000, 20000),
            'comment_video_celltime': random.randint(1000, 20000),
        }
        if reply_id:
            body_params['reply_id'] = reply_id
        body_params['text'] = text
        body_params['text_extra'] = '[]'

        query = _splice_params(query_params)
        body_query = _splice_params(body_params)
        try:
            query_params['a_bogus'] = _sign_spider_a_bogus(query, body_query)
        except Exception as e:
            return {
                'status_code': -1,
                'status_msg': '签名生成失败',
                'message': f'Spider 签名生成失败: {e}',
            }, False
        query_params['verifyFp'] = verify_fp
        query_params['fp'] = verify_fp
        logger.info(
            "comment_publish request shape: query_keys=%s body_keys=%s csrf=%s ticket_guard=%s webid=%s verify_fp=%s",
            list(query_params.keys()),
            list(body_params.keys()),
            bool(headers.get('x-secsdk-csrf-token')),
            bool(headers.get('bd-ticket-guard-client-data')),
            bool(query_params.get('webid')),
            bool(verify_fp),
        )

        try:
            response = await asyncio.to_thread(
                _api_post,
                url,
                params=query_params,
                data=body_params,
                headers=headers,
                cookies=cookie_dict,
                timeout=(10, 30),
            )
        except requests.RequestException as e:
            return {
                'status_code': -1,
                'status_msg': '网络请求失败',
                'message': f'网络请求失败: {e}',
            }, False

        ticket_guard_result = response.headers.get('bd-ticket-guard-result') or response.headers.get('Bd-Ticket-Guard-Result') or ''
        logger.info(
            "comment_publish first response: status=%s len=%s ticket_guard_result=%s logid=%s",
            response.status_code,
            len(response.content or b''),
            ticket_guard_result or '',
            response.headers.get('x-tt-logid') or response.headers.get('X-Tt-Logid') or '',
        )
        if response.status_code == 200 and len(response.content or b'') == 0 and ticket_guard_result == '1002':
            cookie_ticket_headers = self._ticket_guard_headers_from_cookie()
            if cookie_ticket_headers:
                retry_headers = {
                    key: value
                    for key, value in headers.items()
                    if not key.lower().startswith('bd-ticket-guard-')
                }
                retry_headers.update(cookie_ticket_headers)
                retry_csrf_headers = dict(retry_headers)
                retry_csrf_headers['cookie'] = cookie_str_with_ms_token
                retry_csrf_token = await self._get_csrf_token(retry_csrf_headers, force_refresh=True)
                if retry_csrf_token:
                    retry_headers['x-secsdk-csrf-token'] = retry_csrf_token
                logger.info(
                    "comment_publish retry with cookie TicketGuard: query_keys=%s ticket_guard=%s",
                    list(query_params.keys()),
                    bool(retry_headers.get('bd-ticket-guard-client-data')),
                )
                try:
                    response = await asyncio.to_thread(
                        _api_post,
                        url,
                        params=query_params,
                        data=body_params,
                        headers=retry_headers,
                        cookies=cookie_dict,
                        timeout=(10, 30),
                    )
                    retry_ticket_guard_result = response.headers.get('bd-ticket-guard-result') or response.headers.get('Bd-Ticket-Guard-Result') or ''
                    logger.info(
                        "comment_publish retry response: status=%s len=%s ticket_guard_result=%s logid=%s",
                        response.status_code,
                        len(response.content or b''),
                        retry_ticket_guard_result or '',
                        response.headers.get('x-tt-logid') or response.headers.get('X-Tt-Logid') or '',
                    )
                except requests.RequestException as e:
                    return {
                        'status_code': -1,
                        'status_msg': '网络请求失败',
                        'message': f'网络请求失败: {e}',
                    }, False

        if response.status_code == 200 and len(response.content or b'') == 0:
            rust_headers = dict(self.common_headers)
            rust_headers.update(self._relation_ticket_guard_headers(uri))
            rust_headers.update({
                'Referer': f'https://www.douyin.com/video/{aweme_id}',
                'Origin': 'https://www.douyin.com',
                'sec-fetch-site': 'same-origin',
                'sec-fetch-mode': 'cors',
                'sec-fetch-dest': 'empty',
                'priority': 'u=1, i',
                'x-secsdk-csrf-token': 'DOWNGRADE',
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
                'sec-ch-ua': '"Chromium";v="148", "Google Chrome";v="148", "Not/A)Brand";v="99"',
            })
            dtrait = self._relation_dtrait()
            if dtrait:
                rust_headers['x-tt-session-dtrait'] = dtrait

            rust_query_params = dict(self.common_params)
            for key in ('pc_libra_divert', 'support_h265', 'support_dash', 'disable_rs', 'need_filter_settings', 'list_type'):
                rust_query_params.pop(key, None)
            rust_query_params.update({
                'app_name': 'aweme',
                'enter_from': 'discover',
                'previous_page': 'discover',
                'update_version_code': '170400',
                'version_code': '170400',
                'version_name': '17.4.0',
                'browser_name': 'Chrome',
                'browser_version': '148.0.0.0',
                'engine_version': '148.0.0.0',
                'device_memory': '16',
            })
            rust_query_params = await self._deal_params(rust_query_params, rust_headers)
            rust_cookie_dict = dict(cookie_dict)
            rust_cookie_dict['msToken'] = rust_query_params.get('msToken') or rust_cookie_dict.get('msToken') or self._get_ms_token()
            rust_query_params['msToken'] = rust_cookie_dict['msToken']
            rust_headers['Cookie'] = '; '.join([f'{key}={value}' for key, value in rust_cookie_dict.items()])
            rust_params_str = urllib.parse.urlencode(rust_query_params)
            try:
                rust_query_params['a_bogus'] = douyin_sign.sign_detail(
                    rust_params_str,
                    rust_headers.get('User-Agent') or rust_headers.get('user-agent') or '',
                )
            except Exception as e:
                logger.warning("comment_publish relation-v2 fallback sign failed: %s", e)
            else:
                rust_body_params = {
                    'aweme_id': aweme_id,
                    'text': text,
                    'text_extra': '[]',
                    'paste_edit_method': 'non_paste',
                    'comment_send_celltime': '3000',
                    'comment_video_celltime': '2000',
                    'one_level_comment_rank': '1',
                }
                if reply_id:
                    rust_body_params['reply_id'] = reply_id
                    rust_body_params['reply_to_reply_id'] = reply_to_reply_id or '0'

                logger.info(
                    "comment_publish relation-v2 fallback: query_keys=%s body_keys=%s ticket_guard=%s dtrait=%s",
                    list(rust_query_params.keys()),
                    list(rust_body_params.keys()),
                    bool(rust_headers.get('bd-ticket-guard-client-data')),
                    bool(rust_headers.get('x-tt-session-dtrait')),
                )
                try:
                    response = await asyncio.to_thread(
                        _api_post,
                        url,
                        params=rust_query_params,
                        data=rust_body_params,
                        headers=rust_headers,
                        cookies=rust_cookie_dict,
                        timeout=(10, 30),
                    )
                    rust_ticket_guard_result = response.headers.get('bd-ticket-guard-result') or response.headers.get('Bd-Ticket-Guard-Result') or ''
                    logger.info(
                        "comment_publish relation-v2 fallback response: status=%s len=%s ticket_guard_result=%s logid=%s",
                        response.status_code,
                        len(response.content or b''),
                        rust_ticket_guard_result or '',
                        response.headers.get('x-tt-logid') or response.headers.get('X-Tt-Logid') or '',
                    )
                except requests.RequestException as e:
                    return {
                        'status_code': -1,
                        'status_msg': '网络请求失败',
                        'message': f'网络请求失败: {e}',
                    }, False

        if response.status_code != 200 or len(response.content or b'') == 0:
            body_preview = ''
            try:
                body_preview = response.text[:1000]
            except Exception:
                body_preview = '<unreadable>'
            logger.warning(
                "comment_publish empty/error response: status=%s headers=%s",
                response.status_code,
                {
                    key: value
                    for key, value in response.headers.items()
                    if key.lower() in (
                        'content-type',
                        'content-length',
                        'bd-ticket-guard-result',
                        'bd-ticket-guard-server-data',
                        'passport-security-gateway',
                        'x-tt-logid',
                        'x-ms-token',
                        'x-ware-csrf-token',
                    )
                },
            )
            return {
                'status_code': response.status_code,
                'status_msg': '请求失败',
                'message': '发表评论失败，请检查 Cookie 或稍后重试',
                'body': body_preview,
            }, False

        try:
            json_response = response.json()
        except Exception as e:
            return {
                'status_code': -1,
                'status_msg': 'JSON解析失败',
                'message': f'JSON解析失败: {e}',
            }, False

        if json_response.get('status_code', 0) != 0:
            if self._looks_like_logged_out_error(json_response):
                return self._build_login_required_error(json_response), False
            if self._looks_like_login_or_verify_error(uri, json_response):
                verify_hint, _ = self._build_verify_hint(uri, query_params, response)
                api_message = self._extract_api_message(json_response)
                verify_hint.update({
                    'status_code': json_response.get('status_code'),
                    'status_msg': json_response.get('status_msg', ''),
                    'message': f'{api_message}，请完成验证或重新获取 Cookie 后重试',
                })
                return verify_hint, False
            return json_response, False

        return json_response, True

    async def get_comments(self, aweme_id: str, count: int = 20, cursor: int = 0) -> tuple[dict, bool]:
        """获取视频评论列表。"""
        params = {
            'aweme_id': str(aweme_id or ''),
            'cursor': str(cursor or 0),
            'count': str(count or 20),
            'pc_img_format': 'webp',
            'item_type': '0',
            'insert_ids': '',
            'whale_cut_token': '',
            'cut_version': '1',
            'rcFT': '',
        }
        headers = {
            'Origin': 'https://www.douyin.com',
            'Referer': f'https://www.douyin.com/video/{aweme_id}',
            'sec-fetch-site': 'same-site',
        }

        resp = {}
        success = False
        for skip_sign in (False, True):
            try:
                resp, success = await self.common_request(
                    '/aweme/v1/web/comment/list/',
                    dict(params),
                    dict(headers),
                    host='https://www-hj.douyin.com',
                    skip_sign=skip_sign,
                )
            except Exception as error:
                if self.debug_mode:
                    print(f"\033[91m[API] 评论接口请求异常(skip_sign={skip_sign}): {error}\033[0m")
                resp, success = {'message': str(error)}, False

            if success or (isinstance(resp, dict) and resp.get('_need_verify')):
                break

        return resp, success

    async def get_comment_replies(self, aweme_id: str, comment_id: str, count: int = 6, cursor: int = 0) -> tuple[dict, bool]:
        """获取评论的二级回复列表。"""
        params = {
            'item_id': str(aweme_id or ''),
            'aweme_id': str(aweme_id or ''),
            'comment_id': str(comment_id or ''),
            'cursor': str(cursor or 0),
            'count': str(count or 6),
            'pc_img_format': 'webp',
            'item_type': '0',
        }
        headers = {
            'Origin': 'https://www.douyin.com',
            'Referer': f'https://www.douyin.com/video/{aweme_id}',
            'sec-fetch-site': 'same-site',
        }

        resp = {}
        success = False
        for skip_sign in (False, True):
            try:
                resp, success = await self.common_request(
                    '/aweme/v1/web/comment/list/reply/',
                    dict(params),
                    dict(headers),
                    host='https://www-hj.douyin.com',
                    skip_sign=skip_sign,
                )
            except Exception as error:
                if self.debug_mode:
                    print(f"\033[91m[API] 评论回复接口请求异常(skip_sign={skip_sign}): {error}\033[0m")
                resp, success = {'message': str(error)}, False

            if success or (isinstance(resp, dict) and resp.get('_need_verify')):
                break

        return resp, success

    async def get_temp_cookie(self) -> dict:
        """获取临时 Cookie（无需登录）

        Returns:
            dict: {
                'success': bool,
                'cookie': str (如果成功),
                'message': str
            }
        """
        try:
            if self.debug_mode:
                print(f"\033[94m[API] 获取临时 Cookie...\033[0m")

            # 仅使用纯 HTTP 请求获取临时 Cookie
            cookie_str = await self._get_temp_cookie_http()

            if cookie_str:
                return {
                    'success': True,
                    'cookie': cookie_str,
                    'message': '成功获取临时 Cookie（HTTP方式）'
                }

            return {
                'success': False,
                'message': '获取临时 Cookie 失败，请稍后重试或改用登录账号 / 浏览器读取 Cookie'
            }

        except Exception as e:
            if self.debug_mode:
                print(f"\033[91m[API] 获取临时 Cookie 异常: {e}\033[0m")
            return {
                'success': False,
                'message': str(e)
            }

    async def _get_temp_cookie_http(self) -> str:
        """使用纯 HTTP 请求获取临时 Cookie

        Returns:
            str: Cookie 字符串，失败返回空字符串
        """
        try:
            if self.debug_mode:
                print(f"\033[94m[API] 使用 HTTP 方式获取临时 Cookie\033[0m")

            # 准备请求头
            headers = {
                'User-Agent': self.common_headers['User-Agent'],
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
                'Accept-Encoding': 'gzip, deflate, br',
                'Connection': 'keep-alive',
                'Upgrade-Insecure-Requests': '1',
            }

            # 创建一个 session 来自动处理 Cookie
            session = requests.Session()

            # 发送请求
            response = await asyncio.to_thread(
                session.get,
                'https://www.douyin.com/',
                headers=headers,
                timeout=10
            )

            # 从 session.cookies 中提取 Cookie
            cookies = []
            for cookie in session.cookies:
                cookies.append(f"{cookie.name}={cookie.value}")

            if cookies:
                cookie_str = '; '.join(cookies)
                if self.debug_mode:
                    print(f"\033[92m[API] HTTP 方式获取到 {len(cookies)} 个 Cookie\033[0m")
                return cookie_str

            if self.debug_mode:
                print(f"\033[93m[API] HTTP 方式未获取到 Cookie\033[0m")
            return ''

        except Exception as e:
            if self.debug_mode:
                print(f"\033[91m[API] HTTP 获取 Cookie 失败: {e}\033[0m")
            return ''

    @staticmethod
    def get_browser_cookies() -> dict:
        """从浏览器中读取抖音 Cookie（支持 Chrome, Edge, Firefox）

        Returns:
            dict: {
                'success': bool,
                'cookie': str (如果成功),
                'message': str,
                'browser': str (浏览器名称)
            }
        """
        try:
            import browser_cookie3
            import platform

            browsers = []

            # 根据平台选择浏览器
            system = platform.system()
            if system == 'Darwin':  # macOS
                browsers = [
                    ('Chrome', browser_cookie3.chrome),
                    ('Edge', browser_cookie3.edge),
                    ('Firefox', browser_cookie3.firefox),
                    ('Safari', browser_cookie3.safari),
                ]
            elif system == 'Windows':
                browsers = [
                    ('Chrome', browser_cookie3.chrome),
                    ('Edge', browser_cookie3.edge),
                    ('Firefox', browser_cookie3.firefox),
                ]
            elif system == 'Linux':
                browsers = [
                    ('Chrome', browser_cookie3.chrome),
                    ('Firefox', browser_cookie3.firefox),
                ]

            for browser_name, browser_func in browsers:
                try:
                    cookies = browser_func(domain_name='douyin.com')

                    if cookies:
                        cookie_str = '; '.join([f"{c.name}={c.value}" for c in cookies])
                        return {
                            'success': True,
                            'cookie': cookie_str,
                            'message': f'成功从 {browser_name} 浏览器读取到 {len(cookies)} 个 Cookie',
                            'browser': browser_name,
                            'count': len(cookies)
                        }
                except Exception as e:
                    # 该浏览器未安装或无法访问，继续尝试下一个
                    continue

            return {
                'success': False,
                'message': '未能从任何浏览器读取到抖音 Cookie，请确保已在浏览器中登录抖音'
            }

        except ImportError:
            return {
                'success': False,
                'message': '缺少 browser-cookie3 模块，请运行: pip install browser-cookie3'
            }
        except Exception as e:
            return {
                'success': False,
                'message': f'读取浏览器 Cookie 失败: {str(e)}'
            }
