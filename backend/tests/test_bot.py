from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock

from aiogram import Bot
from aiogram.exceptions import TelegramBadRequest
from aiogram.methods import EditMessageText
from aiogram.types import Chat, Message
from sqlalchemy import func, select

from app.bot.handlers import voice_handler
from app.bot.notifier import TelegramRoomNotifier
from app.models import TelegramGroup, VoiceRoom


async def test_repeated_voice_reuses_room_and_replies_each_time(app_context: tuple) -> None:
    app, _, factory, _ = app_context
    sent = SimpleNamespace(message_id=777)
    message = SimpleNamespace(
        chat=SimpleNamespace(id=-100123456, title="Gaming Test"),
        message_thread_id=42,
        answer=AsyncMock(return_value=sent),
    )
    bot = SimpleNamespace(edit_message_text=AsyncMock(), send_message=AsyncMock(return_value=sent))
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

    assert bot.send_message.await_count == 2
    message.answer.assert_not_awaited()
    bot.edit_message_text.assert_not_awaited()
    room_ids = []
    for call in bot.send_message.await_args_list:
        assert call.kwargs["message_thread_id"] == 42
        url = call.kwargs["reply_markup"].inline_keyboard[0][0].url
        room_ids.append(app.state.join_tokens.verify_join_token(url.split("/join/")[1]).room_id)
    assert room_ids[0] == room_ids[1]
    async with factory() as session:
        assert await session.scalar(select(func.count(TelegramGroup.id))) == 1
        assert await session.scalar(select(func.count(VoiceRoom.id))) == 1
        room = await session.scalar(select(VoiceRoom))
        assert room is not None
        assert room.telegram_message_id == 777
        assert room.telegram_thread_id == 42


async def test_voice_in_different_topics_gets_different_rooms(app_context: tuple) -> None:
    app, _, factory, _ = app_context
    for thread_id in (None, 42, 43, 42):
        message = SimpleNamespace(
            chat=SimpleNamespace(id=-100123456, title="Gaming Test"),
            message_thread_id=thread_id,
            answer=AsyncMock(return_value=SimpleNamespace(message_id=100 + (thread_id or 0))),
        )
        bot = SimpleNamespace(
            send_message=AsyncMock(return_value=SimpleNamespace(message_id=100 + (thread_id or 0)))
        )
        await voice_handler(
            message=message,
            bot=bot,
            session_factory=factory,
            voice_service=app.state.voice_service,
            room_repository=app.state.room_repository,
            join_tokens=app.state.join_tokens,
            frontend_public_url="http://frontend.test",
        )
        bot.send_message.assert_awaited_once()
        assert bot.send_message.await_args.kwargs["message_thread_id"] == thread_id
    async with factory() as session:
        rooms = (await session.scalars(select(VoiceRoom))).all()
        assert len(rooms) == 3
        assert {room.telegram_thread_id for room in rooms} == {0, 42, 43}
        assert len({room.livekit_room_name for room in rooms}) == 3


async def test_voice_with_real_aiogram_objects(app_context: tuple) -> None:
    app, _, factory, _ = app_context
    message = Message(
        message_id=1,
        date=datetime.now(UTC),
        chat=Chat(id=-100123456, type="supergroup", title="Forum", is_forum=True),
        message_thread_id=42,
        is_topic_message=True,
        text="/voice",
    )
    sent = message.model_copy(update={"message_id": 777})
    transport = AsyncMock(return_value=sent)
    bot = Bot(token="123456:TEST_TOKEN", session=transport)
    for _ in range(2):
        await voice_handler(
            message=message,
            bot=bot,
            session_factory=factory,
            voice_service=app.state.voice_service,
            room_repository=app.state.room_repository,
            join_tokens=app.state.join_tokens,
            frontend_public_url="http://frontend.test",
        )
    assert transport.await_count == 2
    room_ids = []
    for call in transport.await_args_list:
        request = call.args[1]
        assert request.chat_id == message.chat.id
        assert request.message_thread_id == 42
        url = request.reply_markup.inline_keyboard[0][0].url
        room_ids.append(app.state.join_tokens.verify_join_token(url.split("/join/")[1]).room_id)
    assert room_ids[0] == room_ids[1]


async def test_notifier_replacement_stays_in_room_topic(app_context: tuple) -> None:
    app, _, factory, _ = app_context
    async with factory() as session:
        room = await app.state.voice_service.ensure_general_room(
            session, telegram_chat_id=-100123456, title="Gaming Test", telegram_thread_id=42
        )
        room.telegram_message_id = 777
        await session.commit()
        room_id = room.id
    bot = SimpleNamespace(
        edit_message_text=AsyncMock(
            side_effect=TelegramBadRequest(
                method=EditMessageText(text="test"), message="message to edit not found"
            )
        ),
        send_message=AsyncMock(return_value=SimpleNamespace(message_id=888)),
    )
    notifier = TelegramRoomNotifier(
        bot, factory, app.state.room_repository, app.state.join_tokens, "http://frontend.test"
    )
    await notifier.update(room_id)
    assert bot.send_message.await_args.kwargs["message_thread_id"] == 42
    async with factory() as session:
        room = await session.get(VoiceRoom, room_id)
        assert room.telegram_message_id == 888
