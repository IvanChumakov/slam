from collections.abc import AsyncIterator

import pytest
from httpx import ASGITransport, AsyncClient
from pydantic import SecretStr
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.bot.notifier import NullRoomNotifier
from app.config import Settings
from app.db.base import Base
from app.main import create_app
from app.services.livekit import LiveKitPresenceEvent


class FakeLiveKitTokens:
    def generate_livekit_token(self, *, room_name: str, identity: str, display_name: str) -> str:
        assert room_name
        assert identity.startswith("guest_")
        assert display_name
        return "test-token"


class FakeWebhookParser:
    event: LiveKitPresenceEvent | None = None

    def parse(self, raw_body: str, authorization: str) -> LiveKitPresenceEvent | None:
        assert raw_body
        if authorization != "Bearer valid":
            raise ValueError("invalid signature")
        return self.event


@pytest.fixture
def settings() -> Settings:
    return Settings(
        environment="test",
        bot_token=SecretStr("123456:TEST_TOKEN"),
        database_url="sqlite+aiosqlite://",
        frontend_public_url="http://frontend.test",
        backend_public_url="http://testserver",
        allowed_origins=["http://frontend.test"],
        allowed_hosts=["testserver"],
        join_token_secret=SecretStr("j" * 64),
        join_token_ttl_seconds=900,
        livekit_url="ws://livekit.test",
        livekit_api_key=SecretStr("test-key"),
        livekit_api_secret=SecretStr("test-secret"),
    )


@pytest.fixture
async def app_context(settings: Settings) -> AsyncIterator[tuple]:
    engine = create_async_engine("sqlite+aiosqlite://")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    webhook_parser = FakeWebhookParser()
    app = create_app(
        settings,
        engine=engine,
        session_factory=factory,
        livekit_tokens=FakeLiveKitTokens(),
        livekit_webhooks=webhook_parser,
        room_notifier=NullRoomNotifier(),
    )
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as client:
        yield app, client, factory, webhook_parser
    await engine.dispose()


@pytest.fixture
async def session(app_context: tuple) -> AsyncIterator[AsyncSession]:
    factory = app_context[2]
    async with factory() as db_session:
        yield db_session
