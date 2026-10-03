from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator

DisplayName = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=32)]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class JoinRequest(StrictModel):
    join_token: str = Field(min_length=1, max_length=4096)
    display_name: DisplayName

    @field_validator("display_name")
    @classmethod
    def reject_control_characters(cls, value: str) -> str:
        if any(ord(character) < 32 for character in value):
            raise ValueError("display_name must not contain control characters")
        return value


class RoomsRequest(StrictModel):
    join_token: str = Field(min_length=1, max_length=4096)


class InviteRequest(RoomsRequest):
    room_id: int = Field(gt=0, le=2**63 - 1, strict=True)


class RoomInfo(StrictModel):
    id: int = Field(gt=0, strict=True)
    name: str


class ParticipantInfo(StrictModel):
    identity: str
    display_name: str


class JoinResponse(StrictModel):
    livekit_url: str
    access_token: str
    room: RoomInfo
    participant: ParticipantInfo


class RoomResponse(RoomInfo):
    online_count: int = Field(ge=0, strict=True)


class RoomsResponse(StrictModel):
    current_room_id: int = Field(gt=0, strict=True)
    rooms: list[RoomResponse]


class InviteResponse(StrictModel):
    join_token: str = Field(min_length=1)
    join_url: str = Field(min_length=1)
    room: RoomInfo
    expires_in: int = Field(gt=0, strict=True)


class HealthResponse(StrictModel):
    status: str
