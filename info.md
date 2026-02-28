# План добавления второго провайдера: Deno Deploy

## Цель
Добавить полноценный self-host провайдер `deno` в `codex-remote` с запуском через `codex-remote self-host --provider deno` и совместимыми endpoint'ами для текущих web/anchor клиентов.

## Scope (MVP+)
- Новый runtime сервиса: `services/orbit-deno` (HTTP auth API + WebSocket relay).
- Хранение auth/state в Deno KV.
- Поддержка auth режимов `passkey` и `basic`.
- Поддержка device-code логина для Anchor (`/auth/device/*`).
- Поддержка relay WebSocket каналов `/ws/client` и `/ws/anchor`.
- Деплой через `deployctl` в Deno Deploy.
- Обновление CLI и self-host wizard:
  - `codex-remote self-host --provider deno`
  - `codex-remote self-host --provider deno --login`
  - `codex-remote update` умеет redeploy deno-провайдера.
- Документация и runbook для deno-пути.

## Архитектурные решения
1. API-контракт сохраняем совместимым с текущим фронтом/anchor:
   - `/auth/session`
   - `/auth/register/*`, `/auth/login/*`
   - `/auth/refresh`, `/auth/logout`
   - `/auth/device/code`, `/auth/device/authorise`, `/auth/device/token`, `/auth/device/refresh`
   - `/ws/client`, `/ws/anchor`
2. Relay: in-memory маршрутизация сокетов + thread subscription + multi-dispatch.
3. Persisted данные (KV): пользователи, сессии, refresh-токены, passkey credentials, challenge/device code.
4. Frontend и API деплоятся на одном Deno Deploy проекте (backend + static assets).

## Этапы реализации
1. Создать `services/orbit-deno`:
   - Config/env loader
   - KV-backed auth/session/device services
   - WebAuthn (SimpleWebAuthn) flows
   - WebSocket relay hub
   - Static assets serving (`dist` fallback для SPA)
2. Добавить Deno self-host wizards:
   - `bin/self-host-deno.sh`
   - `bin/self-host-deno.ps1`
3. Интегрировать провайдер в CLI:
   - `bin/codex-remote`, `bin/codex-remote.ps1`
   - парсинг `--provider cloudflare|deno`
   - `update` flow для deno redeploy
4. Обновить документацию:
   - `README.md`, `docs/self-hosting.md`, `docs/installation.md`
5. Валидация:
   - `bun run lint`
   - `bun run test`
   - `bun run ci:local`

## Ограничения и риски
- Deno Deploy не даёт прямой эквивалент Durable Objects; state relay между инстансами eventual-consistent.
- Для production устойчивости нужны reconnect/resubscribe и retry (в текущем протоколе уже есть базовые механизмы).

## Definition of Done
- `codex-remote self-host --provider deno --login` разворачивает рабочий стек.
- Frontend открывается с корректным `AUTH_URL` и может пройти login/device flow.
- Anchor подключается по `wss://.../ws/anchor` и обменивается сообщениями с web-клиентом.
- `codex-remote update` выполняет redeploy для deno-конфига.
