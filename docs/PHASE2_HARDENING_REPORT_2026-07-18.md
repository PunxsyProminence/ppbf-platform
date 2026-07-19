# Phase 2 Hardening Report (2026-07-18)

## Task 1 — Evidence Report (Pre-Change)

### 1) Exact duplicate-key source
- Route/function path:
  - `apps/web/app/api/pilot/intake/review-action/route.ts` in the `action === 'promote'` branch.
- Direct call that triggers account write:
  - `createAthleteAccount(...)`.
- Called from this block when `promotion.athlete.account_id` and `promotion.athlete.pin` are present.

### 2) Exact table/index/constraint causing collision
- Table: `pilot.accounts`
- Constraint: primary key on `account_id` (`accounts_pkey` in runtime error text).
- Schema reference:
  - `infra/azure/pilot_slice_postgres.sql` (`account_id text primary key`).

### 3) Verified cause classification
- Verified primary cause: **non-idempotent account creation** in intake promotion path.
- Supporting evidence:
  - `createAthleteAccount` in `apps/web/src/server/pilot/auth.ts` used plain `insert` (no `on conflict`).
  - `gate:pilot:shadow-intake` and `gate:pilot:shadow-e2e` both execute `scripts/pilot-shadow-intake-gate.mjs`, so reruns with same identity values re-hit account creation.
- Not primary cause:
  - Guardian account path already uses upsert (`createParentAccount` uses `on conflict (account_id) do update`).

### 4) Exact Azure AI config/env vars required
- Required:
  - `AZURE_AI_ENDPOINT`
  - `AZURE_AI_KEY`
  - `AZURE_AI_DEPLOYMENT_NAME`
- Optional/defaulted:
  - `AZURE_AI_API_VERSION` (defaults to `2024-12-01-preview`).

### 5) Current behavior when Azure AI config is missing
- `shadow/chat` logs missing AI credentials and returns fallback unavailable message in response body.
- `shadow/debug` reports missing env vars in `aiTest` payload when authorized.
- Production env-name inspection showed AI vars absent on container app (only DB/storage/auth/bootstrap vars present).

### 6) Routes returning fallback AI responses
- User-facing fallback string source:
  - `apps/web/app/api/pilot/shadow/chat/route.ts`
  - Message: `SHADOW is currently unavailable. Please contact your organization for support.`
- Job processor behavior:
  - `apps/web/app/api/pilot/shadow/jobs/process/route.ts` fails job execution when AI runtime is unavailable.

## Task 2 — Implemented Hardening

### A) SHADOW E2E repeatability hardening
- Updated intake promotion to use idempotent athlete-account upsert function:
  - File: `apps/web/app/api/pilot/intake/review-action/route.ts`
  - Change: `createAthleteAccount` -> `createOrUpdateAthleteAccount`.
- Rationale:
  - Promotion reruns now reuse/update existing disposable athlete account instead of hard-insert collision.

### B) AI runtime validation hardening
- Added centralized AI runtime config helper:
  - File: `apps/web/src/server/pilot/azureAiRuntime.ts`
  - Functions:
    - `getAzureAiRuntimeConfig(...)`
    - `buildAzureAiChatCompletionsUrl(...)`
- Wired helper into SHADOW runtime routes:
  - `apps/web/app/api/pilot/shadow/chat/route.ts`
  - `apps/web/app/api/pilot/shadow/debug/route.ts`
  - `apps/web/app/api/pilot/shadow/jobs/process/route.ts`
- Strengthened preflight gate to include AI connectivity check:
  - File: `apps/web/scripts/pilot-preflight.mjs`
  - Now fails fast if AI env vars are missing or deployment is unreachable.

## Test Coverage Added
- New tests:
  - `apps/web/src/server/pilot/azureAiRuntime.test.ts`
  - `apps/web/src/server/pilot/auth.accounts.test.ts`
- Executed:
  - `npm --workspace web exec jest src/server/pilot/azureAiRuntime.test.ts` ✅
  - `npm --workspace web exec jest src/server/pilot/auth.accounts.test.ts` ✅

## Validation Runs
- `npm --workspace web run lint` ✅
- `npm --workspace web run build` ✅
- `npm --workspace web run pilot:preflight` ✅ (now includes AI connectivity)

## Important Deployment Note
- Local/source hardening is complete, but production runtime behavior will only reflect these fixes after deployment.
- A rerun against current live production still reproduces the original duplicate-key failure because that environment is running pre-hardening code.

## Scope Compliance
- No SHADOW doctrine changes.
- No new product feature introduced.
- Minimal, reversible hardening only.
- No production data mutation performed by code changes.
