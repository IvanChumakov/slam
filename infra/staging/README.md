# Staging deployment prerequisites

Публичное развёртывание выполняется после успешного локального теста двух участников.

Локальный этап завершён. Для VM используем официальный LiveKit deployment generator: он создаёт Docker Compose, Caddy, Redis, LiveKit config и bootstrap script. Generated-файлы содержат credentials и сохраняются только в игнорируемой Git папке `generated/`.

## Что требуется до начала

- Linux VM с публичным IPv4 и SSH-доступом;
- DNS A-запись `rtc.example.ru`;
- DNS A-запись `turn.example.ru`;
- доступ к cloud firewall/security group;
- финальный backend webhook URL;
- согласованные случайные `LIVEKIT_API_KEY` и `LIVEKIT_API_SECRET`.

Если у VM нет рабочего IPv6, AAAA-записи создавать не нужно. Неверная AAAA-запись может направлять часть клиентов на недоступный адрес.

## План развёртывания

1. Заполнить несекретные данные по шаблону `staging-inputs.example.txt`.
2. Создать A-записи RTC и TURN, направленные напрямую на публичный IPv4 VM.
3. Проверить DNS:

```powershell
& .\infra\staging\Test-StagingDns.ps1 `
  -ServerIPv4 "203.0.113.10" `
  -RtcDomain "rtc.example.ru" `
  -TurnDomain "turn.example.ru"
```

4. Запустить официальный интерактивный генератор:

```powershell
& .\infra\staging\Initialize-StagingConfig.ps1
```

В генераторе выбрать `LiveKit Server only`. Ingress и Egress не входят в MVP.

5. Скрипт автоматически проверит структуру generated deployment. Повторная ручная проверка:

```powershell
& .\infra\staging\Test-GeneratedStagingConfig.ps1 `
  -GeneratedDirectory ".\infra\staging\generated\rtc.example.ru"
```

6. Проверить сгенерированные Compose, LiveKit, Caddy и Redis configs, не публикуя их в Git.
7. Зафиксировать версию LiveKit Server `v1.13.1`, если генератор выбрал другую версию или `latest`.
8. Развернуть bootstrap script/cloud-init на VM.
9. Настроить реальные секреты вне Git.
10. Настроить trusted TLS для signaling и TURN.
11. Открыть только необходимые firewall ports.
12. Запустить сервисы и проверить `wss://rtc.example.ru`.
13. Выполнить post-deploy проверку:

```powershell
& .\infra\staging\Test-StagingEndpoint.ps1 `
  -RtcDomain "rtc.example.ru" `
  -TurnDomain "turn.example.ru"
```

14. Проверить embedded TURN/UDP и TURN/TLS реальными браузерами.
15. Подключить backend webhook.
16. Выполнить multi-network и mobile test matrix.

## Ожидаемые порты

Итоговый список всегда сверяется с production `livekit.yaml`:

- `80/TCP` — выпуск и обновление TLS;
- `443/TCP` — HTTPS/WSS и TURN/TLS;
- `7881/TCP` — ICE/TCP;
- `3478/UDP` — TURN/UDP;
- `50000-60000/UDP` — стандартный ICE/UDP media range.

Redis и внутренние административные endpoints наружу не публикуются.

Если DNS управляется через Cloudflare, записи RTC и TURN должны быть в режиме DNS only, если отдельно не приобретён и не настроен L4-прокси, поддерживающий нужные WebRTC/TURN transports.

## Секреты

В эту папку запрещено коммитить:

- `.env`;
- API secrets;
- TLS private keys;
- сгенерированную конфигурацию, содержащую реальные credentials.

Для generated deployment files зарезервирован локальный путь `infra/staging/generated/`, который игнорируется Git.

## Официальные источники

- https://docs.livekit.io/transport/self-hosting/vm/
- https://docs.livekit.io/transport/self-hosting/deployment/
- https://docs.livekit.io/transport/self-hosting/ports-firewall/
