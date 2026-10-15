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
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.db.repositories import RoomRepository

logger = logging.getLogger(__name__)


async def pin_room_card(
    bot: Bot,
    *,
    chat_id: int,
    message_id: int,
    thread_id: int | None,
    notify_failure: bool = True,
) -> bool:
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
        if not notify_failure:
            if isinstance(exc, TelegramRetryAfter):
                raise
            return False
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
        return False
    return True


async def sync_room_card_pins(
    bot: Bot,
    session_factory: async_sessionmaker[AsyncSession],
    repository: RoomRepository,
    room_id: int,
    notify_failure: bool = True,
) -> None:
    async with session_factory() as session:
        # Keep the latest desired ID stable through Telegram operations and the cleanup commit.
        room = await repository.get_room_with_group_for_update(session, room_id)
        if room is None or room.telegram_message_id is None:
            return
        message_id = room.telegram_message_id
        chat_id = room.group.telegram_chat_id
        if room.telegram_pin_pending:
            pinned = await pin_room_card(
                bot,
                chat_id=chat_id,
                message_id=message_id,
                thread_id=room.telegram_thread_id or None,
                notify_failure=notify_failure,
            )
            if not pinned:
                return
            room.telegram_pin_pending = False

        remaining = []
        old_ids = [
            old_id
            for old_id in dict.fromkeys(room.telegram_pending_unpin_ids)
            if old_id != message_id
        ]
        for index, old_id in enumerate(old_ids):
            try:
                await bot.unpin_chat_message(chat_id=chat_id, message_id=old_id)
            except (TelegramAPIError, ClientDecodeError) as exc:
                if isinstance(exc, TelegramRetryAfter):
                    remaining.extend(old_ids[index:])
                    room.telegram_pending_unpin_ids = remaining
                    await session.commit()
                    if not notify_failure:
                        raise
                    break
                detail = (
                    exc.message.strip().lower()
                    if isinstance(exc, TelegramBadRequest) and isinstance(exc.message, str)
                    else ""
                )
                detail = detail.removeprefix("bad request: ")
                if detail in (
                    "message to unpin not found",
                    "message is not pinned",
                    "message not pinned",
                ):
                    continue
                remaining.append(old_id)
                # Do not log exception strings, response bodies, or user/chat identifiers.
                reason = "invalid_response" if isinstance(exc, ClientDecodeError) else "api_error"
                logger.warning("Room card unpin failed: reason=%s", reason)
        room.telegram_pending_unpin_ids = remaining
        await session.commit()
