# Codex Remote

Codex Remote позволяет запускать и контролировать сессии Codex CLI на вашем компьютере с телефона, планшета или любого браузера.

Интерфейс показывает поток ответов в реальном времени, подтверждения действий и изменения файлов до применения.

<img src="docs/assets/demo.gif" alt="Демо Codex Remote" width="320" />

## Что Внутри

Архитектура состоит из трёх частей. Anchor работает локально и подключается к вашему `codex app-server`. Orbit работает в облаке и даёт аутентификацию, WebSocket relay и API. Web client открывается в браузере и управляет сессиями.

```text
Браузер
  │ HTTPS + WebSocket
  ▼
Orbit (Cloudflare или Deno Deploy)
  │ WebSocket
  ▼
Anchor (локально)
  │ JSON-RPC over stdio
  ▼
codex app-server
```

## Что Нового

В проект добавлен второй self-host провайдер `deno`, а также единый флоу `codex-remote self-host --provider ... --login`, который сразу после деплоя выполняет вход устройства без отдельного ручного шага.

| Функция | Как это работает сейчас |
|---|---|
| Два провайдера self-host | `cloudflare` и `deno` |
| Единый деплой+логин | `codex-remote self-host --provider <name> --login` |
| Обновление self-host | `codex-remote update` делает redeploy по `SELF_HOST_PROVIDER` |
| Валидация Deno токена | мастер проверяет `DENO_DEPLOY_TOKEN` и подсказывает ошибки |
| Совместимость с UI/Anchor | поддержаны `/ws/client`, `/ws/anchor`, device-login и session API |

## Быстрый Старт

### Установка на macOS или Linux

```bash
curl -fsSL https://raw.githubusercontent.com/dwnmf/codex_remote/main/install.sh | bash
```

### Установка на Windows

```powershell
iwr -useb https://raw.githubusercontent.com/dwnmf/codex_remote/main/install.ps1 | iex
```

### Установка на Windows в режиме release или source

```powershell
$env:CODEX_REMOTE_INSTALL_MODE="release"
iwr -useb https://raw.githubusercontent.com/dwnmf/codex_remote/main/install.ps1 | iex
```

```powershell
$env:CODEX_REMOTE_INSTALL_MODE="source"
iwr -useb https://raw.githubusercontent.com/dwnmf/codex_remote/main/install.ps1 | iex
```

### Запуск self-host через Cloudflare

```bash
codex-remote self-host --provider cloudflare --login
codex-remote start
```

### Запуск self-host через Deno Deploy

```bash
codex-remote self-host --provider deno --login
codex-remote start
```

Для Deno нужен `DENO_DEPLOY_TOKEN`. Токен можно создать в кабинете Deno Deploy: `https://dash.deno.com/account#access-tokens`. Текущий `deployctl` работает с Classic-организациями Deno Deploy.

### Запуск мастера self-host прямо во время install

```bash
CODEX_REMOTE_RUN_SELF_HOST=1 curl -fsSL https://raw.githubusercontent.com/dwnmf/codex_remote/main/install.sh | bash
```

## Команды CLI

| Команда | Назначение |
|---|---|
| `codex-remote start` | Запускает Anchor |
| `codex-remote login` | Повторно авторизует устройство |
| `codex-remote doctor` | Проверяет окружение, `.env`, токены и статус Anchor |
| `codex-remote config` | Открывает `.env` в редакторе |
| `codex-remote update` | Обновляет код, зависимости и self-host деплой |
| `codex-remote self-host --provider cloudflare|deno --login|--no-login` | Запускает мастер self-host и управляет post-setup логином |
| `codex-remote uninstall` | Удаляет Codex Remote |
| `codex-remote version` | Показывает версию |
| `codex-remote help` | Показывает справку |

## Схема Self-Host Флоу

```text
codex-remote self-host --provider deno --login
        │
        ├─ Проверка локального окружения
        ├─ Проверка провайдерных инструментов
        ├─ Генерация JWT и VAPID секретов
        ├─ Деплой Orbit backend
        ├─ Сборка и деплой web
        ├─ Запись .env для Anchor
        └─ codex-remote login
```

## Deno Провайдер: Аутентификация

На Deno-провайдере поддерживаются оба варианта входа в web: passkey и TOTP.

## Если Сессии Не Грузятся

Сначала проверьте состояние одной командой.

```bash
codex-remote doctor
```

Если в doctor всё `OK`, обычно помогает перезапуск Anchor.

```bash
codex-remote start
```

В self-host режиме URL в настройках должен вести на ваш Orbit endpoint и заканчиваться на `/ws/client`, например `wss://<your-app>.deno.dev/ws/client`.

## Локальная Разработка

```bash
bun run lint
bun run test
bun run ci:local
```

```bash
bun run dev:all
```

По умолчанию frontend открывается на `http://localhost:5173`, backend на `http://localhost:8080`.

## Документация

| Раздел | Ссылка |
|---|---|
| Установка | [docs/installation.md](docs/installation.md) |
| Self-hosting | [docs/self-hosting.md](docs/self-hosting.md) |
| Архитектура | [docs/architecture.md](docs/architecture.md) |
| Аутентификация | [docs/auth.md](docs/auth.md) |
| События и протокол | [docs/events.md](docs/events.md) |
| Безопасность | [docs/security.md](docs/security.md) |
| FastAPI control-plane | [docs/fastapi-control-plane.md](docs/fastapi-control-plane.md) |
| Структура репозитория | [docs/repo-structure.md](docs/repo-structure.md) |
| Vision | [docs/vision.md](docs/vision.md) |

## Лицензия

[MIT](LICENSE)
