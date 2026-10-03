import logging

from aiogram import Bot
from aiogram.exceptions import TelegramBadRequest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.bot.pinning import pin_room_card
from app.bot.presentation import join_keyboard, room_message
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
    ) -> None:
        self._bot = bot
        self._session_factory = session_factory
        self._repository = repository
        self._join_tokens = join_tokens
        self._frontend_public_url = frontend_public_url.rstrip("/")

    async def update(self, room_id: int) -> None:
        async with self._session_factory() as session:
            room = await self._repository.get_room_with_group(session, room_id)
            if room is None or room.telegram_message_id is None:
                return
            presence = await self._repository.presence(session, room)
            token = self._join_tokens.create_join_token(room.id, room.group.telegram_chat_id)
            text = room_message(room.name, presence.online_count, presence.participant_names)
            markup = join_keyboard(f"{self._frontend_public_url}/join/{token}")
            try:
                await self._bot.edit_message_text(
                    chat_id=room.group.telegram_chat_id,
                    message_id=room.telegram_message_id,
                    text=text,
                    reply_markup=markup,
                )
            except TelegramBadRequest as exc:
                if "message is not modified" in str(exc).lower():
                    return
                logger.warning("Room message could not be edited; creating a replacement")
                sent = await self._bot.send_message(
                    chat_id=room.group.telegram_chat_id,
                    message_thread_id=room.telegram_thread_id or None,
                    text=text,
                    reply_markup=markup,
                )
                await self._repository.set_telegram_message_id(session, room, sent.message_id)
                await session.commit()
            else:
                return
            await pin_room_card(
                self._bot,
                chat_id=room.group.telegram_chat_id,
                message_id=sent.message_id,
                thread_id=room.telegram_thread_id or None,
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
