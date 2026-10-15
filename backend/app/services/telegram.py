import hmac
import json
import re
import time
from dataclasses import dataclass
from typing import Protocol
from urllib.parse import parse_qsl, unquote, urlsplit


class InvalidTelegramProfile(ValueError):
    def __init__(self) -> None:
        super().__init__("Invalid Telegram profile")


@dataclass(frozen=True, slots=True)
class TelegramProfile:
    username: str | None
    avatar_url: str | None


class TelegramProfileVerifier(Protocol):
    def verify(self, init_data: str) -> TelegramProfile: ...


def _safe_avatar_url(value: object, bot_token: str) -> str | None:
    if not isinstance(value, str) or not value or len(value) > 4096:
        return None
    if any(character.isspace() or ord(character) < 32 for character in value) or "\\" in value:
        return None
    try:
        url = urlsplit(value)
        if (
            url.scheme != "https"
            or not url.hostname
            or url.username is not None
            or url.password is not None
            or url.port not in (None, 443)
            or url.hostname.rstrip(".").lower() == "api.telegram.org"
            or "/file/bot" in unquote(url.path).lower()
            or bot_token in unquote(value)
        ):
            return None
    except ValueError:
        return None
    return value


def verify_telegram_init_data(
    init_data: str, bot_token: str, now: float | None = None
) -> TelegramProfile:
    """Verify Telegram's bot-token HMAC and return only public profile suggestions."""
    try:
        if not bot_token or not init_data or len(init_data.encode("utf-8")) > 16384:
            raise InvalidTelegramProfile
        pairs = parse_qsl(init_data, keep_blank_values=True, strict_parsing=True, errors="strict")
        fields = dict(pairs)
        if len(fields) != len(pairs):
            raise InvalidTelegramProfile
        received_hash = fields.pop("hash")
        if re.fullmatch(r"[0-9a-fA-F]{64}", received_hash) is None:
            raise InvalidTelegramProfile
        # Unlike third-party Ed25519 validation, bot-token HMAC includes signature.
        check_string = "\n".join(f"{key}={value}" for key, value in sorted(fields.items()))
        secret = hmac.digest(b"WebAppData", bot_token.encode("utf-8"), "sha256")
        expected_hash = hmac.digest(secret, check_string.encode("utf-8"), "sha256").hex()
        if not hmac.compare_digest(expected_hash, received_hash.lower()):
            raise InvalidTelegramProfile
        if re.fullmatch(r"[0-9]+", fields["auth_date"]) is None:
            raise InvalidTelegramProfile
        auth_date = int(fields["auth_date"])
        age = (time.time() if now is None else now) - auth_date
        if auth_date <= 0 or not -30 <= age <= 86400:
            raise InvalidTelegramProfile
        user = json.loads(fields["user"])
        if not isinstance(user, dict) or type(user.get("id")) is not int or user["id"] <= 0:
            raise InvalidTelegramProfile
        username = user.get("username")
        if username is not None and not isinstance(username, str):
            raise InvalidTelegramProfile
        if username is not None:
            username = username.lstrip("@") or None
        return TelegramProfile(username, _safe_avatar_url(user.get("photo_url"), bot_token))
    except (ValueError, KeyError, TypeError, UnicodeError, RecursionError):
        raise InvalidTelegramProfile from None


class TelegramProfileService:
    def __init__(self, bot_token: str) -> None:
        self._bot_token = bot_token

    def verify(self, init_data: str) -> TelegramProfile:
        return verify_telegram_init_data(init_data, self._bot_token)
