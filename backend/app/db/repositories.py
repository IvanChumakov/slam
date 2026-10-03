from dataclasses import dataclass

from sqlalchemy import delete, func, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models import RoomParticipant, TelegramGroup, TelegramTopic, VoiceRoom


@dataclass(frozen=True, slots=True)
class RoomPresence:
    room: VoiceRoom
    online_count: int
    participant_names: tuple[str, ...]


class RoomRepository:
    async def ensure_general_room(
        self,
        session: AsyncSession,
        *,
        telegram_chat_id: int,
        title: str,
        telegram_thread_id: int = 0,
    ) -> VoiceRoom:
        group = await self._upsert_group(session, telegram_chat_id=telegram_chat_id, title=title)
        topic = await session.get(TelegramTopic, (telegram_chat_id, telegram_thread_id))
        name = topic.name if topic else ("Голосовая комната" if telegram_thread_id else "General")
        room_query = select(VoiceRoom).where(
            VoiceRoom.group_id == group.id,
            VoiceRoom.telegram_thread_id == telegram_thread_id,
        )
        room = await session.scalar(room_query)
        if room is None:
            statement = self._insert_for(session, VoiceRoom).values(
                group_id=group.id,
                telegram_thread_id=telegram_thread_id,
                name=name,
                livekit_room_name=(
                    f"telegram_{abs(telegram_chat_id)}_topic_{telegram_thread_id}"
                    if telegram_thread_id
                    else f"telegram_{abs(telegram_chat_id)}_general"
                ),
            )
            statement = statement.on_conflict_do_nothing(
                index_elements=["group_id", "telegram_thread_id"]
            )
            await session.execute(statement)
            await session.flush()
            room = await session.scalar(room_query)
        if room is None:  # pragma: no cover - database invariant guard
            raise RuntimeError("failed to create the General voice room")
        room.name = name
        return room

    async def remember_topic_name(
        self,
        session: AsyncSession,
        *,
        telegram_chat_id: int,
        telegram_thread_id: int,
        name: str,
        overwrite: bool = True,
    ) -> int | None:
        statement = self._insert_for(session, TelegramTopic).values(
            telegram_chat_id=telegram_chat_id,
            telegram_thread_id=telegram_thread_id,
            name=name,
        )
        keys = ["telegram_chat_id", "telegram_thread_id"]
        statement = (
            statement.on_conflict_do_update(index_elements=keys, set_={"name": name})
            if overwrite
            else statement.on_conflict_do_nothing(index_elements=keys)
        )
        await session.execute(statement)
        current_name = await session.scalar(
            select(TelegramTopic.name).where(
                TelegramTopic.telegram_chat_id == telegram_chat_id,
                TelegramTopic.telegram_thread_id == telegram_thread_id,
            )
        )
        room_id = await session.scalar(
            select(VoiceRoom.id)
            .join(TelegramGroup)
            .where(
                TelegramGroup.telegram_chat_id == telegram_chat_id,
                VoiceRoom.telegram_thread_id == telegram_thread_id,
            )
        )
        if room_id is not None:
            await session.execute(
                update(VoiceRoom).where(VoiceRoom.id == room_id).values(name=current_name)
            )
        return room_id

    async def _upsert_group(
        self, session: AsyncSession, *, telegram_chat_id: int, title: str
    ) -> TelegramGroup:
        statement = self._insert_for(session, TelegramGroup).values(
            telegram_chat_id=telegram_chat_id,
            title=title,
        )
        statement = statement.on_conflict_do_update(
            index_elements=["telegram_chat_id"], set_={"title": title}
        )
        await session.execute(statement)
        await session.flush()
        group = await session.scalar(
            select(TelegramGroup).where(TelegramGroup.telegram_chat_id == telegram_chat_id)
        )
        if group is None:  # pragma: no cover - database invariant guard
            raise RuntimeError("failed to create the Telegram group")
        return group

    @staticmethod
    def _insert_for(
        session: AsyncSession, model: type[TelegramGroup] | type[VoiceRoom] | type[TelegramTopic]
    ):
        if session.bind is not None and session.bind.dialect.name == "sqlite":
            return sqlite_insert(model)
        return pg_insert(model)

    async def get_room(self, session: AsyncSession, room_id: int) -> VoiceRoom | None:
        return await session.get(VoiceRoom, room_id)

    async def get_room_with_group(self, session: AsyncSession, room_id: int) -> VoiceRoom | None:
        return await session.scalar(
            select(VoiceRoom).options(selectinload(VoiceRoom.group)).where(VoiceRoom.id == room_id)
        )

    async def get_room_in_group(
        self, session: AsyncSession, *, room_id: int, group_id: int
    ) -> VoiceRoom | None:
        return await session.scalar(
            select(VoiceRoom).where(VoiceRoom.id == room_id, VoiceRoom.group_id == group_id)
        )

    async def list_rooms_with_counts(
        self, session: AsyncSession, group_id: int
    ) -> list[tuple[VoiceRoom, int]]:
        rows = await session.execute(
            select(VoiceRoom, func.count(RoomParticipant.id))
            .outerjoin(RoomParticipant, RoomParticipant.room_id == VoiceRoom.id)
            .where(VoiceRoom.group_id == group_id)
            .group_by(VoiceRoom.id)
            .order_by(
                (VoiceRoom.telegram_thread_id == 0).desc(),
                VoiceRoom.telegram_thread_id,
                VoiceRoom.id,
            )
        )
        return [(room, int(count)) for room, count in rows]

    async def get_room_by_livekit_name(
        self, session: AsyncSession, livekit_room_name: str
    ) -> VoiceRoom | None:
        return await session.scalar(
            select(VoiceRoom)
            .options(selectinload(VoiceRoom.group))
            .where(VoiceRoom.livekit_room_name == livekit_room_name)
        )

    async def set_telegram_message_id(
        self, session: AsyncSession, room: VoiceRoom, message_id: int
    ) -> None:
        room.telegram_message_id = message_id
        await session.flush()

    async def presence(self, session: AsyncSession, room: VoiceRoom) -> RoomPresence:
        names = tuple(
            (
                await session.scalars(
                    select(RoomParticipant.display_name)
                    .where(RoomParticipant.room_id == room.id)
                    .order_by(RoomParticipant.joined_at, RoomParticipant.id)
                )
            ).all()
        )
        return RoomPresence(room=room, online_count=len(names), participant_names=names)

    async def online_count(self, session: AsyncSession, room_id: int) -> int:
        return int(
            await session.scalar(
                select(func.count(RoomParticipant.id)).where(RoomParticipant.room_id == room_id)
            )
            or 0
        )

    async def participant_joined(
        self,
        session: AsyncSession,
        *,
        room_id: int,
        identity: str,
        display_name: str,
    ) -> None:
        statement = self._participant_insert_for(session).values(
            room_id=room_id,
            identity=identity,
            display_name=display_name,
        )
        statement = statement.on_conflict_do_update(
            index_elements=["room_id", "identity"],
            set_={"display_name": display_name, "joined_at": func.now()},
        )
        await session.execute(statement)

    @staticmethod
    def _participant_insert_for(session: AsyncSession):
        if session.bind is not None and session.bind.dialect.name == "sqlite":
            return sqlite_insert(RoomParticipant)
        return pg_insert(RoomParticipant)

    async def participant_left(self, session: AsyncSession, *, room_id: int, identity: str) -> None:
        await session.execute(
            delete(RoomParticipant).where(
                RoomParticipant.room_id == room_id,
                RoomParticipant.identity == identity,
            )
        )
