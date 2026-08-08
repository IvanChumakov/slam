from aiogram import Bot, Dispatcher
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.bot.handlers import create_router
from app.config import Settings
from app.db.repositories import RoomRepository
from app.services.tokens import JoinTokenService
from app.services.voice import VoiceService


def create_dispatcher(
    *,
    settings: Settings,
    session_factory: async_sessionmaker[AsyncSession],
    room_repository: RoomRepository,
    join_tokens: JoinTokenService,
    voice_service: VoiceService,
) -> tuple[Bot, Dispatcher]:
    bot = Bot(token=settings.bot_token.get_secret_value())
    dispatcher = Dispatcher(
        session_factory=session_factory,
        room_repository=room_repository,
        join_tokens=join_tokens,
        voice_service=voice_service,
        frontend_public_url=str(settings.frontend_public_url),
    )
    dispatcher.include_router(create_router())
    return bot, dispatcher
