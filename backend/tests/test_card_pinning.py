import runpy
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from aiogram.exceptions import ClientDecodeError, TelegramBadRequest, TelegramNetworkError
from aiogram.methods import PinChatMessage, UnpinChatMessage
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import create_engine, inspect, select, text
from sqlalchemy.orm import selectinload

from app.bot import pinning
from app.models import VoiceRoom


class LockedRoomRepository:
    async def get_room_with_group_for_update(self, session, room_id):
        return await session.scalar(
            select(VoiceRoom)
            .options(selectinload(VoiceRoom.group))
            .where(VoiceRoom.id == room_id)
            .with_for_update(key_share=True)
            .execution_options(populate_existing=True)
        )


async def make_room(app_context, *, pending=True, cleanup=(111, 222, 333)):
    app, _, factory, _ = app_context
    async with factory() as session:
        room = await app.state.voice_service.ensure_general_room(
            session, telegram_chat_id=-100123456, title="Forum", telegram_thread_id=42
        )
        room.telegram_message_id = 333
        room.telegram_pin_pending = pending
        room.telegram_pending_unpin_ids = list(cleanup)
        await session.commit()
        return room.id


async def synchronize(bot, factory, room_id):
    helper = getattr(pinning, "sync_room_card_pins", None)
    assert helper is not None, "persistent pin synchronization helper is missing"
    await helper(bot, factory, LockedRoomRepository(), room_id, notify_failure=False)


async def test_pin_latest_before_unpinning_only_tracked_cards(app_context):
    factory = app_context[2]
    room_id = await make_room(app_context)
    operations = []

    async def pin(**kwargs):
        operations.append(("pin", kwargs))

    async def unpin(**kwargs):
        operations.append(("unpin", kwargs))

    bot = SimpleNamespace(pin_chat_message=pin, unpin_chat_message=unpin)
    await synchronize(bot, factory, room_id)
    assert operations == [
        ("pin", {"chat_id": -100123456, "message_id": 333, "disable_notification": True}),
        ("unpin", {"chat_id": -100123456, "message_id": 111}),
        ("unpin", {"chat_id": -100123456, "message_id": 222}),
    ]
    async with factory() as session:
        room = await session.get(VoiceRoom, room_id)
        assert room.telegram_pin_pending is False
        assert room.telegram_pending_unpin_ids == []
    await synchronize(bot, factory, room_id)
    assert len(operations) == 3


@pytest.mark.parametrize("decode_error", [False, True])
async def test_failed_pin_keeps_old_pins_and_pending_state(app_context, decode_error, caplog):
    factory = app_context[2]
    room_id = await make_room(app_context)
    secret = "https://api.telegram.org/bot123456:TEST_TOKEN/private-body"
    error = (
        ClientDecodeError("invalid response", ValueError(secret), secret)
        if decode_error
        else TelegramNetworkError(method=PinChatMessage(chat_id=1, message_id=333), message=secret)
    )
    bot = SimpleNamespace(
        pin_chat_message=AsyncMock(side_effect=error),
        unpin_chat_message=AsyncMock(),
        send_message=AsyncMock(),
    )
    await synchronize(bot, factory, room_id)
    bot.unpin_chat_message.assert_not_awaited()
    bot.send_message.assert_not_awaited()
    async with factory() as session:
        room = await session.get(VoiceRoom, room_id)
        assert room.telegram_pin_pending is True
        assert room.telegram_pending_unpin_ids == [111, 222, 333]
    assert "TEST_TOKEN" not in caplog.text
    assert "private-body" not in caplog.text
    bot.pin_chat_message.side_effect = None
    await synchronize(bot, factory, room_id)
    assert bot.pin_chat_message.await_count == 2
    assert bot.unpin_chat_message.await_count == 2


@pytest.mark.parametrize(
    ("detail", "harmless"),
    [
        ("Bad Request: message to unpin not found", True),
        ("message is not pinned", True),
        ("message not pinned", True),
        ("message to unpin not found but not enough rights", False),
        ("MESSAGE_ID_INVALID", False),
        ("chat not found", False),
        ("not enough rights to unpin a message", False),
    ],
)
async def test_unpin_errors_only_clear_explicit_harmless_responses(
    app_context, detail, harmless, caplog
):
    factory = app_context[2]
    room_id = await make_room(app_context)

    async def unpin(**kwargs):
        if kwargs["message_id"] == 111:
            raise TelegramBadRequest(method=UnpinChatMessage(**kwargs), message=detail)

    bot = SimpleNamespace(
        pin_chat_message=AsyncMock(), unpin_chat_message=AsyncMock(side_effect=unpin)
    )
    await synchronize(bot, factory, room_id)
    async with factory() as session:
        room = await session.get(VoiceRoom, room_id)
        assert room.telegram_pin_pending is False
        assert room.telegram_pending_unpin_ids == ([] if harmless else [111])
    assert detail not in caplog.text
    bot.unpin_chat_message.side_effect = None
    await synchronize(bot, factory, room_id)
    assert bot.pin_chat_message.await_count == 1
    assert bot.unpin_chat_message.await_count == (2 if harmless else 3)


@pytest.mark.parametrize("decode_error", [False, True])
async def test_unpin_transport_failure_is_persisted_and_token_safe(
    app_context, decode_error, caplog
):
    factory = app_context[2]
    room_id = await make_room(app_context, pending=False, cleanup=(111,))
    secret = "https://api.telegram.org/bot123456:TEST_TOKEN/private-body"
    error = (
        ClientDecodeError("invalid response", ValueError(secret), secret)
        if decode_error
        else TelegramNetworkError(
            method=UnpinChatMessage(chat_id=1, message_id=111), message=secret
        )
    )
    bot = SimpleNamespace(
        pin_chat_message=AsyncMock(), unpin_chat_message=AsyncMock(side_effect=error)
    )
    await synchronize(bot, factory, room_id)
    bot.pin_chat_message.assert_not_awaited()
    async with factory() as session:
        room = await session.get(VoiceRoom, room_id)
        assert room.telegram_pending_unpin_ids == [111]
    assert "TEST_TOKEN" not in caplog.text
    assert "private-body" not in caplog.text
    assert all(record.exc_info is None for record in caplog.records)


async def test_sync_reads_current_database_id_and_isolates_other_topics(app_context):
    app, _, factory, _ = app_context
    room_id = await make_room(app_context, cleanup=(111,))
    async with factory() as session:
        other = await app.state.voice_service.ensure_general_room(
            session, telegram_chat_id=-100123456, title="Forum", telegram_thread_id=43
        )
        other.telegram_message_id = 555
        other.telegram_pin_pending = True
        other.telegram_pending_unpin_ids = [444]
        room = await session.get(VoiceRoom, room_id)
        room.telegram_message_id = 666
        room.telegram_pending_unpin_ids = [111, 333]
        await session.commit()
        other_id = other.id
    bot = SimpleNamespace(pin_chat_message=AsyncMock(), unpin_chat_message=AsyncMock())
    await synchronize(bot, factory, room_id)
    bot.pin_chat_message.assert_awaited_once_with(
        chat_id=-100123456, message_id=666, disable_notification=True
    )
    assert [call.kwargs["message_id"] for call in bot.unpin_chat_message.await_args_list] == [
        111,
        333,
    ]
    async with factory() as session:
        other = await session.get(VoiceRoom, other_id)
        assert other.telegram_pending_unpin_ids == [444]
        assert other.telegram_pin_pending is True


async def test_missing_room_or_missing_card_does_not_unpin(app_context):
    factory = app_context[2]
    room_id = await make_room(app_context)
    async with factory() as session:
        room = await session.get(VoiceRoom, room_id)
        room.telegram_message_id = None
        await session.commit()
    bot = SimpleNamespace(pin_chat_message=AsyncMock(), unpin_chat_message=AsyncMock())
    await synchronize(bot, factory, room_id)
    await synchronize(bot, factory, room_id + 1000)
    bot.pin_chat_message.assert_not_awaited()
    bot.unpin_chat_message.assert_not_awaited()


async def test_pin_returns_success_and_can_suppress_warning():
    bot = SimpleNamespace(pin_chat_message=AsyncMock(), send_message=AsyncMock())
    assert await pinning.pin_room_card(bot, chat_id=1, message_id=2, thread_id=None) is True
    bot.pin_chat_message.side_effect = TelegramBadRequest(
        method=PinChatMessage(chat_id=1, message_id=2), message="not enough rights"
    )
    assert (
        await pinning.pin_room_card(
            bot, chat_id=1, message_id=2, thread_id=None, notify_failure=False
        )
        is False
    )
    bot.send_message.assert_not_awaited()


async def test_pin_tracking_defaults_are_persisted(app_context):
    app, _, factory, _ = app_context
    async with factory() as session:
        room = await app.state.voice_service.ensure_general_room(
            session, telegram_chat_id=-100999, title="Defaults"
        )
        await session.commit()
        room_id = room.id
    async with factory() as session:
        room = await session.get(VoiceRoom, room_id)
        assert getattr(room, "telegram_pin_pending", None) is False
        assert getattr(room, "telegram_pending_unpin_ids", None) == []
        assert getattr(room, "telegram_replacement_blocked", None) is False


async def test_replacement_block_survives_reload_and_pin_sync(app_context):
    factory = app_context[2]
    room_id = await make_room(app_context)
    async with factory() as session:
        room = await session.get(VoiceRoom, room_id)
        room.telegram_replacement_blocked = True
        await session.commit()
    async with factory() as session:
        room = await session.get(VoiceRoom, room_id)
        assert getattr(room, "telegram_replacement_blocked", None) is True
    bot = SimpleNamespace(pin_chat_message=AsyncMock(), unpin_chat_message=AsyncMock())
    await synchronize(bot, factory, room_id)
    async with factory() as session:
        room = await session.get(VoiceRoom, room_id)
        assert room.telegram_replacement_blocked is True
        assert room.telegram_pin_pending is False
        assert room.telegram_pending_unpin_ids == []


def test_migration_upgrades_existing_rows_and_downgrades():
    migration = runpy.run_path(
        Path(__file__).parents[1] / "alembic" / "versions" / "0004_room_card_pins.py"
    )
    assert migration["revision"] == "0004_room_card_pins"
    assert migration["down_revision"] == "0003_topic_names"
    assert len(migration["revision"]) < 32
    engine = create_engine("sqlite://")
    try:
        with engine.begin() as connection:
            connection.execute(text("CREATE TABLE voice_rooms (id INTEGER PRIMARY KEY)"))
            connection.execute(text("INSERT INTO voice_rooms (id) VALUES (1)"))
            with Operations.context(MigrationContext.configure(connection)):
                migration["upgrade"]()
                row = connection.execute(
                    text(
                        "SELECT telegram_pending_unpin_ids, telegram_pin_pending, "
                        "telegram_replacement_blocked FROM voice_rooms"
                    )
                ).one()
                assert tuple(row) == ("[]", 0, 0)
                migration["downgrade"]()
            assert [
                column["name"] for column in inspect(connection).get_columns("voice_rooms")
            ] == ["id"]
            assert connection.scalar(text("SELECT id FROM voice_rooms")) == 1
    finally:
        engine.dispose()
