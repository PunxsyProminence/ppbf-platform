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
   blockers and parked work, open owner questions, and the build list.
4. [docs/current/OWNER_DECISIONS.md](docs/current/OWNER_DECISIONS.md) — the
   decisions Jason has made, in his words. Read it before writing a test,
   gate, migration or policy that asserts who may do what.

Roles (who builds, plans, reviews and merges) are set by OD-2026-09-28-001 in
[docs/current/OWNER_DECISIONS.md](docs/current/OWNER_DECISIONS.md) and stated
in [AGENT_KERNEL.md](AGENT_KERNEL.md), "Roles", with what each AI can do in
its capability table.

## Domain contracts (read when the task touches them)

- Auth/roles: [AUTH_CONTRACT.md](AUTH_CONTRACT.md),
  [ORGANIZATION_ROLE_MODEL.md](ORGANIZATION_ROLE_MODEL.md),
  [ORGANIZATION_ARCHITECTURE.md](ORGANIZATION_ARCHITECTURE.md),
  [ORGANIZATION_ADMIN_WORKFLOW.md](ORGANIZATION_ADMIN_WORKFLOW.md)
- Capabilities: [docs/capabilities/](docs/capabilities/README.md); build
  status lives in the module files under `docs/capabilities/modules/`
  (OD-2026-09-28-010 item 17); [GATES.md](docs/capabilities/GATES.md)
- SHADOW: [docs/SHADOW_AUTHORITY_MODEL.md](docs/SHADOW_AUTHORITY_MODEL.md) and
  the SHADOW documents AGENT_KERNEL's read path names
- Design: [docs/GOLDEN-ERA-V1-CONTRACT.md](docs/GOLDEN-ERA-V1-CONTRACT.md)
  (the active look), [design-system/README.md](design-system/README.md) (the
  design laws OD-2026-09-28-009 keeps),
  [docs/FRONTEND_STYLE_CONTRACT.md](docs/FRONTEND_STYLE_CONTRACT.md); the
  visual build order is [docs/ROOM-MAP.md](docs/ROOM-MAP.md)
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
  audit snapshot, last changed 2026-08-29 (`1e087898`); history, not current
  deployed state (see `AGENT_KERNEL.md` on deployed state)
- [docs/archive/](docs/archive/README.md) — point-in-time snapshots, never
  current authority
