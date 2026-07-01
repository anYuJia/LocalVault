"""Temporary and browser cookie helpers."""
from __future__ import annotations

import asyncio
import platform

import requests
from src.utils.ssl_utils import requests_verify_value


async def get_temp_cookie(common_headers: dict, debug_mode: bool = False) -> dict:
    """获取临时 Cookie（无需登录）。"""
    try:
        if debug_mode:
            print(f"\033[94m[API] 获取临时 Cookie...\033[0m")

        cookie_str = await get_temp_cookie_http(common_headers, debug_mode)
        if cookie_str:
            return {
                'success': True,
                'cookie': cookie_str,
                'message': '成功获取临时 Cookie（HTTP方式）',
            }

        return {
            'success': False,
            'message': '获取临时 Cookie 失败，请稍后重试或改用登录账号 / 浏览器读取 Cookie',
        }

    except Exception as e:
        if debug_mode:
            print(f"\033[91m[API] 获取临时 Cookie 异常: {e}\033[0m")
        return {
            'success': False,
            'message': str(e),
        }


async def get_temp_cookie_http(common_headers: dict, debug_mode: bool = False) -> str:
    """使用纯 HTTP 请求获取临时 Cookie。"""
    try:
        if debug_mode:
            print(f"\033[94m[API] 使用 HTTP 方式获取临时 Cookie\033[0m")

        headers = {
            'User-Agent': common_headers['User-Agent'],
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
            'Accept-Encoding': 'gzip, deflate, br',
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1',
        }

        session = requests.Session()
        session.verify = requests_verify_value()
        response = await asyncio.to_thread(
            session.get,
            'https://www.douyin.com/',
            headers=headers,
            timeout=10,
        )
        response.close()

        cookies = [f"{cookie.name}={cookie.value}" for cookie in session.cookies]
        session.close()
        if cookies:
            cookie_str = '; '.join(cookies)
            if debug_mode:
                print(f"\033[92m[API] HTTP 方式获取到 {len(cookies)} 个 Cookie\033[0m")
            return cookie_str

        if debug_mode:
            print(f"\033[93m[API] HTTP 方式未获取到 Cookie\033[0m")
        return ''

    except Exception as e:
        if debug_mode:
            print(f"\033[91m[API] HTTP 获取 Cookie 失败: {e}\033[0m")
        return ''


def get_browser_cookies() -> dict:
    """从浏览器中读取抖音 Cookie（支持 Chrome, Edge, Firefox）。"""
    try:
        import browser_cookie3

        browsers = []
        system = platform.system()
        if system == 'Darwin':
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
                        'count': len(cookies),
                    }
            except Exception:
                continue

        return {
            'success': False,
            'message': '未能从任何浏览器读取到抖音 Cookie，请确保已在浏览器中登录抖音',
        }

    except ImportError:
        return {
            'success': False,
            'message': '缺少 browser-cookie3 模块，请运行: pip install browser-cookie3',
        }
    except Exception as e:
        return {
            'success': False,
            'message': f'读取浏览器 Cookie 失败: {str(e)}',
        }
