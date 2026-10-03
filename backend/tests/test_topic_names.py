from datetime import UTC, datetime
from unittest.mock import AsyncMock

from aiogram import Bot, Dispatcher
from aiogram.methods import EditMessageText, SendMessage
from aiogram.types import Chat, ForumTopicCreated, ForumTopicEdited, Message, Update, User
from sqlalchemy import func, select

from app.bot.handlers import create_router
from app.models import TelegramTopic, VoiceRoom


def topic_message(message_id: int, **fields) -> Message:
    return Message(
        message_id=message_id,
        date=datetime.now(UTC),
        chat=Chat(id=-100123456, type="supergroup", title="Forum", is_forum=True),
        from_user=User(id=123, is_bot=False, first_name="Test"),
        message_thread_id=42,
        is_topic_message=True,
        **fields,
    )


def dispatcher_for(app_context: tuple) -> tuple[Dispatcher, Bot, AsyncMock]:
    app, _, factory, _ = app_context
    transport = AsyncMock(return_value=topic_message(777, text="sent"))
    bot = Bot(token="123456:TEST_TOKEN", session=transport)
    dispatcher = Dispatcher(
        session_factory=factory,
        room_repository=app.state.room_repository,
        voice_service=app.state.voice_service,
        join_tokens=app.state.join_tokens,
        frontend_public_url="http://frontend.test",
    )
    dispatcher.include_router(create_router())
    return dispatcher, bot, transport


async def test_topic_creation_rename_and_repeated_voice(app_context: tuple) -> None:
    dispatcher, bot, transport = dispatcher_for(app_context)
    starter = topic_message(
        42, forum_topic_created=ForumTopicCreated(name="Игры 🎮", icon_color=123)
    )
    await dispatcher.feed_update(bot, Update(update_id=1, message=starter))
    async with app_context[2]() as session:
        assert await session.scalar(select(func.count(VoiceRoom.id))) == 0
        assert await session.scalar(select(TelegramTopic.name)) == "Игры 🎮"
    await dispatcher.feed_update(
        bot,
        Update(update_id=2, message=topic_message(100, text="/voice", reply_to_message=starter)),
    )
    request = next(
        call.args[1]
        for call in reversed(transport.await_args_list)
        if isinstance(call.args[1], SendMessage)
    )
    assert isinstance(request, SendMessage)
    assert request.text.startswith("🔊 Игры 🎮")
    assert request.message_thread_id == 42
    async with app_context[2]() as session:
        first_id = await session.scalar(select(VoiceRoom.id))

    await dispatcher.feed_update(
        bot,
        Update(
            update_id=3,
            message=topic_message(101, forum_topic_edited=ForumTopicEdited(name="Работа")),
        ),
    )
    request = transport.await_args.args[1]
    assert isinstance(request, EditMessageText)
    assert request.text.startswith("🔊 Работа")

    # An old topic starter must not overwrite the more recent rename.
    await dispatcher.feed_update(
        bot,
        Update(update_id=4, message=topic_message(102, text="/voice", reply_to_message=starter)),
    )
    request = next(
        call.args[1]
        for call in reversed(transport.await_args_list)
        if isinstance(call.args[1], SendMessage)
    )
    assert request.text.startswith("🔊 Работа")
    await dispatcher.feed_update(
        bot,
        Update(
            update_id=5,
            message=topic_message(
                103, forum_topic_edited=ForumTopicEdited(icon_custom_emoji_id="icon-only")
            ),
        ),
    )
    async with app_context[2]() as session:
        room = await session.scalar(select(VoiceRoom))
        assert room.id == first_id
        assert room.name == "Работа"
        assert await session.scalar(select(func.count(VoiceRoom.id))) == 1


async def test_old_topic_name_can_be_read_from_starter(app_context: tuple) -> None:
    dispatcher, bot, transport = dispatcher_for(app_context)
    starter = topic_message(
        42, forum_topic_created=ForumTopicCreated(name="Музыка", icon_color=123)
    )
    await dispatcher.feed_update(
        bot,
        Update(update_id=1, message=topic_message(100, text="/voice", reply_to_message=starter)),
    )
    request = next(
        call.args[1]
        for call in reversed(transport.await_args_list)
        if isinstance(call.args[1], SendMessage)
    )
    assert request.text.startswith("🔊 Музыка")


async def test_topic_names_are_scoped_to_group(app_context: tuple, session) -> None:
    app = app_context[0]
    repository = app.state.room_repository
    for chat_id, name in ((-123, "Игры"), (-456, "Работа")):
        await repository.remember_topic_name(
            session, telegram_chat_id=chat_id, telegram_thread_id=42, name=name
        )
        room = await repository.ensure_general_room(
            session, telegram_chat_id=chat_id, title="Forum", telegram_thread_id=42
        )
        assert room.name == name
    await session.commit()
