# Структура репозитория

```text
.
├── bin/
│   ├── codex-remote                          # CLI entry point
│   ├── self-host.sh                          # self-host мастер для Cloudflare
│   └── self-host-deno.sh                     # self-host мастер для Deno Deploy
├── docs/                                     # Проектная документация
├── migrations/                               # Миграции БД (D1/совместимые схемы)
├── public/
│   ├── icons/                                # Иконки PWA
│   ├── manifest.json                         # PWA manifest
│   └── sw.js                                 # Service worker
├── services/
│   ├── anchor/                               # Локальный Bun bridge + relay к app-server
│   │   ├── src/
│   │   └── package.json
│   ├── orbit/                                # Cloudflare Worker + Durable Object (relay + auth)
│   │   ├── src/
│   │   └── wrangler.toml
│   ├── orbit-deno/                           # Deno Deploy runtime (relay + auth)
│   │   └── main.ts
│   └── control-plane/                        # FastAPI control plane (альтернативный backend)
│       ├── app/
│       ├── tests/
│       └── requirements.txt
├── src/                                      # Web client (Svelte)
│   ├── lib/
│   │   ├── components/
│   │   └── styles/
│   ├── routes/
│   └── global.css
├── .env.example
├── install.sh                                # Установщик для macOS/Linux
├── install.ps1                               # Установщик для Windows
├── package.json
├── tsconfig.json
├── vite.config.ts
├── svelte.config.js
└── wrangler.toml                             # Конфиг деплоя web client (Cloudflare Pages)
```

## Примечания

- Верхнеуровневый `src/` - это web client (Svelte + Vite).
- Frontend статический и может быть задеплоен на Cloudflare Pages, Deno Deploy, Vercel и другие static host.
- Control plane реализован в трёх вариантах: Cloudflare (`services/orbit`), Deno (`services/orbit-deno`) и FastAPI (`services/control-plane`).
- Anchor (`services/anchor`) запускается локально и общается с `codex app-server` через stdio.
- `bin/codex-remote` - основной CLI для локального использования.
- `bin/self-host*.sh` - провайдер-специфичные мастера, вызываемые командой `codex-remote self-host --provider ...`.
- `install.sh`/`install.ps1` отвечают за bootstrap, зависимости и настройку PATH.
