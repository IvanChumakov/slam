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
- `GET /api/rooms/{room_id}`
- `POST /api/livekit/webhook`

The LiveKit webhook route requires the original request body and the signed
`Authorization` header. `participant_joined` and `participant_left` are applied
idempotently before the existing Telegram room message is edited.

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
