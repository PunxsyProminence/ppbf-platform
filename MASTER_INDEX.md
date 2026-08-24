# PPBF Master Index

A thin pointer map. Orientation lives in [README.md](README.md); AI working
rules live in [AGENT_KERNEL.md](AGENT_KERNEL.md). Current `origin/main` and
observed deployed state beat prose everywhere.

## Start here

1. [README.md](README.md) — what PPBF is, the operating model, the
   documentation hierarchy.
2. [AGENT_KERNEL.md](AGENT_KERNEL.md) — execution contract for AI work,
   including its read path for domain documents.
3. [docs/current/ACTIVE_WORK.md](docs/current/ACTIVE_WORK.md) — current
   blockers and parked work.

## Domain contracts (read when the task touches them)

- Auth/roles: [AUTH_CONTRACT.md](AUTH_CONTRACT.md),
  [ORGANIZATION_ROLE_MODEL.md](ORGANIZATION_ROLE_MODEL.md),
  [ORGANIZATION_ARCHITECTURE.md](ORGANIZATION_ARCHITECTURE.md),
  [ORGANIZATION_ADMIN_WORKFLOW.md](ORGANIZATION_ADMIN_WORKFLOW.md)
- Capabilities and go-live: [docs/capabilities/](docs/capabilities/README.md)
  (lifecycle, contracts, [GATES.md](docs/capabilities/GATES.md))
- SHADOW: [docs/SHADOW_AUTHORITY_MODEL.md](docs/SHADOW_AUTHORITY_MODEL.md) and
  the SHADOW documents AGENT_KERNEL's read path names
- Design: [design-system/README.md](design-system/README.md),
  [docs/FRONTEND_STYLE_CONTRACT.md](docs/FRONTEND_STYLE_CONTRACT.md)
- Release/deploy/migrations:
  [docs/AI_DELIVERY_PIPELINE.md](docs/AI_DELIVERY_PIPELINE.md) plus the
  relevant runbook under `docs/`

## Development

- [apps/web/README.md](apps/web/README.md) — run, test, build
- [DEVELOPER_ONBOARDING.md](DEVELOPER_ONBOARDING.md) — first-run setup
- [SEED_GUIDE.md](SEED_GUIDE.md) — seed data

Database/schema changes use the controlled migration mechanisms already in the
repository. No HTTP route changes the schema.

## Historical material

- [docs/current/WORK_QUEUE.md](docs/current/WORK_QUEUE.md) — provenance ledger
- [docs/current/PRODUCTION_STATE.json](docs/current/PRODUCTION_STATE.json) —
  observed deployment truth
- [docs/archive/](docs/archive/README.md) — point-in-time snapshots, never
  current authority
