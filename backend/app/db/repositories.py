from dataclasses import dataclass

from sqlalchemy import delete, func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models import RoomParticipant, TelegramGroup, VoiceRoom


@dataclass(frozen=True, slots=True)
class RoomPresence:
    room: VoiceRoom
    online_count: int
    participant_names: tuple[str, ...]


class RoomRepository:
    async def ensure_general_room(
        self, session: AsyncSession, *, telegram_chat_id: int, title: str
    ) -> VoiceRoom:
        group = await self._upsert_group(session, telegram_chat_id=telegram_chat_id, title=title)
        room = await session.scalar(select(VoiceRoom).where(VoiceRoom.group_id == group.id))
        if room is None:
            statement = self._insert_for(session, VoiceRoom).values(
                group_id=group.id,
                name="General",
                livekit_room_name=f"telegram_{abs(telegram_chat_id)}_general",
            )
            statement = statement.on_conflict_do_nothing(index_elements=["group_id"])
            await session.execute(statement)
            await session.flush()
            room = await session.scalar(select(VoiceRoom).where(VoiceRoom.group_id == group.id))
        if room is None:  # pragma: no cover - database invariant guard
            raise RuntimeError("failed to create the General voice room")
        return room

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
    def _insert_for(session: AsyncSession, model: type[TelegramGroup] | type[VoiceRoom]):
        if session.bind is not None and session.bind.dialect.name == "sqlite":
            return sqlite_insert(model)
        return pg_insert(model)

    async def get_room(self, session: AsyncSession, room_id: int) -> VoiceRoom | None:
        return await session.get(VoiceRoom, room_id)

    async def get_room_with_group(self, session: AsyncSession, room_id: int) -> VoiceRoom | None:
        return await session.scalar(
            select(VoiceRoom).options(selectinload(VoiceRoom.group)).where(VoiceRoom.id == room_id)
        )

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
