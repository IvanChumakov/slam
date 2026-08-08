from aiogram import Bot, F, Router
from aiogram.enums import ChatType
from aiogram.exceptions import TelegramBadRequest
from aiogram.filters import Command, CommandStart
from aiogram.types import Message
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.bot.presentation import join_keyboard, room_message
from app.db.repositories import RoomRepository
from app.services.tokens import JoinTokenService
from app.services.voice import VoiceService


async def start_handler(message: Message) -> None:
    await message.answer("Добавьте бота в Telegram-группу и выполните /voice.")


async def voice_handler(
    message: Message,
    bot: Bot,
    session_factory: async_sessionmaker[AsyncSession],
    voice_service: VoiceService,
    room_repository: RoomRepository,
    join_tokens: JoinTokenService,
    frontend_public_url: str,
) -> None:
    async with session_factory() as session:
        room = await voice_service.ensure_general_room(
            session,
            telegram_chat_id=message.chat.id,
            title=message.chat.title or "Telegram group",
        )
        await session.commit()
        room = await room_repository.get_room_with_group(session, room.id)
        if room is None:  # pragma: no cover - database invariant guard
            raise RuntimeError("created room disappeared")
        presence = await room_repository.presence(session, room)
        token = join_tokens.create_join_token(room.id, room.group.telegram_chat_id)
        url = f"{frontend_public_url.rstrip('/')}/join/{token}"
        text = room_message(room.name, presence.online_count, presence.participant_names)
        markup = join_keyboard(url)

        if room.telegram_message_id is not None:
            try:
                await bot.edit_message_text(
                    chat_id=message.chat.id,
                    message_id=room.telegram_message_id,
                    text=text,
                    reply_markup=markup,
                )
                return
            except TelegramBadRequest as exc:
                if "message is not modified" in str(exc).lower():
                    return

        sent = await message.answer(text, reply_markup=markup)
        await room_repository.set_telegram_message_id(session, room, sent.message_id)
        await session.commit()


def create_router() -> Router:
    router = Router(name="telegram-voice")
    router.message.register(start_handler, CommandStart(), F.chat.type == ChatType.PRIVATE)
    router.message.register(
        voice_handler,
        Command("voice"),
        F.chat.type.in_({ChatType.GROUP, ChatType.SUPERGROUP}),
    )

    return router
