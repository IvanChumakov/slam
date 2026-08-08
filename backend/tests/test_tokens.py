import jwt
import pytest

from app.services.tokens import InvalidJoinToken, JoinTokenService


def test_create_and_verify_join_token() -> None:
    service = JoinTokenService("s" * 64, ttl_seconds=900)

    token = service.create_join_token(room_id=42, telegram_chat_id=-100123456)
    claims = service.verify_join_token(token)

    assert claims.room_id == 42
    assert claims.telegram_chat_id == -100123456


def test_expired_join_token_is_rejected() -> None:
    payload = {
        "room_id": 42,
        "telegram_chat_id": -100123456,
        "iat": 1,
        "exp": 2,
        "iss": JoinTokenService.issuer,
        "aud": JoinTokenService.audience,
    }
    token = jwt.encode(payload, "s" * 64, algorithm="HS256")

    with pytest.raises(InvalidJoinToken):
        JoinTokenService("s" * 64).verify_join_token(token)


def test_invalid_join_token_is_rejected() -> None:
    with pytest.raises(InvalidJoinToken):
        JoinTokenService("s" * 64).verify_join_token("not-a-jwt")
