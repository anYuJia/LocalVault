import pytest

from src.user.user_manager import DouyinUserManager


class FakePostApi:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    async def common_request(self, uri, params, headers, skip_sign=False):
        self.calls.append((uri, dict(params), dict(headers), skip_sign))
        if not self.responses:
            raise AssertionError("get_user_videos did not stop after an empty/stalled page")
        return self.responses.pop(0)


@pytest.mark.asyncio
async def test_get_user_videos_stops_on_empty_has_more_page():
    api = FakePostApi(
        [
            (
                {
                    "aweme_list": [{"aweme_id": "1", "desc": "first"}],
                    "max_cursor": 10,
                    "has_more": 1,
                },
                True,
            ),
            (
                {
                    "aweme_list": [],
                    "max_cursor": 10,
                    "has_more": 1,
                },
                True,
            ),
        ]
    )
    manager = object.__new__(DouyinUserManager)
    manager.api = api
    manager.debug_mode = False

    videos = await manager.get_user_videos("sec-user", limit=10000)

    assert [video["aweme_id"] for video in videos] == ["1"]
    assert len(api.calls) == 2


@pytest.mark.asyncio
async def test_get_user_videos_stops_when_cursor_does_not_advance():
    api = FakePostApi(
        [
            (
                {
                    "aweme_list": [{"aweme_id": "1", "desc": "first"}],
                    "max_cursor": 0,
                    "has_more": 1,
                },
                True,
            ),
        ]
    )
    manager = object.__new__(DouyinUserManager)
    manager.api = api
    manager.debug_mode = False

    videos = await manager.get_user_videos("sec-user", limit=10000)

    assert [video["aweme_id"] for video in videos] == ["1"]
    assert len(api.calls) == 1
