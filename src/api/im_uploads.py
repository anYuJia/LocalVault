"""IM 图片上传逻辑。

负责 AWS VOD 签名、图片上传配置获取、申请上传、上传字节、提交上传等流程。
IMClient 通过组合方式使用此模块，保持对外方法不变。
"""
import asyncio
import hashlib
import hmac
import json
import random
import string
import time
import urllib.parse

from src.api.http_client import (
    api_get as _api_get,
    api_post as _api_post,
)


def _aws_quote(value) -> str:
    return urllib.parse.quote(str(value), safe='-_.~')


def _aws_canonical_query(params: dict) -> str:
    pairs = []
    for key, value in sorted((str(k), str(v)) for k, v in (params or {}).items()):
        pairs.append(f'{_aws_quote(key)}={_aws_quote(value)}')
    return '&'.join(pairs)


def _aws_signing_key(secret_access_key: str, date_stamp: str, region: str = 'cn-north-1', service: str = 'vod') -> bytes:
    k_date = hmac.new(('AWS4' + secret_access_key).encode('utf-8'), date_stamp.encode('utf-8'), hashlib.sha256).digest()
    k_region = hmac.new(k_date, region.encode('utf-8'), hashlib.sha256).digest()
    k_service = hmac.new(k_region, service.encode('utf-8'), hashlib.sha256).digest()
    return hmac.new(k_service, b'aws4_request', hashlib.sha256).digest()


def _aws_vod_auth_headers(
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
        _aws_canonical_query(query_params),
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
        _aws_signing_key(secret_access_key, date_stamp),
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
    return _aws_canonical_query(query_params), headers


async def get_im_image_upload_config(common_request_fn) -> tuple[dict, bool]:
    """获取 IM 图片上传配置。"""
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
    response, success = await common_request_fn('/aweme/v1/web/im/upload/config/v2', params, headers)
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


async def apply_im_image_upload(config: dict, file_size: int) -> tuple[dict, bool]:
    """申请图片上传。"""
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
    query, auth_headers = _aws_vod_auth_headers(
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


async def upload_im_image_bytes(
    upload_address: dict,
    image_bytes: bytes,
    crc32_hex: str,
) -> tuple[dict, bool]:
    """上传图片字节。"""
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


async def commit_im_image_upload(config: dict, session_key: str) -> tuple[dict, bool]:
    """提交图片上传。"""
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
    query, auth_headers = _aws_vod_auth_headers(
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
