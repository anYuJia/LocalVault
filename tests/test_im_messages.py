import asyncio

from src.api.api import DouyinAPI
from src.api.im_messages import IMMessages


def test_im_media_uri_client_entrypoint_matches_messages_service():
    api = DouyinAPI("")
    url = "https://example.com/aweme/img/example/path.webp~tplv-dy"

    assert api.im._media_uri_from_url(url) == IMMessages.media_uri_from_url(url)
    assert api.im._media_uri_from_url(url) == "example/path"


def test_im_text_message_delegates_to_messages_service(monkeypatch):
    api = DouyinAPI("")
    called = {}

    async def fake_send_text(to_user_id, content):
        called["to_user_id"] = to_user_id
        called["content"] = content
        return {"message": "sent"}, True

    monkeypatch.setattr(api.im.messages, "send_text_message", fake_send_text)

    result, success = asyncio.run(api.send_im_text_message(123, "你好"))

    assert success is True
    assert result == {"message": "sent"}
    assert called == {"to_user_id": 123, "content": "你好"}


def test_im_content_message_delegates_to_messages_service(monkeypatch):
    api = DouyinAPI("")
    called = {}

    async def fake_send_content(to_user_id, msg_content, message_type=7, extra_headers=None):
        called["to_user_id"] = to_user_id
        called["msg_content"] = msg_content
        called["message_type"] = message_type
        called["extra_headers"] = extra_headers
        return {"message": "sent"}, True

    monkeypatch.setattr(api.im.messages, "send_content_message", fake_send_content)

    result, success = asyncio.run(
        api.im._send_im_content_message(
            123,
            '{"text":"你好"}',
            message_type=8,
            extra_headers={"x": "y"},
        )
    )

    assert success is True
    assert result == {"message": "sent"}
    assert called == {
        "to_user_id": 123,
        "msg_content": '{"text":"你好"}',
        "message_type": 8,
        "extra_headers": {"x": "y"},
    }
