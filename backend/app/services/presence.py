import asyncio
import logging
from dataclasses import dataclass
from typing import Protocol

from aiogram.exceptions import TelegramRetryAfter
from aiohttp import ClientTimeout
from livekit import api
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.db.repositories import RoomRepository
from app.models import VoiceRoom

logger = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class ConnectedParticipant:
    identity: str
    display_name: str


class PresenceUnavailable(RuntimeError):
    pass


class LiveKitPresenceReader(Protocol):
    async def snapshot(self, room_name: str) -> tuple[ConnectedParticipant, ...]: ...
    async def aclose(self) -> None: ...


class RoomNotifier(Protocol):
    async def update(self, room_id: int) -> None: ...


class LiveKitPresenceSource:
    def __init__(self, url: str, api_key: str, api_secret: str) -> None:
        self._url = url
        self._api_key = api_key
        self._api_secret = api_secret
        self._client: api.LiveKitAPI | None = None

    async def snapshot(self, room_name: str) -> tuple[ConnectedParticipant, ...]:
        if self._client is None:
            self._client = api.LiveKitAPI(
                url=self._url,
                api_key=self._api_key,
                api_secret=self._api_secret,
                timeout=ClientTimeout(total=5),
            )
        try:
            response = await self._client.room.list_participants(
                api.ListParticipantsRequest(room=room_name)
            )
        except api.TwirpError as exc:
            if exc.code == "not_found":
                return ()
            raise PresenceUnavailable("LiveKit participant count is unavailable") from None
        except Exception as exc:
            logger.warning("LiveKit presence request failed: error_class=%s", type(exc).__name__)
            raise PresenceUnavailable("LiveKit participant count is unavailable") from None
        return tuple(
            ConnectedParticipant(participant.identity, participant.name or participant.identity)
            for participant in response.participants
            if participant.state == api.ParticipantInfo.ACTIVE
            and participant.kind == api.ParticipantInfo.STANDARD
            and not participant.permission.hidden
        )

    async def aclose(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None


class PresenceSynchronizer:
    def __init__(
        self,
        source: LiveKitPresenceReader,
        session_factory: async_sessionmaker[AsyncSession],
        repository: RoomRepository,
        notifier: RoomNotifier,
        interval: float = 5,
    ) -> None:
        self._source = source
        self._session_factory = session_factory
        self._repository = repository
        self._notifier = notifier
        self._interval = interval
        self._locks: dict[int, asyncio.Lock] = {}
        self._wake = asyncio.Event()
        self._requested: set[int] = set()
        self._notification_dirty: set[int] = set()
        self._updates: dict[int, asyncio.Task[None]] = {}
        self._task: asyncio.Task[None] | None = None

    def start(self) -> None:
        if self._task is None:
            self._task = asyncio.create_task(self._run(), name="livekit-presence")

    def request_refresh(self, room_id: int) -> None:
        self._requested.add(room_id)
        self._wake.set()

    async def refresh(self, room_id: int) -> None:
        async with self._locks.setdefault(room_id, asyncio.Lock()):
            async with self._session_factory() as session:
                room = await self._repository.get_room(session, room_id)
                if room is None:
                    return
                participants = await self._source.snapshot(room.livekit_room_name)
                await self._repository.sync_participants(
                    session,
                    room_id=room_id,
                    participants={
                        participant.identity: participant.display_name
                        for participant in participants
                    },
                )
                await session.commit()
            if self._task is not None:
                self._notification_dirty.add(room_id)
                if room_id not in self._updates:
                    self._updates[room_id] = asyncio.create_task(
                        self._deliver(room_id), name=f"telegram-room-{room_id}"
                    )

    async def _deliver(self, room_id: int) -> None:
        try:
            while True:
                self._notification_dirty.discard(room_id)
                try:
                    await self._notifier.update(room_id)
                except Exception as exc:
                    delay = max(5, exc.retry_after) if isinstance(exc, TelegramRetryAfter) else 5
                    logger.warning(
                        "Room card update deferred: room_id=%s error_class=%s",
                        room_id,
                        type(exc).__name__,
                    )
                    await asyncio.sleep(delay)
                    continue
                if room_id not in self._notification_dirty:
                    break
        finally:
            self._updates.pop(room_id, None)

    async def _run(self) -> None:
        next_sweep = 0.0
        while True:
            self._wake.clear()
            requested, self._requested = self._requested, set()
            try:
                now = asyncio.get_running_loop().time()
                if now >= next_sweep:
                    async with self._session_factory() as session:
                        requested.update(await session.scalars(select(VoiceRoom.id)))
                    next_sweep = now + self._interval
                for room_id in requested:
                    try:
                        await self.refresh(room_id)
                    except Exception as exc:
                        logger.warning(
                            "Room presence refresh failed: room_id=%s error_class=%s",
                            room_id,
                            type(exc).__name__,
                        )
            except Exception as exc:
                logger.warning("Presence sweep failed: error_class=%s", type(exc).__name__)
            try:
                async with asyncio.timeout(
                    max(0.01, next_sweep - asyncio.get_running_loop().time())
                ):
                    await self._wake.wait()
            except TimeoutError:
                pass

    async def stop(self) -> None:
        tasks = list(self._updates.values())
        if self._task is not None:
            tasks.append(self._task)
        self._task = None
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        self._updates.clear()
        self._notification_dirty.clear()
