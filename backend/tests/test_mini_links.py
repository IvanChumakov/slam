import base64
from types import SimpleNamespace
from unittest.mock import AsyncMock
from urllib.parse import parse_qs, urlsplit

from aiogram.exceptions import TelegramNetworkError
from aiogram.methods import GetMe

from app.bot.presentation import room_keyboard


async def test_main_mini_app_link_carries_only_room_invite_and_keeps_browser_fallback():
    bot = SimpleNamespace(
        me=AsyncMock(
            return_value=SimpleNamespace(username="testslam228_bot", has_main_web_app=True)
        )
    )
    token = "header.signed-room-invite.signature"
    markup = await room_keyboard(bot, "https://voice.test/", token)
    primary = urlsplit(markup.inline_keyboard[0][0].url)
    payload = parse_qs(primary.query)["startapp"][0]
    assert primary.scheme == "https" and primary.netloc == "t.me"
    assert primary.path == "/testslam228_bot"
    assert payload.startswith("join_") and len(payload) <= 512
    assert base64.urlsafe_b64decode(payload[5:] + "=" * (-len(payload[5:]) % 4)).decode() == token
    assert markup.inline_keyboard[1][0].url == f"https://voice.test/join/{token}"
    assert markup.inline_keyboard[2][0].callback_data == "voice:link"


async def test_disabled_mini_app_keeps_existing_guest_keyboard():
    bot = SimpleNamespace(
        me=AsyncMock(
            return_value=SimpleNamespace(username="testslam228_bot", has_main_web_app=False)
        )
    )
    markup = await room_keyboard(bot, "https://voice.test", "token")
    assert markup.inline_keyboard[0][0].url == "https://voice.test/join/token"
    assert len(markup.inline_keyboard) == 2


async def test_unavailable_bot_profile_does_not_prevent_guest_join_links(caplog):
    bot = SimpleNamespace(
        me=AsyncMock(
            side_effect=TelegramNetworkError(method=GetMe(), message="private-token-value")
        )
    )
    markup = await room_keyboard(bot, "https://voice.test", "token")
    assert markup.inline_keyboard[0][0].url == "https://voice.test/join/token"
    assert "private-token-value" not in caplog.text


async def test_oversized_start_payload_uses_browser_link_not_an_invalid_mini_app_link():
    bot = SimpleNamespace(
        me=AsyncMock(
            return_value=SimpleNamespace(username="testslam228_bot", has_main_web_app=True)
        )
    )
    markup = await room_keyboard(bot, "https://voice.test", "a" * 1000)
    assert markup.inline_keyboard[0][0].url == "https://voice.test/join/" + "a" * 1000
