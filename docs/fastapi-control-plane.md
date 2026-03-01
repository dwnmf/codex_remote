# FastAPI Control Plane

Это облегчённая альтернатива Orbit (Cloudflare/Deno), если нужен простой self-host стек:

- статический фронтенд на Vercel (или любом static host)
- backend на FastAPI для auth + websocket relay
- локальный Anchor на macOS/Linux/Windows

## Что реализовано

- `GET /health`
- `GET /auth/session`
- `POST /auth/register/basic`
- `POST /auth/login/basic`
- `POST /auth/register/options` (режим `AUTH_MODE=passkey`)
- `POST /auth/register/verify` (режим `AUTH_MODE=passkey`)
- `POST /auth/login/options` (режим `AUTH_MODE=passkey`)
- `POST /auth/login/verify` (режим `AUTH_MODE=passkey`)
- `POST /auth/refresh`
- `POST /auth/logout`
- `POST /auth/device/code`
- `POST /auth/device/authorise`
- `POST /auth/device/token`
- `POST /auth/device/refresh`
- `GET /ws/client` и `GET /ws/anchor` preflight (`426` при валидной auth до апгрейда)
- `WS /ws/client`
- `WS /ws/anchor`

Поведение realtime-части повторяет базовый Orbit-флоу:

- `orbit.subscribe` / `orbit.unsubscribe`
- `orbit.list-anchors`
- `anchor.hello`, `orbit.anchor-connected`, `orbit.anchor-disconnected`
- thread-scoped маршрутизация сообщений от Anchor к подписанным клиентам

## Локальный запуск

```bash
cd services/control-plane
python -m venv .venv
source .venv/bin/activate  # Windows: .venv\\Scripts\\activate
pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8080
```

## Переменные окружения

Базовые:

- `AUTH_MODE=passkey` или `AUTH_MODE=basic`
- `CODEX_REMOTE_WEB_JWT_SECRET=change-me`
- `DATABASE_PATH=./data/control_plane.db`
- `CORS_ORIGINS=https://your-frontend.vercel.app,http://localhost:5173`
- `DEVICE_VERIFICATION_URL=https://your-frontend.vercel.app/device`
- `ACCESS_TTL_SEC=3600`
- `REFRESH_TTL_SEC=604800`
- `DEVICE_CODE_TTL_SEC=600`
- `DEVICE_CODE_POLL_INTERVAL_SEC=5`
- `ANCHOR_ACCESS_TTL_SEC=86400`
- `ANCHOR_REFRESH_TTL_SEC=2592000`

Для passkey-режима:

- `PASSKEY_ORIGIN=https://your-frontend.vercel.app`
- `PASSKEY_RP_ID=your-frontend.vercel.app` (опционально; можно вывести из origin)
- `CHALLENGE_TTL_SEC=300`

## Настройка фронтенда

Для сборки web client задайте:

- `AUTH_URL=https://<your-fastapi-domain>`
- `AUTH_MODE=passkey` (рекомендуется) или `AUTH_MODE=basic` (быстрый dev)

## Настройка Anchor

Для подключения Anchor к FastAPI relay:

- `ANCHOR_ORBIT_URL=wss://<your-fastapi-domain>/ws/anchor`
- `AUTH_URL=https://<your-fastapi-domain>`

Anchor получает device-токены через `/auth/device/token` и продлевает их через `/auth/device/refresh`.

## Продакшен-заметки

- используйте сильные секреты
- включайте только HTTPS/WSS
- настройте строгие CORS origin’ы
- контролируйте логи (в них не должны утекать токены/секреты)

Полный endpoint reference находится в [services/control-plane/README.md](../services/control-plane/README.md).
