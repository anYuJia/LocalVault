from src.config.config import Config
from src.web.web_app import app


def test_liked_authors_without_cookie_returns_login_error(monkeypatch):
    monkeypatch.setattr(Config, "COOKIE", "")

    client = app.test_client()
    response = client.post("/api/get_liked_authors", json={"count": 20})

    assert response.status_code == 200
    payload = response.get_json()
    assert payload["success"] is False
    assert payload["need_login"] is True
    assert not payload.get("need_verify")
