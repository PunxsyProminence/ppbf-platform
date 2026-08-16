# SHADOW Total Todo Execution Tracker

Last Updated: 2026-07-15

Purpose: single execution tracker for remaining SHADOW work with owners, target dates, verification commands, and status.

Status Key:
- DONE: implemented and verified in this repo/session.
- PENDING: not yet implemented.
- BLOCKED_EXTERNAL: requires external environment, credential, or deployment coordination.

## 1) Deploy-Target E2E Validation

- Status: DONE
- Owner: Platform/DevOps
- Target Date: 2026-07-16
- Task: run SHADOW E2E gate against deployed backend endpoint and archive evidence.
- Verification Command:
  - `PILOT_GATE_BASE_URL=https://<deployed-api-host> npm --prefix apps/web run gate:pilot:shadow-e2e`
- Evidence Output:
  - Initial staging redeploy run `29410768581` failed due to missing secret ref `azure-postgres-connection-string`.
  - Secret refs were restored directly on `app-ppbf-staging`:
    - `azure-postgres-connection-string`
    - `azure-storage-connection-string`
    - `ppbf-pilot-bootstrap-key`
    - `ppbf-pilot-default-org-id`
    - `ppbf-pilot-shadow-container`
  - Subsequent deploy run `29411738160` completed successfully.
  - Workflow run `29414990400` completed successfully after installing web dependencies for the gate.
  - Final deployed validation:
    - `PILOT_GATE_BASE_URL=https://app-ppbf-staging.purpledesert-3a75d580.eastus.azurecontainerapps.io npm --prefix apps/web run gate:pilot:shadow-e2e` => `SHADOW INTAKE GATE PASS`

## 2) CI Required Gate

- Status: DONE
- Owner: Platform/DevOps
- Target Date: 2026-07-15
- Task: execute SHADOW E2E gate from staging deployment workflow.
- Verification:
  - Workflow file contains post-deploy gate steps and command:
    - `.github/workflows/deploy-staging.yml`
    - `npm --prefix apps/web run gate:pilot:shadow-e2e`

## 3) Runtime Readiness Enforcement

- Status: DONE
- Owner: Backend
- Target Date: 2026-07-15
- Task: hard-fail SHADOW APIs when required runtime env/tables are missing.
- Verification:
  - Readiness helper exists: `apps/web/src/server/pilot/shadowReadiness.ts`
  - Referenced by SHADOW routes under `apps/web/app/api/pilot/shadow/**` and intake review/upload routes.

## 4) Migration/Schema Dependency Guarding

- Status: DONE
- Owner: Backend
- Target Date: 2026-07-15
- Task: enforce required pilot tables per endpoint before serving SHADOW reads/writes.
- Verification:
  - `assertShadowRuntimeReadiness({ requiredTables: [...] })` present in SHADOW API routes.

## 5) SHADOW Checklist Reality Update

- Status: DONE
- Owner: Architecture/Backend
- Target Date: 2026-07-15
- Task: update phase checklist to reflect completed backend spine/hardening items.
- Verification:
  - `docs/SHADOW_PHASE1_HARDENING_CHECKLIST.md` contains checked items aligned to implemented backend pieces.

## 6) SHADOW Spec Reality Update

- Status: DONE
- Owner: Architecture
- Target Date: 2026-07-15
- Task: remove stale frontend-only mock statement and reflect mixed real backend + scaffolded UI state.
- Verification:
  - `docs/SHADOW_SPECIFICATION.md` implementation status section updated.

## 7) Deployment Reality Documentation

- Status: DONE
- Owner: Platform/Architecture
- Target Date: 2026-07-15
- Task: document current split reality (SWA static front-end vs Container App API runtime for pilot backend).
- Verification:
  - `AUTH_DEPLOYMENT_VERIFICATION.md` includes runtime reality note for pilot backend validation path.

## 8) Athlete-Scope Projection Filtering Tests

- Status: DONE
- Owner: Backend/QA
- Target Date: 2026-07-15
- Task: enforce athlete scope in SHADOW observation/event/telemetry reads and validate in gate assertions.
- Verification:
  - Athlete scoping exists in `apps/web/src/server/pilot/shadowReadModels.ts`.
  - Gate script checks correlation and stream presence in `apps/web/scripts/pilot-shadow-intake-gate.mjs`.

## 9) Backend-Required Admin Mode Negative Path

- Status: DONE
- Owner: Frontend/Backend
- Target Date: 2026-07-15
- Task: block review/promotion actions when backend queue is unavailable; disable quick-add staging fallback.
- Verification:
  - `apps/web/app/admin/shadow/page.tsx` has backend readiness checks and quick-add blocked mode.

## 10) Research Projection Field Regression Coverage

- Status: DONE
- Owner: Backend/QA
- Target Date: 2026-07-15
- Task: ensure research projection fields are emitted in upload/review events and asserted in gate.
- Verification:
  - Emitters:
    - `apps/web/app/api/pilot/shadow/upload/route.ts`
    - `apps/web/app/api/pilot/intake/review-action/route.ts`
  - Assertions:
    - `apps/web/scripts/pilot-shadow-intake-gate.mjs`

## 11) Coach/Athlete Full De-Placeholder (Non-SHADOW Spine)

- Status: DONE
- Owner: Product + Backend + Frontend
- Target Date: 2026-07-22
- Task: remove seeded local state from coach/athlete workspaces and complete backend-driven data flows.
- Verification Commands:
  - `npm --prefix apps/web run lint`
  - `npm --prefix apps/web run gate:pilot`
  - `npm --prefix apps/web run gate:pilot:multiorg`

## 12) Extended Non-SHADOW Feature Integration

- Status: PENDING
- Owner: Product + Engineering
- Target Date: 2026-07-29
- Task: backend-connect remaining non-critical placeholder modules (separate from SHADOW ingestion spine).
- Verification:
  - Updated capability matrix and green gates for impacted workflows.

## Executed In This Session

- `npm --prefix apps/web run lint` => PASS
- `npm --prefix apps/web run gate:pilot:shadow-e2e` => PASS (localhost runtime)
- `PILOT_GATE_BASE_URL=https://app-ppbf-staging.purpledesert-3a75d580.eastus.azurecontainerapps.io npm --prefix apps/web run gate:pilot:shadow-e2e` => FAIL (`POST /api/pilot/shadow/events` returned 404)
- `gh workflow run deploy-staging.yml --ref main` => dispatched run `29410768581`
- `gh run watch 29410768581 --exit-status` => FAIL (deploy step blocked by missing secret ref `azure-postgres-connection-string`)
- `az containerapp secret set --name app-ppbf-staging ...` => SUCCESS (required secret refs created)
- `gh workflow run deploy-staging.yml --ref main` => dispatched run `29411738160`
- run `29411738160` => SUCCESS
- `PILOT_GATE_BASE_URL=https://app-ppbf-staging.purpledesert-3a75d580.eastus.azurecontainerapps.io npm --prefix apps/web run gate:pilot:shadow-e2e` => FAIL (`POST /api/pilot/shadow/events` returned 404)
- `gh workflow run deploy-staging.yml --ref main` => dispatched run `29414990400`
- run `29414990400` => SUCCESS
- `PILOT_GATE_BASE_URL=https://app-ppbf-staging.purpledesert-3a75d580.eastus.azurecontainerapps.io npm --prefix apps/web run gate:pilot:shadow-e2e` => PASS
- `npm --prefix apps/web run lint` => PASS
- `PILOT_GATE_BASE_URL=https://app-ppbf-staging.purpledesert-3a75d580.eastus.azurecontainerapps.io PILOT_ADMIN_ACCOUNT_ID=<set> PILOT_ADMIN_PIN=<set> PPBF_PILOT_BOOTSTRAP_KEY=<set> npm --prefix apps/web run gate:pilot` => PASS
- `PILOT_GATE_BASE_URL=https://app-ppbf-staging.purpledesert-3a75d580.eastus.azurecontainerapps.io PPBF_PILOT_BOOTSTRAP_KEY=<set> npm --prefix apps/web run gate:pilot:multiorg` => PASS
