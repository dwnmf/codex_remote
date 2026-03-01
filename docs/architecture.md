# Архитектура

## Верхнеуровневая схема

```text
      Web Client (браузер)
              |
              | HTTPS + WebSocket
              v
   Orbit / Control Plane (Cloudflare или Deno)
              |
              | WebSocket relay (исходящее подключение с локальной машины)
              v
   Anchor (локальный bridge: macOS/Linux/Windows)
              |
              | JSON-RPC over stdio
              v
        codex app-server
```

## Компоненты

### 1) Anchor (локальный bridge)

Что делает:

- запускает и сопровождает процесс `codex app-server`
- проксирует JSON-RPC между web client и `app-server`
- отправляет ввод пользователя (в т.ч. интерактивный)
- пересылает запросы на подтверждение действий
- выполняет локальные helper-методы (`anchor.*`) для git/config/file/image/release операций

Технологии:

- Bun runtime
- JSONL/JSON-RPC по stdio
- WebSocket к control plane
- device access tokens (основной путь) + legacy JWT secret (обратная совместимость)

### 2) Orbit / Control Plane

Что делает:

- аутентифицирует web client (passkey/TOTP; для FastAPI также basic-режим)
- выпускает пользовательские токены и refresh токены
- обслуживает device-code flow для Anchor
- валидирует подключения `/ws/client` и `/ws/anchor`
- маршрутизирует сообщения по `threadId` между Anchor и клиентами

Провайдеры:

- `services/orbit`: Cloudflare Worker + Durable Objects + D1
- `services/orbit-deno`: Deno Deploy runtime + Deno KV
- `services/control-plane`: FastAPI-реализация для лёгкого self-host

### 3) Web Client

Что делает:

- вход пользователя (passkey/TOTP/device authorisation)
- список тредов, история и потоковые обновления
- отправка команд, подтверждений и пользовательского ввода
- автоматическое восстановление соединения

Технологии:

- Svelte + Vite
- WebSocket с логикой переподключения
- статический деплой (Cloudflare Pages, Deno Deploy, Vercel и др.)

## Потоки данных

### A) Вход пользователя

1. Клиент вызывает auth endpoint’ы (`/auth/register/*`, `/auth/login/*`)
2. Control plane возвращает `token` + `refreshToken`
3. Клиент хранит токены и обновляет access token через `/auth/refresh`
4. Для завершения сессии вызывается `/auth/logout`

### B) Device login для Anchor

1. Anchor запрашивает код через `POST /auth/device/code`
2. Пользователь подтверждает код в браузере через `POST /auth/device/authorise`
3. Anchor опрашивает `POST /auth/device/token`
4. После авторизации Anchor получает `anchorAccessToken` + `anchorRefreshToken` (или legacy secret)
5. При истечении Anchor обновляет токен через `POST /auth/device/refresh`

### C) Рабочая сессия

1. Web client подключается к `/ws/client?token=<jwt>`
2. Anchor подключается к `/ws/anchor?token=<anchor-token>`
3. Клиент подписывается на тред через `orbit.subscribe`
4. RPC `thread/*` и `turn/*` идут через control plane в Anchor
5. Anchor передаёт вызовы в `codex app-server`
6. Нотификации и результаты возвращаются назад подписанным клиентам

### D) Подтверждения

1. `codex app-server` отправляет `item/*/requestApproval`
2. Anchor/Orbit доставляют запрос в клиент
3. Клиент отвечает JSON-RPC результатом с `decision`
4. Ответ возвращается в `app-server`

## Протокол сообщений

Основной протокол - JSON-RPC-подобный формат поверх WebSocket.

- Бизнес-сообщения: методы `thread/*`, `turn/*`, `item/*`
- Control-frame Orbit: `orbit.hello`, `orbit.subscribe`, `orbit.unsubscribe`, `orbit.list-anchors`, `orbit.anchors`, `orbit.anchor-connected`, `orbit.anchor-disconnected`, `ping/pong`
- Anchor metadata: `anchor.hello`

TypeScript-схемы для клиентской интеграции можно генерировать через:

```bash
codex app-server generate-ts --out DIR
```

## HTTP/WS endpoint’ы

### WebSocket

- `GET /ws/client` - сокет web client
- `GET /ws/anchor` - сокет Anchor

### Auth/API (общий набор)

- `GET /health`
- `GET /auth/session`
- `POST /auth/register/*`
- `POST /auth/login/*`
- `POST /auth/refresh`
- `POST /auth/logout`
- `POST /auth/device/code`
- `POST /auth/device/token`
- `POST /auth/device/authorise`
- `POST /auth/device/refresh`

Примечание: точный набор `register/login` endpoint’ов зависит от провайдера и режима `AUTH_MODE`.

## Состояние маршрутизации

- Cloudflare-провайдер хранит состояние relay в Durable Object на пользователя
- Deno/FastAPI-провайдеры реализуют эквивалентную маршрутизацию по `threadId`
- Основная цель во всех вариантах: доставка сообщений только в релевантные подписанные сокеты

## Безопасность

- пользовательская аутентификация через passkey/TOTP (и basic в FastAPI-режиме)
- access/refresh токены с серверной проверкой сессии и отзыва
- отдельные токены/секреты для web и anchor контекстов
- TLS для внешнего трафика

Детали см. в [auth.md](auth.md) и [security.md](security.md).
