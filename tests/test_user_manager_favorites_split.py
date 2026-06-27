"""回归测试：UserManager 点赞收藏拆分后的公开入口委托。"""
import asyncio

from src.api.api import DouyinAPI
from src.downloader.downloader import DouyinDownloader
from src.user.favorites import FavoritesService
from src.user.user_manager import DouyinUserManager


def _manager():
    api = DouyinAPI("")
    return DouyinUserManager(api, DouyinDownloader(api))


def test_user_manager_favorites_property_returns_bound_service():
    manager = _manager()

    favorites = manager.favorites

    assert isinstance(favorites, FavoritesService)
    assert favorites._mgr is manager
    assert manager.favorites is favorites


def test_user_manager_get_liked_videos_delegates_to_favorites(monkeypatch):
    captured = {}

    async def fake_get_liked_videos(self, count=20, cursor=0, include_pagination=False):
        captured["self"] = self
        captured["args"] = (count, cursor, include_pagination)
        return {"data": ["ok"], "cursor": cursor, "has_more": False}

    monkeypatch.setattr(FavoritesService, "get_liked_videos", fake_get_liked_videos)

    manager = _manager()
    result = asyncio.run(
        manager.get_liked_videos(count=7, cursor=123, include_pagination=True)
    )

    assert captured["self"] is manager.favorites
    assert captured["args"] == (7, 123, True)
    assert result == {"data": ["ok"], "cursor": 123, "has_more": False}
