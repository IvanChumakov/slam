import logging
from typing import Protocol

from fastapi import APIRouter, Header, HTTPException, Request, Response, status
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

from app.api.dependencies import SessionDependency
from app.schemas.voice import (
    HealthResponse,
    JoinRequest,
    JoinResponse,
    ParticipantInfo,
    RoomInfo,
    RoomResponse,
)
from app.services.tokens import InvalidJoinToken
from app.services.voice import RoomNotFound

logger = logging.getLogger(__name__)


class RoomNotifier(Protocol):
    async def update(self, room_id: int) -> None: ...


router = APIRouter()


@router.get("/health", response_model=HealthResponse, tags=["system"])
async def health() -> HealthResponse:
    return HealthResponse(status="ok")


@router.get(
    "/ready",
    response_model=HealthResponse,
    responses={503: {"description": "Database is unavailable"}},
    tags=["system"],
)
async def readiness(session: SessionDependency) -> HealthResponse:
    try:
        await session.execute(text("select 1"))
    except SQLAlchemyError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Database is unavailable",
        ) from exc
    return HealthResponse(status="ok")


@router.post(
    "/api/voice/join",
    response_model=JoinResponse,
    responses={
        401: {"description": "Invalid or expired invite"},
        404: {"description": "Room not found"},
    },
    tags=["voice"],
)
async def join_voice(
    payload: JoinRequest, request: Request, session: SessionDependency
) -> JoinResponse:
    try:
        result = await request.app.state.voice_service.join(
            session,
            join_token=payload.join_token,
            display_name=payload.display_name,
        )
    except InvalidJoinToken as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired invite"
        ) from exc
    except RoomNotFound as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Room not found") from exc
    return JoinResponse(
        livekit_url=result.livekit_url,
        access_token=result.access_token,
        room=RoomInfo(id=result.room.id, name=result.room.name),
        participant=ParticipantInfo(identity=result.identity, display_name=result.display_name),
    )


@router.get(
    "/api/rooms/{room_id}",
    response_model=RoomResponse,
    responses={404: {"description": "Room not found"}},
    tags=["voice"],
)
async def room(room_id: int, request: Request, session: SessionDependency) -> RoomResponse:
    voice_room = await request.app.state.room_repository.get_room(session, room_id)
    if voice_room is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Room not found")
    online_count = await request.app.state.room_repository.online_count(session, room_id)
    return RoomResponse(id=voice_room.id, name=voice_room.name, online_count=online_count)


@router.post(
    "/api/livekit/webhook",
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=Response,
    tags=["integrations"],
)
async def livekit_webhook(
    request: Request,
    session: SessionDependency,
    authorization: str | None = Header(default=None),
) -> Response:
    if not authorization:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid webhook")
    content_length = request.headers.get("content-length")
    if content_length:
        try:
            declared_size = int(content_length)
        except ValueError:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST) from None
        if declared_size > 65_536:
            raise HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE)
    raw_body = await request.body()
    if len(raw_body) > 65_536:
        raise HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE)
    try:
        event = request.app.state.livekit_webhooks.parse(raw_body.decode("utf-8"), authorization)
    except Exception as exc:
        logger.warning("Rejected an invalid LiveKit webhook: %s", type(exc).__name__)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid webhook"
        ) from None
    if event is None:
        return Response(status_code=status.HTTP_204_NO_CONTENT)
    voice_room = await request.app.state.room_repository.get_room_by_livekit_name(
        session, event.room_name
    )
    if voice_room is None:
        return Response(status_code=status.HTTP_204_NO_CONTENT)
    if event.event == "participant_joined":
        await request.app.state.room_repository.participant_joined(
            session,
            room_id=voice_room.id,
            identity=event.identity,
            display_name=event.display_name,
        )
    elif event.event == "participant_left":
        await request.app.state.room_repository.participant_left(
            session, room_id=voice_room.id, identity=event.identity
        )
    await session.commit()
    await request.app.state.room_notifier.update(voice_room.id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
