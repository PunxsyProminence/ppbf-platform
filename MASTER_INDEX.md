# PPBF Master Index

Entry point for the repository. Anything not listed here is either archived or
generated.

**Currency warning:** the documents below were written at various points and are
not automatically kept in sync with the code. `origin/main` and the deployed
container revision are the only authorities on current behaviour. Local
branches in this repo have repeatedly been many commits behind — verify against
`origin/main`, not a local checkout.

## Start here

- [README.md](README.md) — what the project is
- [DEVELOPER_ONBOARDING.md](DEVELOPER_ONBOARDING.md) — getting a local environment running
- [SEED_GUIDE.md](SEED_GUIDE.md) — seeding data
- [QUALITY_CHECKLIST.md](QUALITY_CHECKLIST.md) — what to check before shipping

## Contracts and interfaces

- [AUTH_CONTRACT.md](AUTH_CONTRACT.md) — authentication and principal model
- [API_DOCS.md](API_DOCS.md) — HTTP surface
- [docs/FRONTEND_STYLE_CONTRACT.md](docs/FRONTEND_STYLE_CONTRACT.md) — UI conventions

## Architecture

- [ORGANIZATION_ARCHITECTURE.md](ORGANIZATION_ARCHITECTURE.md)
- [ORGANIZATION_ROLE_MODEL.md](ORGANIZATION_ROLE_MODEL.md)
- [ORGANIZATION_ADMIN_WORKFLOW.md](ORGANIZATION_ADMIN_WORKFLOW.md)
- [TENANT_ARCHITECTURE.md](TENANT_ARCHITECTURE.md)
- [PPBF_CORE_ENTITY_MAP_REALITY_BASED.md](PPBF_CORE_ENTITY_MAP_REALITY_BASED.md)
- [PPBF_RELATIONSHIP_MAP_REALITY_BASED.md](PPBF_RELATIONSHIP_MAP_REALITY_BASED.md)
- [PPBF_CAPABILITY_MAP_REALITY_BASED.md](PPBF_CAPABILITY_MAP_REALITY_BASED.md)
- [PPBF_MISSING_CAPABILITY_REGISTER_REALITY_BASED.md](PPBF_MISSING_CAPABILITY_REGISTER_REALITY_BASED.md)
- [PPBF_DATAVERSE_BLUEPRINT_REALITY_BASED.md](PPBF_DATAVERSE_BLUEPRINT_REALITY_BASED.md)
- [PPBF_MULTI_GYM_READINESS_NOTES.md](PPBF_MULTI_GYM_READINESS_NOTES.md)

## SHADOW

- [docs/SHADOW_SPECIFICATION.md](docs/SHADOW_SPECIFICATION.md)
- [docs/SHADOW_AUTHORITY_MODEL.md](docs/SHADOW_AUTHORITY_MODEL.md)
- [docs/SHADOW_EVENT_MODEL.md](docs/SHADOW_EVENT_MODEL.md)
- [docs/SHADOW_PHASE1_HARDENING_CHECKLIST.md](docs/SHADOW_PHASE1_HARDENING_CHECKLIST.md)

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
