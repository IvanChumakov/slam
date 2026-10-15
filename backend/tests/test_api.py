from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock
from urllib.parse import urlsplit

import jwt
import pytest
from sqlalchemy import event, func, select

from app.models import TelegramTopic, VoiceRoom
from app.services.livekit import LiveKitPresenceEvent, LiveKitTokenService
from app.services.presence import ConnectedParticipant


async def test_telegram_profile_contract(app_context, telegram_init_data):
    _, client, _, _ = app_context
    response = await client.post("/api/telegram/profile", json={"init_data": telegram_init_data()})
    assert response.status_code == 200
    assert response.json() == {"username": "alice", "avatar_url": None}


@pytest.mark.parametrize("age", [86401, -31])
async def test_telegram_profile_rejects_expired_and_future_data(
    app_context, telegram_init_data, age
):
    import time

    response = await app_context[1].post(
        "/api/telegram/profile",
        json={
            "init_data": telegram_init_data(auth_date=int(time.time()) - age),
        },
    )
    assert response.status_code == 401
    assert response.json() == {"detail": "Invalid Telegram profile"}


@pytest.mark.parametrize(
    "user", [{"id": 123456789}, {"id": 123456789, "photo_url": "http://unsafe.test/photo"}]
)
async def test_telegram_join_no_photo_and_guest_have_same_claims(
    app_context, telegram_init_data, user
):
    app, client, factory, _ = app_context
    _, token = await create_room_and_token(app, factory)
    secret = "livekit-secret-which-is-long-enough-for-hs256"
    app.state.voice_service.livekit_tokens = LiveKitTokenService("api-key", secret)
    claims_list = []
    for data in (None, telegram_init_data(user=user)):
        payload = {"join_token": token, "display_name": "Edited"}
        if data is not None:
            payload["telegram_init_data"] = data
        response = await client.post("/api/voice/join", json=payload)
        assert response.status_code == 200
        claims = jwt.decode(response.json()["access_token"], secret, algorithms=["HS256"])
        assert claims.get("metadata", "") == ""
        assert "123456789" not in str(claims)
        claims.pop("sub")
        claims.pop("iat", None)
        claims.pop("nbf", None)
        claims.pop("exp", None)
        claims_list.append(claims)
    assert claims_list[0] == claims_list[1]


@pytest.mark.parametrize(
    "payload", [{}, {"init_data": []}, {"init_data": 123}, {"init_data": "x", "user_id": 1}]
)
async def test_telegram_profile_strict_body(app_context, payload):
    assert (await app_context[1].post("/api/telegram/profile", json=payload)).status_code == 422


async def test_telegram_profile_invalid_is_generic_and_not_logged(app_context, caplog):
    response = await app_context[1].post(
        "/api/telegram/profile", json={"init_data": "private-raw-data"}
    )
    assert response.status_code == 401
    assert response.json() == {"detail": "Invalid Telegram profile"}
    assert "private-raw-data" not in caplog.text


async def test_telegram_join_avatar_name_override_and_unique_identity(
    app_context, telegram_init_data
):
    app, client, factory, _ = app_context
    _, token = await create_room_and_token(app, factory)
    secret = "livekit-secret-which-is-long-enough-for-hs256"
    app.state.voice_service.livekit_tokens = LiveKitTokenService("api-key", secret)
    photo = "https://t.me/i/userpic/320/photo.jpg"
    data = telegram_init_data(user={"id": 123456789, "username": "alice", "photo_url": photo})
    identities = []
    for _ in range(2):
        response = await client.post(
            "/api/voice/join",
            json={
                "join_token": token,
                "display_name": "My editable name",
                "telegram_init_data": data,
            },
        )
        assert response.status_code == 200
        body = response.json()
        assert set(body["participant"]) == {"identity", "display_name"}
        claims = jwt.decode(body["access_token"], secret, algorithms=["HS256"])
        assert claims["name"] == "My editable name"
        assert claims["metadata"] == '{"avatar_url":"' + photo + '"}'
        assert claims["sub"].startswith("guest_")
        assert "123456789" not in str(claims)
        identities.append(claims["sub"])
    assert identities[0] != identities[1]


async def test_telegram_join_invalid_and_room_authorization_first(app_context):
    from unittest.mock import Mock

    app, client, factory, _ = app_context
    _, token = await create_room_and_token(app, factory)
    response = await client.post(
        "/api/voice/join",
        json={
            "join_token": token,
            "display_name": "Name",
            "telegram_init_data": "invalid",
        },
    )
    assert response.status_code == 401
    assert response.json() == {"detail": "Invalid Telegram profile"}
    app.state.voice_service.telegram_profiles = Mock()
    response = await client.post(
        "/api/voice/join",
        json={
            "join_token": "invalid",
            "display_name": "Name",
            "telegram_init_data": "invalid",
        },
    )
    assert response.status_code == 401
    app.state.voice_service.telegram_profiles.verify.assert_not_called()


@pytest.mark.parametrize(
    "endpoint,field",
    [("/api/telegram/profile", "init_data"), ("/api/voice/join", "telegram_init_data")],
)
async def test_telegram_data_request_size_limit(app_context, endpoint, field):
    payload = {field: "x" * 16385}
    if field == "telegram_init_data":
        payload.update(join_token="invite", display_name="Name")
    assert (await app_context[1].post(endpoint, json=payload)).status_code == 422


async def test_channel_rosters_and_counts_use_one_authorized_snapshot(app_context):
    app, client, factory, _ = app_context
    rooms, other = await create_group_rooms(app, factory)
    token = app.state.join_tokens.create_join_token(rooms[0].id, -100123456)
    snapshots = {
        rooms[0].livekit_room_name: (
            ConnectedParticipant("alice", "Alice"),
            ConnectedParticipant("bob", "Bob"),
        ),
        rooms[1].livekit_room_name: (ConnectedParticipant("max", "Max"),),
    }
    app.state.livekit_presence.snapshot = AsyncMock(
        side_effect=lambda name: snapshots.get(name, ())
    )
    response = await client.post("/api/voice/rooms", json={"join_token": token})
    assert response.status_code == 200
    listed = response.json()["rooms"]
    by_id = {room["id"]: room for room in listed}
    assert by_id[rooms[0].id]["participants"] == [
        {"identity": "alice", "display_name": "Alice"},
        {"identity": "bob", "display_name": "Bob"},
    ]
    assert by_id[rooms[1].id]["participants"] == [{"identity": "max", "display_name": "Max"}]
    assert by_id[rooms[2].id]["participants"] == []
    assert all(room["online_count"] == len(room["participants"]) for room in listed)
    assert app.state.livekit_presence.snapshot.await_count == len(rooms)
    assert other.livekit_room_name not in {
        call.args[0] for call in app.state.livekit_presence.snapshot.await_args_list
    }


async def test_public_room_endpoint_does_not_expose_new_channel_rosters(app_context):
    app, client, factory, _ = app_context
    rooms, _ = await create_group_rooms(app, factory)
    response = await client.get(f"/api/rooms/{rooms[0].id}")
    assert response.status_code == 200
    assert set(response.json()) == {"id", "name", "online_count"}


async def test_invalid_invitation_never_queries_or_exposes_channel_rosters(app_context):
    app, client, _, _ = app_context
    app.state.livekit_presence.snapshot = AsyncMock()
    response = await client.post("/api/voice/rooms", json={"join_token": "invalid"})
    assert response.status_code == 401
    assert "participants" not in response.text
    app.state.livekit_presence.snapshot.assert_not_awaited()


async def create_room_and_token(app, factory) -> tuple[int, str]:
    async with factory() as session:
        room = await app.state.voice_service.ensure_general_room(
            session, telegram_chat_id=-100123456, title="Gaming Test"
        )
        await session.commit()
        token = app.state.join_tokens.create_join_token(room.id, -100123456)
        return room.id, token


async def test_health(app_context: tuple) -> None:
    _, client, _, _ = app_context
    response = await client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


async def test_readiness_checks_database(app_context: tuple) -> None:
    _, client, _, _ = app_context
    response = await client.get("/ready")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


async def test_join_voice_contract(app_context: tuple) -> None:
    app, client, factory, _ = app_context
    room_id, token = await create_room_and_token(app, factory)

    response = await client.post(
        "/api/voice/join", json={"join_token": token, "display_name": "  Ivan  "}
    )

    assert response.status_code == 200
    body = response.json()
    assert body["livekit_url"] == "ws://livekit.test"
    assert body["access_token"] == "test-token"
    assert body["room"] == {"id": room_id, "name": "General"}
    assert body["participant"]["identity"].startswith("guest_")
    assert body["participant"]["display_name"] == "Ivan"


async def test_unknown_room_is_rejected(app_context: tuple) -> None:
    app, client, _, _ = app_context
    token = app.state.join_tokens.create_join_token(999, -100123456)
    response = await client.post(
        "/api/voice/join", json={"join_token": token, "display_name": "Ivan"}
    )
    assert response.status_code == 404


async def test_invalid_token_is_rejected(app_context: tuple) -> None:
    _, client, _, _ = app_context
    response = await client.post(
        "/api/voice/join", json={"join_token": "invalid", "display_name": "Ivan"}
    )
    assert response.status_code == 401


async def test_display_name_validation(app_context: tuple) -> None:
    app, client, factory, _ = app_context
    _, token = await create_room_and_token(app, factory)

    empty = await client.post("/api/voice/join", json={"join_token": token, "display_name": "   "})
    too_long = await client.post(
        "/api/voice/join", json={"join_token": token, "display_name": "x" * 33}
    )

    assert empty.status_code == 422
    assert too_long.status_code == 422


async def test_livekit_webhook_presence_is_idempotent(app_context: tuple) -> None:
    app, client, factory, webhook_parser = app_context
    room_id, _ = await create_room_and_token(app, factory)
    webhook_parser.event = LiveKitPresenceEvent(
        event="participant_joined",
        room_name="telegram_100123456_general",
        identity="guest_1",
        display_name="Ivan",
    )

    for _ in range(2):
        response = await client.post(
            "/api/livekit/webhook",
            content=b'{"event":"participant_joined"}',
            headers={
                "Authorization": "Bearer valid",
                "Content-Type": "application/webhook+json",
            },
        )
        assert response.status_code == 204

    room = await client.get(f"/api/rooms/{room_id}")
    assert room.json()["online_count"] == 1

    webhook_parser.event = LiveKitPresenceEvent(
        event="participant_left",
        room_name="telegram_100123456_general",
        identity="guest_1",
        display_name="Ivan",
    )
    response = await client.post(
        "/api/livekit/webhook",
        content=b'{"event":"participant_left"}',
        headers={"Authorization": "Bearer valid"},
    )
    assert response.status_code == 204
    room = await client.get(f"/api/rooms/{room_id}")
    assert room.json()["online_count"] == 0


async def test_livekit_webhook_requires_valid_authorization(app_context: tuple) -> None:
    _, client, _, _ = app_context
    missing = await client.post("/api/livekit/webhook", content=b"{}")
    invalid = await client.post(
        "/api/livekit/webhook", content=b"{}", headers={"Authorization": "Bearer bad"}
    )
    assert missing.status_code == 401
    assert invalid.status_code == 401


async def create_group_rooms(app, factory):
    async with factory() as session:
        rooms = []
        for thread_id in (20, 0, 10):
            room = await app.state.voice_service.ensure_general_room(
                session, telegram_chat_id=-100123456, title="Gaming", telegram_thread_id=thread_id
            )
            rooms.append(room)
        other = await app.state.voice_service.ensure_general_room(
            session, telegram_chat_id=-100999999, title="Other group"
        )
        session.add(
            TelegramTopic(telegram_chat_id=-100123456, telegram_thread_id=99, name="No room")
        )
        await app.state.room_repository.participant_joined(
            session, room_id=rooms[0].id, identity="one", display_name="One"
        )
        await app.state.room_repository.participant_joined(
            session, room_id=rooms[0].id, identity="two", display_name="Two"
        )
        await app.state.room_repository.participant_joined(
            session, room_id=other.id, identity="other", display_name="Other"
        )
        await session.commit()
        return rooms, other


async def test_voice_rooms_lists_only_existing_source_group_rooms_with_aggregate_counts(
    app_context: tuple,
) -> None:
    app, client, factory, _ = app_context
    rooms, other = await create_group_rooms(app, factory)
    token = app.state.join_tokens.create_join_token(rooms[0].id, -100123456)
    app.state.livekit_presence.snapshot = AsyncMock(
        side_effect=lambda name: (
            (ConnectedParticipant("one", "One"), ConnectedParticipant("two", "Two"))
            if name == rooms[0].livekit_room_name
            else ()
        )
    )
    queries = []

    def record_query(connection, cursor, statement, parameters, context, executemany):
        queries.append(statement)

    event.listen(app.state.engine.sync_engine, "before_cursor_execute", record_query)
    try:
        response = await client.post("/api/voice/rooms", json={"join_token": token})
    finally:
        event.remove(app.state.engine.sync_engine, "before_cursor_execute", record_query)

    assert response.status_code == 200
    assert response.json() == {
        "current_room_id": rooms[0].id,
        "rooms": [
            {
                "id": room.id,
                "name": room.name,
                "online_count": count,
                "participants": [
                    {"identity": "one", "display_name": "One"},
                    {"identity": "two", "display_name": "Two"},
                ]
                if count
                else [],
            }
            for room, count in ((rooms[1], 0), (rooms[2], 0), (rooms[0], 2))
        ],
    }
    assert other.id not in [room["id"] for room in response.json()["rooms"]]
    assert len(queries) <= 3
    assert {call.args[0] for call in app.state.livekit_presence.snapshot.await_args_list} == {
        room.livekit_room_name for room in rooms
    }
    async with factory() as session:
        assert await session.scalar(select(func.count(VoiceRoom.id))) == 4


@pytest.mark.parametrize("target_index", [0, 1, 2])
async def test_voice_invite_mints_target_token_and_can_join(
    app_context: tuple, target_index: int
) -> None:
    app, client, factory, _ = app_context
    rooms, _ = await create_group_rooms(app, factory)
    source_token = app.state.join_tokens.create_join_token(rooms[0].id, -100123456)
    source_claims = jwt.decode(source_token, options={"verify_signature": False})
    source_claims["iat"] -= 60
    source_claims["exp"] -= 60
    source_token = jwt.encode(
        source_claims, app.state.settings.join_token_secret.get_secret_value(), algorithm="HS256"
    )
    app.state.settings.frontend_public_url = "https://frontend.test/app/"
    target = rooms[target_index]
    response = await client.post(
        "/api/voice/invite", json={"join_token": source_token, "room_id": target.id}
    )
    assert response.status_code == 200
    body = response.json()
    assert set(body) == {"join_token", "join_url", "room", "expires_in"}
    assert body["room"] == {"id": target.id, "name": target.name}
    assert body["join_token"] != source_token
    assert body["join_url"] == f"https://frontend.test/app/join/{body['join_token']}"
    assert urlsplit(body["join_url"]).hostname == "frontend.test"
    assert body["expires_in"] == app.state.settings.join_token_ttl_seconds
    minted_claims = jwt.decode(body["join_token"], options={"verify_signature": False})
    assert minted_claims["exp"] > source_claims["exp"]
    assert minted_claims["exp"] - minted_claims["iat"] == body["expires_in"]
    claims = app.state.join_tokens.verify_join_token(body["join_token"])
    assert claims.room_id == target.id
    assert claims.telegram_chat_id == -100123456
    joined = await client.post(
        "/api/voice/join", json={"join_token": body["join_token"], "display_name": "Ivan"}
    )
    assert joined.status_code == 200
    assert joined.json()["room"] == body["room"]
    listed = await client.post("/api/voice/rooms", json={"join_token": body["join_token"]})
    assert listed.status_code == 200
    assert listed.json()["current_room_id"] == target.id


async def test_voice_rooms_does_not_create_missing_general(app_context: tuple) -> None:
    app, client, factory, _ = app_context
    async with factory() as session:
        source = await app.state.voice_service.ensure_general_room(
            session, telegram_chat_id=-100123456, title="Gaming", telegram_thread_id=10
        )
        await session.commit()
        token = app.state.join_tokens.create_join_token(source.id, -100123456)
    for _ in range(2):
        response = await client.post("/api/voice/rooms", json={"join_token": token})
        assert response.status_code == 200
        assert response.json() == {
            "current_room_id": source.id,
            "rooms": [
                {"id": source.id, "name": source.name, "online_count": 0, "participants": []}
            ],
        }
    async with factory() as session:
        assert await session.scalar(select(func.count(VoiceRoom.id))) == 1


async def test_voice_invite_missing_and_cross_group_targets_are_identical(
    app_context: tuple,
) -> None:
    app, client, factory, _ = app_context
    rooms, other = await create_group_rooms(app, factory)
    token = app.state.join_tokens.create_join_token(rooms[0].id, -100123456)
    for target_id in (other.id, 999999):
        response = await client.post(
            "/api/voice/invite", json={"join_token": token, "room_id": target_id}
        )
        assert response.status_code == 404
        assert response.json() == {"detail": "Room not found"}


@pytest.mark.parametrize("room_id", [2**63, 10**100])
async def test_voice_invite_rejects_room_ids_outside_signed_bigint(
    app_context: tuple, room_id: int
) -> None:
    app, client, factory, _ = app_context
    _, token = await create_room_and_token(app, factory)
    response = await client.post(
        "/api/voice/invite", json={"join_token": token, "room_id": room_id}
    )
    assert response.status_code == 422
    error = response.json()["detail"][0]
    assert error["loc"] == ["body", "room_id"]
    assert error["type"] == "less_than_equal"


async def test_voice_invite_max_signed_bigint_missing_room_returns_404(app_context: tuple) -> None:
    app, client, factory, _ = app_context
    _, token = await create_room_and_token(app, factory)
    response = await client.post(
        "/api/voice/invite", json={"join_token": token, "room_id": 2**63 - 1}
    )
    assert response.status_code == 404
    assert response.json() == {"detail": "Room not found"}


@pytest.mark.parametrize("endpoint", ["rooms", "invite"])
@pytest.mark.parametrize(
    "invalid_kind", ["invalid", "signature", "expired", "issuer", "audience", "chat", "missing"]
)
async def test_voice_discovery_and_invite_validate_source(
    app_context: tuple, endpoint: str, invalid_kind: str
) -> None:
    app, client, factory, _ = app_context
    rooms, _ = await create_group_rooms(app, factory)
    token = app.state.join_tokens.create_join_token(rooms[0].id, -100123456)
    claims = jwt.decode(token, options={"verify_signature": False})
    secret = app.state.settings.join_token_secret.get_secret_value()
    if invalid_kind == "invalid":
        token = "invalid"
    else:
        if invalid_kind == "expired":
            claims["exp"] = datetime.now(UTC) - timedelta(seconds=1)
        elif invalid_kind == "issuer":
            claims["iss"] = "other"
        elif invalid_kind == "audience":
            claims["aud"] = "other"
        elif invalid_kind == "chat":
            claims["telegram_chat_id"] = -100999999
        elif invalid_kind == "missing":
            claims["room_id"] = 999999
        elif invalid_kind == "signature":
            secret = "x" * 64
        token = jwt.encode(claims, secret, algorithm="HS256")
    payload = {"join_token": token}
    if endpoint == "invite":
        payload["room_id"] = rooms[1].id
    response = await client.post(f"/api/voice/{endpoint}", json=payload)
    expected = 404 if invalid_kind in {"chat", "missing"} else 401
    assert response.status_code == expected
    assert response.json() == {
        "detail": "Room not found" if expected == 404 else "Invalid or expired invite"
    }


@pytest.mark.parametrize(
    "endpoint,payload",
    [
        ("rooms", {}),
        ("rooms", {"join_token": ""}),
        ("rooms", {"join_token": "x" * 4097}),
        ("rooms", {"join_token": "token", "group_id": 1}),
        ("invite", {"join_token": "token", "room_id": 0}),
        ("invite", {"join_token": "token", "room_id": -1}),
        ("invite", {"join_token": "token", "room_id": True}),
        ("invite", {"join_token": "token", "room_id": 1.0}),
        ("invite", {"join_token": "token", "room_id": "1"}),
        ("invite", {"join_token": "token", "room_id": 1, "group_id": 1}),
    ],
)
async def test_voice_discovery_and_invite_strict_requests(app_context, endpoint, payload) -> None:
    response = await app_context[1].post(f"/api/voice/{endpoint}", json=payload)
    assert response.status_code == 422
