# Аутентификация: обзор

Codex Remote использует комбинацию из passkey/TOTP/basic-входа (в зависимости от провайдера), refresh-токенов и device-code flow для Anchor.

## Компоненты

- Web client (Svelte)
- Orbit / control plane (`services/orbit`, `services/orbit-deno` или `services/control-plane`)
- Anchor (локальный Bun-сервис, мост к `codex app-server`)

## Модель токенов и секретов

### Пользовательская сессия (web)

- access token (`token`) используется для API/WS запросов
- refresh token (`refreshToken`) обновляет сессию через `/auth/refresh`
- access token короткоживущий, refresh token - долгоживущий с ротацией

### Anchor-сессия (device flow)

- Anchor получает `anchorAccessToken` + `anchorRefreshToken` после device-code авторизации
- access token обновляется через `/auth/device/refresh`
- в legacy-сценариях может использоваться `CODEX_REMOTE_ANCHOR_JWT_SECRET`

### Секреты

- `CODEX_REMOTE_WEB_JWT_SECRET` - подпись/проверка пользовательских JWT
- `CODEX_REMOTE_ANCHOR_JWT_SECRET` - legacy service-to-service JWT для Anchor (и совместимость)

## Основные потоки

### 1) Вход через passkey

1. Клиент вызывает `POST /auth/register/options` + `POST /auth/register/verify` (регистрация) или `POST /auth/login/options` + `POST /auth/login/verify` (вход)
2. Сервер выдаёт `token` + `refreshToken`
3. Клиент хранит токены и обновляет `token` через `POST /auth/refresh`
4. При выходе вызывается `POST /auth/logout`

### 2) Вход через TOTP

Доступно в orbit/orbit-deno при `AUTH_MODE=passkey`:

- `POST /auth/register/totp/start`
- `POST /auth/register/totp/verify`
- `POST /auth/login/totp`
- `POST /auth/totp/setup/options`
- `POST /auth/totp/setup/verify`

TOTP-факторы хранятся на сервере с защитой от replay (`last_used_step`).

### 3) Basic login (только FastAPI и/или Deno в `AUTH_MODE=basic`)

- `POST /auth/register/basic`
- `POST /auth/login/basic`

Используется как упрощённый режим для локальной разработки и лёгкого self-host.

### 4) Device code для Anchor

1. Anchor: `POST /auth/device/code`
2. Пользователь подтверждает код в web: `POST /auth/device/authorise`
3. Anchor polling: `POST /auth/device/token`
4. После `authorised` Anchor получает anchor-токены
5. Для продления сессии Anchor использует `POST /auth/device/refresh`

Креды Anchor сохраняются в `CODEX_REMOTE_CREDENTIALS_FILE` (по умолчанию `~/.codex-remote/credentials.json`).

## WebSocket-аутентификация

### Web client -> Orbit

Подключение:

- `wss://.../ws/client?token=<jwt>`
- или заголовок `Authorization: Bearer <jwt>` (где применимо)

Токен валидируется по issuer/audience и по состоянию серверной сессии.

### Anchor -> Orbit

Подключение:

- `wss://.../ws/anchor?token=<anchorAccessToken>`

В legacy-режиме Anchor может подписывать короткоживущий JWT через `CODEX_REMOTE_ANCHOR_JWT_SECRET`.

## Обязательная конфигурация

### Orbit / Orbit Deno

- `PASSKEY_ORIGIN` (для passkey-режима)
- `CODEX_REMOTE_WEB_JWT_SECRET`
- `CODEX_REMOTE_ANCHOR_JWT_SECRET` (если нужен legacy flow)

### FastAPI control-plane

- `AUTH_MODE=passkey|basic`
- `CODEX_REMOTE_WEB_JWT_SECRET`
- `DEVICE_VERIFICATION_URL`
- `CORS_ORIGINS`
- дополнительно для passkey: `PASSKEY_ORIGIN`, `PASSKEY_RP_ID`

### Anchor

- `ANCHOR_ORBIT_URL`
- `AUTH_URL`
- опционально `CODEX_REMOTE_ANCHOR_JWT_SECRET` (legacy)
- опционально `ANCHOR_APP_CWD`

## Типовые проблемы

- `Orbit unavailable`: неверный `AUTH_URL` или несовпадение origin (`PASSKEY_ORIGIN` / CORS)
- `401/403` на `/ws/client` или `/ws/anchor`: недействительный/просроченный токен
- ошибки `Not initialized`: `codex app-server` не прошёл `initialize`
- неверные файлы проекта: неправильно задан `ANCHOR_APP_CWD`

## Важные замечания

- токены в query string (`?token=`) могут попадать в логи
- при хранении токенов в `localStorage` безопасность устройства пользователя критична
- серверная ротация refresh токенов и `logout` нужны для отзыва сессий
