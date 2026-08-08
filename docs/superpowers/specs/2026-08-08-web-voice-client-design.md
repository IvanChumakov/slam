# Web Voice Client Design

## Goal

Build the MVP web client described in `telegram_voice_team_spec.md`, limited to
the `frontend/` workspace. A user opens `/join/:token`, enters a display name,
joins the matching LiveKit room, talks to other participants, controls their
microphone, and leaves cleanly.

## Scope and ownership

All application code, tests, tooling, and frontend documentation live under
`frontend/`. The implementation does not modify `/backend`, `/infra`, or the
shared `POST /api/voice/join` contract. It does not add video, screen sharing,
chat, authentication, registration, recording, multiple channels, or Telegram
Mini App behavior.

The frontend may consume later shared-contract changes only after inspecting
incoming commits. Such changes must remain isolated in the API or LiveKit
adapter rather than spreading backend assumptions through UI components.

## Technology

- React and TypeScript built with Vite.
- `react-router-dom` for `/join/:token` routing.
- `livekit-client` for the voice connection and media tracks.
- Vitest, React Testing Library, and jsdom for automated tests.
- ESLint for static checks.
- Plain responsive CSS with no component framework or global state manager.

## Architecture

The application uses three boundaries:

1. `api/voiceApi.ts` implements the fixed join request and response contract.
   It selects either the HTTP implementation or a production-shaped mock from
   environment configuration.
2. `voice/LiveKitVoiceClient.ts` wraps LiveKit SDK operations and events behind
   a small interface. React code does not depend on SDK objects directly.
3. `voice/useVoiceRoom.ts` owns the room state machine and exposes state and
   commands to presentation components.

`App.tsx` extracts the token from the route and renders the appropriate screen.
The UI is split into focused components for joining, room controls,
participants, connection status, errors, and the post-leave state.

## State model

The client has explicit phases: `idle`, `requestingCredentials`, `connecting`,
`requestingMicrophone`, `connected`, `reconnecting`, `left`, and `error`.
Only one join attempt may be active. Join controls are disabled while a request
or connection attempt is in progress.

Participant state is derived from LiveKit, including the local participant.
Each rendered participant contains a stable identity, display name, local flag,
and microphone state. LiveKit remains authoritative; UI state is refreshed on
participant, track, mute, unmute, reconnect, and disconnect events.

## Join and connection flow

The join form trims the display name, rejects an empty result, and limits the
value to 32 characters. Submission sends the URL token unchanged as
`join_token` together with the trimmed name as `display_name`.

After a successful API response, the voice client connects to the returned
`livekit_url` using `access_token`, requests microphone access, and publishes
the microphone track. The room screen becomes active only after those steps
succeed. A failed step cleans up any partially created connection and track
before showing a recoverable error.

## Voice behavior

Remote audio tracks are attached when subscribed and detached when
unsubscribed. If browser autoplay blocks playback, the room displays an
`Enable Audio` action that retries playback in a user gesture.

Mute and unmute operate on the actual LiveKit local microphone publication.
The button label and participant microphone icon are driven by the resulting
LiveKit state rather than optimistic UI state.

Leave disconnects the room, stops the local microphone, detaches audio,
removes listeners, clears participants, and displays `You left the room` with
a `Join Again` action. Reconnect events update status without constructing a
second room connection.

## Errors

Errors are mapped to actionable UI states:

- invalid or expired invite;
- backend unavailable;
- LiveKit unavailable or connection failed;
- microphone permission denied, with `Try Again`;
- unexpected disconnect;
- reconnecting and reconnected status.

The UI always retains a visible recovery action where recovery is possible.
No error leaves a blank page. Technical details may be logged for development,
but users receive concise messages.

## Visual design and responsiveness

The interface is a dark, Discord-inspired voice card without copying Discord
assets. It uses a charcoal background, a raised room panel, blue-violet primary
actions, green connected indicators, and red destructive actions. Controls
have large touch targets and clear focus states.

The layout is mobile-first. On a narrow screen the card fills most of the
viewport width and controls stack; on desktop it is centered with a bounded
width. Safe-area padding supports iPhone browsers. Functionality and readable
status text take precedence over decoration and animation.

## Independent development

With `VITE_USE_MOCK_API=true`, the API adapter returns the exact production
response shape. `VITE_DEV_LIVEKIT_URL` and `VITE_DEV_LIVEKIT_TOKEN` may override
the mock credentials for a real development LiveKit server. No LiveKit API
secret is stored in frontend code or environment examples.

The normal HTTP mode reads `VITE_API_URL` and sends
`POST /api/voice/join`. The repository includes `frontend/.env.example` with
safe defaults and documents both modes.

## Testing and verification

Automated tests cover token routing, name validation and trimming, the API
request shape, mock response compatibility, join-state transitions, duplicate
submission prevention, microphone-denied recovery, participants, mute/unmute,
reconnect status, remote-audio recovery, leave cleanup, and user-facing error
mapping.

The LiveKit SDK boundary is replaced with a deterministic fake in component
and hook tests. Adapter-level tests verify event translation and cleanup without
requiring a running SFU. Completion requires passing `npm test`, `npm run lint`,
and `npm run build` from `frontend/`. Real two-browser audio and mobile/network
checks remain documented manual integration checks because they require a
reachable LiveKit deployment and valid credentials.

## Collaboration safeguards

Work remains on `frontend/web-voice-client`. Before major implementation and
final verification, inspect local and remote commit history for changes from
other developers. Do not merge or rewrite their branches automatically. If a
shared contract changes, adapt only the frontend boundary and report any
incompatible requirement.
