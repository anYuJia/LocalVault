"""评论读取逻辑拆分模块。

将 CommentClient 中评论列表、评论回复读取相关方法抽取到独立模块。
通过 CommentReaders 类持有 CommentClient 实例引用，共享 cookie、
headers、公共请求方法等状态。CommentClient 保留原方法签名作为薄代理，
保持对外接口不变。
"""


class CommentReaders:
    """评论读取服务，封装评论列表与二级回复读取。"""

    def __init__(self, client):
        """
        Args:
            client: CommentClient 实例，用于共享 cookie、headers、公共请求方法等。
        """
        self._client = client

    async def get_comments(self, aweme_id: str, count: int = 20, cursor: int = 0, insert_ids: str = '') -> tuple[dict, bool]:
        """获取视频评论列表。

        insert_ids 非空时，抖音会把指定 cid 的评论插入返回列表（用于定位特定评论）。
        """
        params = {
            'aweme_id': str(aweme_id or ''),
            'cursor': str(cursor or 0),
            'count': str(count or 20),
            'pc_img_format': 'webp',
            'item_type': '0',
            'insert_ids': str(insert_ids or ''),
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
                resp, success = await self._client.common_request(
                    '/aweme/v1/web/comment/list/',
                    dict(params),
                    dict(headers),
                    host='https://www-hj.douyin.com',
                    skip_sign=skip_sign,
                )
            except Exception as error:
                if self._client.debug_mode:
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
                resp, success = await self._client.common_request(
                    '/aweme/v1/web/comment/list/reply/',
                    dict(params),
                    dict(headers),
                    host='https://www-hj.douyin.com',
                    skip_sign=skip_sign,
                )
            except Exception as error:
                if self._client.debug_mode:
                    print(f"\033[91m[API] 评论回复接口请求异常(skip_sign={skip_sign}): {error}\033[0m")
                resp, success = {'message': str(error)}, False

            if success or (isinstance(resp, dict) and resp.get('_need_verify')):
                break

        return resp, success
