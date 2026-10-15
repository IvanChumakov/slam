import base64
import logging

from aiogram import Bot
from aiogram.exceptions import ClientDecodeError, TelegramAPIError
from aiogram.types import InlineKeyboardButton, InlineKeyboardMarkup

logger = logging.getLogger(__name__)


def room_message(name: str, online_count: int, participant_names: tuple[str, ...] = ()) -> str:
    lines = [f"🔊 {name}", "", f"Сейчас в комнате: {online_count}"]
    if participant_names:
        lines.extend(("", *participant_names))
    return "\n".join(lines)


def join_keyboard(join_url: str, browser_url: str | None = None) -> InlineKeyboardMarkup:
    rows = [[InlineKeyboardButton(text="🎧 Войти в комнату", url=join_url)]]
    if browser_url is not None:
        rows.append([InlineKeyboardButton(text="Открыть в браузере", url=browser_url)])
    rows.append(
        [InlineKeyboardButton(text="🔗 Получить ссылку ещё раз", callback_data="voice:link")]
    )
    return InlineKeyboardMarkup(inline_keyboard=rows)


async def room_keyboard(bot: Bot, frontend_public_url: str, token: str) -> InlineKeyboardMarkup:
    browser_url = f"{frontend_public_url.rstrip('/')}/join/{token}"
    payload = "join_" + base64.urlsafe_b64encode(token.encode()).decode().rstrip("=")
    if len(payload) > 512:
        return join_keyboard(browser_url)
    try:
        profile = await bot.me()
    except (TelegramAPIError, ClientDecodeError) as exc:
        logger.warning("Mini App bot lookup unavailable: error_class=%s", type(exc).__name__)
        return join_keyboard(browser_url)
    if profile.has_main_web_app and profile.username:
        return join_keyboard(f"https://t.me/{profile.username}?startapp={payload}", browser_url)
    return join_keyboard(browser_url)
