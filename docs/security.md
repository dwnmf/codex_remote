# Безопасность

## Модель угроз

- несанкционированный удалённый контроль локальной машины
- перехват/повтор токенов сессии (access/refresh)
- утечка чувствительных данных через логи или запросы к модели
- злоупотребление локальным Anchor WebSocket/API

## Текущие меры защиты

### Аутентификация пользователей

- поддерживаются passkey (WebAuthn), TOTP и basic-flow (в зависимости от провайдера/`AUTH_MODE`)
- access token и refresh token выдаются раздельно
- refresh-токены ротируются при обновлении сессии (`/auth/refresh`)
- серверная проверка сессии позволяет отзывать токены через `/auth/logout`

### Аутентификация Anchor

- основной путь: device-code (`/auth/device/code` -> `/auth/device/authorise` -> `/auth/device/token`)
- Anchor получает `anchorAccessToken` + `anchorRefreshToken` и обновляет через `/auth/device/refresh`
- поддерживается legacy JWT secret flow для обратной совместимости
- креды сохраняются в `~/.codex-remote/credentials.json` с правами `0600`

### Защита локального Anchor WebSocket

По умолчанию локальный сокет Anchor не открыт для произвольного внешнего доступа.

- можно требовать явный токен через `ANCHOR_WS_TOKEN`
- без токена разрешаются только loopback/private адреса
- `ANCHOR_WS_ALLOW_PUBLIC=1` снимает ограничение (рискованный режим)

### Транспорт

- внешний трафик идёт по HTTPS/WSS
- Anchor инициирует исходящее подключение к control plane
- входящие порты на локальной машине для Orbit не требуются

### CORS и защитные заголовки (Orbit)

- origin проверяется относительно `PASSKEY_ORIGIN` / `ALLOWED_ORIGIN`
- `localhost` и `127.0.0.1` допускаются для dev-окружения
- ответы Orbit включают `X-Content-Type-Options: nosniff` и `X-Frame-Options: DENY`

## Изоляция данных

- маршрутизация событий выполняется по `threadId` и подпискам сокетов
- Cloudflare-провайдер использует Durable Object на пользователя
- состояние сессий хранится на стороне backend (D1 или KV, в зависимости от провайдера)

## Известные ограничения

- web токены хранятся в `localStorage`; компрометация устройства компрометирует сессию
- токены в query string WebSocket (`?token=`) потенциально могут попадать в инфраструктурные логи
- нет сквозного E2E-шифрования между web client и Anchor (TLS завершается на edge/backend)
- credentials-файл Anchor содержит чувствительные токены/секреты в plaintext
- отдельный rate limiting для auth/ws endpoint’ов на уровне приложения не реализован
- автоматическое разрешение localhost-origin удобно для dev, но требует осторожности на shared-машинах

## Операционные рекомендации

- регулярно ротируйте секреты (`CODEX_REMOTE_WEB_JWT_SECRET`, `CODEX_REMOTE_ANCHOR_JWT_SECRET` при legacy-flow)
- используйте `codex-remote logout`/`/auth/logout` при смене устройства или подозрении на компрометацию
- не включайте `ANCHOR_WS_ALLOW_PUBLIC=1` без необходимости
- не храните в переписке с агентом секреты и приватные ключи
- ограничивайте CORS origin’ы production-доменами

## Что логично усилить дальше

- добавить rate limiting на auth/device/ws endpoint’ы
- внедрить опциональное E2E-шифрование полезной нагрузки между клиентом и Anchor
- добавить централизованную маскировку секретов в логах
