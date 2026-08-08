from app.config import Settings


def test_settings_parse_allowed_origins_and_hosts_from_csv(monkeypatch) -> None:
    monkeypatch.setenv("ALLOWED_ORIGINS", "https://one.example, https://two.example")
    monkeypatch.setenv("ALLOWED_HOSTS", "api.example,localhost")

    settings = Settings(
        bot_token="test-token",
        database_url="postgresql+asyncpg://user:password@db:5432/app",
        frontend_public_url="https://frontend.example",
        backend_public_url="https://api.example",
        join_token_secret="a" * 32,
        livekit_url="wss://rtc.example",
        livekit_api_key="test-key",
        livekit_api_secret="test-secret",
    )

    assert settings.allowed_origins == [
        "https://one.example",
        "https://two.example",
    ]
    assert settings.allowed_hosts == ["api.example", "localhost"]
