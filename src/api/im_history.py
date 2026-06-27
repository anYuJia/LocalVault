"""IM 历史消息逻辑。

封装最近消息、指定会话历史消息，以及消息结构归一化。IMClient 保留旧
入口并委托到这里，避免改变外部调用方式。
"""
import json
import time

from src.api import douyin_im_proto


class IMHistory:
    """IM 历史消息服务。"""

    def __init__(self, client):
        self._client = client

    @staticmethod
    def normalize_messages(messages: list[dict]) -> list[dict]:
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
                create_time = int(time.time() * 1000)
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

    async def get_recent_user_messages(self, cursor: int = 0) -> tuple[dict, bool]:
        signer = self._client._im_proto_signer()
        if not signer:
            return {'message': '私信安全参数未采集完整，请在设置中重新登录 Cookie 后重试'}, False
        payload = self._client._build_im_pc_proto_request(
            cmd=128,
            body=douyin_im_proto.build_get_user_message_body(max(0, int(cursor or 0))),
            signer=signer,
        )
        response, success = await self._client._post_im_proto(
            'https://imapi.douyin.com/v1/message/get_user_message',
            payload,
        )
        if not success:
            return response, False
        body = response.get('body', {}).get('get_user_message_body', {})
        messages = body.get('messages') if isinstance(body, dict) else []
        return {
            'message': '获取历史消息成功',
            'messages': self.normalize_messages(messages),
            'next_cursor': body.get('next_cursor') if isinstance(body, dict) else 0,
            'has_more': bool(body.get('has_more')) if isinstance(body, dict) else False,
        }, True

    async def get_history_messages(
        self,
        cursor: int = 0,
        to_user_id: str | int | None = None,
        conversation_id: str | None = None,
        conversation_short_id: int | None = None,
        conversation_type: int = 1,
    ) -> tuple[dict, bool]:
        signer = self._client._im_proto_signer()
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
            conversation, created = await self._client.create_im_conversation(to_user_id)
            if not created:
                return conversation, False

        if not conversation:
            return await self.get_recent_user_messages(cursor)

        payload = self._client._build_im_pc_proto_request(
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
        response, success = await self._client._post_im_proto(
            'https://imapi.douyin.com/v1/message/get_by_conversation',
            payload,
        )
        if not success:
            return response, False
        body = response.get('body', {}).get('get_by_conversation_body', {})
        messages = body.get('messages') if isinstance(body, dict) else []
        return {
            'message': '获取历史消息成功',
            'messages': self.normalize_messages(messages),
            'next_cursor': body.get('next_cursor') if isinstance(body, dict) else 0,
            'has_more': bool(body.get('has_more')) if isinstance(body, dict) else False,
            'conversation': {
                'conversation_id': conversation.get('conversation_id') or '',
                'conversation_short_id': conversation.get('conversation_short_id') or 0,
                'conversation_type': conversation.get('conversation_type') or 0,
            },
        }, True
