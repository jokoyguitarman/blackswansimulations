# AGENTS.md

## Cursor Cloud specific instructions

### Product overview

**Unified Simulation Environment (USE)** / Black Swan Simulations — a monorepo crisis-coordination training platform. One Node/Express backend (API + Socket.io + in-process schedulers) and one React/Vite frontend. **Supabase** (hosted Postgres + Auth) is required; there is no local database or Docker Compose in this repo.

### Ports (local dev)

| Service                 | Default URL             |
| ----------------------- | ----------------------- |
| Backend API + WebSocket | `http://localhost:3001` |
| Frontend (Vite)         | `http://localhost:3002` |

`frontend/vite.config.ts` uses port **3002** (not 3000). Set `CLIENT_URL=http://localhost:3002` in root `.env` so CORS matches. Set `VITE_API_URL=http://localhost:3001` in `frontend/.env.local` so WebSockets hit the backend directly.

### Required environment files

Create these locally (both are gitignored):

**Root `.env`** — see `docs/ENV_TEMPLATE.md`. Minimum required:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

**`frontend/.env.local`** — minimum required:

- `VITE_SUPABASE_URL` (same project URL as above)
- `VITE_SUPABASE_ANON_KEY`
- `VITE_API_URL=http://localhost:3001` (recommended)

Without these, the backend exits on startup and the frontend shows a full-screen `SupabaseConfigError` overlay.

### Start commands

From repo root after env files exist:

```bash
npm run dev          # backend + frontend (concurrently)
npm run dev:server   # backend only (tsx watch)
npm run dev:client   # frontend only (vite)
```

### Lint / typecheck / build / test

| Command                  | Notes                                                                                                                                                               |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck`      | `tsc --noEmit` — should pass                                                                                                                                        |
| `npm run lint`           | ESLint on `server/`, `shared/`, `src/` — may report pre-existing unused-var issues in `server/routes/resources.ts` and `server/services/participantScoreService.ts` |
| `npm run build:server`   | Compiles backend to `dist/`                                                                                                                                         |
| `npm run build:frontend` | Builds SPA to `frontend/dist/`                                                                                                                                      |
| `npm test`               | Stub only (`exit 1`); no automated test suite                                                                                                                       |

### Database migrations

Apply SQL files under `migrations/` in numeric order via the Supabase SQL Editor (or `supabase db push` if linked). Demo scenario seeds live in `demo/`. See `migrations/README.md` and `demo/README.md`.

### Gotchas

- **No Docker / local Supabase** in this repo — cloud agents need real Supabase project credentials as secrets.
- **OpenAI** (`OPENAI_API_KEY`) is optional for startup but required for AI features (injects, AAR, war room).
- **Husky** runs `lint-staged` on pre-commit; `npm install` triggers `husky install` via `prepare`.
- **Presentation deck** (`presentation/index.html`) is static and can be opened without the backend; it is not the main app.
