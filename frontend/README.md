# SLAM Web Voice Client

React/Vite client for the `/join/:token` voice-room flow. It exchanges the
Telegram invite token for LiveKit credentials, publishes the microphone, plays
remote audio, shares screens and camera video, and renders room state from LiveKit events.

Microphone mute and incoming room audio mute are independent. Incoming mute
silences all remote voices and shared-screen audio, including tracks that arrive
later; shared video remains visible. Screen capture requires browser support and
a secure context (HTTPS or localhost). Unsupported browsers can still view others'
screens. Where supported, the browser chooser offers optional screen audio.
Cancelling or denying capture keeps you in the room. No recording is used.

Camera video is enabled only by an explicit user action, independently of the
microphone and screen sharing. Camera Off stops and unpublishes capture. Leaving,
changing channels or retrying does not restart the camera; late permission
results for a retired request are stopped rather than published. Camera and
screen video are shown separately, including a muted local camera preview.
Speaking indicators use actual LiveKit participant activity, not microphone-on
state. Remote camera viewing does not require a local camera or capture permission.

The matte workspace places channels in a desktop side rail, participants and
media in the main area, and compact audio/video controls in a persistent bottom
bar. On smaller screens, channels open in a native modal drawer. Current-channel
and microphone/incoming-audio states are shown explicitly, not by color alone.

**Appearance** offers System, Light and Dark modes plus Clay, Sage and Slate
accents. Only versioned appearance preferences are stored in
`localStorage["slam.appearance.v1"]`; no tokens, links, names, microphone or camera
preferences are stored there. System mode follows operating-system changes;
blocked storage still permits session-only appearance changes.

While connected, **Group channels** lists the existing voice rooms authorized by
the current invite in the same Telegram group. Channel changes reuse your name
and preserve microphone and incoming-audio mute. A previously muted microphone
stays unpublished until you explicitly unmute. Target invites and credentials
are fetched before leaving the old room; metadata failures keep the call intact.
The old connection and media are closed before connecting to the target. Screen
sharing and camera capture are stopped, never restarted in another channel. Leave cancels pending
operations, and failed target connections offer **Retry connection**.

Selecting a target replaces the browser URL without reloading, so refreshing
joins the selected channel. **Share room** requests a fresh signed invite for the
current room, then displays its URL and a separate **Copy link** button. This
keeps clipboard writes inside a user click on mobile. When clipboard access is
missing or denied, the visible link can be selected and copied manually. Listing,
invite, and clipboard failures do not disconnect the call. A valid invite grants
access to existing rooms in its Telegram group, not other groups; the frontend
does not perform Telegram membership checks or create unknown channels.

## Requirements

- Node.js 22.12 or newer (Node.js 24 is used in development).
- A backend implementing `POST /api/voice/join`, `POST /api/voice/rooms`, and
  `POST /api/voice/invite` for production mode.
- A reachable LiveKit server and valid participant token for real audio.

## Setup

```bash
cp .env.example .env
npm install
npm run dev
```

Open `http://localhost:5173/join/<signed-token>`.

For the recommended Docker-based full-stack setup (including a generated local
invite and real LiveKit audio), see [`../LOCAL_DEVELOPMENT.md`](../LOCAL_DEVELOPMENT.md).
It uses Node 24 in Docker, so no compatible Node.js installation is required on
the host.

## Environment

```dotenv
VITE_API_URL=http://localhost:8000
VITE_USE_MOCK_API=false
VITE_DEV_LIVEKIT_URL=
VITE_DEV_LIVEKIT_TOKEN=
```

- `VITE_API_URL` is the backend origin. The client appends `/api/voice/join`,
  `/api/voice/rooms`, and `/api/voice/invite`.
- `VITE_USE_MOCK_API=true` replaces backend requests with production-shaped
  responses for General and Lounge. Minted mock invite tokens retain the selected
  room across refreshes and reject unknown target room IDs.
- Set `VITE_DEV_LIVEKIT_URL` and `VITE_DEV_LIVEKIT_TOKEN` in mock mode to join a
  real development LiveKit room. Without them, the placeholder credentials are
  suitable for UI/error-state work but cannot establish audio.
- A static development LiveKit token is scoped to its own actual LiveKit room;
  mock channel metadata cannot mint real credentials for a second room. Verify
  real multi-room switching using production-mode backend-issued tokens.
- Never put a LiveKit API secret in a `VITE_` variable. Vite exposes these values
  to the browser.

## Commands

```bash
npm test
npm run lint
npm run build
```

`npm run build` performs strict TypeScript checks before the Vite production
build. The LiveKit adapter is loaded lazily after Join, keeping the landing
screen bundle small.

## Manual integration checklist

- Open the same invite in two browsers and verify both participants appear.
- Allow both microphones and verify each browser hears the other.
- Mute and unmute each participant; verify the icon and remote audio state.
- Mute incoming room audio while leaving the microphone on; verify another
  participant can still hear you. Start another participant's screen audio while
  muted, then unmute and verify it plays. Verify screen video stays visible.
- Share a screen in each browser, optionally including audio where offered.
  Verify local preview and remote video. Stop from the room button and from the
  browser's Stop sharing control; verify both video and shared audio stop.
- Turn on a camera with the microphone muted; verify local and remote video and
  that the microphone remains unpublished. Show camera and screen together;
  Camera Off must release camera capture without stopping the screen or its audio.
- Cancel pending camera capture, Leave or switch channels before permission
  resolves; verify the late track stops without publication or changing a new room.
- Speak and stop speaking with two clients; verify participant and camera activity
  markers follow the correct identity, including duplicate display names.
- Test all theme/accent pairs, System-mode changes and blocked/invalid storage.
  Reload and verify only appearance is restored, never camera capture.
- At mobile widths, open Channels and test Tab/Shift+Tab, Escape and focus return;
  verify the bottom controls remain reachable without covering room content.
- Cancel or deny the screen chooser; verify the room and controls remain usable.
  Leave with the chooser open, then finish capture; verify no capture remains active.
- Check a browser without `getDisplayMedia`: sharing is disabled with an
  explanation, but incoming screens and independent audio controls still work.
- Leave one browser; verify it disappears in the other browser.
- Switch channels while both audio mutes are enabled and a screen is shared.
  Verify the old capture stops, no second call overlaps, and no microphone is
  captured in the target until unmute. Refresh and verify the selected channel.
- Leave during a pending invite, credential request, connection, or screen
  chooser; verify late completions cannot revive the call or show an old invite.
- Share each channel and verify the link opens that channel. Deny clipboard
  access and verify the manual link stays available without ending the call.
- Deny microphone permission, then allow it and use **Try again**.
- Block autoplay and verify **Enable audio** restores playback.
- Interrupt the network and verify **Reconnecting…** returns to **Connected**
  without a second room connection.
- Verify invalid/expired tokens and backend failures show recovery guidance.
- Repeat the flow in an Android browser and an iPhone browser.
- Repeat on Wi-Fi and a mobile network against public staging/TURN.

The Telegram bot, backend, LiveKit deployment, and TURN configuration are owned
by the other project workspaces and are intentionally not implemented here.
