# Dual-track import: schema/API mapping

Base: `origin/agent/shadow-trust-foundation @ e73829f`. All table/route names below were verified by reading the actual files at that commit, not assumed from documentation.

## Athlete profile

- Target: `pilot.athletes` (`infra/azure/pilot_slice_postgres.sql:57`).
- This package **never writes to `pilot.athletes`**. `dryRunImporter.ts` has no record kind that targets it, and `privacyClassification.ts` does not list it as an allowed destination for any classification. Identity is always the caller-supplied, already-existing `athlete_id` — see `assertRequestScope` in `dryRunImporter.ts`.
- Name-spelling discrepancy: recorded as a `pilot.coach_observations` note (`note_type` describing an identity-verification flag, `status: pending_verification`), never as an update to `pilot.athletes.full_name`. See `henryMapping.fixture.ts`.

## Tracks / program assignments

- No existing table represents a per-athlete dual-track program. `pilot.goals` is single-metric; `pilot.admin_track_assignments` (`pilot_slice_postgres.sql:719`) is org-level `jsonb`, not athlete-level.
- Draft (not applied) additive table: `infra/azure/drafts/pilot_slice_postgres_dual_track_migration.sql` → `pilot.athlete_dual_track_programs`, with DB-level `CHECK` constraints mirroring `schema.ts`'s `validateDualTrackProgram` (workload authority fixed to `primary`; all four mandatory gate categories required; all six core conditioning domains required in `never_replaces_domains`).

## Sessions

- Target: `pilot.sessions` (`pilot_slice_postgres.sql:87`), already `(organization_id, athlete_id)`-scoped with cascade FK to `pilot.athletes`.
- Classification: `athlete_private`.

## Formula observations/results

- Targets: `pilot.shadow_formula_observations` / `pilot.shadow_formula_results` (`pilot_slice_postgres.sql:996,1039`).
- Both already `(organization_id, athlete_id)`-scoped. Observations require `observed_at`; this package's `measured_result` record kind enforces the same rule at the planning layer (`MISSING_OBSERVATION_DATE_CANNOT_BE_CURRENT`).
- The 12 MVP formula engines (`apps/web/src/server/pilot/formulas/registry.ts`) compute deterministically from whatever rows exist in `shadow_formula_observations` — this package's only job is to plan well-formed, dated, correctly-scoped observation rows; it does not touch formula computation.

## Evidence documents/chunks (general SHADOW library)

- Targets: `pilot.shadow_library_sources` / `_documents` / `_chunks` (`pilot_slice_postgres.sql:177,195,227`), gated by `approval_state`/`verification_state` added in `pilot_slice_postgres_shadow_evidence_migration.sql`.
- **Confirmed gap**: none of these tables carry a privacy-classification column. `searchShadowLibrary`/`retrieveShadowEvidenceBundle` (per prior audit of this codebase) filter on organization/subject scope and approval/verification/ingest state only — not on any content-sensitivity tier.
- Consequence, enforced in `privacyClassification.ts` and `dryRunImporter.ts`: only `organization_doctrine`-classified evidence may ever target these tables. `admin_restricted` and unapproved `support_reference` content is refused unconditionally (`RESTRICTED_CLASSIFICATION_CANNOT_ENTER_GENERAL_LIBRARY`, `ADMIN_RESTRICTED_HAS_NO_SECURE_DESTINATION`).

## Privacy / export / deletion

- `pilot.shadow_data_deletion_requests` (`pilot_slice_postgres.sql:817`) exists but — per this codebase's own prior audit — has no fulfillment worker; a request only ever reaches `status: pending`. This package does not add or rely on deletion/export functionality; it is out of scope here, but any future wet-run implementation inherits that same open gap and should not be built on top of it without first closing it.

## Administrative review

- `pilot.intake_cases` / `pilot.intake_documents` (`pilot_slice_postgres.sql:342,360`) provide a real, DB-enforced review state machine (`pending_review → approved/rejected → promoted`), consumed by `apps/web/app/api/pilot/intake/review-queue/route.ts` and `review-action/route.ts`.
- `organization_doctrine` evidence should go through this existing review path before ever reaching `pilot.shadow_library_*`, exactly as the current app already requires for any SHADOW library content.

## What this package deliberately does not implement

- No database connection anywhere in `dualTrackImport/` — `planDualTrackImport` is a pure function; it cannot execute a write, dry-run or otherwise (`WET_RUN_NOT_IMPLEMENTED` is unconditional).
- No destination for `admin_restricted` content — recruiter/waiver/ASVAB/financial/government-identifier material has no code path into any table.
- No document extraction/chunking — outside this package's scope entirely; `organization_doctrine` evidence records assume text content already exists as an approved `shadow_library_chunks` row.
