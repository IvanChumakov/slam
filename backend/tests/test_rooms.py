from sqlalchemy import func, select

from app.models import TelegramGroup, VoiceRoom


async def test_ensure_general_room_is_idempotent(app_context: tuple, session) -> None:
    app = app_context[0]

    first = await app.state.voice_service.ensure_general_room(
        session, telegram_chat_id=-100123456, title="Gaming Test"
    )
    await session.commit()
    second = await app.state.voice_service.ensure_general_room(
        session, telegram_chat_id=-100123456, title="Gaming Test renamed"
    )
    await session.commit()

    assert first.id == second.id
    assert await session.scalar(select(func.count(TelegramGroup.id))) == 1
    assert await session.scalar(select(func.count(VoiceRoom.id))) == 1
    group = await session.scalar(select(TelegramGroup))
    assert group is not None
    assert group.title == "Gaming Test renamed"
