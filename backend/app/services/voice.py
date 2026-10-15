from dataclasses import dataclass
from uuid import uuid4

from sqlalchemy.ext.asyncio import AsyncSession

from app.db.repositories import RoomPresence, RoomRepository
from app.models import VoiceRoom
from app.services.livekit import LiveKitTokenIssuer
from app.services.presence import ConnectedParticipant, LiveKitPresenceReader
from app.services.telegram import TelegramProfileVerifier
from app.services.tokens import InvalidJoinToken, JoinTokenService


class RoomNotFound(LookupError):
    """Raised when a referenced voice room does not exist."""


@dataclass(frozen=True, slots=True)
class JoinResult:
    room: VoiceRoom
    livekit_url: str
    access_token: str
    identity: str
    display_name: str


@dataclass(frozen=True, slots=True)
class RoomRoster:
    room: VoiceRoom
    participants: tuple[ConnectedParticipant, ...]


class VoiceService:
    def __init__(
        self,
        repository: RoomRepository,
        join_tokens: JoinTokenService,
        livekit_tokens: LiveKitTokenIssuer,
        livekit_url: str,
        livekit_presence: LiveKitPresenceReader,
        telegram_profiles: TelegramProfileVerifier,
    ) -> None:
        self.repository = repository
        self.join_tokens = join_tokens
        self.livekit_tokens = livekit_tokens
        self.livekit_url = livekit_url
        self.livekit_presence = livekit_presence
        self.telegram_profiles = telegram_profiles

    async def presence(self, session: AsyncSession, room: VoiceRoom) -> RoomPresence:
        participants = await self.livekit_presence.snapshot(room.livekit_room_name)
        return RoomPresence(
            room, len(participants), tuple(participant.display_name for participant in participants)
        )

    async def ensure_general_room(
        self,
        session: AsyncSession,
        *,
        telegram_chat_id: int,
        title: str,
        telegram_thread_id: int = 0,
    ) -> VoiceRoom:
        return await self.repository.ensure_general_room(
            session,
            telegram_chat_id=telegram_chat_id,
            title=title,
            telegram_thread_id=telegram_thread_id,
        )

    async def join(
        self,
        session: AsyncSession,
        *,
        join_token: str,
        display_name: str,
        telegram_init_data: str | None = None,
    ) -> JoinResult:
        room = await self._validate_source_room(session, join_token)
        avatar_url = (
            self.telegram_profiles.verify(telegram_init_data).avatar_url
            if telegram_init_data is not None
            else None
        )
        identity = f"guest_{uuid4().hex}"
        access_token = self.livekit_tokens.generate_livekit_token(
            room_name=room.livekit_room_name,
            identity=identity,
            display_name=display_name,
            avatar_url=avatar_url,
        )
        return JoinResult(
            room=room,
            livekit_url=self.livekit_url,
            access_token=access_token,
            identity=identity,
            display_name=display_name,
        )

    async def _validate_source_room(self, session: AsyncSession, join_token: str) -> VoiceRoom:
        claims = self.join_tokens.verify_join_token(join_token)
        room = await self.repository.get_room_with_group(session, claims.room_id)
        if room is None or room.group.telegram_chat_id != claims.telegram_chat_id:
            raise RoomNotFound("voice room not found")
        return room

    async def list_rooms(
        self, session: AsyncSession, *, join_token: str
    ) -> tuple[int, list[RoomRoster]]:
        source = await self._validate_source_room(session, join_token)
        rooms = await self.repository.list_rooms_with_counts(session, source.group_id)
        return source.id, [
            RoomRoster(room, await self.livekit_presence.snapshot(room.livekit_room_name))
            for room, _ in rooms
        ]

    async def create_invite(
        self, session: AsyncSession, *, join_token: str, room_id: int
    ) -> tuple[VoiceRoom, str]:
        source = await self._validate_source_room(session, join_token)
        target = await self.repository.get_room_in_group(
            session, room_id=room_id, group_id=source.group_id
        )
        if target is None:
            raise RoomNotFound("voice room not found")
        token = self.join_tokens.create_join_token(target.id, source.group.telegram_chat_id)
        return target, token


__all__ = ["InvalidJoinToken", "JoinResult", "RoomNotFound", "VoiceService"]
