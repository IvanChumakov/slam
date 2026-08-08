from types import SimpleNamespace
from unittest.mock import AsyncMock

from sqlalchemy import func, select

from app.bot.handlers import voice_handler
from app.models import TelegramGroup, VoiceRoom


async def test_repeated_voice_reuses_room_and_message(app_context: tuple) -> None:
    app, _, factory, _ = app_context
    sent = SimpleNamespace(message_id=777)
    message = SimpleNamespace(
        chat=SimpleNamespace(id=-100123456, title="Gaming Test"),
        answer=AsyncMock(return_value=sent),
    )
    bot = SimpleNamespace(edit_message_text=AsyncMock())
    arguments = {
        "message": message,
        "bot": bot,
        "session_factory": factory,
        "voice_service": app.state.voice_service,
        "room_repository": app.state.room_repository,
        "join_tokens": app.state.join_tokens,
        "frontend_public_url": "http://frontend.test",
    }

    await voice_handler(**arguments)
    await voice_handler(**arguments)

    message.answer.assert_awaited_once()
    bot.edit_message_text.assert_awaited_once()
    async with factory() as session:
        assert await session.scalar(select(func.count(TelegramGroup.id))) == 1
        assert await session.scalar(select(func.count(VoiceRoom.id))) == 1
        room = await session.scalar(select(VoiceRoom))
        assert room is not None
        assert room.telegram_message_id == 777
