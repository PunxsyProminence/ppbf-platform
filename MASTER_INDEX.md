# PPBF Master Index

Primary entry points for the repository. This is an index, not a claim that every other file is current.

**Currency rule:** current `origin/main` and observed deployed state beat prose. Dated audits, old queues, plans, and local branches are evidence/history unless current source confirms them.

## AI start path

For AI-assisted work, start here and stop loading documents once the task is sufficiently grounded:

1. [AGENT_KERNEL.md](AGENT_KERNEL.md) — default execution contract.
2. [docs/current/ACTIVE_WORK.md](docs/current/ACTIVE_WORK.md) — small current blocker/parked-work view.
3. Current source + live open PRs — coordination truth.
4. The user request or assigned ticket, if one exists.

Load [docs/AI_COLLABORATION.md](docs/AI_COLLABORATION.md) only when concurrent AI work may overlap.

Load domain/release documents only when the touched surface requires them:

- release/deploy/migrations: [docs/AI_DELIVERY_PIPELINE.md](docs/AI_DELIVERY_PIPELINE.md) plus the relevant runbook/workflow
- auth/roles: [AUTH_CONTRACT.md](AUTH_CONTRACT.md), [ORGANIZATION_ROLE_MODEL.md](ORGANIZATION_ROLE_MODEL.md)
- SHADOW: [docs/SHADOW_AUTHORITY_MODEL.md](docs/SHADOW_AUTHORITY_MODEL.md), [docs/SHADOW_ML_ARCHITECTURE_SPEC.md](docs/SHADOW_ML_ARCHITECTURE_SPEC.md), and relevant safety rules
- database/schema: existing migration/runner pattern plus applicable sections of [docs/AI_CONTRIBUTOR_GUARDRAILS.md](docs/AI_CONTRIBUTOR_GUARDRAILS.md)
- visual design: [design-system/README.md](design-system/README.md), [design-system/ppbf.css](design-system/ppbf.css)
- audit/provenance: [docs/current/WORK_QUEUE.md](docs/current/WORK_QUEUE.md), [docs/current/PRODUCTION_STATE.json](docs/current/PRODUCTION_STATE.json)

The historical work queue and long contributor guardrails are **not** default startup reading.

## Developer setup

- [README.md](README.md) — project overview and verified quick start
- [DEVELOPER_ONBOARDING.md](DEVELOPER_ONBOARDING.md) — local environment
- [SEED_GUIDE.md](SEED_GUIDE.md) — seed data

## Architecture and contracts

- [AUTH_CONTRACT.md](AUTH_CONTRACT.md) — authentication/principal model
- [ORGANIZATION_ARCHITECTURE.md](ORGANIZATION_ARCHITECTURE.md) — organization isolation model
- [ORGANIZATION_ROLE_MODEL.md](ORGANIZATION_ROLE_MODEL.md) — role hierarchy/permissions
- [ORGANIZATION_ADMIN_WORKFLOW.md](ORGANIZATION_ADMIN_WORKFLOW.md) — organization lifecycle
- [docs/BOARD_SEAT_ASSIGNMENT.md](docs/BOARD_SEAT_ASSIGNMENT.md) — board seats and concurrency rules
- [docs/PAYMENT_SERVICE_SLOT.md](docs/PAYMENT_SERVICE_SLOT.md) — reserved payment capability

## Design

- [design-system/README.md](design-system/README.md) — design laws and usage
- [design-system/ppbf.css](design-system/ppbf.css) — token/component source of truth
- [docs/FRONTEND_STYLE_CONTRACT.md](docs/FRONTEND_STYLE_CONTRACT.md) — frontend conventions
- [apps/web/src/design/PAGE_MAP.md](apps/web/src/design/PAGE_MAP.md) — route/design inventory; verify against source before trusting stale counts

Older retro/design briefs remain useful as rationale/reference but do not override the shipped design system.

## SHADOW and evidence

- [docs/SHADOW_AUTHORITY_MODEL.md](docs/SHADOW_AUTHORITY_MODEL.md)
- [docs/SHADOW_EVENT_MODEL.md](docs/SHADOW_EVENT_MODEL.md)
- [docs/SHADOW_PHASE1_HARDENING_CHECKLIST.md](docs/SHADOW_PHASE1_HARDENING_CHECKLIST.md)
- [docs/SHADOW_ML_ARCHITECTURE_SPEC.md](docs/SHADOW_ML_ARCHITECTURE_SPEC.md)
- [docs/RESEARCH_EVIDENCE_REGISTRY.md](docs/RESEARCH_EVIDENCE_REGISTRY.md)
- [docs/SHADOW_RESEARCH_INTAKE_IMPORT.md](docs/SHADOW_RESEARCH_INTAKE_IMPORT.md)

Dated SHADOW audits are point-in-time evidence only; verify any open finding against current source before building from it.

## Operations

- [docs/AI_DELIVERY_PIPELINE.md](docs/AI_DELIVERY_PIPELINE.md) — detailed release/integration history and controls; conditional reading
- [docs/AI_CONTRIBUTOR_GUARDRAILS.md](docs/AI_CONTRIBUTOR_GUARDRAILS.md) — detailed incident-derived domain rules; conditional reading
- [docs/current/WORK_QUEUE.md](docs/current/WORK_QUEUE.md) — historical/provenance ledger, not ordinary build workflow
- [docs/current/PRODUCTION_STATE.json](docs/current/PRODUCTION_STATE.json) — observed deployment truth ledger
- [docs/PRODUCTION_READINESS.md](docs/PRODUCTION_READINESS.md)
- [docs/MULTI_ORG_MIGRATION_RUNBOOK.md](docs/MULTI_ORG_MIGRATION_RUNBOOK.md)
- [docs/MULTI_ORG_ROLLBACK_RUNBOOK.md](docs/MULTI_ORG_ROLLBACK_RUNBOOK.md)
- [docs/MULTI_ORG_SMOKE_TEST_PLAN.md](docs/MULTI_ORG_SMOKE_TEST_PLAN.md)
- [docs/BACKUP_RUNBOOK.md](docs/BACKUP_RUNBOOK.md)
- [docs/DATA_RETENTION.md](docs/DATA_RETENTION.md)

Database/schema changes use the controlled migration mechanisms already in the repository. No HTTP route changes the schema.

## Code

- `apps/web` — live Next.js application
- `infra/azure/` — Postgres schema/migrations
- `scripts/` — repository tooling and deterministic helpers
- `packages/` — legacy/support packages; verify live imports before extending

## Historical material

- [docs/current/WORK_QUEUE.md](docs/current/WORK_QUEUE.md) retains detailed shipped/collision/runtime-verification history.
- [docs/archive/](docs/archive/) contains archived point-in-time material.
- Dated audit/build-plan documents outside the archive may still contain unresolved leads, but a lead is not a current defect until verified against source/runtime.
