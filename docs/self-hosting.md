# Self-hosting

Codex Remote можно полностью развернуть в своём аккаунте с провайдером `cloudflare` или `deno`.

Команда `codex-remote self-host` запускает единый мастер деплоя для обоих вариантов.

## Требования

- macOS/Linux/Windows
- установленный [Bun](https://bun.sh)
- установленный [Codex CLI](https://github.com/openai/codex)
- установленный Codex Remote (см. [installation.md](installation.md))
- аккаунт провайдера:
  - Cloudflare (подходит free tier)
  - Deno Deploy (подходит free tier)

Провайдерные инструменты:

- `cloudflare`: `wrangler`
- `deno`: `deployctl` (глобально или через `deno run -A jsr:@deno/deployctl`)

Для Deno нужен `DENO_DEPLOY_TOKEN`.

## Что деплоится

| Сервис | Платформа | Назначение |
|---|---|---|
| Orbit / Control Plane | Cloudflare Worker + DO или Deno Deploy runtime | auth, выпуск токенов, websocket relay между web и Anchor |
| Web | Cloudflare Pages или Deno Deploy static | статический Svelte frontend |

Хранилище состояния:

- `cloudflare`: D1
- `deno`: Deno KV

JWT/служебные секреты генерируются мастером и автоматически прокидываются в окружение деплоя.

## Запуск мастера

```bash
codex-remote self-host --provider cloudflare
# или:
codex-remote self-host --provider deno
# принудительно выполнить login после настройки:
codex-remote self-host --provider deno --login
```

Мастер можно запустить:

1. во время `install.sh` / `install.ps1`, или
2. позже вручную из терминала.

## Что делает мастер

1. Проверяет проект и локальные зависимости
2. Проверяет инструменты провайдера (`wrangler`/`deployctl`)
3. Для Deno проверяет `DENO_DEPLOY_TOKEN`
4. Генерирует JWT/VAPID секреты
5. Деплоит backend (Orbit/control-plane)
6. Собирает frontend с корректным `AUTH_URL`
7. Деплоит статический web
8. Записывает значения в `.env` для Anchor

В конце печатает URL и следующие шаги.

По умолчанию после деплоя спрашивает, запускать ли `codex-remote login`. Поведение можно зафиксировать флагами `--login`/`--no-login`.

## Поведение при ошибках

`codex-remote self-host` завершится с non-zero кодом, если критический этап не прошёл.

После исправления причины ошибку можно безопасно повторно прогнать ту же команду.

## После деплоя

1. Откройте URL приложения (из вывода мастера) и создайте/войдите в аккаунт
2. Запустите `codex-remote start` для подключения локального Anchor

## Обновление self-host окружения

```bash
codex-remote update
```

Команда пере-деплоит web + backend для провайдера из `SELF_HOST_PROVIDER`.

Если update не прошёл, исправьте окружение (например, auth у провайдера) и повторите.

Пример ручного redeploy для Cloudflare:

```bash
# redeploy orbit
(cd ~/.codex-remote/services/orbit && wrangler deploy)

# rebuild + deploy web
(cd ~/.codex-remote && bun run build && wrangler pages deploy dist --project-name codex-remote)
```

## Архитектура

Подробности взаимодействия компонентов: [architecture.md](architecture.md).
