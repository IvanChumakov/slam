from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from aiogram import Bot, Dispatcher
from aiogram.methods import AnswerCallbackQuery, PinChatMessage, SendMessage
from aiogram.types import CallbackQuery, Chat, Message, Update, User
from sqlalchemy import func, select

from app.bot.commands import register_commands
from app.bot.handlers import create_router
from app.models import VoiceRoom


async def test_command_menu_has_voice_for_groups() -> None:
    bot = SimpleNamespace(set_my_commands=AsyncMock())
    await register_commands(bot)
    assert bot.set_my_commands.await_count == 2
    default, groups = bot.set_my_commands.await_args_list
    assert default.kwargs["scope"].type == "default"
    assert groups.kwargs["scope"].type == "all_group_chats"
    assert [command.command for command in groups.kwargs["commands"]] == ["voice"]


@pytest.mark.parametrize("thread_id", [None, 42])
async def test_voice_button_reuses_room_in_current_topic(
    app_context: tuple, thread_id: int | None
) -> None:
    app, _, factory, _ = app_context
    message = Message(
        message_id=10,
        date=datetime.now(UTC),
        chat=Chat(id=-100123456, type="supergroup", title="Forum", is_forum=True),
        message_thread_id=thread_id,
        is_topic_message=thread_id is not None,
        text="/voice",
        from_user=User(id=123, is_bot=False, first_name="Test"),
    )
    transport = AsyncMock(return_value=message.model_copy(update={"message_id": 777}))
    bot = Bot(token="123456:TEST_TOKEN", session=transport)
    dispatcher = Dispatcher(
        session_factory=factory,
        room_repository=app.state.room_repository,
        voice_service=app.state.voice_service,
        join_tokens=app.state.join_tokens,
        frontend_public_url="http://frontend.test",
    )
    dispatcher.include_router(create_router())
    await dispatcher.feed_update(bot, Update(update_id=1, message=message))
    first_request = transport.await_args_list[0].args[1]
    assert first_request.reply_markup.inline_keyboard[1][0].callback_data == "voice:link"
    query = CallbackQuery(
        id="button-click",
        from_user=message.from_user,
        chat_instance="test-group",
        message=message.model_copy(update={"message_id": 777, "text": "room card"}),
        data="voice:link",
    )
    for update_id in (2, 3):
        await dispatcher.feed_update(bot, Update(update_id=update_id, callback_query=query))
    requests = [call.args[1] for call in transport.await_args_list]
    assert sum(isinstance(request, AnswerCallbackQuery) for request in requests) == 2
    sends = [request for request in requests if isinstance(request, SendMessage)]
    assert len(sends) == 3
    pins = [request for request in requests if isinstance(request, PinChatMessage)]
    assert len(pins) == 3
    for pin in pins:
        assert pin.chat_id == message.chat.id
        assert pin.message_id == 777
        assert pin.disable_notification is True
        assert "message_thread_id" not in pin.model_dump()
    room_ids = []
    for request in sends:
        assert request.message_thread_id == thread_id
        url = request.reply_markup.inline_keyboard[0][0].url
        room_ids.append(app.state.join_tokens.verify_join_token(url.split("/join/")[1]).room_id)
    assert len(set(room_ids)) == 1
    async with factory() as session:
        assert await session.scalar(select(func.count(VoiceRoom.id))) == 1


@pytest.mark.parametrize("command", ["/voice", "/voicehelp", "/start"])
async def test_private_commands_do_not_pin(app_context: tuple, command: str) -> None:
    app, _, factory, _ = app_context
    message = Message(
        message_id=1,
        date=datetime.now(UTC),
        chat=Chat(id=123, type="private"),
        text=command,
        from_user=User(id=123, is_bot=False, first_name="Test"),
    )
    transport = AsyncMock(return_value=message)
    bot = Bot(token="123456:TEST_TOKEN", session=transport)
    dispatcher = Dispatcher(
        session_factory=factory,
        room_repository=app.state.room_repository,
        voice_service=app.state.voice_service,
        join_tokens=app.state.join_tokens,
        frontend_public_url="http://frontend.test",
    )
    dispatcher.include_router(create_router())
    await dispatcher.feed_update(bot, Update(update_id=1, message=message))
    assert not any(isinstance(call.args[1], PinChatMessage) for call in transport.await_args_list)
    async with factory() as session:
        assert await session.scalar(select(func.count(VoiceRoom.id))) == 0
