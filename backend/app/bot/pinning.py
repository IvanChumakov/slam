import logging

from aiogram import Bot
from aiogram.exceptions import (
    ClientDecodeError,
    TelegramAPIError,
    TelegramBadRequest,
    TelegramForbiddenError,
    TelegramMigrateToChat,
    TelegramNetworkError,
    TelegramRetryAfter,
    TelegramServerError,
)

logger = logging.getLogger(__name__)


async def pin_room_card(bot: Bot, *, chat_id: int, message_id: int, thread_id: int | None) -> None:
    try:
        await bot.pin_chat_message(
            chat_id=chat_id, message_id=message_id, disable_notification=True
        )
    except (TelegramAPIError, ClientDecodeError) as exc:
        # Only allowlisted classifications may be logged, never exception text or response bodies.
        error_class, reason = "TelegramAPIError", "api_error"
        for exception_type, category in (
            (ClientDecodeError, "invalid_response"),
            (TelegramMigrateToChat, "chat_migrated"),
            (TelegramRetryAfter, "rate_limited"),
            (TelegramNetworkError, "network_error"),
            (TelegramServerError, "server_error"),
            (TelegramForbiddenError, "forbidden"),
            (TelegramBadRequest, "api_error"),
        ):
            if isinstance(exc, exception_type):
                error_class, reason = exception_type.__name__, category
                break
        if isinstance(exc, (TelegramBadRequest, TelegramForbiddenError)):
            detail = exc.message.lower() if isinstance(exc.message, str) else ""
            for category, markers in (
                ("bot_kicked", ("bot was kicked",)),
                ("bot_not_member", ("bot is not a member",)),
                ("bot_blocked", ("bot was blocked",)),
                ("message_unavailable", ("message to pin not found", "message_id_invalid")),
                (
                    "topic_unavailable",
                    (
                        "topic_deleted",
                        "topic_closed",
                        "message_thread_invalid",
                        "message thread not found",
                    ),
                ),
                ("chat_unavailable", ("chat not found",)),
                ("admin_required", ("chat_admin_required", "administrator rights")),
                ("pin_permission_required", ("not enough rights",)),
            ):
                if any(marker in detail for marker in markers):
                    reason = category
                    break
        logger.warning("Room card pin failed: error_class=%s reason=%s", error_class, reason)
        action = {
            "admin_required": (
                "Make the bot an administrator in this chat with the Pin messages permission "
                "(can_pin_messages)."
            ),
            "pin_permission_required": (
                "Give the bot the Pin messages permission (can_pin_messages) in this chat."
            ),
            "bot_kicked": "Telegram reports the bot was kicked. Add the bot back to this chat.",
            "bot_not_member": "Telegram reports the bot is not a member. Add the bot to this chat.",
            "bot_blocked": "Telegram reports the bot is blocked. Unblock the bot.",
            "forbidden": "Telegram denied the request. Check the bot's access to this chat.",
            "message_unavailable": "Telegram cannot find the card message. Check that it exists.",
            "topic_unavailable": "Telegram reports the topic is unavailable. Check the topic.",
            "chat_unavailable": "Telegram could not find the chat. Check the bot's access to it.",
            "chat_migrated": "This group migrated. Use the card in the current group.",
            "rate_limited": "Telegram rate-limited the request. Try pinning manually later.",
        }.get(reason, "You can pin it manually or try again later.")
        warning = "The voice room card is usable, but could not be pinned. " + action
        try:
            await bot.send_message(chat_id=chat_id, message_thread_id=thread_id, text=warning)
        except (TelegramAPIError, ClientDecodeError):
            logger.warning("Room card pin warning could not be delivered")
