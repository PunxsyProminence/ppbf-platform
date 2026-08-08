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
  screen previews. Open it before designing a new surface. These are hand-authored
  mockups of the language, not pictures of the shipped pages.
- `npm run shots` → `apps/web/page-shots/gallery.html` — the shipped pages themselves.
  Photographs every route at two widths, each opened as the role that opens that
  door, and lays the prints out on one contact sheet grouped by room. Flags redirects,
  horizontal overflow, and routes the building map does not list. Prints for a person
  to judge, not a pixel baseline — see
  [apps/web/scripts/page-shots.ts](apps/web/scripts/page-shots.ts) for why that
  distinction matters here. Output is gitignored; re-run it rather than trusting an
  old sheet.
- [docs/BRAND_DESIGN_BRIEF.md](docs/BRAND_DESIGN_BRIEF.md) — for generating
  **external** visuals (posters, social cards, grant covers) in tools that can't
  read CSS. The only document allowed to restate hex values, and it is transcribed
  from `ppbf.css` rather than being independent.
- [docs/CANVAS_CONTEXT_PACK.md](docs/CANVAS_CONTEXT_PACK.md) — product and
  structure context for design tools (Canvas etc.); paste alongside the brand
  brief above when generating a new screen

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
- [docs/BOARD_SEAT_ASSIGNMENT.md](docs/BOARD_SEAT_ASSIGNMENT.md) — the eight
  board seats, the concurrency/handover rules the database enforces, and the
  `/api/pilot/board/seats` contract; cited from `ORGANIZATION_ROLE_MODEL.md`
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
- [docs/SHADOW_V1_BUILD_PROMPT_FOR_VS.md](docs/SHADOW_V1_BUILD_PROMPT_FOR_VS.md) —
  SHADOW build doctrine: automatic-action authority boundaries (may create,
  route, classify; may never medically clear, diagnose, or prescribe),
  enforced in `shadowChat.ts`'s doctrine validation
- [docs/SHADOW_ML_ARCHITECTURE_SPEC.md](docs/SHADOW_ML_ARCHITECTURE_SPEC.md) —
  ML/routing architecture, kept in sync with the shipped `shadowRouter.ts` /
  `shadowClassifier.ts`; where this doc and the code disagree, the code is
  authoritative and the drift is a defect in the doc, per its own header
- [docs/SHADOW_CHAT_FUNCTIONALITY_AUDIT_2026-07-28.md](docs/SHADOW_CHAT_FUNCTIONALITY_AUDIT_2026-07-28.md)
  — dated audit, but still live: 8 of its findings are fixed and recorded as
  such, and its 13 `[U]` findings were never verified — treat those as a
  to-check queue, not as fact. Its 4 originally-unaudited dimensions are now
  covered by the two follow-up audits below.
- [docs/SHADOW_JOBS_ROUTING_EVIDENCE_AUDIT_2026-07-31.md](docs/SHADOW_JOBS_ROUTING_EVIDENCE_AUDIT_2026-07-31.md)
  and [docs/SHADOW_SURFACES_SPEC_CONFORMANCE_AUDIT_2026-08-01.md](docs/SHADOW_SURFACES_SPEC_CONFORMANCE_AUDIT_2026-08-01.md)
  — together complete the 2026-07-28 audit's remaining dimensions. Both still
  carry open DESIGN-GAP items (the first's F1–F3 are DEFECTs and its
  highest-value unclaimed items; the second's B2 asks whether to build the
  Scout Report pipeline or retitle `/shadow/scout`), and the second flags two
  places where `SHADOW_ML_ARCHITECTURE_SPEC.md` has drifted from the code
  (logged `STALE-SPEC`, not yet corrected in the spec).

## Research

- [docs/RESEARCH_EVIDENCE_REGISTRY.md](docs/RESEARCH_EVIDENCE_REGISTRY.md) — the
  peer-review package behind SHADOW's coaching guidance: 1,193 claims with
  independently-verified citations, a 34-item cross-track conflict ledger, and the
  methods/limitations a reviewer needs before trusting any of it. Reference layer
  only — not loaded into the database.
- [docs/SHADOW_RESEARCH_INTAKE_IMPORT.md](docs/SHADOW_RESEARCH_INTAKE_IMPORT.md) —
  the companion loadable corpus derived from the same research programme, and the
  importer that seeds it into `pilot.shadow_library_*` (dry-run by default, evidence
  left `pending_review`/`unverified` until a human reviews it).

## Audits

Point-in-time, but not archived — these describe issues that may still be open.

- [docs/DEEP_CRITICAL_APP_AUDIT_2026-07-18.md](docs/DEEP_CRITICAL_APP_AUDIT_2026-07-18.md)
- [docs/PLATFORM_AUDIT_2026-07-31_DECISIONS_MADE.md](docs/PLATFORM_AUDIT_2026-07-31_DECISIONS_MADE.md)
  — the owner's decisions from the 2026-07-31 full-platform audit and why
  they were made; supersedes the question list in
  `PLATFORM_AUDIT_2026-07-31_OWNER_DECISIONS.md`
- [docs/PLATFORM_AUDIT_2026-08-07_TRIAGE.md](docs/PLATFORM_AUDIT_2026-08-07_TRIAGE.md)
  — triage of an external third-party audit against source; documents the
  platform's real (non-blanket) rate-limiting strategy and lists remaining
  owner/infra-decision items (migration rollback runbook, bundle analysis,
  monitoring, secrets rotation)
- [docs/FIX_LIST_2026-08-02.md](docs/FIX_LIST_2026-08-02.md) — point-in-time
  defect hunt; its two P0 items are already fixed in code without this file
  being updated (verify against source before trusting a "confirmed defect"
  here), and Part 2's carried-forward owner-decision items are still open
- [docs/EXTERNAL_AUDIT_PROMPTS.md](docs/EXTERNAL_AUDIT_PROMPTS.md) — vetted
  prompts and guardrails for handing this codebase to an outside model for
  audit; actively used (see `PLATFORM_AUDIT_2026-08-07_TRIAGE.md` above,
  which cites its standing rule that an outside model's claims get checked
  against real code before anyone acts on them)

## Operations

- [docs/AI_DELIVERY_PIPELINE.md](docs/AI_DELIVERY_PIPELINE.md) — how AI-built
  capabilities move from a ticket in [intake/](intake/) through one verified
  gate to production; extends
  [docs/AI_CONTRIBUTOR_GUARDRAILS.md](docs/AI_CONTRIBUTOR_GUARDRAILS.md) and
  [docs/MULTI_AI_EXECUTION_PLAN.md](docs/MULTI_AI_EXECUTION_PLAN.md)
- [docs/current/WORK_QUEUE.md](docs/current/WORK_QUEUE.md) — the single
  authoritative work queue the pipeline above runs on; supersedes the root
  `docs/WORK_QUEUE.md` and `docs/WORK_QUEUE_2026-08-01.md` (both kept only as
  incident/collision history)
- [docs/PRODUCTION_READINESS.md](docs/PRODUCTION_READINESS.md)
- [docs/MULTI_ORG_MIGRATION_RUNBOOK.md](docs/MULTI_ORG_MIGRATION_RUNBOOK.md)
- [docs/MULTI_ORG_ROLLBACK_RUNBOOK.md](docs/MULTI_ORG_ROLLBACK_RUNBOOK.md)
- [docs/MULTI_ORG_SMOKE_TEST_PLAN.md](docs/MULTI_ORG_SMOKE_TEST_PLAN.md)
- [docs/BACKUP_RUNBOOK.md](docs/BACKUP_RUNBOOK.md) — nightly and on-demand
  pilot-schema backup/restore procedure, plus the restore-drill checklist
  nobody has run yet
- [docs/DATA_RETENTION.md](docs/DATA_RETENTION.md) — retention windows and
  deletion triggers for minor/family data; enforced nightly (dry-run) by
  `retention-cleanup.yml` and `scripts/pilot-cleanup-deleted-data.mjs`. Its
  "Admin navigates to `/admin/data-deletion`" line describes a console page
  that doesn't exist — only the API route does; correct that line before
  trusting it as a UI walkthrough
- [docs/CAPABILITY_BUILD_PLAN_2026-08-03.md](docs/CAPABILITY_BUILD_PLAN_2026-08-03.md)
  — status of all 200 detailed capabilities against real code, phased build
  sequence; actively updated as PRs land and cited by capability number in
  `docs/current/WORK_QUEUE.md`
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

## Archive

[docs/archive/](docs/archive/) holds point-in-time audits, reports, and
superseded plans. Read its README before trusting anything in it — several of
those documents describe a version of the platform that no longer exists.
