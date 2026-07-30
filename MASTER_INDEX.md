# PPBF Master Index

Entry point for the repository. Anything not listed here is either archived or
generated.

**Currency warning:** the documents below were written at various points and are
not automatically kept in sync with the code. `origin/main` and the deployed
container revision are the only authorities on current behaviour. Local
branches in this repo have repeatedly been many commits behind — verify against
`origin/main`, not a local checkout.

## Start here

- [README.md](README.md) — what the project is, verified quick start
- [DEVELOPER_ONBOARDING.md](DEVELOPER_ONBOARDING.md) — getting a local environment running
- [SEED_GUIDE.md](SEED_GUIDE.md) — seeding data

## Contracts and interfaces

- [AUTH_CONTRACT.md](AUTH_CONTRACT.md) — authentication and principal model
- [docs/FRONTEND_STYLE_CONTRACT.md](docs/FRONTEND_STYLE_CONTRACT.md) — UI conventions

Note: `API_DOCS.md` and `QUALITY_CHECKLIST.md` were archived — both described
a planned/aspirational state (a placeholder endpoint list and a governance
checklist) that never matched the real API surface or dev workflow. The real
HTTP surface lives under `apps/web/app/api/**/route.ts`; the real quality
gates are `npm run typecheck` / `lint` / `test`.

## Architecture

- [ORGANIZATION_ARCHITECTURE.md](ORGANIZATION_ARCHITECTURE.md) — multi-org isolation
  model; Platform Owner boundary section reflects standing cross-org visibility
  into de-identified data for pilot ops + SHADOW learning, not deny-by-default
- [ORGANIZATION_ROLE_MODEL.md](ORGANIZATION_ROLE_MODEL.md) — role hierarchy and
  permission matrix; cross-check role names against the live `PilotRole` enum
  in [apps/web/src/server/pilot/contracts.ts](apps/web/src/server/pilot/contracts.ts)
- [ORGANIZATION_ADMIN_WORKFLOW.md](ORGANIZATION_ADMIN_WORKFLOW.md) — org
  lifecycle workflow, tracks closely to real functions in
  [apps/web/src/server/pilot/auth.ts](apps/web/src/server/pilot/auth.ts)

## SHADOW

- [docs/archive/SHADOW_SPECIFICATION.md](docs/archive/SHADOW_SPECIFICATION.md) — archived vision doc; do not build from it
- [docs/SHADOW_AUTHORITY_MODEL.md](docs/SHADOW_AUTHORITY_MODEL.md)
- [docs/SHADOW_EVENT_MODEL.md](docs/SHADOW_EVENT_MODEL.md)
- [docs/SHADOW_PHASE1_HARDENING_CHECKLIST.md](docs/SHADOW_PHASE1_HARDENING_CHECKLIST.md)
- [docs/SHADOW_CHAT_FUNCTIONALITY_AUDIT_2026-07-28.md](docs/SHADOW_CHAT_FUNCTIONALITY_AUDIT_2026-07-28.md)
  — dated audit, but still live: 8 of its findings are fixed and recorded as
  such, while 4 dimensions were never audited and its 13 `[U]` findings were
  never verified. Treat the remainder as a to-check queue, not as fact.

## Audits

Point-in-time, but not archived — these describe issues that may still be open.

- [docs/DEEP_CRITICAL_APP_AUDIT_2026-07-18.md](docs/DEEP_CRITICAL_APP_AUDIT_2026-07-18.md)

## Operations

- [docs/PRODUCTION_READINESS.md](docs/PRODUCTION_READINESS.md)
- [docs/MULTI_ORG_MIGRATION_RUNBOOK.md](docs/MULTI_ORG_MIGRATION_RUNBOOK.md)
- [docs/MULTI_ORG_ROLLBACK_RUNBOOK.md](docs/MULTI_ORG_ROLLBACK_RUNBOOK.md)
- [docs/MULTI_ORG_SMOKE_TEST_PLAN.md](docs/MULTI_ORG_SMOKE_TEST_PLAN.md)
- [docs/governance-rules.md](docs/governance-rules.md)
- [scripts/README.md](scripts/README.md)

Database migrations are applied by a controlled operator script under an
advisory lock, never from an HTTP route and never from CI.

## Code

- `apps/web` — the Next.js application (App Router)
- `packages/` — governance, routing, execution, intelligence, continuity
- `infra/azure/` — Postgres schema and migrations for the `pilot.*` schema
- `infra/supabase/schema.sql` — earlier Supabase schema

## Archive

[docs/archive/](docs/archive/) holds point-in-time audits, reports, and
superseded plans. Read its README before trusting anything in it — several of
those documents describe a version of the platform that no longer exists.
