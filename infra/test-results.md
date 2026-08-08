# Voice infrastructure test results

До проведения реальных тестов строки имеют статус `NOT RUN`.

## Environment

| Field | Value |
|---|---|
| LiveKit image | `livekit/livekit-server:v1.13.1` |
| Local signaling URL | `ws://localhost:7880` |
| Test room | `test-room` |
| VPN | No |

## Automated and configuration checks

| Check | Status | Notes |
|---|---|---|
| `docker compose config` | PASS | Parsed by Docker Compose v5.3.1 |
| LiveKit container starts | PASS | LiveKit Server 1.13.1 |
| HTTP/signaling port 7880 is reachable | PASS | `GET /` returned `200 OK` |
| RoomService API | PASS | Authenticated `ListRooms` completed successfully |
| Test JWT generation | PASS | Separate valid JWTs created for `user-a` and `user-b` |
| Restart returns service to working state | PASS | Container restarted and endpoint returned to service |

## Two-participant audio test

| Check | Status | Notes |
|---|---|---|
| User A connects | PASS | User-confirmed browser test; identity: `user-a` |
| User B connects | PASS | User-confirmed browser test; identity: `user-b` |
| A hears B | PASS | User confirmed that audio is present |
| B hears A | PASS | User confirmed that audio is present |
| Mute/unmute A | PASS | User confirmed local microphone mute and unmute |
| Mute/unmute B | NOT RUN | |
| Participant disconnect | PASS | Webhook recorded `CLIENT_INITIATED` after Leave |
| Reconnect | PASS | Refresh created a new participant SID for `user-a` without identity conflict |

LiveKit Meet is an infrastructure test client, not the project frontend. After Leave it displays `Disconnected` and does not provide the product-specific `Join Again` screen. Refresh reconnects while the one-hour test JWT remains valid. The final Leave/Join Again interface belongs to Developer C.

## Webhook test

| Event | Status | Notes |
|---|---|---|
| `room_started` | PASS | Received by local test receiver |
| `participant_joined` | PASS | Received for identity `webhook-probe` |
| `participant_left` | PASS | Received after probe disconnect |
| `room_finished` | PASS | Received after the room closed |

All received events used `Content-Type: application/webhook+json` and included an `Authorization` header.

## Device and network matrix

Add one row for every manual run.

| Date | Device / OS | Browser | Network / ISP | VPN | Connect time | A -> B | B -> A | Reconnect | Transport | Result / notes |
|---|---|---|---|---|---|---|---|---|---|---|
| 2026-08-08 | Windows | Browser not recorded | Local development | No | Not recorded | PASS | PASS | PASS | Not recorded | Audio, local mute/unmute, Leave and refresh reconnect confirmed |
