#!/bin/sh
set -eu
cd /opt/slam
tar -xzf release.tar.gz --no-same-owner
if [ ! -f .env.server ]; then
    umask 077
    bot_token=123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi
    db_password=$(openssl rand -hex 32)
    join_secret=$(openssl rand -hex 32)
    livekit_secret=$(openssl rand -hex 32)
    public_host=${PUBLIC_HOST:-24observer.ru}
    printf '%s\n' \
        "ENVIRONMENT=production" \
        "BOT_TOKEN=$bot_token" \
        "PUBLIC_HOST=$public_host" \
        "POSTGRES_DB=slam" \
        "POSTGRES_USER=slam" \
        "POSTGRES_PASSWORD=$db_password" \
        "DATABASE_URL=postgresql+asyncpg://slam:$db_password@db:5432/slam" \
        "FRONTEND_PUBLIC_URL=https://$public_host" \
        "BACKEND_PUBLIC_URL=https://$public_host" \
        "ALLOWED_ORIGINS=https://$public_host" \
        "ALLOWED_HOSTS=$public_host,localhost,127.0.0.1,api" \
        "JOIN_TOKEN_SECRET=$join_secret" \
        "JOIN_TOKEN_TTL_SECONDS=86400" \
        "LIVEKIT_URL=wss://$public_host/livekit" \
        "LIVEKIT_API_KEY=serverkey" \
        "LIVEKIT_API_SECRET=$livekit_secret" > .env.server
fi
chmod 600 .env.server
docker compose --env-file .env.server -f compose.server.yaml config --quiet
if [ "${1:-}" = build ]; then
    docker compose --env-file .env.server -f compose.server.yaml build
    exit
fi
if [ ! -f .bot-token ]; then
    echo 'A separately provisioned Telegram token is required before starting services.' >&2
    exit 1
fi
bot_token=$(tr -d '\r\n' < .bot-token)
test -n "$bot_token"
sed -i "s|^BOT_TOKEN=.*|BOT_TOKEN=$bot_token|" .env.server
docker compose --env-file .env.server -f compose.server.yaml up -d --build
docker compose --env-file .env.server -f compose.server.yaml ps -a
