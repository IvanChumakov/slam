# Telegram Voice MVP — Общее ТЗ для команды из 3 разработчиков

## 1. Общая идея

Сервис добавляет Discord-подобные голосовые комнаты в обычные Telegram-группы.

Telegram используется для:
- текстового общения;
- групп;
- уведомлений;
- отправки ссылок на голосовые комнаты.

Сам голос Telegram не использует.

Основной пользовательский сценарий:

```text
Telegram Group
      ↓
    /voice
      ↓
Bot sends:

🔊 General
Сейчас: 2 человека

Ivan
Max

[🎧 Join Voice]

      ↓

https://voice.example.ru/join/<token>

      ↓

Web Voice Client

      ↓

LiveKit / WebRTC

      ↓

пользователи разговаривают
```

Главная цель MVP:

> Пользователь может из Telegram-группы одним нажатием открыть голосовую комнату и разговаривать с другими участниками без Discord и без VPN.

---

# 2. Общая архитектура

```text
                   Telegram
                       │
                       │ /voice
                       ▼
                 Telegram Bot
                       │
                       ▼
                 FastAPI Backend
                  │           │
                  │           │
             PostgreSQL       │
                              │
                       generate join URL
                              │
                              ▼
                  voice.example.ru
                              │
                       Web Voice Client
                              │
                     POST /api/voice/join
                              │
                              ▼
                        FastAPI Backend
                              │
                      generate LiveKit JWT
                              │
                              ▼
                        LiveKit SFU
                              │
                          WebRTC audio
                       ┌──────┴───────┐
                       ▼              ▼
                    User A          User B
```

---

# 3. Разделение команды

## Developer A — Telegram + Backend

Отвечает за:
- Telegram Bot;
- FastAPI;
- PostgreSQL;
- join token;
- LiveKit JWT generation;
- LiveKit webhook;
- обновление Telegram room message.

Рабочая зона:

```text
/backend
```

---

## Developer B — Voice / LiveKit / Infrastructure

Отвечает за:
- LiveKit;
- WebRTC;
- TURN;
- TURN/TLS fallback;
- Docker;
- staging deployment;
- network testing.

Рабочая зона:

```text
/infra
```

---

## Developer C — Web Voice Client

Отвечает за:
- React;
- TypeScript;
- LiveKit JS SDK;
- microphone;
- remote audio;
- participant list;
- mute/unmute;
- leave;
- reconnect;
- UI/error states.

Рабочая зона:

```text
/frontend
```

---

# 4. Общий API Contract

Этот контракт нельзя менять без согласования всех трёх разработчиков.

## Join Voice

```http
POST /api/voice/join
Content-Type: application/json
```

Request:

```json
{
  "join_token": "...",
  "display_name": "Ivan"
}
```

Response:

```json
{
  "livekit_url": "wss://rtc.example.ru",
  "access_token": "...",
  "room": {
    "id": 42,
    "name": "General"
  },
  "participant": {
    "identity": "guest_e84...",
    "display_name": "Ivan"
  }
}
```

Frontend использует этот response для подключения к LiveKit.

---

# 5. Общий Acceptance Scenario

Есть Telegram-группа:

```text
Gaming Test
```

Пользователь A пишет:

```text
/voice
```

Бот отвечает:

```text
🔊 General

Сейчас в комнате: 0

[🎧 Join Voice]
```

Пользователь A нажимает кнопку.

Открывается:

```text
https://voice.example.ru/join/<signed_token>
```

Пользователь вводит имя:

```text
Ivan
```

и нажимает:

```text
Join Voice
```

Разрешает доступ к микрофону.

Пользователь B делает то же самое.

После этого:

```text
A слышит B.
B слышит A.
```

Оба видят список участников.

Mute/unmute работает.

После выхода пользователя он исчезает из participant list.

Telegram room message обновляет online count.

---

# 6. BACKEND.md — Telegram Bot + Backend API

## 6.1 Цель

Реализовать backend сервиса голосовых комнат для Telegram-групп.

Backend отвечает за:
- Telegram Bot;
- Telegram-группы и комнаты;
- защищённые join-ссылки;
- API для frontend;
- LiveKit access token;
- LiveKit webhook;
- обновление количества участников в Telegram.

---

## 6.2 Технологии

Использовать:

- Python 3.12+
- FastAPI
- aiogram 3
- PostgreSQL
- SQLAlchemy 2
- Alembic
- Pydantic
- PyJWT или аналог
- LiveKit Server SDK

Не реализовывать frontend и не настраивать LiveKit infrastructure.

---

## 6.3 Структура

```text
backend/
├── app/
│   ├── main.py
│   ├── config.py
│   ├── bot/
│   ├── api/
│   ├── models/
│   ├── schemas/
│   ├── services/
│   └── db/
├── alembic/
├── tests/
├── Dockerfile
└── pyproject.toml
```

---

## 6.4 Database

### TelegramGroup

Поля:

```text
id
telegram_chat_id
title
created_at
```

`telegram_chat_id` — unique.

### VoiceRoom

Поля:

```text
id
group_id
name
livekit_room_name
telegram_message_id
created_at
```

Для MVP:

```text
одна Telegram-группа = одна voice room "General"
```

---

## 6.5 Telegram Bot

### /start

В личке:

```text
Добавьте бота в Telegram-группу и выполните /voice.
```

### /voice

Работает только в:
- group;
- supergroup.

Алгоритм:

1. Найти TelegramGroup по `telegram_chat_id`.
2. Если нет — создать.
3. Найти VoiceRoom этой группы.
4. Если нет — создать `General`.
5. Сгенерировать signed join token.
6. Создать URL.
7. Отправить сообщение с кнопкой.

Сообщение:

```text
🔊 General

Сейчас в комнате: 0

[🎧 Join Voice]
```

URL:

```text
{FRONTEND_PUBLIC_URL}/join/{join_token}
```

Если `/voice` вызывается повторно, вторую комнату не создавать.

---

## 6.6 Join Token

Реализовать:

```python
create_join_token(
    room_id: int,
    telegram_chat_id: int,
) -> str
```

и:

```python
verify_join_token(token: str)
```

Payload:

```json
{
  "room_id": 42,
  "telegram_chat_id": -100123456,
  "exp": 1786200000
}
```

Подписывать:

```text
JOIN_TOKEN_SECRET
```

Backend обязан проверять:
- signature;
- expiration;
- room existence.

---

## 6.7 Join API

```http
POST /api/voice/join
```

Request:

```json
{
  "join_token": "...",
  "display_name": "Ivan"
}
```

Backend должен:

1. проверить token;
2. проверить существование VoiceRoom;
3. проверить `display_name`;
4. создать случайный LiveKit participant identity;
5. выпустить LiveKit JWT;
6. вернуть данные подключения.

Identity:

```text
guest_<uuid>
```

LiveKit room:

```text
voice_room.livekit_room_name
```

Response строго:

```json
{
  "livekit_url": "wss://rtc.example.ru",
  "access_token": "...",
  "room": {
    "id": 42,
    "name": "General"
  },
  "participant": {
    "identity": "guest_e84...",
    "display_name": "Ivan"
  }
}
```

---

## 6.8 Дополнительный API

### Health

```http
GET /health
```

Response:

```json
{
  "status": "ok"
}
```

### Room

```http
GET /api/rooms/{room_id}
```

Response:

```json
{
  "id": 42,
  "name": "General",
  "online_count": 3
}
```

---

## 6.9 LiveKit Integration

Backend не поднимает LiveKit.

Считать, что доступны:

```text
LIVEKIT_URL
LIVEKIT_API_KEY
LIVEKIT_API_SECRET
```

Реализовать:

```python
generate_livekit_token(
    room_name: str,
    identity: str,
    display_name: str,
) -> str
```

Token должен разрешать:
- join room;
- publish audio;
- subscribe audio.

---

## 6.10 LiveKit Webhook

Endpoint:

```http
POST /api/livekit/webhook
```

Проверять подпись webhook.

Минимально обрабатывать:

```text
participant_joined
participant_left
```

После события обновлять Telegram room message.

---

## 6.11 Telegram Room Message

Пример:

```text
🔊 General

Сейчас в комнате: 3

Ivan
Max
Alex

[🎧 Join Voice]
```

Если participant list пока сложно реализовать, допустимо:

```text
🔊 General

Сейчас в комнате: 3

[🎧 Join Voice]
```

Не отправлять новое сообщение при каждом изменении.

Редактировать существующее.

---

## 6.12 Environment

`.env.example`:

```text
BOT_TOKEN=

DATABASE_URL=

FRONTEND_PUBLIC_URL=
BACKEND_PUBLIC_URL=

JOIN_TOKEN_SECRET=

LIVEKIT_URL=
LIVEKIT_API_KEY=
LIVEKIT_API_SECRET=
```

---

## 6.13 Независимая разработка

LiveKit может ещё не быть готов.

Поэтому LiveKit-логику вынести за service/interface.

Для unit tests разрешён mock:

```python
generate_livekit_token(...) -> "test-token"
```

Backend должен тестироваться независимо от реального LiveKit.

---

## 6.14 Tests

Минимально проверить:

- создание join token;
- проверку join token;
- expired token;
- invalid token;
- `/api/voice/join`;
- неизвестную комнату;
- пустое имя;
- слишком длинное имя;
- повторный `/voice`;
- создание TelegramGroup;
- создание VoiceRoom.

Использовать:

```text
pytest
ruff
```

---

## 6.15 Не реализовывать

Не делать:
- frontend;
- Mini App;
- Steam;
- LFG;
- роли;
- несколько voice rooms;
- screen sharing;
- video;
- регистрацию;
- Telegram authentication;
- payments;
- запись аудио.

---

## 6.16 Definition of Done

Backend готов, если:

1. Backend запускается.
2. PostgreSQL migrations работают.
3. `/voice` создаёт комнату.
4. Бот отправляет `Join Voice`.
5. Join URL содержит signed token.
6. `POST /api/voice/join` работает.
7. API возвращает LiveKit credentials.
8. LiveKit webhook принимается и валидируется.
9. Telegram message обновляет online count.
10. README содержит команды запуска.

---

# 7. VOICE_INFRA.md — LiveKit + WebRTC Infrastructure

## 7.1 Цель

Поднять и настроить voice-инфраструктуру.

Она должна позволять двум или более пользователям из обычных браузеров разговаривать через WebRTC без VPN.

Эта часть должна работать независимо от Telegram Bot и основного frontend.

---

## 7.2 Технологии

Использовать:

- LiveKit Server;
- Docker / Docker Compose;
- WebRTC;
- TURN;
- TURN/TLS fallback;
- Linux server;
- HTTPS/WSS;
- reverse proxy при необходимости.

Не реализовывать Telegram Bot или основной React UI.

---

## 7.3 Local LiveKit

Поднять локальный LiveKit.

Подготовить:

```text
infra/
├── livekit.yaml
├── docker-compose.yml
├── .env.example
└── README.md
```

Команда:

```bash
docker compose up -d
```

После запуска должны быть доступны:

```text
LIVEKIT_URL
LIVEKIT_API_KEY
LIVEKIT_API_SECRET
```

---

## 7.4 LiveKit Configuration

Настроить:
- WebSocket signaling;
- WebRTC UDP;
- participant publishing;
- participant subscriptions;
- audio rooms;
- webhook configuration.

Видео не требуется.

---

## 7.5 Token Contract

Backend самостоятельно генерирует LiveKit JWT.

Backend получает:

```text
LIVEKIT_URL
LIVEKIT_API_KEY
LIVEKIT_API_SECRET
```

Проверить, что token с permissions:

```text
roomJoin = true
canPublish = true
canSubscribe = true
```

работает корректно.

---

## 7.6 Независимый Test Client

Сделать минимальный test client или использовать официальный совместимый инструмент.

Главная проверка:

```text
Browser A
    ↓
LiveKit
    ↑
Browser B
```

Два пользователя должны:
- войти в одну room;
- опубликовать microphone track;
- услышать друг друга;
- mute/unmute;
- disconnect.

Основной frontend для этого не нужен.

---

## 7.7 Public Staging

Развернуть тестовую инфраструктуру.

Целевой endpoint:

```text
rtc.example.ru
```

Signaling:

```text
wss://rtc.example.ru
```

TLS-сертификат должен быть валидным.

---

## 7.8 Network Requirements

Главная продуктовая задача:

```text
voice работает из российских сетей без VPN
```

Предусмотреть fallback:

```text
WebRTC UDP
      ↓
TURN UDP
      ↓
TURN/TCP или TURN/TLS
```

Production-конфигурация должна иметь fallback через TLS/443 там, где это корректно для выбранной конфигурации.

---

## 7.9 TURN

Настроить TURN fallback.

Допускается:
- встроенный TURN LiveKit;
- отдельный coturn.

В README описать:
- архитектуру;
- порты;
- transport fallback.

---

## 7.10 Firewall

В README указать:
- TCP ports;
- UDP ports;
- TLS ports;
- firewall rules.

Не оставлять открытые административные интерфейсы.

---

## 7.11 Webhooks

Backend предоставит:

```text
POST https://api.example.ru/api/livekit/webhook
```

Минимально нужны события:

```text
participant_joined
participant_left
room_started
room_finished
```

Во время независимой разработки можно использовать временный webhook receiver.

---

## 7.12 Environment Contract

Backend ожидает:

```text
LIVEKIT_URL=wss://rtc.example.ru
LIVEKIT_API_KEY=...
LIVEKIT_API_SECRET=...
```

---

## 7.13 Тестирование

Проверить:

### Desktop
- Windows + Chrome
- macOS + Chrome
- желательно macOS + Safari

### Mobile
- Android + Chrome
- iPhone + Safari

### Networks
- домашний интернет;
- другой ISP;
- мобильная сеть;
- разные сети одновременно.

---

## 7.14 Что измерять

Для каждого теста записывать:

```text
connection success
time to connect
audio works yes/no
reconnect works yes/no
transport used
network type
VPN used yes/no
```

---

## 7.15 Failure Testing

Проверить:
- кратковременное пропадание сети;
- смену Wi-Fi → mobile;
- отключение UDP;
- закрытие вкладки;
- повторное подключение;
- disconnect одного участника.

---

## 7.16 Не реализовывать

Не делать:
- Telegram Bot;
- PostgreSQL;
- основной React frontend;
- video;
- screen sharing;
- recording;
- transcription;
- AI noise suppression;
- moderation;
- authentication;
- payments.

---

## 7.17 Definition of Done

Voice/Infra готов, если:

1. LiveKit поднимается через Docker.
2. Backend может использовать API key/secret.
3. Два браузера входят в одну room.
4. Оба пользователя слышат друг друга.
5. Mute/unmute работает.
6. Webhook events отправляются.
7. Есть публичный staging endpoint.
8. Проведён тест минимум из двух разных сетей.
9. Проведён тест через мобильный интернет.
10. Для обычного сценария VPN не требуется.

---

# 8. FRONTEND.md — Web Voice Client

## 8.1 Цель

Сделать простой web-клиент голосовой комнаты.

Пользователь переходит:

```text
https://voice.example.ru/join/<token>
```

Вводит имя, нажимает Join и подключается к LiveKit voice room.

Frontend должен разрабатываться независимо от Telegram Bot.

---

## 8.2 Технологии

Использовать:
- React;
- TypeScript;
- Vite;
- LiveKit Client SDK.

Не использовать:
- Next.js;
- Telegram Mini App;
- сложный state manager без необходимости.

---

## 8.3 Route

Основной route:

```text
/join/:token
```

Frontend не должен самостоятельно решать, валиден ли token.

Token передаётся backend.

---

## 8.4 Экран подключения

```text
┌───────────────────────────┐
│ 🔊 Voice Room             │
│                           │
│ Your name                 │
│ [ Ivan                  ] │
│                           │
│ [ 🎧 Join Voice ]         │
└───────────────────────────┘
```

Требования:
- trim имени;
- имя не пустое;
- разумный max length, например 32 символа.

---

## 8.5 Backend API Contract

```http
POST /api/voice/join
Content-Type: application/json
```

Request:

```json
{
  "join_token": "<token from URL>",
  "display_name": "Ivan"
}
```

Response:

```json
{
  "livekit_url": "wss://rtc.example.ru",
  "access_token": "...",
  "room": {
    "id": 42,
    "name": "General"
  },
  "participant": {
    "identity": "guest_e84...",
    "display_name": "Ivan"
  }
}
```

Не менять этот контракт.

---

## 8.6 Независимая разработка

Backend может ещё не быть готов.

Создать mock adapter.

Например:

```text
VITE_USE_MOCK_API=true
```

Mock должен возвращать production-compatible structure.

Дополнительно можно предусмотреть:

```text
VITE_DEV_LIVEKIT_URL=
VITE_DEV_LIVEKIT_TOKEN=
```

---

## 8.7 Connection Flow

```text
/join/:token
      ↓
user enters name
      ↓
POST /api/voice/join
      ↓
receive LiveKit credentials
      ↓
connect LiveKit
      ↓
request microphone
      ↓
publish microphone
      ↓
listen to remote participants
```

---

## 8.8 UI после подключения

```text
┌──────────────────────────────┐
│ 🔊 General                   │
│                              │
│ ● Ivan                  🎤   │
│ ● Max                   🎤   │
│ ● Alex                  🔇   │
│                              │
│      [ 🎤 Mute ]             │
│                              │
│      [ Leave ]               │
└──────────────────────────────┘
```

---

## 8.9 Participants

Показывать:
- display name;
- microphone state.

Participant list должен обновляться в real time.

Authoritative state брать из LiveKit.

---

## 8.10 LiveKit Events

Обрабатывать:

```text
ParticipantConnected
ParticipantDisconnected
TrackSubscribed
TrackUnsubscribed
TrackMuted
TrackUnmuted
Reconnecting
Reconnected
Disconnected
```

---

## 8.11 Remote Audio

Подписываться на remote audio tracks.

Если браузер блокирует autoplay, показать:

```text
Enable Audio
```

---

## 8.12 Microphone

После Join запросить microphone permission.

Если доступ получен:
- publish microphone track.

Если отказано:

```text
Не удалось получить доступ к микрофону.

Разрешите доступ к микрофону в браузере и попробуйте снова.

[Try Again]
```

---

## 8.13 Mute / Unmute

Кнопка:

```text
🎤 Mute
```

После mute:

```text
🔇 Unmute
```

Mute должен реально менять состояние LiveKit microphone track.

---

## 8.14 Leave

При Leave:

1. disconnect from LiveKit;
2. stop local microphone;
3. clear room state;
4. показать:

```text
You left the room.

[Join Again]
```

---

## 8.15 Reconnect

Показывать:

```text
Reconnecting...
```

После восстановления:

```text
Connected
```

Не создавать второе соединение.

---

## 8.16 Error States

Обработать:

```text
Invalid or expired invite
Backend unavailable
LiveKit unavailable
Connection failed
Microphone denied
Disconnected
Reconnecting
```

---

## 8.17 Loading States

Например:

```text
Connecting...
```

и:

```text
Requesting microphone access...
```

Кнопки блокировать во время активного join.

---

## 8.18 Responsive Design

Voice client должен работать:
- desktop;
- Android browser;
- iPhone browser.

Функциональность важнее сложного дизайна.

---

## 8.19 Suggested Structure

```text
frontend/
├── src/
│   ├── App.tsx
│   ├── api/
│   │   └── voiceApi.ts
│   ├── voice/
│   │   ├── livekit.ts
│   │   └── types.ts
│   ├── components/
│   │   ├── JoinScreen.tsx
│   │   ├── VoiceRoom.tsx
│   │   ├── Participant.tsx
│   │   └── ConnectionStatus.tsx
│   └── main.tsx
├── .env.example
├── package.json
└── README.md
```

---

## 8.20 Environment

`.env.example`:

```text
VITE_API_URL=http://localhost:8000
VITE_USE_MOCK_API=false
```

Dev-only:

```text
VITE_DEV_LIVEKIT_URL=
VITE_DEV_LIVEKIT_TOKEN=
```

LiveKit API secret никогда не хранить во frontend.

---

## 8.21 Checks

Перед завершением:

```bash
npm run lint
npm run build
```

Вручную проверить:
- join;
- microphone permission;
- два участника;
- remote audio;
- mute;
- unmute;
- participant leave;
- reconnect;
- invalid token;
- backend error.

---

## 8.22 Не реализовывать

Не делать:
- Telegram Bot;
- Telegram Mini App;
- PostgreSQL;
- LiveKit server deployment;
- несколько voice channels;
- video;
- screen sharing;
- text chat;
- Steam;
- LFG;
- authentication;
- registration;
- payments;
- recording.

---

## 8.23 Definition of Done

Frontend готов, если:

1. `/join/:token` открывается.
2. Пользователь вводит имя.
3. Frontend вызывает `/api/voice/join`.
4. Credentials используются для LiveKit.
5. Микрофон публикуется.
6. Remote audio воспроизводится.
7. Участники отображаются.
8. Mic state отображается.
9. Mute/unmute работает.
10. Leave работает.
11. Reconnect обрабатывается.
12. Ошибки не оставляют пустой интерфейс.
13. `npm run build` проходит.

---

# 9. Общий Git Workflow

Один repository:

```text
telegram-voice/
│
├── AGENTS.md
├── SPEC.md
├── backend/
├── frontend/
├── infra/
├── docker-compose.yml
└── README.md
```

Основная ветка:

```text
main
```

Рабочие ветки:

```text
feature/backend
feature/voice-infra
feature/frontend
```

Не работать напрямую в `main`.

Процесс:

```text
Codex пишет код
↓
разработчик проверяет diff
↓
commit
↓
push
↓
Pull Request
↓
review
↓
merge
```

---

# 10. Правила независимой разработки

## Backend

Не должен ждать frontend.

Проверять через:
- Swagger;
- curl;
- pytest;
- mock LiveKit service.

## Frontend

Не должен ждать backend.

Использовать:
- mock API;
- dev LiveKit credentials.

## Voice / Infra

Не должен ждать backend/frontend.

Использовать:
- отдельный test client;
- temporary webhook receiver.

---

# 11. Порядок интеграции

## Milestone 1

Без Telegram:

```text
Browser A
      │
      ▼
Web Client
      │
      ▼
Backend token
      │
      ▼
LiveKit
      ▲
      │
Web Client
      ▲
      │
Browser B
```

A и B слышат друг друга.

---

## Milestone 2

```text
Telegram /voice
      ↓
Join link
      ↓
Browser
      ↓
Voice
```

---

## Milestone 3

Telegram показывает:

```text
🔊 General

3 online

Ivan
Max
Alex

[Join]
```

и обновляется автоматически.

---

# 12. Общий MVP Checklist

## Telegram / Backend

- [ ] `/voice`
- [ ] persistent General room
- [ ] Join button
- [ ] signed join token
- [ ] PostgreSQL
- [ ] `POST /api/voice/join`
- [ ] LiveKit JWT
- [ ] LiveKit webhook
- [ ] participant count

## Voice / Infra

- [ ] LiveKit
- [ ] WebRTC audio
- [ ] microphone
- [ ] TURN fallback
- [ ] TURN/TLS
- [ ] public staging
- [ ] webhook delivery
- [ ] multi-network test
- [ ] mobile test
- [ ] without VPN

## Frontend

- [ ] `/join/:token`
- [ ] Join screen
- [ ] microphone permission
- [ ] participant list
- [ ] remote audio
- [ ] mute
- [ ] unmute
- [ ] leave
- [ ] reconnect
- [ ] error handling
- [ ] mobile layout

---

# 13. Что НЕ делать в MVP

Не реализовывать:

- Mini App;
- несколько voice rooms;
- video;
- screen sharing;
- Steam;
- LFG;
- clans;
- friends;
- ratings;
- roles;
- recording;
- AI moderation;
- payments;
- push-to-talk;
- desktop application.

---

# 14. Главное правило проекта

Сначала доказать, что работает цепочка:

```text
Telegram
   ↓
Join Link
   ↓
Browser
   ↓
Backend
   ↓
LiveKit
   ↓
Voice without VPN
```

До этого не расширять продукт дополнительными функциями.
