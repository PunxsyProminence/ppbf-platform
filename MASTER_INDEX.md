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
- [docs/FRONTEND_STYLE_CONTRACT.md](docs/FRONTEND_STYLE_CONTRACT.md) — UI
  conventions, the alias layer, and drift guardrails. Holds no colour values of
  its own; the design system below is the source of truth for those.

## Visual design

- [design-system/README.md](design-system/README.md) — the "Leather & Brass"
  direction and the Eight Laws that govern it
- [design-system/ppbf.css](design-system/ppbf.css) — **the single source of truth**
  for every token, material, and component class. `@import`ed by
  [apps/web/app/globals.css](apps/web/app/globals.css), so the previews and the
  shipped app render against the same sheet and a value cannot drift between them.
  Zero external assets — all texture is generated from SVG `feTurbulence` data
  URIs, so the floor kiosk renders offline.
- [apps/web/src/design/PAGE_MAP.md](apps/web/src/design/PAGE_MAP.md) — which of
  three shapes each of the 61 routes takes, and which ground (ink for staff,
  warm canvas for family and public) it sits on
- `design-system/index.html` — browsable index of the foundation, component, and
  screen previews. Open it before designing a new surface.
- [docs/BRAND_DESIGN_BRIEF.md](docs/BRAND_DESIGN_BRIEF.md) — for generating
  **external** visuals (posters, social cards, grant covers) in tools that can't
  read CSS. The only document allowed to restate hex values, and it is transcribed
  from `ppbf.css` rather than being independent.

The retro spec set below predates the shipped design system.
[docs/RETRO_DESIGN_SYSTEM.md](docs/RETRO_DESIGN_SYSTEM.md) is **superseded** — its
tokens and components are dead and its `[data-theme="retro"]` coexistence plan was
never built; it is kept only as the rationale the Eight Laws came from. Its three
companions are functional rather than visual specs and were never verified against
the code, so treat them as proposals: [docs/USABILITY_SPEC_RETRO.md](docs/USABILITY_SPEC_RETRO.md),
[docs/STAMP_AND_LEDGER_SCHEMA.md](docs/STAMP_AND_LEDGER_SCHEMA.md),
[docs/FLOOR_FLOWS_SPARRING_ATTENDANCE.md](docs/FLOOR_FLOWS_SPARRING_ATTENDANCE.md).

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
- [docs/PAYMENT_SERVICE_SLOT.md](docs/PAYMENT_SERVICE_SLOT.md) — RESERVED, NOT
  BUILT: the payment capability's scope (donations, recurring giving, class
  fees, B2B wholesale) and the names the future build must use

## Design

- [design-system/README.md](design-system/README.md) — the eight laws and the token
  system; `design-system/ppbf.css` is the source of truth for tokens and proportion
- [docs/RETRO_DESIGN_SYSTEM.md](docs/RETRO_DESIGN_SYSTEM.md) — component vocabulary
  (stamp, brass plate, paper ticket, ledger tape, passbook) and floor ergonomics
- [docs/USABILITY_SPEC_RETRO.md](docs/USABILITY_SPEC_RETRO.md) — role density matrix,
  floor-use constraints, accessibility checklist
- [docs/FLOOR_FLOWS_SPARRING_ATTENDANCE.md](docs/FLOOR_FLOWS_SPARRING_ATTENDANCE.md) —
  the two highest-frequency gym-floor flows, specced but not built
- [docs/STAMP_AND_LEDGER_SCHEMA.md](docs/STAMP_AND_LEDGER_SCHEMA.md) — canonical stamp
  vocabulary; every status change writes a ledger event
- [docs/PASSBOOK_V1_BUILD_PROMPT_FOR_VS.md](docs/PASSBOOK_V1_BUILD_PROMPT_FOR_VS.md) —
  build directive: promote the passbook from a component to the platform's organizing
  object
- [apps/web/src/design/PAGE_MAP.md](apps/web/src/design/PAGE_MAP.md) — route inventory
  by shape and ground; stale, see the passbook prompt §8

Note: [docs/FRONTEND_STYLE_CONTRACT.md](docs/FRONTEND_STYLE_CONTRACT.md) and
[docs/BRAND_DESIGN_BRIEF.md](docs/BRAND_DESIGN_BRIEF.md) are historical — both describe
palettes the app no longer ships. The brief is still useful for the org profile and for
briefing external image tools; its colour table is not.

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

Database migrations are applied only by the controlled operator scripts, run
either from an operator's shell or from the manually dispatched
`apply-migrations` workflow. No HTTP route changes the schema, and no push,
merge, or deploy applies a migration as a side effect.

## Code

- `apps/web` — the Next.js application (App Router)
- `packages/` — governance, routing, execution, intelligence, continuity
- `infra/azure/` — Postgres schema and migrations for the `pilot.*` schema
- `infra/supabase/schema.sql` — earlier Supabase schema

## Archive

[docs/archive/](docs/archive/) holds point-in-time audits, reports, and
superseded plans. Read its README before trusting anything in it — several of
those documents describe a version of the platform that no longer exists.
