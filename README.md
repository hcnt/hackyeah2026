# hackyeah2026

FastAPI (`backend/`) + React/Vite/Tailwind/shadcn (`frontend/`) behind Caddy.

## Architecture

```
hackyeah.kindhome.io ───────┐
pr-12-hackyeah.kindhome.io ─┼─ Cloudflare ─ tunnel ─ cloudflared (host, systemd) ─ 127.0.0.1:8080
pr-15-hackyeah.kindhome.io ─┘                                                         │
                                                                  edge router (edge/, routes by Host)
                                                          ┌───────────────┼───────────────┐
                                                     prod stack      pr-12 stack     pr-15 stack
                                                  (caddy + backend, each its own compose project)
```

- Cloudflare terminates TLS. The VPS needs **no inbound ports** (only SSH).
- The edge router is the only thing published on the host (`127.0.0.1:8080`). Each stack's caddy joins
  the shared `edge` network under the alias `prod` or `pr-<N>`; inside a stack, caddy serves the React
  build and proxies `/api/*` to FastAPI.
- Cloudflare tunnel routes: `hackyeah.kindhome.io` and `*.kindhome.io` -> `http://localhost:8080`.

## Run locally (Docker)

```sh
docker compose -f edge/compose.yaml up -d --build   # once; owns :8080 and the "edge" network
docker compose -p prod up -d --build                # http://localhost:8080
```

## Deployment (GitHub Actions -> VPS)

| Workflow | Trigger | Does |
|---|---|---|
| `deploy.yml` | push to `main` | rsync to `/opt/hackyeah2026`, `scripts/deploy-prod.sh` (edge + prod, health check) |
| `preview.yml` | PR opened/updated | rsync to `/opt/hackyeah2026-previews/pr-N`, `scripts/deploy-preview.sh N` |
| `preview.yml` | PR closed/merged | `scripts/teardown-preview.sh N` (containers, volumes, images, checkout) |
| `preview-cleanup.yml` | daily 03:00 UTC | removes previews of PRs that are no longer open |

Each PR gets `https://pr-<N>-hackyeah.kindhome.io` and a "View deployment" link on the PR.

Repo secrets: `DEPLOY_HOST`, `DEPLOY_SSH_KEY` (dedicated key, `restrict`ed in `authorized_keys`),
`DEPLOY_KNOWN_HOSTS` (pinned host key). Every other repo variable and secret (e.g. `ORACLE_KEYPAIR`, see
`.env.example`) is written to prod's `.env` on every deploy and passed to the backend; previews get no `.env`,
so they pay with in-memory stubs.
Fork and Dependabot PRs do not get previews.

If the site breaks, test the origin first on the VPS:
`curl -H 'Host: hackyeah.kindhome.io' http://127.0.0.1:8080/api/health` (or `pr-N-hackyeah...`).
Origin OK -> the problem is in the tunnel/Cloudflare config, not the app.

## Local dev (hot reload)

```sh
cd backend && uv run uvicorn app.main:app --reload  # :8000
cd frontend && npm run dev                     # :5173, proxies /api -> :8000
```

Add shadcn components: `cd frontend && npx shadcn@latest add <component>`.
