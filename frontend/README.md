# SLAM Web Voice Client

React/Vite client for the `/join/:token` voice-room flow. It exchanges the
Telegram invite token for LiveKit credentials, publishes the microphone, plays
remote audio, and renders room state from LiveKit events.

## Requirements

- Node.js 22.12 or newer (Node.js 24 is used in development).
- A backend implementing `POST /api/voice/join` for production mode.
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

- `VITE_API_URL` is the backend origin. The client appends `/api/voice/join`.
- `VITE_USE_MOCK_API=true` replaces only the backend join request with a
  production-shaped response.
- Set `VITE_DEV_LIVEKIT_URL` and `VITE_DEV_LIVEKIT_TOKEN` in mock mode to join a
  real development LiveKit room. Without them, the placeholder credentials are
  suitable for UI/error-state work but cannot establish audio.
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
- Leave one browser; verify it disappears in the other browser.
- Deny microphone permission, then allow it and use **Try again**.
- Block autoplay and verify **Enable audio** restores playback.
- Interrupt the network and verify **Reconnecting…** returns to **Connected**
  without a second room connection.
- Verify invalid/expired tokens and backend failures show recovery guidance.
- Repeat the flow in an Android browser and an iPhone browser.
- Repeat on Wi-Fi and a mobile network against public staging/TURN.

The Telegram bot, backend, LiveKit deployment, and TURN configuration are owned
by the other project workspaces and are intentionally not implemented here.
