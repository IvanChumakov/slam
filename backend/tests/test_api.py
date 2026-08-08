from app.services.livekit import LiveKitPresenceEvent


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
