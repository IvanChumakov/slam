import asyncio
import logging

from aiogram.exceptions import TelegramAPIError

from app.bot.commands import register_commands
from app.bot.runtime import create_dispatcher
from app.config import get_settings
from app.db.repositories import RoomRepository
from app.db.session import create_db_engine, create_session_factory
from app.services.livekit import LiveKitTokenService
from app.services.tokens import JoinTokenService
from app.services.voice import VoiceService


async def run() -> None:
    settings = get_settings()
    engine = create_db_engine(settings.database_url)
    factory = create_session_factory(engine)
    repository = RoomRepository()
    join_tokens = JoinTokenService(
        settings.join_token_secret.get_secret_value(), settings.join_token_ttl_seconds
    )
    livekit_tokens = LiveKitTokenService(
        settings.livekit_api_key.get_secret_value(),
        settings.livekit_api_secret.get_secret_value(),
    )
    voice_service = VoiceService(repository, join_tokens, livekit_tokens, settings.livekit_url)
    bot, dispatcher = create_dispatcher(
        settings=settings,
        session_factory=factory,
        room_repository=repository,
        join_tokens=join_tokens,
        voice_service=voice_service,
    )
    try:
        try:
            await register_commands(bot)
        except TelegramAPIError:
            logging.getLogger(__name__).warning(
                "Could not register command menu; continuing polling", exc_info=True
            )
        await dispatcher.start_polling(bot)
    finally:
        await bot.session.close()
        await engine.dispose()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    asyncio.run(run())
