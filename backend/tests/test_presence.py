import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from livekit import api

from app.models import RoomParticipant, VoiceRoom
from app.services.presence import (
    ConnectedParticipant,
    LiveKitPresenceSource,
    PresenceSynchronizer,
    PresenceUnavailable,
)


async def make_room(app_context):
    app, _, factory, _ = app_context
    async with factory() as session:
        room = await app.state.voice_service.ensure_general_room(
            session, telegram_chat_id=-100123456, title="Test"
        )
        await session.commit()
        return room


async def test_livekit_source_is_lazy_and_counts_only_visible_active_people(monkeypatch):
    client = SimpleNamespace(
        room=SimpleNamespace(
            list_participants=AsyncMock(
                return_value=api.ListParticipantsResponse(
                    participants=[
                        api.ParticipantInfo(
                            identity="a", name="Alice", state=api.ParticipantInfo.ACTIVE
                        ),
                        api.ParticipantInfo(identity="b", state=api.ParticipantInfo.ACTIVE),
                        api.ParticipantInfo(identity="joining", state=api.ParticipantInfo.JOINED),
                        api.ParticipantInfo(
                            identity="left", state=api.ParticipantInfo.DISCONNECTED
                        ),
                        api.ParticipantInfo(
                            identity="agent",
                            state=api.ParticipantInfo.ACTIVE,
                            kind=api.ParticipantInfo.AGENT,
                        ),
                        api.ParticipantInfo(
                            identity="hidden",
                            state=api.ParticipantInfo.ACTIVE,
                            permission=api.ParticipantPermission(hidden=True),
                        ),
                    ]
                )
            )
        ),
        aclose=AsyncMock(),
    )
    factory = Mock(return_value=client)
    monkeypatch.setattr(api, "LiveKitAPI", factory)
    source = LiveKitPresenceSource("http://livekit:7880", "key", "secret")
    factory.assert_not_called()
    assert await source.snapshot("room") == (
        ConnectedParticipant("a", "Alice"),
        ConnectedParticipant("b", "b"),
    )
    await source.snapshot("room")
    factory.assert_called_once()
    assert factory.call_args.kwargs["url"] == "http://livekit:7880"
    await source.aclose()
    client.aclose.assert_awaited_once()


@pytest.mark.parametrize("code", ["not_found", "unauthenticated", "unavailable"])
async def test_only_confirmed_room_absence_is_empty(monkeypatch, code):
    client = SimpleNamespace(
        room=SimpleNamespace(
            list_participants=AsyncMock(
                side_effect=api.TwirpError(
                    code=code, msg="private", status=404 if code == "not_found" else 503
                )
            )
        ),
        aclose=AsyncMock(),
    )
    monkeypatch.setattr(api, "LiveKitAPI", Mock(return_value=client))
    source = LiveKitPresenceSource("http://livekit:7880", "key", "secret")
    if code == "not_found":
        assert await source.snapshot("missing") == ()
    else:
        with pytest.raises(PresenceUnavailable):
            await source.snapshot("room")
    await source.aclose()


async def test_reconciliation_repairs_missed_joins_and_leaves(app_context):
    app, _, factory, _ = app_context
    room = await make_room(app_context)
    async with factory() as session:
        session.add(RoomParticipant(room_id=room.id, identity="ghost", display_name="Ghost"))
        await session.commit()
    source = SimpleNamespace(
        snapshot=AsyncMock(return_value=(ConnectedParticipant("alice", "Alice"),))
    )
    notifier = SimpleNamespace(update=AsyncMock())
    sync = PresenceSynchronizer(source, factory, app.state.room_repository, notifier)
    await sync.refresh(room.id)
    async with factory() as session:
        presence = await app.state.room_repository.presence(session, room)
        assert presence.online_count == 1
        assert presence.participant_names == ("Alice",)
    source.snapshot.return_value = ()
    await sync.refresh(room.id)
    async with factory() as session:
        assert await app.state.room_repository.online_count(session, room.id) == 0
    await sync.stop()


async def test_failed_livekit_query_never_deletes_last_known_presence(app_context):
    app, _, factory, _ = app_context
    room = await make_room(app_context)
    async with factory() as session:
        session.add(RoomParticipant(room_id=room.id, identity="alice", display_name="Alice"))
        await session.commit()
    source = SimpleNamespace(snapshot=AsyncMock(side_effect=PresenceUnavailable()))
    sync = PresenceSynchronizer(
        source, factory, app.state.room_repository, SimpleNamespace(update=AsyncMock())
    )
    with pytest.raises(PresenceUnavailable):
        await sync.refresh(room.id)
    async with factory() as session:
        assert await app.state.room_repository.online_count(session, room.id) == 1
    await sync.stop()


async def test_slow_telegram_does_not_block_reconciliation(app_context):
    app, _, factory, _ = app_context
    room = await make_room(app_context)
    edit_started = asyncio.Event()
    hold_edit = asyncio.Event()

    async def slow_edit(room_id):
        edit_started.set()
        await hold_edit.wait()

    source = SimpleNamespace(
        snapshot=AsyncMock(return_value=(ConnectedParticipant("alice", "Alice"),))
    )
    sync = PresenceSynchronizer(
        source, factory, app.state.room_repository, SimpleNamespace(update=slow_edit)
    )
    sync.start()
    try:
        async with asyncio.timeout(2):
            await edit_started.wait()
        source.snapshot.return_value = ()
        await sync.refresh(room.id)
        async with factory() as session:
            assert await app.state.room_repository.online_count(session, room.id) == 0
        assert not hold_edit.is_set()
    finally:
        hold_edit.set()
        await sync.stop()


async def test_api_counts_are_authoritative_and_errors_are_not_fake_zero(app_context):
    app, client, factory, _ = app_context
    room = await make_room(app_context)
    token = app.state.join_tokens.create_join_token(room.id, -100123456)
    app.state.livekit_presence.snapshot = AsyncMock(return_value=())
    async with factory() as session:
        session.add(RoomParticipant(room_id=room.id, identity="ghost", display_name="Ghost"))
        await session.commit()
    response = await client.post("/api/voice/rooms", json={"join_token": token})
    assert response.status_code == 200
    assert response.json()["rooms"][0]["online_count"] == 0
    response = await client.get(f"/api/rooms/{room.id}")
    assert response.json()["online_count"] == 0
    app.state.livekit_presence.snapshot.side_effect = PresenceUnavailable()
    response = await client.post("/api/voice/rooms", json={"join_token": token})
    assert response.status_code == 503
    async with factory() as session:
        assert await app.state.room_repository.online_count(session, room.id) == 1


async def test_webhook_ack_is_independent_of_telegram_delivery(app_context):
    app, client, _, parser = app_context
    room = await make_room(app_context)
    from app.services.livekit import LiveKitPresenceEvent

    parser.event = LiveKitPresenceEvent("participant_left", room.livekit_room_name, "a", "Alice")
    app.state.room_notifier.update = AsyncMock(side_effect=RuntimeError("Telegram unavailable"))
    response = await client.post(
        "/api/livekit/webhook", content=b"{}", headers={"Authorization": "Bearer valid"}
    )
    assert response.status_code == 204
    app.state.room_notifier.update.assert_not_awaited()


async def test_periodic_sweep_repairs_presence_without_any_webhook(app_context):
    app, _, factory, _ = app_context
    await make_room(app_context)
    first = asyncio.Event()
    repaired = asyncio.Event()
    source = SimpleNamespace(
        snapshot=AsyncMock(return_value=(ConnectedParticipant("alice", "Alice"),))
    )

    async def confirmed(room_id):
        async with factory() as session:
            count = await app.state.room_repository.online_count(session, room_id)
        if count == 1:
            first.set()
        elif first.is_set():
            repaired.set()

    sync = PresenceSynchronizer(
        source, factory, app.state.room_repository, SimpleNamespace(update=confirmed), interval=0.02
    )
    sync.start()
    try:
        async with asyncio.timeout(2):
            await first.wait()
            source.snapshot.return_value = ()
            await repaired.wait()
    finally:
        await sync.stop()


async def test_late_card_response_cannot_replace_newer_card_or_clear_uncertainty(app_context):
    app, _, factory, _ = app_context
    room = await make_room(app_context)
    async with factory() as session:
        room = await session.get(VoiceRoom, room.id)
        await app.state.room_repository.set_telegram_message_id(session, room, 777)
        await session.commit()
        await app.state.room_repository.set_telegram_message_id(session, room, 888)
        await session.commit()
        await app.state.room_repository.set_telegram_message_id(session, room, 666)
        await session.commit()
        assert room.telegram_message_id == 888
        assert room.telegram_pending_unpin_ids == [666, 777]
        room.telegram_replacement_blocked = True
        await session.commit()
        await app.state.room_repository.set_telegram_message_id(session, room, 888)
        await session.commit()
        assert room.telegram_replacement_blocked is True
        await app.state.room_repository.set_telegram_message_id(session, room, 999)
        await session.commit()
        assert room.telegram_replacement_blocked is False
