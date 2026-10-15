import asyncio
import logging

from aiogram import Bot
from aiogram.exceptions import (
    TelegramBadRequest,
    TelegramForbiddenError,
    TelegramMigrateToChat,
    TelegramRetryAfter,
)
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.bot.pinning import sync_room_card_pins
from app.bot.presentation import room_keyboard, room_message
from app.db.repositories import RoomRepository
from app.models import VoiceRoom
from app.services.tokens import JoinTokenService

logger = logging.getLogger(__name__)


class TelegramRoomNotifier:
    def __init__(
        self,
        bot: Bot,
        session_factory: async_sessionmaker[AsyncSession],
        repository: RoomRepository,
        join_tokens: JoinTokenService,
        frontend_public_url: str,
        notify_pin_failure: bool = True,
    ) -> None:
        self._bot = bot
        self._session_factory = session_factory
        self._repository = repository
        self._join_tokens = join_tokens
        self._frontend_public_url = frontend_public_url.rstrip("/")
        self._notify_pin_failure = notify_pin_failure
        self._locks: dict[int, asyncio.Lock] = {}
        self._last_delivered: dict[int, tuple[int, str, tuple[str, ...]]] = {}
        self._unavailable_cards: set[tuple[int, int]] = set()

    async def update(self, room_id: int) -> None:
        async with self._locks.setdefault(room_id, asyncio.Lock()):
            async with self._session_factory() as session:
                room = await self._repository.get_room_with_group_for_update(session, room_id)
                if room is None or room.telegram_message_id is None:
                    return
                if (
                    room.telegram_replacement_blocked
                    or (room_id, room.telegram_message_id) in self._unavailable_cards
                ):
                    return
                presence = await self._repository.presence(session, room)
                signature = (room.telegram_message_id, room.name, presence.participant_names)
                if signature != self._last_delivered.get(room_id):
                    token = self._join_tokens.create_join_token(
                        room.id, room.group.telegram_chat_id
                    )
                    text = room_message(
                        room.name, presence.online_count, presence.participant_names
                    )
                    markup = await room_keyboard(self._bot, self._frontend_public_url, token)
                    try:
                        await self._bot.edit_message_text(
                            chat_id=room.group.telegram_chat_id,
                            message_id=room.telegram_message_id,
                            text=text,
                            reply_markup=markup,
                        )
                    except (TelegramForbiddenError, TelegramMigrateToChat):
                        self._unavailable_cards.add((room_id, room.telegram_message_id))
                        logger.warning(
                            "Room card is inaccessible; waiting for a new registered card"
                        )
                        return
                    except TelegramBadRequest as exc:
                        detail = exc.message.lower() if isinstance(exc.message, str) else ""
                        if "chat not found" in detail:
                            self._unavailable_cards.add((room_id, room.telegram_message_id))
                            logger.warning(
                                "Room card chat is inaccessible; waiting for a new registered card"
                            )
                            return
                        if "message is not modified" not in detail:
                            if "message to edit not found" not in detail:
                                raise
                            logger.warning("Room card was removed; creating a replacement")
                            replaced_id = room.telegram_message_id
                            # Persist uncertainty before POST, including cancellation/crash windows.
                            room.telegram_replacement_blocked = True
                            await session.commit()
                            try:
                                sent = await self._bot.send_message(
                                    chat_id=room.group.telegram_chat_id,
                                    message_thread_id=room.telegram_thread_id or None,
                                    text=text,
                                    reply_markup=markup,
                                )
                            except (
                                TelegramBadRequest,
                                TelegramForbiddenError,
                                TelegramRetryAfter,
                                TelegramMigrateToChat,
                            ):
                                current = await self._repository.get_room_with_group_for_update(
                                    session, room_id
                                )
                                if (
                                    current is not None
                                    and current.telegram_message_id == replaced_id
                                ):
                                    current.telegram_replacement_blocked = False
                                await session.commit()
                                raise
                            await self._repository.set_telegram_message_id(
                                session, room, sent.message_id
                            )
                            signature = (
                                room.telegram_message_id,
                                room.name,
                                presence.participant_names,
                            )
                    await session.commit()
                    self._last_delivered[room_id] = signature
            await sync_room_card_pins(
                self._bot,
                self._session_factory,
                self._repository,
                room_id,
                notify_failure=self._notify_pin_failure,
            )


class NullRoomNotifier:
    async def update(self, room_id: int) -> None:
        del room_id


async def save_message_id(
    repository: RoomRepository,
    session: AsyncSession,
    room: VoiceRoom,
    message_id: int,
) -> None:
    await repository.set_telegram_message_id(session, room, message_id)
    await session.commit()
