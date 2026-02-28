# Orbit Deno

Deno Deploy control-plane provider for Codex Remote.

## Endpoints

- `GET /health`
- `GET /auth/session`
- `POST /auth/register/*`
- `POST /auth/login/*`
- `POST /auth/refresh`
- `POST /auth/logout`
- `POST /auth/device/*`
- `GET/WS /ws/client`
- `GET/WS /ws/anchor`

## Run locally

```bash
deno run -A services/orbit-deno/main.ts
```

## Deploy

Use `codex-remote self-host --provider deno`.
