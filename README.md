# slam

Telegram Voice MVP добавляет Discord-подобные голосовые комнаты в обычные Telegram-группы.

Компоненты проекта:

- [`backend/`](backend/README.md) — Telegram bot, FastAPI, PostgreSQL и LiveKit tokens/webhooks;
- [`frontend/`](frontend/README.md) — React web voice client;
- [`infra/`](infra/README.md) — локальная LiveKit/WebRTC infrastructure.

Полная командная спецификация находится в [`telegram_voice_team_spec.md`](telegram_voice_team_spec.md).

Инструкция production-развёртывания backend: [`backend/DEPLOY.md`](backend/DEPLOY.md).

Единый локальный запуск frontend, backend, PostgreSQL и LiveKit, включая
проверку реального аудио в двух браузерах: [`LOCAL_DEVELOPMENT.md`](LOCAL_DEVELOPMENT.md).
