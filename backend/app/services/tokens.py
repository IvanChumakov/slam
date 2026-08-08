from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

import jwt


class InvalidJoinToken(ValueError):
    """Raised when an invite token is malformed, expired, or untrusted."""


@dataclass(frozen=True, slots=True)
class JoinTokenClaims:
    room_id: int
    telegram_chat_id: int


class JoinTokenService:
    algorithm = "HS256"
    issuer = "telegram-voice-backend"
    audience = "telegram-voice-join"

    def __init__(self, secret: str, ttl_seconds: int = 900) -> None:
        if len(secret) < 32:
            raise ValueError("join token secret must contain at least 32 characters")
        self._secret = secret
        self._ttl = timedelta(seconds=ttl_seconds)

    def create_join_token(self, room_id: int, telegram_chat_id: int) -> str:
        now = datetime.now(UTC)
        payload = {
            "room_id": room_id,
            "telegram_chat_id": telegram_chat_id,
            "iat": now,
            "exp": now + self._ttl,
            "iss": self.issuer,
            "aud": self.audience,
        }
        return jwt.encode(payload, self._secret, algorithm=self.algorithm)

    def verify_join_token(self, token: str) -> JoinTokenClaims:
        try:
            payload: dict[str, Any] = jwt.decode(
                token,
                self._secret,
                algorithms=[self.algorithm],
                issuer=self.issuer,
                audience=self.audience,
                options={"require": ["exp", "iat", "iss", "aud", "room_id", "telegram_chat_id"]},
            )
            room_id = int(payload["room_id"])
            telegram_chat_id = int(payload["telegram_chat_id"])
        except (jwt.PyJWTError, KeyError, TypeError, ValueError) as exc:
            raise InvalidJoinToken("invalid or expired invite") from exc
        if room_id <= 0 or telegram_chat_id == 0:
            raise InvalidJoinToken("invalid or expired invite")
        return JoinTokenClaims(room_id=room_id, telegram_chat_id=telegram_chat_id)
