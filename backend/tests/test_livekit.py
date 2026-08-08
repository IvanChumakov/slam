import base64
import hashlib

import jwt
from livekit import api

from app.services.livekit import LiveKitTokenService, LiveKitWebhookService


def test_livekit_token_has_required_room_permissions() -> None:
    api_secret = "livekit-secret-which-is-long-enough-for-hs256"
    token = LiveKitTokenService("api-key", api_secret).generate_livekit_token(
        room_name="telegram_1_general",
        identity="guest_1",
        display_name="Ivan",
    )

    claims = jwt.decode(token, api_secret, algorithms=["HS256"], audience=None)
    assert claims["sub"] == "guest_1"
    assert claims["name"] == "Ivan"
    assert claims["video"]["room"] == "telegram_1_general"
    assert claims["video"]["roomJoin"] is True
    assert claims["video"]["canPublish"] is True
    assert claims["video"]["canSubscribe"] is True


def test_livekit_webhook_signature_and_payload_are_verified() -> None:
    api_key = "api-key"
    api_secret = "livekit-secret-which-is-long-enough-for-hs256"
    body = (
        '{"event":"participant_joined","room":{"name":"telegram_1_general"},'
        '"participant":{"identity":"guest_1","name":"Ivan"}}'
    )
    body_hash = base64.b64encode(hashlib.sha256(body.encode()).digest()).decode()
    authorization = api.AccessToken(api_key, api_secret).with_sha256(body_hash).to_jwt()

    event = LiveKitWebhookService(api_key, api_secret).parse(body, authorization)

    assert event is not None
    assert event.event == "participant_joined"
    assert event.room_name == "telegram_1_general"
    assert event.identity == "guest_1"
    assert event.display_name == "Ivan"
