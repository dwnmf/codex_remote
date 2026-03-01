# Установка Codex Remote

Codex Remote запускает локальный сервис Anchor на вашей машине и подключает его к Orbit (control plane), чтобы вы могли управлять сессиями Codex удалённо через браузер.

## Требования

- macOS или Linux для установки через `install.sh`
- Windows для установки через `install.ps1`
- интернет-доступ для загрузки зависимостей

Для Windows-установщика `install.ps1` доступны режимы:

- `source`: клонирование репозитория + запуск через Bun (нужны `git` и `bun`)
- `release`: загрузка готового пакета из GitHub Releases (на клиенте не нужны `git` и `bun`)

Режим по умолчанию: `auto`.

- если установлены и `git`, и `bun` -> используется `source`
- иначе -> используется `release`

Установщик проверяет доступность [Codex CLI](https://github.com/openai/codex) и запускает `codex login`.

Если нужен облегчённый backend вместо Cloudflare Orbit, см. [FastAPI Control Plane](fastapi-control-plane.md).

## Установка

macOS / Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/dwnmf/codex_remote/main/install.sh | bash
```

Windows (PowerShell):

```powershell
iwr -useb https://raw.githubusercontent.com/dwnmf/codex_remote/main/install.ps1 | iex
```

Принудительно выбрать режим установки на Windows:

```powershell
$env:CODEX_REMOTE_INSTALL_MODE="release"   # или "source"
iwr -useb https://raw.githubusercontent.com/dwnmf/codex_remote/main/install.ps1 | iex
```

В `release`-режиме установщик скачивает `codex-remote-windows-x64.zip` в `~/.codex-remote`, ставит CLI-обёртки и использует включённый `anchor.exe`.

Запустить self-host мастер прямо в процессе установки:

```bash
CODEX_REMOTE_RUN_SELF_HOST=1 curl -fsSL https://raw.githubusercontent.com/dwnmf/codex_remote/main/install.sh | bash
```

## Сборка из исходников

```bash
git clone https://github.com/dwnmf/codex_remote.git ~/.codex-remote
cd ~/.codex-remote/services/anchor && bun install
```

Добавьте `~/.codex-remote/bin` в `PATH`.

## Первичная настройка

1. Если self-host не запускали во время установки: `codex-remote self-host --provider cloudflare --login` (или `--provider deno --login`)
2. Запустите `codex-remote start` (или `codex-remote login` для переавторизации)
3. В терминале появится device code
4. Откроется браузер для подтверждения входа
5. Данные сохранятся в `~/.codex-remote/credentials.json`

## Запуск

```bash
codex-remote start
```

После запуска Anchor подключается к Orbit и ждёт команд из веб-клиента.

## Команды CLI

| Команда | Назначение |
|---|---|
| `codex-remote start` | Запуск Anchor |
| `codex-remote login` | Переавторизация устройства |
| `codex-remote doctor` | Проверка окружения и конфигурации |
| `codex-remote config` | Открыть `.env` в редакторе |
| `codex-remote update` | Обновить код, зависимости и выполнить redeploy self-host (если настроен) |
| `codex-remote self-host --provider cloudflare\|deno --login\|--no-login` | Мастер self-host и управление post-setup логином |
| `codex-remote uninstall` | Удалить Codex Remote |
| `codex-remote version` | Показать версию |
| `codex-remote help` | Показать справку |

## Проверка установки

```bash
codex-remote doctor
```

Проверяются Bun, Codex CLI, исходники Anchor, зависимости, `.env`, креды и статус Anchor.

## Обновление

```bash
codex-remote update
```

Команда подтягивает актуальный код, переустанавливает зависимости и, если настроен self-host, повторно деплоит backend/frontend для выбранного провайдера.

## Self-host

```bash
codex-remote self-host --provider cloudflare
# или:
codex-remote self-host --provider deno
```

Полный сценарий развёртывания описан в [self-hosting.md](self-hosting.md).

## Типовые проблемы

### `codex-remote: command not found`

Убедитесь, что `~/.codex-remote/bin` есть в `PATH`:

```bash
echo 'export PATH="$HOME/.codex-remote/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

### Ошибки подключения

```bash
codex-remote login
```

### Диагностика

```bash
codex-remote doctor
```
