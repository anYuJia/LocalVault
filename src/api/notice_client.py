"""通知消息接口逻辑。

从 DouyinAPI 中拆出的通知（点赞/关注/评论等）列表接口。NoticeClient 持有
DouyinAPI 实例引用，共享 cookie、headers、common_request 等状态。请求签名
（a_bogus）与 msToken/verifyFp/webid 等参数由 common_request/_deal_params 统一
注入，调用方只需提供通知特有的业务参数。
"""

# notice_group 是通知分组的位掩码，960 对应「全部互动」分组（与网页端捕获一致）。
DEFAULT_NOTICE_GROUP = 960


class NoticeClient:
    """通知消息接口服务。"""

    def __init__(self, api):
        self._api = api

    @property
    def debug_mode(self) -> bool:
        return self._api.debug_mode

    async def get_notices(
        self,
        count: int = 10,
        min_time: int = 0,
        max_time: int = 0,
        notice_group: int = DEFAULT_NOTICE_GROUP,
    ) -> tuple[dict, bool]:
        """获取通知消息列表。

        Args:
            count: 拉取条数
            min_time: 起始时间（0 表示最新）
            max_time: 截止时间（0 表示不限制；翻历史时传上一批返回的 min_time）
            notice_group: 通知分组位掩码，默认 960（全部互动）

        Returns:
            tuple[dict, bool]: (响应数据, 是否成功)
        """
        count = max(1, min(int(count or 10), 50))
        min_time = int(min_time or 0)
        max_time = int(max_time or 0)
        notice_group = int(notice_group or DEFAULT_NOTICE_GROUP) or DEFAULT_NOTICE_GROUP

        if self.debug_mode:
            print(f"\033[94m[API] 获取通知: count={count}, min_time={min_time}, max_time={max_time}, group={notice_group}\033[0m")

        # is_new_notice=1 返回新版结构 notice_list_v2；is_mark_read=1 让接口带上已读状态。
        params = {
            'is_new_notice': '1',
            'is_mark_read': '1',
            'notice_group': str(notice_group),
            'count': str(count),
            'min_time': str(min_time),
            'max_time': str(max_time),
        }
        headers = {
            'Referer': 'https://www.douyin.com/',
        }

        resp = {}
        success = False
        # 先走签名请求；若遇到验证/限流再尝试 skip_sign 兜底，与其它接口保持一致。
        for skip_sign in (False, True):
            try:
                resp, success = await self._api.common_request(
                    '/aweme/v1/web/notice/',
                    dict(params),
                    dict(headers),
                    skip_sign=skip_sign,
                    method='GET',
                )
            except Exception as error:
                if self.debug_mode:
                    print(f"\033[91m[API] 通知接口请求异常(skip_sign={skip_sign}): {error}\033[0m")
                resp, success = {'message': str(error)}, False

            if success or (isinstance(resp, dict) and (resp.get('_need_verify') or resp.get('_need_login'))):
                break

        if success and self.debug_mode:
            notice_count = len(resp.get('notice_list_v2') or resp.get('notice_list') or [])
            print(f"\033[92m[API] 获取通知成功: {notice_count} 条\033[0m")

        if not success and self.debug_mode:
            print(f"\033[91m[API] 获取通知失败\033[0m")
            if resp:
                print(f"\033[91m[API] 响应: {resp}\033[0m")

        return resp, success
