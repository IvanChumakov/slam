# Telegram Voice Backend

FastAPI API and aiogram bot for the Telegram Voice MVP. The backend owns Telegram groups,
the persistent `General` room, signed join invitations, LiveKit participant tokens and
participant-presence updates from signed LiveKit webhooks.

## Local setup

Requirements: Python 3.12+ and PostgreSQL.

```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -e '.[dev]'
cp .env.example .env
alembic upgrade head
```

Use random production-grade values for `JOIN_TOKEN_SECRET`, `LIVEKIT_API_KEY` and
`LIVEKIT_API_SECRET`. Never commit `.env`.

Run the API:

```bash
uvicorn app.main:create_app --factory --reload
```

Run the Telegram bot in a second process:

```bash
python -m app.bot.polling
```

Swagger is available at `http://localhost:8000/docs` outside production. In production,
the interactive docs are disabled.

## Checks

```bash
ruff check .
ruff format --check .
pytest
```

## API

- `GET /health`
- `GET /ready` (includes a PostgreSQL connectivity check)
- `POST /api/voice/join`
- `POST /api/voice/rooms` with `{join_token}` returns `current_room_id` and
  existing same-group rooms with `id`, `name` and `online_count`.
- `POST /api/voice/invite` with `{join_token, room_id}` returns a fresh
  `join_token`, `join_url`, target `room` and `expires_in` in seconds.
- `GET /api/rooms/{room_id}`
- `POST /api/livekit/webhook`

The LiveKit webhook route requires the original request body and the signed
`Authorization` header. `participant_joined` and `participant_left` are applied
idempotently before the existing Telegram room message is edited.

Rooms and invitation endpoints require a valid signed source-room invitation.
Its holder can discover and enter every existing voice room in that Telegram
group, including when the invitation was forwarded; Telegram membership is not
verified. Other groups remain inaccessible. Expired invitations cannot list
rooms or issue fresh links. Listing does not create rooms for unseen topics.
Fresh links use the configured invitation lifetime; valid holders can renew
access by issuing another invitation before their current token expires.

New `/voice` cards, callback-created cards and replacement cards are automatically
pinned in their originating topic without a pin notification. Existing pins are
not removed. The bot needs administrator `can_pin_messages` permission; missing
rights or Telegram errors leave the saved link card usable and produce a
best-effort explanatory message. Editing an existing card does not repin it.

## Docker

Build and run the API image from this directory:

```bash
docker build -t telegram-voice-backend .
docker run --env-file .env -p 8000:8000 telegram-voice-backend
```

Apply migrations as a release step before starting new application instances:

```bash
docker run --rm --env-file .env telegram-voice-backend alembic upgrade head
```

Run polling as a separate process/container by overriding the command:

```bash
docker run --rm --env-file .env telegram-voice-backend python -m app.bot.polling
```

For a production Docker Compose deployment, TLS proxy setup, LiveKit webhook,
smoke tests, backups and rollback, see [`DEPLOY.md`](DEPLOY.md).
