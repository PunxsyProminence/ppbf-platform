# `apps/web` — PPBF Platform web application

The Next.js App Router application that is the PPBF Platform: athlete, coach,
parent, board and admin surfaces, the pilot API under `app/api/pilot/**`, and
the SHADOW interfaces. Server-side domain logic lives in `src/server/pilot/`.

Product and architecture context lives at the repository root — see
[`../../README.md`](../../README.md), [`../../DEVELOPER_ONBOARDING.md`](../../DEVELOPER_ONBOARDING.md)
(first-run setup), [`../../SEED_GUIDE.md`](../../SEED_GUIDE.md) (data seeding),
and [`../../AUTH_CONTRACT.md`](../../AUTH_CONTRACT.md) (roles, sessions, guards).

Note: `AGENTS.md` in this directory is maintained by `next dev` itself — this
repo runs a Next.js version with breaking changes, documented in
`node_modules/next/dist/docs/`. Read those docs, not your memory of Next.js.

## Prerequisites and install

- Node **22.x** (root `package.json` `engines`; CI runs Node 22).
- This is an npm workspace. Install from the **repository root**, never from
  this directory: `npm ci` (or `npm install`).

## Environment

Copy the repo-root [`../../.env.example`](../../.env.example) to
`apps/web/.env.local` and fill it in — the template documents which values are
required (`AZURE_POSTGRES_CONNECTION_STRING`, `AZURE_STORAGE_CONNECTION_STRING`)
and which are only needed for specific features. Never commit the filled copy.

## Run

From the repository root (each proxies into this workspace):

```bash
npm run dev      # next dev
npm run build    # next build + postbuild-swa packaging
npm start        # serve the production build
```

## Database and migrations

Schema changes are applied only through the controlled operator scripts —
`npm --workspace web run pilot:apply-schema` and the other `pilot:apply-*`
scripts — from an operator's shell or the manually dispatched
`apply-migrations` workflow. **No HTTP route ever carries DDL**;
`src/server/pilot/httpRoutesCarryNoDdl.test.ts` fails the build if one does.
`npm --workspace web run pilot:preflight` verifies environment and config.

## Checks

Run from the repository root — this matches what CI (`.github/workflows/ci.yml`)
runs on every non-docs PR:

```bash
npm run typecheck         # web app + root scripts
npm run lint
npm test                  # Jest; excludes *.pg.test.ts by design
npm run build
npm run test:migrations   # every embedded-Postgres suite; required when SQL or
                          # src/server/pilot persistence code changes
```

Each migration suite also runs alone as `test:migrations:<name>` (e.g.
`npm --workspace web run test:migrations:session`) — see this package's
`scripts` for the names. CI runs the full chain only when the diff touches
migration surface.

### End-to-end (Playwright)

There is no umbrella `test:e2e` script; the suites run individually, from this
workspace, against a dev server Playwright starts itself on port 3100:

```bash
npx --workspace web playwright install --with-deps chromium   # once
npm --workspace web run test:e2e:homepage   # also: :board :coach :athlete :guardian
```

The journey suites stub the pilot API and need no database. If port 3100 is
taken set `PPBF_E2E_PORT`; if your sandbox pins its own Chromium point
`PPBF_CHROMIUM_PATH` at it (see `playwright.config.ts`).

## PDF ingest mock run

`/api/document-ingest` accepts PDF uploads and writes to Dataverse, SharePoint
and Google Drive (configure via `.env.local`). To validate the route contract
locally without touching those services: set `PPBF_MOCK_INGEST_SESSION_TOKEN`
to an active organization-admin session token, then run
`npm --workspace web run audit:mock-ingest`. It still needs the configured
PostgreSQL database to validate the session and append the audit event.
