# Server deployment

The full application runs in `/opt/slam` on the server from `creds.txt`.
Public URL: https://24observer.ru
The previous `5-42-102-94.sslip.io` address redirects to the same path on the
custom domain, so previously sent Telegram invitations continue to work.

Services: PostgreSQL, migrations, API, Telegram polling bot, static frontend,
LiveKit, and Caddy with automatic HTTPS. PostgreSQL and certificates use persistent
Docker volumes. Long-running services restart automatically with Docker.

```sh
cd /opt/slam
docker compose --env-file .env.server -f compose.server.yaml ps -a
docker compose --env-file .env.server -f compose.server.yaml logs --tail=100 bot api livekit proxy
docker compose --env-file .env.server -f compose.server.yaml up -d --build
```

Secrets are stored in `.env.server` and `.bot-token` with mode `600` and excluded
from Git. The release archive must exclude all `.env` and `.env.*` files,
`creds.txt`, dependencies, caches, and build artifacts. Provision `.bot-token`
separately before running `sh deploy-server.sh`.

Only ports 80/443, WebRTC TCP 7881, and WebRTC UDP 7882 are public. PostgreSQL and
the backend port are not published. LiveKit signaling uses `/livekit` over WSS;
webhooks go directly to the API within the Docker network.

The server DNS-selected Telegram address was unreachable. Backend containers use
the verified Telegram endpoint `149.154.167.220`. Override `TELEGRAM_API_IP` in
`.env.server` if Telegram changes its endpoint or network routing changes.

For a product test, add the bot to a Telegram group, send `/voice`, then open the
Join link from two devices and allow microphone access. TURN is not configured;
networks blocking both UDP 7882 and TCP 7881 may not establish audio connections.

Voice rooms are scoped to the Telegram group and topic (`message_thread_id`).
Each `/voice` replies in the current topic with a fresh invitation to its existing
room; repeated commands do not create additional rooms. Different topics have
separate rooms. Migration `0002_topic_rooms` preserves existing General room IDs
and invitations under thread ID `0`; non-topic groups continue using General.
Presence updates refresh the latest room card, and replacement cards stay in the
same topic.

Migration `0003_topic_names` adds a persistent topic-name cache. Topic creation and
rename service updates populate it without creating voice rooms; renames refresh
the latest room card. `/voice` also reads an attached topic starter when available.
Older topics without cached metadata may need a rename event to supply the title.
If the name is unknown, the card says `Голосовая комната`, not a numeric topic ID.

The bot registers `/voice` in Telegram's command menu at startup, both globally
and for group chats. Room cards include `Войти в комнату` and
`Получить ссылку ещё раз`; the second button sends a fresh invitation in the same
topic without creating another room. Old cards gain the buttons on their next
presence/title refresh or after another `/voice` command.

The frontend explicitly disables LiveKit `singlePeerConnection`. With the SDK's
default enabled, Firefox sessions repeatedly failed SDP negotiation with
`remoteDescription contained media section without mid value`. Separate publishing
and subscribing connections avoid this failure. The deployment was checked with
two Firefox clients using virtual microphones: both remained connected and played
remote audio streams.
