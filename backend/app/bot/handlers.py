from aiogram import Bot, F, Router
from aiogram.enums import ChatType
from aiogram.filters import Command, CommandStart
from aiogram.types import CallbackQuery, Message
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.bot.notifier import TelegramRoomNotifier
from app.bot.pinning import sync_room_card_pins
from app.bot.presentation import room_keyboard, room_message
from app.db.repositories import RoomRepository
from app.services.tokens import JoinTokenService
from app.services.voice import VoiceService


async def start_handler(message: Message) -> None:
    await message.answer(
        "Добавьте бота в Telegram-группу. В нужном топике выберите /voice "
        "в меню команд у поля ввода. Бот пришлёт кнопку входа в голосовую комнату."
    )


async def topic_handler(
    message: Message,
    bot: Bot,
    session_factory: async_sessionmaker[AsyncSession],
    room_repository: RoomRepository,
    join_tokens: JoinTokenService,
    frontend_public_url: str,
) -> None:
    event = message.forum_topic_created or message.forum_topic_edited
    if event is None or not event.name:
        return
    thread_id = message.message_thread_id or (
        message.message_id if message.forum_topic_created else 0
    )
    async with session_factory() as session:
        room_id = await room_repository.remember_topic_name(
            session,
            telegram_chat_id=message.chat.id,
            telegram_thread_id=thread_id,
            name=event.name,
        )
        await session.commit()
    if room_id is not None:
        notifier = TelegramRoomNotifier(
            bot, session_factory, room_repository, join_tokens, frontend_public_url
        )
        await notifier.update(room_id)


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
        # A topic starter may be attached as the replied-to message, including for old topics.
        reply = getattr(message, "reply_to_message", None)
        created = getattr(reply, "forum_topic_created", None)
        if (
            created
            and reply.chat.id == message.chat.id
            and (
                reply.message_id == message.message_thread_id
                or reply.message_thread_id == message.message_thread_id
            )
        ):
            await room_repository.remember_topic_name(
                session,
                telegram_chat_id=message.chat.id,
                telegram_thread_id=message.message_thread_id or 0,
                name=created.name,
                overwrite=False,
            )
        room = await voice_service.ensure_general_room(
            session,
            telegram_chat_id=message.chat.id,
            title=message.chat.title or "Telegram group",
            telegram_thread_id=message.message_thread_id or 0,
        )
        await session.commit()
        room = await room_repository.get_room_with_group(session, room.id)
        if room is None:  # pragma: no cover - database invariant guard
            raise RuntimeError("created room disappeared")
        presence = await voice_service.presence(session, room)
        token = join_tokens.create_join_token(room.id, room.group.telegram_chat_id)
        text = room_message(room.name, presence.online_count, presence.participant_names)
        markup = await room_keyboard(bot, frontend_public_url, token)

        sent = await bot.send_message(
            chat_id=message.chat.id,
            text=text,
            reply_markup=markup,
            message_thread_id=message.message_thread_id,
        )
        await room_repository.set_telegram_message_id(session, room, sent.message_id)
        room_id = room.id
        await session.commit()
    await sync_room_card_pins(bot, session_factory, room_repository, room_id)


async def voice_button_handler(
    query: CallbackQuery,
    bot: Bot,
    session_factory: async_sessionmaker[AsyncSession],
    voice_service: VoiceService,
    room_repository: RoomRepository,
    join_tokens: JoinTokenService,
    frontend_public_url: str,
) -> None:
    message = query.message
    if not isinstance(message, Message) or message.chat.type not in (
        ChatType.GROUP,
        ChatType.SUPERGROUP,
    ):
        await query.answer("Откройте сообщение комнаты в группе.")
        return
    await query.answer()
    await voice_handler(
        message=message,
        bot=bot,
        session_factory=session_factory,
        voice_service=voice_service,
        room_repository=room_repository,
        join_tokens=join_tokens,
        frontend_public_url=frontend_public_url,
    )


def create_router() -> Router:
    router = Router(name="telegram-voice")
    router.callback_query.register(voice_button_handler, F.data == "voice:link")
    router.message.register(
        topic_handler,
        F.forum_topic_created | F.forum_topic_edited,
        F.chat.type.in_({ChatType.GROUP, ChatType.SUPERGROUP}),
    )
    router.message.register(start_handler, CommandStart(), F.chat.type == ChatType.PRIVATE)
    router.message.register(
        voice_handler,
        Command("voice"),
        F.chat.type.in_({ChatType.GROUP, ChatType.SUPERGROUP}),
    )

    return router
