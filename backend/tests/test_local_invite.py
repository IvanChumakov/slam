from urllib.parse import urlparse

import pytest

from app.config import Settings
from app.local_invite import LOCAL_TELEGRAM_CHAT_ID, create_local_invite
from app.services.tokens import JoinTokenService


async def test_create_local_invite_is_valid_and_idempotent(
    settings: Settings, app_context: tuple
) -> None:
    factory = app_context[2]

    first = await create_local_invite(settings, factory)
    second = await create_local_invite(settings, factory)

    parsed = urlparse(first)
    assert f"{parsed.scheme}://{parsed.netloc}" == "http://frontend.test"
    token = parsed.path.removeprefix("/join/")
    claims = JoinTokenService(
        settings.join_token_secret.get_secret_value(),
        settings.join_token_ttl_seconds,
    ).verify_join_token(token)
    assert claims.room_id == 1
    assert claims.telegram_chat_id == LOCAL_TELEGRAM_CHAT_ID

    second_token = urlparse(second).path.removeprefix("/join/")
    second_claims = JoinTokenService(
        settings.join_token_secret.get_secret_value(),
        settings.join_token_ttl_seconds,
    ).verify_join_token(second_token)
    assert second_claims.room_id == claims.room_id


async def test_local_invite_is_disabled_in_production(
    settings: Settings, app_context: tuple
) -> None:
    production = settings.model_copy(update={"environment": "production"})

    with pytest.raises(RuntimeError, match="disabled in production"):
        await create_local_invite(production, app_context[2])
