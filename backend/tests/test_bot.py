import json
from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from aiogram import Bot
from aiogram.client.session.aiohttp import AiohttpSession
from aiogram.exceptions import (
    ClientDecodeError,
    TelegramBadRequest,
    TelegramForbiddenError,
    TelegramMigrateToChat,
    TelegramNetworkError,
    TelegramRetryAfter,
    TelegramServerError,
)
from aiogram.methods import EditMessageText, PinChatMessage, SendMessage
from aiogram.types import Chat, Message
from sqlalchemy import func, select

from app.bot.handlers import voice_handler
from app.bot.notifier import TelegramRoomNotifier
from app.bot.pinning import pin_room_card
from app.models import TelegramGroup, VoiceRoom
from app.services.livekit import LiveKitPresenceEvent


async def test_repeated_voice_reuses_room_and_replies_each_time(app_context: tuple) -> None:
    app, _, factory, _ = app_context
    sent = SimpleNamespace(message_id=777)
    message = SimpleNamespace(
        chat=SimpleNamespace(id=-100123456, title="Gaming Test"),
        message_thread_id=42,
        answer=AsyncMock(return_value=sent),
    )
    bot = SimpleNamespace(
        edit_message_text=AsyncMock(),
        send_message=AsyncMock(return_value=sent),
        pin_chat_message=AsyncMock(),
    )
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
            send_message=AsyncMock(return_value=SimpleNamespace(message_id=100 + (thread_id or 0))),
            pin_chat_message=AsyncMock(),
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
    assert transport.await_count == 4
    room_ids = []
    for call in transport.await_args_list:
        request = call.args[1]
        if isinstance(request, PinChatMessage):
            assert request.chat_id == message.chat.id
            assert request.message_id == 777
            assert request.disable_notification is True
            continue
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
        pin_chat_message=AsyncMock(),
    )
    notifier = TelegramRoomNotifier(
        bot, factory, app.state.room_repository, app.state.join_tokens, "http://frontend.test"
    )
    await notifier.update(room_id)
    assert bot.send_message.await_args.kwargs["message_thread_id"] == 42
    async with factory() as session:
        room = await session.get(VoiceRoom, room_id)
        assert room.telegram_message_id == 888


@pytest.mark.parametrize("thread_id", [None, 42])
@pytest.mark.parametrize("replacement", [False, True])
@pytest.mark.parametrize("failure", [None, "rights", "forbidden", "network", "bad_request"])
@pytest.mark.parametrize("warning_fails", [False, True])
async def test_new_cards_pin_after_commit_without_card_loss(
    app_context: tuple,
    thread_id: int | None,
    replacement: bool,
    failure: str | None,
    warning_fails: bool,
    caplog,
) -> None:
    app, client, factory, webhook_parser = app_context
    message = Message(
        message_id=1,
        date=datetime.now(UTC),
        chat=Chat(id=-100123456, type="supergroup", title="Forum", is_forum=True),
        message_thread_id=thread_id,
        text="/voice",
    )
    async with factory() as session:
        room = await app.state.voice_service.ensure_general_room(
            session,
            telegram_chat_id=message.chat.id,
            title="Forum",
            telegram_thread_id=thread_id or 0,
        )
        room.telegram_message_id = 555 if replacement else None
        await session.commit()
        room_id = room.id
        livekit_room_name = room.livekit_room_name

    async def respond(bot, request, **kwargs):
        if isinstance(request, EditMessageText):
            raise TelegramBadRequest(method=request, message="message to edit not found")
        if isinstance(request, PinChatMessage):
            async with factory() as session:
                saved = await session.get(VoiceRoom, room_id)
                assert saved.telegram_message_id == 888
                if replacement:
                    presence = await app.state.room_repository.presence(session, saved)
                    assert presence.online_count == 1
            assert request.chat_id == message.chat.id
            assert request.message_id == 888
            assert request.disable_notification is True
            assert "message_thread_id" not in request.model_dump()
            if failure:
                errors = {
                    "rights": (TelegramBadRequest, "not enough rights to pin a message"),
                    "forbidden": (TelegramForbiddenError, "Forbidden"),
                    "network": (TelegramNetworkError, "123456:TEST_TOKEN connection failed"),
                    "bad_request": (TelegramBadRequest, "message can't be pinned"),
                }
                error_type, detail = errors[failure]
                raise error_type(method=request, message=detail)
            return True
        assert isinstance(request, SendMessage)
        assert request.message_thread_id == thread_id
        if request.reply_markup is None:
            if failure == "rights":
                assert "can_pin_messages" in request.text
                assert "can_manage_topics" not in request.text
            if failure == "forbidden":
                assert "can_pin_messages" not in request.text
            if warning_fails:
                raise TelegramNetworkError(
                    method=request, message="123456:TEST_TOKEN warning failed"
                )
            return message.model_copy(update={"message_id": 999})
        return message.model_copy(update={"message_id": 888})

    transport = AsyncMock(side_effect=respond)
    bot = Bot(token="123456:TEST_TOKEN", session=transport)
    if replacement:
        notifier = TelegramRoomNotifier(
            bot, factory, app.state.room_repository, app.state.join_tokens, "http://frontend.test"
        )
        app.state.room_notifier = notifier
        webhook_parser.event = LiveKitPresenceEvent(
            event="participant_joined",
            room_name=livekit_room_name,
            identity="guest_1",
            display_name="Test",
        )
        response = await client.post(
            "/api/livekit/webhook",
            content=b'{"event":"participant_joined"}',
            headers={"Authorization": "Bearer valid"},
        )
        assert response.status_code == 204
    else:
        await voice_handler(
            message,
            bot,
            factory,
            app.state.voice_service,
            app.state.room_repository,
            app.state.join_tokens,
            "http://frontend.test",
        )
    requests = [call.args[1] for call in transport.await_args_list]
    assert sum(isinstance(request, PinChatMessage) for request in requests) == 1
    cards = [
        request
        for request in requests
        if isinstance(request, SendMessage) and request.reply_markup is not None
    ]
    assert len(cards) == 1
    warnings = [
        request
        for request in requests
        if isinstance(request, SendMessage) and request.reply_markup is None
    ]
    assert len(warnings) == int(failure is not None)
    assert "TEST_TOKEN" not in caplog.text
    async with factory() as session:
        saved = await session.get(VoiceRoom, room_id)
        assert saved.telegram_message_id == 888


@pytest.mark.parametrize(
    ("error_type", "detail", "parameters", "reason", "action"),
    [
        (
            TelegramBadRequest,
            "not enough rights to pin a message",
            {},
            "pin_permission_required",
            "can_pin_messages",
        ),
        (TelegramBadRequest, "CHAT_ADMIN_REQUIRED", {}, "admin_required", "administrator"),
        (
            TelegramForbiddenError,
            "administrator rights required",
            {},
            "admin_required",
            "administrator",
        ),
        (
            TelegramForbiddenError,
            "Forbidden: bot was kicked from the supergroup chat",
            {},
            "bot_kicked",
            "add the bot back",
        ),
        (
            TelegramForbiddenError,
            "Forbidden: bot is not a member of the supergroup chat",
            {},
            "bot_not_member",
            "add the bot",
        ),
        (
            TelegramForbiddenError,
            "Forbidden: bot was blocked by the user",
            {},
            "bot_blocked",
            "unblock the bot",
        ),
        (TelegramForbiddenError, "Forbidden", {}, "forbidden", "check the bot's access"),
        (TelegramBadRequest, "message to pin not found", {}, "message_unavailable", "card message"),
        (TelegramBadRequest, "MESSAGE_ID_INVALID", {}, "message_unavailable", "card message"),
        (TelegramBadRequest, "TOPIC_DELETED", {}, "topic_unavailable", "topic"),
        (TelegramBadRequest, "TOPIC_CLOSED", {}, "topic_unavailable", "topic"),
        (TelegramBadRequest, "message thread not found", {}, "topic_unavailable", "topic"),
        (TelegramBadRequest, "MESSAGE_THREAD_INVALID", {}, "topic_unavailable", "topic"),
        (TelegramBadRequest, "chat not found", {}, "chat_unavailable", "chat"),
        (
            TelegramMigrateToChat,
            "group migrated",
            {"migrate_to_chat_id": -100987654},
            "chat_migrated",
            "current group",
        ),
        (TelegramRetryAfter, "Too Many Requests", {"retry_after": 30}, "rate_limited", "later"),
        (
            TelegramNetworkError,
            "connection failed; not enough rights",
            {},
            "network_error",
            "manually",
        ),
        (TelegramServerError, "Internal Server Error", {}, "server_error", "manually"),
        (TelegramBadRequest, "unrecognized failure", {}, "api_error", "manually"),
    ],
)
@pytest.mark.parametrize("warning_fails", [False, True])
async def test_pin_failures_are_classified_without_leaking_details(
    error_type, detail, parameters, reason, action, warning_fails, caplog
) -> None:
    secret = "https://api.telegram.org/bot123456:TEST_TOKEN/private-body"
    transport = AsyncMock()
    bot = Bot(token="123456:TEST_TOKEN", session=transport)

    async def respond(bot, request, **kwargs):
        if isinstance(request, PinChatMessage):
            raise error_type(method=request, message=f"{detail} {secret}", **parameters)
        assert isinstance(request, SendMessage)
        assert request.message_thread_id == 42
        assert action in request.text.lower()
        if reason not in ("pin_permission_required", "admin_required"):
            assert "can_pin_messages" not in request.text
        assert secret not in request.text
        if warning_fails:
            raise TelegramNetworkError(method=request, message=secret)
        return True

    transport.side_effect = respond
    await pin_room_card(bot, chat_id=-100123456, message_id=888, thread_id=42)
    assert transport.await_count == 2
    records = [r for r in caplog.records if r.name == "app.bot.pinning"]
    assert len(records) == 1 + int(warning_fails)
    assert f"error_class={error_type.__name__} reason={reason}" in records[0].getMessage()
    assert all(r.exc_info is None and r.stack_info is None for r in records)
    for private in ("TEST_TOKEN", "api.telegram.org", "private-body", "-100123456", "888"):
        assert private not in caplog.text


@pytest.mark.parametrize("not_modified", [False, True])
async def test_notifier_pure_edit_does_not_pin(app_context: tuple, not_modified: bool) -> None:
    app, _, factory, _ = app_context
    async with factory() as session:
        room = await app.state.voice_service.ensure_general_room(
            session, telegram_chat_id=-100123456, title="Forum", telegram_thread_id=42
        )
        room.telegram_message_id = 777
        await session.commit()
        room_id = room.id
    transport = AsyncMock(return_value=True)
    if not_modified:
        transport.side_effect = TelegramBadRequest(
            method=EditMessageText(text="test"), message="message is not modified"
        )
    bot = Bot(token="123456:TEST_TOKEN", session=transport)
    notifier = TelegramRoomNotifier(
        bot, factory, app.state.room_repository, app.state.join_tokens, "http://frontend.test"
    )
    await notifier.update(room_id)
    assert transport.await_count == 1
    assert isinstance(transport.await_args.args[1], EditMessageText)


@pytest.mark.parametrize("replacement", [False, True])
@pytest.mark.parametrize("failing_call", ["pin", "warning"])
@pytest.mark.parametrize(
    ("status", "content", "expected_error", "reason"),
    [
        (502, "<html>Bad Gateway 123456:TEST_TOKEN</html>", ClientDecodeError, "invalid_response"),
        (
            200,
            '{"ok":true,"result":{"invalid":"123456:TEST_TOKEN"}}',
            ClientDecodeError,
            "invalid_response",
        ),
        (400, '{"ok":false}', TelegramBadRequest, "api_error"),
        (400, '{"ok":false,"description":null}', TelegramBadRequest, "api_error"),
        (403, '{"ok":false}', TelegramForbiddenError, "forbidden"),
        (403, '{"ok":false,"description":null}', TelegramForbiddenError, "forbidden"),
    ],
)
async def test_sdk_error_responses_preserve_committed_card(
    app_context: tuple,
    replacement: bool,
    failing_call: str,
    status: int,
    content: str,
    expected_error,
    reason: str,
    caplog,
) -> None:
    app, client, factory, webhook_parser = app_context
    message = Message(
        message_id=1,
        date=datetime.now(UTC),
        chat=Chat(id=-100123456, type="supergroup", title="Forum", is_forum=True),
        message_thread_id=42,
        text="/voice",
    )
    async with factory() as session:
        room = await app.state.voice_service.ensure_general_room(
            session, telegram_chat_id=message.chat.id, title="Forum", telegram_thread_id=42
        )
        room.telegram_message_id = 555 if replacement else None
        await session.commit()
        room_id = room.id
        livekit_room_name = room.livekit_room_name

    decoder = AiohttpSession()
    response_failures = []

    async def respond(bot, request, **kwargs):
        if isinstance(request, EditMessageText):
            raise TelegramBadRequest(method=request, message="message to edit not found")
        if isinstance(request, PinChatMessage):
            async with factory() as session:
                saved = await session.get(VoiceRoom, room_id)
                assert saved.telegram_message_id == 888
                if replacement:
                    presence = await app.state.room_repository.presence(session, saved)
                    assert presence.online_count == 1
            if failing_call == "warning":
                return decoder.check_response(
                    bot,
                    request,
                    400,
                    '{"ok":false,"description":"not enough rights to pin a message"}',
                ).result
        else:
            assert isinstance(request, SendMessage)
            assert request.message_thread_id == 42
            assert "TEST_TOKEN" not in request.text
            if request.reply_markup is None and failing_call == "pin":
                assert "The voice room card is usable" in request.text
                assert "can_pin_messages" not in request.text
            if request.reply_markup is not None or failing_call == "pin":
                sent = message.model_copy(
                    update={"message_id": 888 if request.reply_markup else 999}
                )
                return decoder.check_response(
                    bot,
                    request,
                    200,
                    json.dumps({"ok": True, "result": sent.model_dump(mode="json")}),
                ).result
            assert "can_pin_messages" in request.text
        try:
            return decoder.check_response(bot, request, status, content).result
        except expected_error as exc:
            if expected_error is not ClientDecodeError:
                assert exc.message is None
            response_failures.append(type(request))
            raise

    transport = AsyncMock(side_effect=respond)
    bot = Bot(token="123456:TEST_TOKEN", session=transport)
    if replacement:
        app.state.room_notifier = TelegramRoomNotifier(
            bot, factory, app.state.room_repository, app.state.join_tokens, "http://frontend.test"
        )
        webhook_parser.event = LiveKitPresenceEvent(
            event="participant_joined",
            room_name=livekit_room_name,
            identity="guest_1",
            display_name="Test",
        )
        response = await client.post(
            "/api/livekit/webhook",
            content=b'{"event":"participant_joined"}',
            headers={"Authorization": "Bearer valid"},
        )
        assert response.status_code == 204
    else:
        await voice_handler(
            message,
            bot,
            factory,
            app.state.voice_service,
            app.state.room_repository,
            app.state.join_tokens,
            "http://frontend.test",
        )
    assert response_failures == [PinChatMessage if failing_call == "pin" else SendMessage]
    requests = [call.args[1] for call in transport.await_args_list]
    assert sum(isinstance(request, PinChatMessage) for request in requests) == 1
    sends = [request for request in requests if isinstance(request, SendMessage)]
    assert len(sends) == 2
    assert sends[0].reply_markup is not None
    assert sends[1].reply_markup is None
    assert "TEST_TOKEN" not in caplog.text
    assert "api.telegram.org" not in caplog.text
    assert (
        f"reason={reason}" in caplog.text
        if failing_call == "pin"
        else ("Room card pin warning could not be delivered" in caplog.text)
    )
    assert all(record.exc_info is None for record in caplog.records)
    async with factory() as session:
        saved = await session.get(VoiceRoom, room_id)
        assert saved.telegram_message_id == 888
