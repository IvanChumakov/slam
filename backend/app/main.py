from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from aiogram import Bot
from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker
from starlette.middleware.trustedhost import TrustedHostMiddleware

from app.api.routes import RoomNotifier, router
from app.bot.notifier import NullRoomNotifier, TelegramRoomNotifier
from app.config import Settings, get_settings
from app.db.repositories import RoomRepository
from app.db.session import create_db_engine, create_session_factory
from app.services.livekit import (
    LiveKitTokenIssuer,
    LiveKitTokenService,
    LiveKitWebhookParser,
    LiveKitWebhookService,
)
from app.services.tokens import JoinTokenService
from app.services.voice import VoiceService


def create_app(
    settings: Settings | None = None,
    *,
    engine: AsyncEngine | None = None,
    session_factory: async_sessionmaker[AsyncSession] | None = None,
    livekit_tokens: LiveKitTokenIssuer | None = None,
    livekit_webhooks: LiveKitWebhookParser | None = None,
    room_notifier: RoomNotifier | None = None,
) -> FastAPI:
    settings = settings or get_settings()
    owns_engine = engine is None
    engine = engine or create_db_engine(settings.database_url)
    session_factory = session_factory or create_session_factory(engine)
    repository = RoomRepository()
    join_tokens = JoinTokenService(
        settings.join_token_secret.get_secret_value(), settings.join_token_ttl_seconds
    )
    livekit_tokens = livekit_tokens or LiveKitTokenService(
        settings.livekit_api_key.get_secret_value(),
        settings.livekit_api_secret.get_secret_value(),
    )
    livekit_webhooks = livekit_webhooks or LiveKitWebhookService(
        settings.livekit_api_key.get_secret_value(),
        settings.livekit_api_secret.get_secret_value(),
    )
    voice_service = VoiceService(repository, join_tokens, livekit_tokens, settings.livekit_url)
    bot: Bot | None = None
    if room_notifier is None and settings.environment != "test":
        bot = Bot(settings.bot_token.get_secret_value())
        room_notifier = TelegramRoomNotifier(
            bot,
            session_factory,
            repository,
            join_tokens,
            str(settings.frontend_public_url),
        )
    room_notifier = room_notifier or NullRoomNotifier()

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        yield
        if bot is not None:
            await bot.session.close()
        if owns_engine:
            await engine.dispose()

    docs_enabled = settings.environment != "production"
    app = FastAPI(
        title="Telegram Voice Backend",
        version="0.1.0",
        docs_url="/docs" if docs_enabled else None,
        redoc_url=None,
        openapi_url="/openapi.json" if docs_enabled else None,
        lifespan=lifespan,
    )
    app.state.settings = settings
    app.state.engine = engine
    app.state.session_factory = session_factory
    app.state.room_repository = repository
    app.state.join_tokens = join_tokens
    app.state.voice_service = voice_service
    app.state.livekit_webhooks = livekit_webhooks
    app.state.room_notifier = room_notifier

    app.add_middleware(TrustedHostMiddleware, allowed_hosts=settings.allowed_hosts)
    if settings.allowed_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=settings.allowed_origins,
            allow_credentials=False,
            allow_methods=["GET", "POST"],
            allow_headers=["Content-Type", "Authorization"],
        )

    @app.middleware("http")
    async def security_headers(request: Request, call_next) -> Response:
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["Permissions-Policy"] = "camera=(), geolocation=()"
        return response

    app.include_router(router)
    return app
