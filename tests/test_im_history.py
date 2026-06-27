import asyncio

from src.api.api import DouyinAPI
from src.api.im_history import IMHistory


def test_im_history_normalize_messages_service():
    messages = [{
        "conversation_id": "conv",
        "conversation_short_id": 123,
        "conversation_type": 1,
        "server_message_id": 456,
        "sender": 789,
        "content": '{"text":"你好"}',
        "version": 1700000000000,
    }]

    normalized = IMHistory.normalize_messages(messages)
    assert normalized[0]["content"] == "你好"
    assert normalized[0]["sender_uid"] == "789"


def test_im_history_recent_messages_delegates_to_history_service(monkeypatch):
    api = DouyinAPI("")
    called = {}

    async def fake_recent(cursor):
        called["cursor"] = cursor
        return {"messages": [], "next_cursor": 0, "has_more": False}, True

    monkeypatch.setattr(api.im.history, "get_recent_user_messages", fake_recent)

    result, success = asyncio.run(api.im._get_im_recent_user_messages(cursor=42))

    assert success is True
    assert result["messages"] == []
    assert called["cursor"] == 42
