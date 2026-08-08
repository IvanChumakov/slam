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


class RoomInfo(StrictModel):
    id: int
    name: str


class ParticipantInfo(StrictModel):
    identity: str
    display_name: str


class JoinResponse(StrictModel):
    livekit_url: str
    access_token: str
    room: RoomInfo
    participant: ParticipantInfo


class RoomResponse(StrictModel):
    id: int
    name: str
    online_count: int


class HealthResponse(StrictModel):
    status: str
