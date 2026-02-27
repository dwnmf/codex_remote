# Codex Remote

`Codex Remote` позволяет запускать и контролировать сессии `Codex CLI` на вашем компьютере с телефона, планшета или любого браузера.

Вы можете:
- запускать задачи удалённо;
- смотреть поток вывода агента в реальном времени;
- подтверждать/отклонять действия (например, запись файлов);
- просматривать диффы до применения изменений.

<img src="docs/assets/demo.gif" alt="Демо Codex Remote" width="320" />

## Что это такое

Codex Remote состоит из трёх частей:
- `Anchor` (локально): запускает `codex app-server` и передаёт команды/события.
- `Orbit` (в облаке): ретрансляция WebSocket, аутентификация, push-уведомления.
- `Web client` (в браузере): интерфейс управления сессиями.

Схема:

```text
Телефон / Браузер
        |
        | HTTPS + WebSocket
        v
Orbit (Cloudflare)
        ^
        | WebSocket
        v
Anchor (локально)
        |
        | JSON-RPC over stdio
        v
codex app-server
```

## Для кого

- Для разработчиков, которые запускают Codex локально и хотят контролировать его удалённо.
- Для команд, где нужно быстро согласовывать действия агента без доступа к ноутбуку.
- Для тех, кому важен self-hosting и контроль своей инфраструктуры.

## Ключевые возможности

- Удалённый запуск задач в Codex CLI.
- Live-поток ответов и событий сессии.
- Подтверждение опасных операций из браузера.
- Просмотр диффов по каждому шагу.
- Поддержка passkey (WebAuthn) в облачном режиме.
- Push-уведомления (при self-host настройке).
- Локальный режим без Cloudflare (для доверенной сети).

## Быстрый старт

### 1) Требования

- Windows-инсталлер (`install.ps1`) работает в двух режимах:
  - `source`: клон репозитория + Bun runtime (`git` + `bun`)
  - `release`: установка из prebuilt GitHub Release (без `git` и `bun` на клиенте)
  По умолчанию `auto`: если нет `git`/`bun`, выбирается `release`.
- Инсталлер проверяет `Codex CLI` и запускает `codex login`.
- Для self-host режима: аккаунт Cloudflare + `wrangler` CLI.

### 2) Установка

macOS / Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/dwnmf/codex_remote/main/install.sh | bash
```

Windows (PowerShell):

```powershell
iwr -useb https://raw.githubusercontent.com/dwnmf/codex_remote/main/install.ps1 | iex
```

Принудительный режим установки на Windows:

```powershell
$env:CODEX_REMOTE_INSTALL_MODE="release"   # или "source"
iwr -useb https://raw.githubusercontent.com/dwnmf/codex_remote/main/install.ps1 | iex
```

### 3) Первый запуск

```bash
codex-remote start
```

Для self-host:

```bash
codex-remote self-host
codex-remote start
```

Что произойдёт:
1. Откроется авторизация устройства.
2. Вы входите через passkey.
3. Anchor подключается к Orbit.
4. Веб-интерфейс готов к удалённому управлению.

Если нужно запускать self-host мастер прямо во время установки, используйте:

```bash
CODEX_REMOTE_RUN_SELF_HOST=1 curl -fsSL https://raw.githubusercontent.com/dwnmf/codex_remote/main/install.sh | bash
```

## Режимы работы

### Self-host (рекомендуется)

- Полный контроль над инфраструктурой в вашем Cloudflare.
- Аутентификация и уведомления работают из коробки после `codex-remote self-host`.

### Local mode (без Cloudflare)

Подходит для доверенной сети (LAN, Tailscale, WireGuard), когда облако не нужно.

Запуск Anchor:

```bash
cd services/anchor
bun install
ANCHOR_ORBIT_URL="" bun run dev
```

Запуск веб-клиента:

```bash
bun install
bun run dev -- --host 0.0.0.0
```

После этого откройте `http://<ваш-ip>:5173`.

Важно: в local mode нет встроенной аутентификации. Используйте только в доверенной сети.

## Команды CLI

| Команда | Описание |
|---|---|
| `codex-remote start` | Запуск Anchor |
| `codex-remote login` | Повторная авторизация устройства |
| `codex-remote doctor` | Проверка окружения и конфигурации |
| `codex-remote config` | Открыть `.env` в редакторе |
| `codex-remote update` | Обновить код и зависимости |
| `codex-remote self-host` | Мастер self-host развёртывания |
| `codex-remote uninstall` | Удалить Codex Remote |
| `codex-remote version` | Показать версию |
| `codex-remote help` | Справка по командам |

## Локальная разработка

Быстрые команды:

```bash
bun run lint
bun run test
bun run ci:local
```

Запуск полного локального стека (frontend + FastAPI control-plane + anchor):

```bash
bun run dev:all
```

По умолчанию:
- frontend: `http://localhost:5173`
- backend: `http://localhost:8080`

## Документация

- [Установка](docs/installation.md)
- [Self-hosting](docs/self-hosting.md)
- [Архитектура](docs/architecture.md)
- [Аутентификация](docs/auth.md)
- [События и протокол](docs/events.md)
- [Безопасность](docs/security.md)
- [FastAPI control-plane](docs/fastapi-control-plane.md)
- [Структура репозитория](docs/repo-structure.md)
- [Vision](docs/vision.md)

## Лицензия

[MIT](LICENSE)
