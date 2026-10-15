import hashlib
import hmac
import json
import time
from collections.abc import AsyncIterator
from urllib.parse import urlencode

import pytest
from httpx import ASGITransport, AsyncClient
from pydantic import SecretStr
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.bot.notifier import NullRoomNotifier
from app.config import Settings
from app.db.base import Base
from app.main import create_app
from app.models import RoomParticipant, VoiceRoom
from app.services.livekit import LiveKitPresenceEvent
from app.services.presence import ConnectedParticipant


class FakeLiveKitTokens:
    def generate_livekit_token(
        self, *, room_name: str, identity: str, display_name: str, avatar_url: str | None = None
    ) -> str:
        assert room_name
        assert identity.startswith("guest_")
        assert display_name
        return "test-token"


@pytest.fixture
def telegram_init_data(settings):
    def sign(*, user=None, auth_date=None, fields=None, bot_token=None):
        values = {
            "auth_date": str(int(time.time()) if auth_date is None else auth_date),
            "user": json.dumps({"id": 123456789, "username": "@alice"} if user is None else user),
            **(fields or {}),
        }
        values = {key: value for key, value in values.items() if value is not None}
        secret = hmac.digest(
            b"WebAppData", (bot_token or settings.bot_token.get_secret_value()).encode(), "sha256"
        )
        check = "\n".join(f"{key}={value}" for key, value in sorted(values.items()))
        values["hash"] = hmac.new(secret, check.encode(), hashlib.sha256).hexdigest()
        return urlencode(values)

    return sign


class FakeWebhookParser:
    event: LiveKitPresenceEvent | None = None

    def parse(self, raw_body: str, authorization: str) -> LiveKitPresenceEvent | None:
        assert raw_body
        if authorization != "Bearer valid":
            raise ValueError("invalid signature")
        return self.event


class FakeLiveKitPresence:
    def __init__(self, factory, parser):
        self.factory = factory
        self.parser = parser

    async def snapshot(self, room_name):
        event = self.parser.event
        if event is not None and event.room_name == room_name:
            if event.event == "participant_joined":
                return (ConnectedParticipant(event.identity, event.display_name),)
            if event.event == "participant_left":
                return ()
        # Existing repository fixtures also stand in for the fake LiveKit server's roster.
        async with self.factory() as session:
            rows = await session.execute(
                select(RoomParticipant.identity, RoomParticipant.display_name)
                .join(VoiceRoom)
                .where(VoiceRoom.livekit_room_name == room_name)
                .order_by(RoomParticipant.id)
            )
            return tuple(ConnectedParticipant(identity, name) for identity, name in rows)

    async def aclose(self):
        pass


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
        livekit_presence=FakeLiveKitPresence(factory, webhook_parser),
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
