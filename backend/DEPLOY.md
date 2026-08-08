# Backend deployment

This runbook deploys only the Telegram/FastAPI/PostgreSQL backend. LiveKit, TURN,
the frontend and public network testing remain separate components as defined in
`telegram_voice_team_spec.md`.

## 1. Production prerequisites

- Linux host with Docker Engine and Docker Compose v2.
- DNS record such as `api.example.ru` pointing to the host.
- TLS reverse proxy such as Caddy, nginx or a managed load balancer.
- A working frontend URL and separately provisioned LiveKit URL/API credentials.
- Outbound HTTPS access to Telegram; inbound access to the API through HTTPS.
- PostgreSQL backups stored outside the application host.

Keep the API bound to `127.0.0.1:8000` when the reverse proxy runs on the host.
If the proxy is another container, attach it to the Compose `public` network instead
of exposing PostgreSQL or binding the API to the whole internet.

## 2. Configure secrets

On the server:

```bash
cp .env.production.example .env.production
chmod 600 .env.production
openssl rand -hex 32
```

Place the generated value in `JOIN_TOKEN_SECRET`. Generate a separate URL-safe
PostgreSQL password (hex is suitable) and fill every `replace-me` value.
Do not commit `.env.production`. Use a secrets manager when the deployment platform
supports one.

Important values:

- `ALLOWED_HOSTS` must include the backend hostname.
- `ALLOWED_ORIGINS` must contain only trusted frontend origins, without `*`.
- `LIVEKIT_URL` must be the browser-facing `wss://` endpoint.
- `LIVEKIT_API_SECRET` stays only on the backend.
- Run exactly one `bot` replica when using Telegram long polling.

## 3. Validate and deploy

```bash
docker compose --env-file .env.production -f compose.production.yaml config --quiet
docker compose --env-file .env.production -f compose.production.yaml build
docker compose --env-file .env.production -f compose.production.yaml up -d
docker compose --env-file .env.production -f compose.production.yaml ps
```

The `migrate` service waits for PostgreSQL, runs `alembic upgrade head`, and must
finish successfully before `api` and `bot` start.

Inspect startup logs:

```bash
docker compose --env-file .env.production -f compose.production.yaml logs migrate
docker compose --env-file .env.production -f compose.production.yaml logs --tail=100 api bot
```

## 4. TLS reverse proxy

Example Caddy configuration when Caddy runs directly on the host:

```caddyfile
api.example.ru {
    request_body {
        max_size 64KB
    }
    reverse_proxy 127.0.0.1:8000
}
```

Allow inbound TCP `80/443` for certificate issuance and HTTPS. Do not expose port
`5432`. The API container is published only on host loopback by default.

When using nginx or a managed proxy, configure the equivalent TLS termination,
64 KB request-body limit and upstream `127.0.0.1:8000`. Do not blindly trust public
`X-Forwarded-*` headers.

## 5. Configure LiveKit webhook

Configure the separate LiveKit server/cloud project to send webhooks to:

```text
https://api.example.ru/api/livekit/webhook
```

The endpoint consumes the raw `application/webhook+json` body and verifies the
signed `Authorization` header with `LIVEKIT_API_KEY`/`LIVEKIT_API_SECRET`.

## 6. Smoke tests

```bash
curl --fail https://api.example.ru/health
curl --fail https://api.example.ru/ready
docker compose --env-file .env.production -f compose.production.yaml ps
```

Expected response from both HTTP checks:

```json
{"status":"ok"}
```

Then run the product smoke test:

1. Add the bot to a Telegram group.
2. Send `/voice` twice and confirm only one `General` room/message is reused.
3. Open the Join button and call `POST /api/voice/join` from the frontend.
4. Join LiveKit with two browser clients.
5. Confirm `participant_joined`/`participant_left` update the Telegram count.

## 7. Updates and rollback

Use immutable image tags in production, for example a Git commit SHA:

```bash
export BACKEND_IMAGE=registry.example.ru/telegram-voice-backend:<git-sha>
docker compose --env-file .env.production -f compose.production.yaml pull api bot migrate
docker compose --env-file .env.production -f compose.production.yaml up -d
```

Migrations must remain backward-compatible during a rollout. To roll application
code back, set `BACKEND_IMAGE` to the previous known-good tag and run `up -d` again.
Do not automatically downgrade the database: review the Alembic migration and backup
before any schema rollback.

## 8. Operations and backup

```bash
docker compose --env-file .env.production -f compose.production.yaml logs -f api bot
docker compose --env-file .env.production -f compose.production.yaml exec db \
  sh -c 'pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
docker compose --env-file .env.production -f compose.production.yaml exec -T db \
  sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' > telegram_voice.sql
```

Store backups encrypted outside the host and test restores regularly. Monitor API
availability, HTTP error rate, latency, PostgreSQL storage/connections, bot polling
errors and LiveKit webhook failures.

## 9. Troubleshooting

- `api` does not start: inspect `migrate` logs and `/ready`; verify PostgreSQL credentials.
- Bot receives no commands: ensure only one polling replica runs and `BOT_TOKEN` is valid.
- Join returns `401`: invitation is expired, malformed, or signed with an old secret.
- LiveKit webhook returns `401`: API key/secret or raw-body proxy handling is incorrect.
- Telegram count is stale: inspect API logs and verify LiveKit webhook delivery.
- Browser cannot connect: verify `LIVEKIT_URL`; TURN/WebRTC networking belongs to the
  separate voice-infrastructure deployment.
