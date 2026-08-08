# Voice infrastructure

Локальный стенд LiveKit для Telegram Voice MVP. Он предназначен для независимой проверки WebRTC-аудио до готовности Telegram-бота, backend и основного frontend.

## Что входит в текущий стенд

- LiveKit Server `v1.13.1`;
- signaling/API на `ws://localhost:7880`;
- WebRTC TCP fallback на `7881/TCP`;
- WebRTC UDP mux на `7882/UDP`;
- комнаты только с кодеком `audio/opus`;
- ключи через переменные окружения;
- локальный test-only webhook receiver;
- воспроизводимый запуск через Docker Compose.

TURN намеренно выключен в локальной конфигурации. Для TURN/TLS требуются публичный домен и доверенный TLS-сертификат; эта часть будет включена при развёртывании staging.

## Требования

- Windows 10/11;
- WSL2;
- Docker Desktop с запущенным Docker Engine;
- Git;
- свободные порты `7880/TCP`, `7881/TCP` и `7882/UDP`.

Проверка окружения:

```powershell
git --version
docker version
docker compose version
```

## Быстрый запуск

Из корня репозитория:

```powershell
Copy-Item .\infra\.env.example .\infra\.env
docker compose --file .\infra\docker-compose.yml config
docker compose --file .\infra\docker-compose.yml pull
docker compose --file .\infra\docker-compose.yml up -d
docker compose --file .\infra\docker-compose.yml ps
```

Посмотреть логи:

```powershell
docker compose --file .\infra\docker-compose.yml logs --follow livekit
```

Проверить signaling-порт:

```powershell
Test-NetConnection 127.0.0.1 -Port 7880
```

Полная автоматическая проверка локального стенда:

```powershell
& .\infra\scripts\Test-LocalInfra.ps1
```

Остановить стенд:

```powershell
docker compose --file .\infra\docker-compose.yml down
```

## Локальные credentials

`.env.example` содержит только известные небезопасные значения для локальной разработки:

```text
LIVEKIT_URL=ws://localhost:7880
LIVEKIT_API_KEY=devkey
LIVEKIT_API_SECRET=local-development-secret-change-me
```

Перед staging эти значения обязательно заменяются случайными секретами. Файл `infra/.env` игнорируется Git.

## Тестовый токен

Установить официальный LiveKit CLI (`lk`) и выпустить токен первого участника:

```powershell
lk token create `
  --api-key devkey `
  --api-secret local-development-secret-change-me `
  --join `
  --room test-room `
  --identity user-a `
  --valid-for 1h
```

Для второго участника повторить команду с уникальным identity:

```powershell
lk token create `
  --api-key devkey `
  --api-secret local-development-secret-change-me `
  --join `
  --room test-room `
  --identity user-b `
  --valid-for 1h
```

Оба токена должны вести в `test-room`, но identity обязаны отличаться. Для ручной проверки можно использовать официальный совместимый клиент LiveKit Meet. Камеру следует выключить: локальная конфигурация разрешает только `audio/opus`.

Вместо длинных команд можно использовать скрипт:

```powershell
& .\infra\scripts\New-TestToken.ps1 -Identity user-a -DisplayName "User A"
& .\infra\scripts\New-TestToken.ps1 -Identity user-b -DisplayName "User B"
```

Чтобы сразу открыть тестовый клиент:

```powershell
& .\infra\scripts\New-TestToken.ps1 -Identity user-a -DisplayName "User A" -OpenMeet
& .\infra\scripts\New-TestToken.ps1 -Identity user-b -DisplayName "User B" -OpenMeet
```

Во вкладках нужно разрешить микрофон, выключить камеру и проверить звук в обе стороны. Чтобы избежать акустической обратной связи, лучше использовать наушники либо открыть второго участника на другом устройстве.

## Webhook

Локальный Compose уже включает test-only receiver `webhook-receiver`. Он принимает события на внутреннем адресе:

```text
http://webhook-receiver:8080/webhook
```

Посмотреть полученные события:

```powershell
docker compose --file .\infra\docker-compose.yml logs --follow webhook-receiver
```

Receiver не валидирует подпись и не предназначен для production. Он не публикует порт на хост и выводит только факт наличия `Authorization`, не раскрывая сам JWT.

После появления backend локальный receiver заменяется endpoint:

```text
POST https://api.example.ru/api/livekit/webhook
```

Минимально проверяем события:

- `room_started`;
- `participant_joined`;
- `participant_left`;
- `room_finished`.

LiveKit подписывает webhook тем же API key/secret, которые использует сервер. API key должен совпадать с одной из настроенных пар ключей.

Важно: локальный `livekit.yaml` использует `webhook.api_key: devkey`. Если изменить `LIVEKIT_API_KEY` в `.env`, нужно изменить и это значение. Staging-конфигурация генерируется отдельно и не содержит локальный ключ.

## Staging

Staging не является копией локальной конфигурации. Для него потребуются:

- Linux VM с публичным IPv4;
- `rtc.example.ru` и `turn.example.ru`;
- доверенные TLS-сертификаты;
- Caddy или другой подходящий TLS termination;
- Redis;
- embedded TURN;
- firewall для WSS, ICE/TCP, ICE/UDP, TURN/UDP и TURN/TLS.

Подробности и список входных данных находятся в [`staging/README.md`](staging/README.md).

Staging automation:

- `staging/Initialize-StagingConfig.ps1` — запускает закреплённый официальный generator;
- `staging/Test-GeneratedStagingConfig.ps1` — проверяет generated deployment;
- `staging/Test-StagingDns.ps1` — проверяет RTC/TURN DNS;
- `staging/Test-StagingEndpoint.ps1` — проверяет TCP и доверенный TLS после deployment.

## Диагностика

Проверить контейнеры:

```powershell
docker compose --file .\infra\docker-compose.yml ps
```

Проверить последние 200 строк логов:

```powershell
docker compose --file .\infra\docker-compose.yml logs --tail 200 livekit
```

Проверить занятые порты:

```powershell
Get-NetTCPConnection -LocalPort 7880,7881 -ErrorAction SilentlyContinue
Get-NetUDPEndpoint -LocalPort 7882 -ErrorAction SilentlyContinue
```

Частые причины проблем:

- Docker Desktop не запущен;
- `.env` отсутствует или содержит другой ключ, чем использовался для JWT;
- identity двух участников совпадают;
- браузеру запрещён доступ к микрофону;
- порты заняты другим процессом;
- клиент пытается публиковать видео, хотя разрешён только `audio/opus`.

## Официальная документация

- [Self-hosting](https://docs.livekit.io/transport/self-hosting/)
- [Локальный запуск](https://docs.livekit.io/transport/self-hosting/local/)
- [Production deployment](https://docs.livekit.io/transport/self-hosting/deployment/)
- [Порты и firewall](https://docs.livekit.io/transport/self-hosting/ports-firewall/)
- [LiveKit CLI](https://docs.livekit.io/reference/developer-tools/livekit-cli/)
- [Webhooks](https://docs.livekit.io/intro/basics/rooms-participants-tracks/webhooks-events/)
