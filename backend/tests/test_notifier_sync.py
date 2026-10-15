import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from aiogram.exceptions import TelegramBadRequest, TelegramNetworkError, TelegramRetryAfter
from aiogram.methods import EditMessageText, PinChatMessage, SendMessage, UnpinChatMessage

from app.bot.notifier import TelegramRoomNotifier
from app.models import RoomParticipant, VoiceRoom


async def setup_notifier(app_context):
    app, _, factory, _ = app_context
    async with factory() as session:
        room = await app.state.voice_service.ensure_general_room(
            session, telegram_chat_id=-100123456, title="Test"
        )
        room.telegram_message_id = 777
        session.add(RoomParticipant(room_id=room.id, identity="alice", display_name="Alice"))
        await session.commit()
        room_id = room.id
    bot = SimpleNamespace(
        me=AsyncMock(return_value=SimpleNamespace(has_main_web_app=False, username="test_bot")),
        edit_message_text=AsyncMock(),
        send_message=AsyncMock(return_value=SimpleNamespace(message_id=888)),
        pin_chat_message=AsyncMock(return_value=True),
        unpin_chat_message=AsyncMock(return_value=True),
    )
    notifier = TelegramRoomNotifier(
        bot, factory, app.state.room_repository, app.state.join_tokens, "http://frontend.test"
    )
    return app, factory, room_id, bot, notifier


async def test_unchanged_presence_does_not_keep_editing_or_regenerating_invites(app_context):
    _, factory, room_id, bot, notifier = await setup_notifier(app_context)
    await notifier.update(room_id)
    await notifier.update(room_id)
    bot.edit_message_text.assert_awaited_once()
    async with factory() as session:
        session.add(RoomParticipant(room_id=room_id, identity="bob", display_name="Bob"))
        await session.commit()
    await notifier.update(room_id)
    assert bot.edit_message_text.await_count == 2
    assert "Bob" in bot.edit_message_text.await_args.kwargs["text"]
    bot.send_message.assert_not_awaited()


async def test_network_edit_failure_retries_the_same_id_not_a_new_post(app_context):
    _, _, room_id, bot, notifier = await setup_notifier(app_context)
    bot.edit_message_text.side_effect = [
        TelegramNetworkError(method=EditMessageText(text="x"), message="timeout"),
        True,
    ]
    with pytest.raises(TelegramNetworkError):
        await notifier.update(room_id)
    await notifier.update(room_id)
    assert [call.kwargs["message_id"] for call in bot.edit_message_text.await_args_list] == [
        777,
        777,
    ]
    bot.send_message.assert_not_awaited()


async def test_unknown_replacement_delivery_is_not_replayed_after_restart(app_context):
    app, factory, room_id, bot, notifier = await setup_notifier(app_context)
    bot.edit_message_text.side_effect = TelegramBadRequest(
        method=EditMessageText(text="x"), message="message to edit not found"
    )
    bot.send_message.side_effect = TelegramNetworkError(
        method=SendMessage(chat_id=-1, text="x"), message="timeout"
    )
    with pytest.raises(TelegramNetworkError):
        await notifier.update(room_id)
    async with factory() as session:
        assert (await session.get(VoiceRoom, room_id)).telegram_replacement_blocked is True
    restarted = TelegramRoomNotifier(
        bot, factory, app.state.room_repository, app.state.join_tokens, "http://frontend.test"
    )
    await restarted.update(room_id)
    bot.send_message.assert_awaited_once()
    async with factory() as session:
        room = await session.get(VoiceRoom, room_id)
        await app.state.room_repository.set_telegram_message_id(session, room, 999)
        await session.commit()
        assert room.telegram_replacement_blocked is False


async def test_cancelled_replacement_is_blocked_before_post_completion(app_context):
    _, factory, room_id, bot, notifier = await setup_notifier(app_context)
    bot.edit_message_text.side_effect = TelegramBadRequest(
        method=EditMessageText(text="x"), message="message to edit not found"
    )
    accepted = asyncio.Event()

    async def accepted_without_response(**kwargs):
        accepted.set()
        await asyncio.Event().wait()

    bot.send_message.side_effect = accepted_without_response
    task = asyncio.create_task(notifier.update(room_id))
    await accepted.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    async with factory() as session:
        assert (await session.get(VoiceRoom, room_id)).telegram_replacement_blocked is True
    await notifier.update(room_id)
    bot.send_message.assert_awaited_once()


async def test_unrelated_bad_request_does_not_create_replacement(app_context):
    _, _, room_id, bot, notifier = await setup_notifier(app_context)
    bot.edit_message_text.side_effect = TelegramBadRequest(
        method=EditMessageText(text="x"), message="not enough rights"
    )
    with pytest.raises(TelegramBadRequest):
        await notifier.update(room_id)
    bot.send_message.assert_not_awaited()


async def test_concurrent_edits_are_ordered_and_read_latest_presence(app_context):
    _, factory, room_id, bot, notifier = await setup_notifier(app_context)
    started = asyncio.Event()
    release = asyncio.Event()

    async def edit(**kwargs):
        if not started.is_set():
            started.set()
            await release.wait()

    bot.edit_message_text.side_effect = edit
    first = asyncio.create_task(notifier.update(room_id))
    await started.wait()
    async with factory() as session:
        session.add(RoomParticipant(room_id=room_id, identity="bob", display_name="Bob"))
        await session.commit()
    second = asyncio.create_task(notifier.update(room_id))
    await asyncio.sleep(0)
    assert bot.edit_message_text.await_count == 1
    release.set()
    await asyncio.gather(first, second)
    assert bot.edit_message_text.await_count == 2
    assert "Bob" in bot.edit_message_text.await_args.kwargs["text"]


@pytest.mark.parametrize("operation", ["pin", "unpin"])
async def test_background_pin_cleanup_preserves_retry_after(app_context, operation):
    app, factory, room_id, bot, _ = await setup_notifier(app_context)
    async with factory() as session:
        room = await session.get(VoiceRoom, room_id)
        room.telegram_pin_pending = operation == "pin"
        room.telegram_pending_unpin_ids = [555]
        await session.commit()
    method = (
        PinChatMessage(chat_id=-1, message_id=777)
        if operation == "pin"
        else UnpinChatMessage(chat_id=-1, message_id=555)
    )
    failure = TelegramRetryAfter(method=method, message="slow down", retry_after=17)
    if operation == "pin":
        bot.pin_chat_message.side_effect = failure
    else:
        bot.unpin_chat_message.side_effect = failure
    notifier = TelegramRoomNotifier(
        bot,
        factory,
        app.state.room_repository,
        app.state.join_tokens,
        "http://frontend.test",
        notify_pin_failure=False,
    )
    with pytest.raises(TelegramRetryAfter) as caught:
        await notifier.update(room_id)
    assert caught.value.retry_after == 17
    async with factory() as session:
        assert (await session.get(VoiceRoom, room_id)).telegram_pending_unpin_ids == [555]
