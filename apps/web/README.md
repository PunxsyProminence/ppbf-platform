# `apps/web` — PPBF Platform web application

The Next.js App Router application that is the PPBF Platform: athlete, coach,
parent, board and admin surfaces, the pilot API under `app/api/pilot/**`, and
the SHADOW interfaces. Server-side domain logic lives in `src/server/pilot/`.

Setup, environment variables and the local database are covered once, at the
repository root — not duplicated here, because a second copy is a second thing
to go stale:

- [`../../README.md`](../../README.md) — what the platform is, how to run it
- [`../../DEVELOPER_ONBOARDING.md`](../../DEVELOPER_ONBOARDING.md) — first-run setup
- [`../../AUTH_CONTRACT.md`](../../AUTH_CONTRACT.md) — roles, sessions, guards
- [`../../docs/FRONTEND_STYLE_CONTRACT.md`](../../docs/FRONTEND_STYLE_CONTRACT.md) — design-system rules

## Checks

Run from the repository root, not from here:

```bash
npm run typecheck     # both projects
npm run lint
npm test              # unit and component suites
npm run test:migrations   # real-Postgres suites; required when SQL or
                          # src/server/pilot persistence code changes
```

## PDF ingest backend pipeline

A backend ingestion route at `/api/document-ingest`:

1. Accepts PDF uploads.
2. Extracts text and classifies destination context.
3. Writes a Dataverse record.
4. Uploads the PDF to SharePoint and Google Drive.
5. Appends an audit entry to `.audit/document-ingest.jsonl`.

Copy `.env.example` and fill the required Dataverse, Graph and Google Drive
values before using it.

### Local mock ingest run

Set `PPBF_MOCK_INGEST_SESSION_TOKEN` to an active organization-admin session
token, then:

```bash
npm run audit:mock-ingest
```

This sets `PPBF_INGEST_MOCK_MODE=true`, generates a mock PDF, posts it through
the authenticated API route, and validates the response contract without
writing to Dataverse, SharePoint or Google Drive. It still needs the configured
PostgreSQL database, to validate the session and append the ingest audit event.
