# slam

Telegram Voice MVP добавляет Discord-подобные голосовые комнаты в обычные Telegram-группы.

Компоненты проекта:

- [`backend/`](backend/README.md) — Telegram bot, FastAPI, PostgreSQL и LiveKit tokens/webhooks;
- `frontend/` — web voice client (разрабатывается отдельно);
- `infra/` — LiveKit/WebRTC infrastructure (разрабатывается отдельно).

Полная командная спецификация находится в [`telegram_voice_team_spec.md`](telegram_voice_team_spec.md).

Инструкция production-развёртывания backend: [`backend/DEPLOY.md`](backend/DEPLOY.md).
