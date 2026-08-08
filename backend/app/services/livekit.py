from dataclasses import dataclass
from datetime import timedelta
from typing import Protocol

from livekit import api


class LiveKitTokenIssuer(Protocol):
    def generate_livekit_token(
        self, *, room_name: str, identity: str, display_name: str
    ) -> str: ...


class LiveKitTokenService:
    def __init__(self, api_key: str, api_secret: str, ttl_seconds: int = 900) -> None:
        self._api_key = api_key
        self._api_secret = api_secret
        self._ttl = timedelta(seconds=ttl_seconds)

    def generate_livekit_token(self, *, room_name: str, identity: str, display_name: str) -> str:
        return (
            api.AccessToken(self._api_key, self._api_secret)
            .with_identity(identity)
            .with_name(display_name)
            .with_ttl(self._ttl)
            .with_grants(
                api.VideoGrants(
                    room_join=True,
                    room=room_name,
                    can_publish=True,
                    can_subscribe=True,
                    can_publish_data=False,
                )
            )
            .to_jwt()
        )


@dataclass(frozen=True, slots=True)
class LiveKitPresenceEvent:
    event: str
    room_name: str
    identity: str
    display_name: str


class LiveKitWebhookParser(Protocol):
    def parse(self, raw_body: str, authorization: str) -> LiveKitPresenceEvent | None: ...


class LiveKitWebhookService:
    def __init__(self, api_key: str, api_secret: str) -> None:
        verifier = api.TokenVerifier(api_key, api_secret)
        self._receiver = api.WebhookReceiver(verifier)

    def parse(self, raw_body: str, authorization: str) -> LiveKitPresenceEvent | None:
        event = self._receiver.receive(raw_body, authorization)
        if event.event not in {"participant_joined", "participant_left"}:
            return None
        if event.room is None or event.participant is None:
            return None
        return LiveKitPresenceEvent(
            event=event.event,
            room_name=event.room.name,
            identity=event.participant.identity,
            display_name=event.participant.name or event.participant.identity,
        )
