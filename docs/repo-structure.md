# Repo Structure

```
.
├── bin/
│   ├── codex-remote                          # CLI entry point
│   ├── self-host.sh                          # Cloudflare self-host wizard
│   └── self-host-deno.sh                     # Deno Deploy self-host wizard
├── docs/                             # Project documentation
├── migrations/                       # D1 database migrations
├── public/
│   ├── icons/                        # PWA icons
│   ├── manifest.json                 # PWA manifest
│   └── sw.js                         # Service worker
├── services/
│   ├── anchor/                       # Bun local bridge + app-server relay
│   │   ├── src/
│   │   └── package.json
│   ├── orbit/                        # Cloudflare Worker + Durable Object (relay + auth)
│   │   ├── src/
│   │   └── wrangler.toml
│   └── orbit-deno/                   # Deno Deploy runtime (relay + auth)
│       └── main.ts
├── src/                              # Web client (Svelte)
│   ├── lib/
│   │   ├── components/
│   │   └── styles/
│   ├── routes/
│   └── global.css
├── .env.example
├── install.sh                        # Installation script
├── package.json
├── tsconfig.json
├── vite.config.ts
├── svelte.config.js
└── wrangler.toml                     # Web client Pages config
```

## Notes
- The top-level `src/` is the web client (Svelte + Vite).
- The web client is static and can deploy to Cloudflare Pages or Deno Deploy.
- Orbit has two provider runtimes: Cloudflare (`services/orbit`) and Deno (`services/orbit-deno`).
- Anchor is Bun-only and runs locally on macOS.
- `bin/codex-remote` is the CLI entry point for local usage.
- `bin/self-host*.sh` are provider-specific self-host wizards invoked by `codex-remote self-host --provider ...`.
- `install.sh` handles cloning, dependency install, and PATH setup.
