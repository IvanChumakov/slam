# Local full-stack development

This setup runs the React client, FastAPI, PostgreSQL and LiveKit locally with
Docker. It supports a real two-browser WebRTC audio test without Telegram,
public domains, TLS, Node.js or the LiveKit CLI.

## Requirements

- Docker Desktop with the Docker Engine running.
- Free TCP ports `5173`, `8000`, `7880`, `7881` and UDP port `7882`.
- Chrome, Firefox or Safari with microphone access.

The credentials in `compose.local.yaml` are intentionally public and unsafe.
They are only for localhost and must never be reused on a server.

## Start

From the repository root:

```bash
docker compose -f compose.local.yaml up -d --build
docker compose -f compose.local.yaml ps
```

Wait until `db` and `api` are healthy and `migrate` has exited with code `0`.
Create a local room and signed invitation:

```bash
docker compose -f compose.local.yaml run --rm invite
```

The command prints a URL beginning with:

```text
http://localhost:5173/join/
```

## Test real audio

1. Open the generated URL in two browser windows. A normal and an incognito
   window are convenient.
2. Enter different names in each window.
3. Select **Join Voice** and allow microphone access.
4. Confirm both names appear in both windows.
5. Use headphones to avoid feedback, then confirm audio works both ways.
6. Test mute/unmute and **Leave**.

The invite is valid for 24 hours in the local environment. Run the `invite`
command again at any time to get a fresh one.

## Test the UI without audio

Automated checks use Node 24 inside the frontend image:

```bash
docker build --target build -t slam-frontend-check ./frontend
docker run --rm slam-frontend-check npm test
docker run --rm slam-frontend-check npm run lint
```

The first command also runs the TypeScript and Vite production build.

## Optional Telegram bot

Set the real token only in the shell session, then start the optional profile:

```bash
export BOT_TOKEN='token from BotFather'
docker compose -f compose.local.yaml --profile telegram up -d bot
docker compose -f compose.local.yaml logs -f bot
```

Telegram Desktop on the same computer can open the bot's localhost Join link.
A phone cannot use `localhost` on the computer; use the generated URL directly
in mobile testing only after exposing the frontend and API on the local network
or through HTTPS tunnels.

## Diagnostics

```bash
docker compose -f compose.local.yaml ps
docker compose -f compose.local.yaml logs --tail=200 api livekit frontend
curl --fail http://localhost:8000/health
curl --fail http://localhost:8000/ready
```

Common issues:

- Microphone is denied: allow it in browser site settings and join again.
- A second browser cannot be heard: use different display names and verify UDP
  `7882` is not occupied.
- Join fails: generate a fresh invite and inspect `api` logs.
- Containers do not start: check for port conflicts with another LiveKit or
  backend Compose project.

## Stop and reset

Stop containers while preserving the local database and dependency volume:

```bash
docker compose -f compose.local.yaml down
```

Delete all local test data and installed frontend dependencies:

```bash
docker compose -f compose.local.yaml down -v
```
