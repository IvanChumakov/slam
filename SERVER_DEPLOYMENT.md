# Server deployment

The full application runs in `/opt/slam` on the server from `creds.txt`.
Public URL: https://24observer.ru
The previous `5-42-102-94.sslip.io` address redirects to the same path on the
custom domain, so previously sent Telegram invitations continue to work.

Services: PostgreSQL, migrations, API, Telegram polling bot, static frontend,
LiveKit, coturn, and Caddy with automatic HTTPS. PostgreSQL and certificates use persistent
Docker volumes. Long-running services restart automatically with Docker.
The current server enables TURN/TLS at `24observer.ru:5349`; always include both
Compose files when updating this deployment.

```sh
cd /opt/slam
docker compose --env-file .env.server -f compose.server.yaml -f compose.server.turn.yaml ps -a
docker compose --env-file .env.server -f compose.server.yaml -f compose.server.turn.yaml logs --tail=100 bot api livekit coturn proxy
docker compose --env-file .env.server -f compose.server.yaml -f compose.server.turn.yaml up -d --build
```

Secrets are stored in `.env.server` and `.bot-token` with mode `600` and excluded
from Git. The release archive must exclude all `.env` and `.env.*` files,
`creds.txt`, dependencies, caches, and build artifacts. Provision `.bot-token`
separately before running `sh deploy-server.sh`.
That script starts the base-only deployment; it must not be used to update the
current TURN-enabled server. Use the two-file commands above instead.

By default, only ports 80/443, WebRTC TCP 7881, and WebRTC UDP 7882 are public. PostgreSQL and
the backend port are not published. LiveKit signaling uses `/livekit` over WSS;
webhooks go directly to the API within the Docker network.

The server DNS-selected Telegram address was unreachable. Backend containers use
the verified Telegram endpoint `149.154.167.220`. Override `TELEGRAM_API_IP` in
`.env.server` if Telegram changes its endpoint or network routing changes.

For a product test, add the bot to a Telegram group, send `/voice`, then open the
Join link from two devices and allow microphone access. TURN is disabled by default;
networks blocking both UDP 7882 and TCP 7881 may not establish media connections.
Server, integrated local, and infra-only LiveKit configs allow Opus audio plus
VP8/H264 video for screen sharing. Client support and token grants still apply;
existing rooms may need to be recreated to inherit the updated codec defaults.

## Optional TURN/TLS fallback

`compose.server.turn.yaml` adds authenticated external coturn on `5349/TCP`.
The image is pinned to `coturn/coturn:4.18.0-r0-alpine` and its multi-platform
manifest digest (official Docker release of 2026-09-08). It retains the base
LiveKit config, API keys, `/livekit` signaling, webhook signing, and direct RTC
ports. No custom LiveKit build or host dependency installation is needed.

LiveKit v1.13.1 hardcodes port 443 for **embedded** TURN/TLS candidate URLs,
regardless of its listener `tls_port`. Embedded TURN is therefore explicitly
disabled; `infra/scripts/turn-start.sh` inserts `rtc.turn_servers` with
`protocol: tls`, the configured hostname, `port: 5349`, and `secret_file` into a runtime copy
of `infra/livekit.server.yaml`. The external TURN branch advertises
`turns:<hostname>:5349?transport=tcp`, not 443.

Coturn uses REST shared-secret authentication, not anonymous or static-user
access. LiveKit issues per-participant HMAC-SHA1 credentials with a four-hour
TTL; the shared secret itself never goes into client responses, Compose env,
process arguments, or images. Both services read the same externally supplied
file. Coturn's secret-bearing config is generated with mode `0600` in private
tmpfs. Coturn allows peers only on `TURN_PUBLIC_IP` (the LiveKit server on this
same host), denies other IPv4/IPv6 peers, and disables CLI, plaintext TCP/UDP
client listeners, DTLS, and TCP relays. UDP **relay** sockets remain required.

Port 443 remains owned by Caddy: this is **not** a TURN-on-443 solution and cannot
help networks that also block outbound TCP 5349 or TURN traffic.

Before enabling, an operator must provision the following separately (these repo
changes do not edit server state, DNS, or firewalls):

- A public hostname such as `turn.24observer.ru`, resolving directly to the
  server's reachable public IPv4, not an HTTP/CDN proxy. This override is IPv4-only:
  do not publish AAAA for this TURN hostname.
- `TURN_PUBLIC_IP`: that same public IPv4, assigned directly to a host interface
  and also advertised by LiveKit for RTC. Only coturn uses `network_mode: host`;
  it binds its listener and relay sockets to this exact public IPv4. No
  `external-ip` mapping is used: coturn's Docker NAT mapping would translate the
  same-host SFU peer onto coturn itself and break permission checks. This package
  requires a Linux host with a directly assigned public IPv4, not upstream NAT.
  All other services retain their existing Docker network configuration.
- A publicly trusted certificate whose SAN covers that exact hostname, with a PEM
  full chain and matching, unencrypted PEM private key. Self-signed certificates
  are not suitable for browser TURN/TLS. Obtain and renew via your existing
  certificate tooling; Caddy's HTTPS certificate is not automatically shared here.
- Absolute paths outside the repository, for example
  `/etc/slam/turn/fullchain.pem` and `/etc/slam/turn/privkey.pem`. Restrict the private
  key to its owner (`0600`), keep it readable by the coturn container process,
  and never put certificate private keys or credentials in a release archive/Git.
- `TURN_SECRET_FILE`: an absolute path outside the repo, for example
  `/etc/slam/turn/shared-secret`, containing exactly 64 random hexadecimal
  characters, optionally followed by a newline. Provision it separately using
  existing secret tooling (e.g. `openssl rand -hex 32`); do not reuse an API secret.
  It must be a regular file, owner-readable, mode `0600`. LiveKit v1.13.1 rejects
  `secret_file` with any permission bits for "other"; the wrapper enforces the
  stricter `0600` on both services. Keep it out of Git, images, release archives,
  logs, and environment variable values. Only its path is a Compose setting.
- Reachable inbound `5349/TCP` and `49160-49200/UDP` in host/cloud firewalls.
  Coturn binds these ports directly on the public host interface, without Docker
  port publishing or NAT. The 41-port relay range is used only in the override;
  the allocation quota is capped at 40
  (12 per username), and port exhaustion can occur sooner with reserved ports.
  Do not open 3478, 5349/UDP, or relay TCP ports. Clients need outbound TCP 5349,
  not UDP to coturn; coturn exchanges UDP with the LiveKit SFU.
- Working UDP routing between coturn's public sockets and LiveKit's advertised
  public UDP 7882, including the existing Docker port mapping for LiveKit.
  Preserve the existing RTC ports. Restrict relay-range firewall access to the
  SFU where feasible; coturn is subject to host INPUT rules, while LiveKit's
  Docker published-port rules must also be considered.
- Synchronized clocks for credential expiration. After four hours, a very long
  session may require reconnection to obtain fresh TURN credentials.

The coturn process runs as container UID 0 to read root-owned `0600` files, with a
read-only root filesystem, private tmpfs, no-new-privileges and dropped capabilities
except `NET_BIND_SERVICE` (the upstream binary carries this file capability).
It is not privileged, but coturn shares the host network namespace and has less
network isolation than a bridge container. Explicit public-IP binding and peer
restrictions remain required. Provision root-readable files accordingly,
including any user-namespace mappings. The pinned image's
default entrypoint evaluates arguments; the override bypasses it with the checked
POSIX-shell wrapper and directly executes `/usr/bin/turnserver`.

From `/opt/slam`, set these non-secret settings in the shell (or in the existing
private `.env.server`):

```sh
export TURN_DOMAIN=turn.24observer.ru
export TURN_PUBLIC_IP=YOUR_SERVER_PUBLIC_IPV4
export TURN_CERT_FILE=/etc/slam/turn/fullchain.pem
export TURN_KEY_FILE=/etc/slam/turn/privkey.pem
export TURN_SECRET_FILE=/etc/slam/turn/shared-secret
docker compose --env-file .env.server -f compose.server.yaml -f compose.server.turn.yaml config --quiet
docker compose --env-file .env.server -f compose.server.yaml -f compose.server.turn.yaml up -d --no-deps coturn livekit
docker compose --env-file .env.server -f compose.server.yaml -f compose.server.turn.yaml logs --tail=100 coturn livekit
openssl s_client -connect "$TURN_DOMAIN:5349" -servername "$TURN_DOMAIN" -verify_hostname "$TURN_DOMAIN" -verify_return_error </dev/null
```

Use `--no-deps` only when the base application/API is already healthy; for a full
deployment use `up -d --build` with both files. Service ordering is not a TLS
health check. Missing settings fail Compose interpolation; missing mounted files
are not created as directories. Missing/empty/unreadable TLS files and invalid
secret format/permissions fail the wrapper. Certificate/key parsing and matching
are performed by coturn; inspect logs and verify its TLS listener before use.

The TLS probe checks trust and reachability, not TURN allocation or media.
With an existing TURN diagnostic client, verify that unauthenticated/wrong-secret
Allocate requests are rejected and REST-authenticated allocations succeed. Then
verify two clients on the affected VPN (or block direct RTC in a controlled test),
with browser WebRTC diagnostics showing the received external TURN URL on 5349,
no embedded `turns:<hostname>:443` URL, and a selected `relay` candidate. Also verify
bidirectional audio and screen video, not merely successful TLS/signaling.
TCP relaying can add latency and head-of-line blocking, especially for screens.

Always include both Compose files for subsequent deployments while TURN is enabled.
The default `deploy-server.sh` and base-only `up` commands do not include this
override and can remove LiveKit's external TURN settings without stopping the
orphan coturn container. After certificate renewal, recreate coturn with both
files (`up -d --no-deps --force-recreate coturn`) to reload replaced bind mounts
and the certificate. After shared-secret rotation, recreate **both** coturn and
LiveKit (`up -d --no-deps --force-recreate coturn livekit`) to avoid mismatched
credentials. These actions interrupt relayed sessions; LiveKit recreation also
interrupts rooms. Never inspect or archive the generated secret-bearing config.

To disable TURN, first stop/remove only coturn using both files, then restore the
base LiveKit service:

```sh
docker compose --env-file .env.server -f compose.server.yaml -f compose.server.turn.yaml stop coturn
docker compose --env-file .env.server -f compose.server.yaml -f compose.server.turn.yaml rm -f coturn
docker compose --env-file .env.server -f compose.server.yaml up -d --no-deps livekit
```

The default server needs no TURN domain, public IP, certificates, or secret file.
Offline regression checks (Python with existing PyYAML and Docker Compose; no
containers, installs, real certificates, or env-secret reads):

```sh
python3 infra/scripts/test_turn_config.py -v
sh -n infra/scripts/turn-start.sh
```

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
