# PPBF Deep Critical App Audit (2026-07-18)

## Scope
- Dashboard and user-surface runtime availability checks.
- API function/method coverage review across all route handlers.
- Gate and intake workflow validation.
- AI/ML endpoint and model-path smoke checks.
- Stress probes on high-traffic auth/login paths.

## What Was Executed
- `npm --workspace web run lint`
- `npm --workspace web run test`
- `npm --workspace web run build`
- `npm --workspace web run gate:pilot`
- `npm --workspace web run gate:pilot:multiorg`
- `npm --workspace web run gate:pilot:shadow-intake`
- `npm --workspace web run gate:pilot:shadow-e2e`
- Production route probes on key dashboard/user pages.
- Production stress probes on auth/login/oauth-start path.
- Production container log inspection.

## Top Findings (Critical First)

### 1) SHADOW E2E gate repeatability gap (Critical)
- First SHADOW intake run passed, repeated SHADOW E2E run failed with:
  - `duplicate key value violates unique constraint "accounts_pkey"`
- Impact:
  - Gate is not safely repeatable under current account provisioning assumptions.
  - CI reruns or retried promotions can fail despite healthy first-pass behavior.
- Area:
  - Intake promotion/account creation path in `review-action` flow.

### 2) AI model path configured but unavailable at runtime (Critical)
- Authenticated SHADOW chat request returned successful API envelope but fallback content:
  - `SHADOW is currently unavailable. Please contact your organization for support.`
- Production logs include:
  - `Azure AI credentials not configured`
- Impact:
  - AI capability appears online from UI/API perspective but does not deliver model-backed responses.

### 3) API lifecycle incompleteness across app (High)
- Total API routes discovered: 75
- Routes with `DELETE`: 1
- Routes without `DELETE`: 74
- Organization lifecycle currently supports create/update/status, no hard delete endpoint.
- Impact:
  - Operational cleanup and incident rollback depend on status toggles rather than full lifecycle controls.

### 4) Method asymmetry and action-style endpoints (Medium)
- Heavy use of action endpoints (`/get`, `/update`, `/post`) over resourceful method semantics.
- Example pattern clusters:
  - Athletes, goals, sessions, coach-reviews use POST-heavy action routes.
- Impact:
  - Increases client complexity and makes API behavior less predictable for tooling/integrations.

### 5) Runtime warning debt in production logs (Medium)
- `process.getBuiltinModule is not a function`
- Polyfill warnings for `DOMMatrix`, `ImageData`, `Path2D`
- PostgreSQL SSL mode warning (`prefer/require/verify-ca` aliasing)
- Impact:
  - Not immediate outage issues, but increases risk for future Node/pg upgrades and rendering edge cases.

### 6) Jest open handle warning (Low/Medium)
- Test suite passes but reports:
  - `Jest did not exit one second after the test run has completed.`
- Impact:
  - Potential hidden async leaks and flaky CI behavior under parallelization.

## Stress Probe Results (Production)

### Route Latency / Status
- `GET /login`
  - count: 50
  - avg: 70.23 ms
  - p95: 84.65 ms
  - max: 118.39 ms
  - status: `200:50`
- `POST /api/pilot/auth/session` (unauth)
  - count: 50
  - avg: 67.20 ms
  - p95: 98.91 ms
  - max: 114.68 ms
  - status: `200:50`
- `GET /api/pilot/auth/microsoft/start`
  - count: 30
  - avg: 355.16 ms
  - p95: 518.62 ms
  - max: 939.58 ms
  - status: `200:30` (redirect-follow path)
- `POST /api/pilot/auth/session` (auth flow probe)
  - count: 50
  - avg: 63.52 ms
  - p95: 74.50 ms
  - max: 161.28 ms
  - status: `200:50`

### Interpretation
- Core app/auth session endpoints are stable and fast.
- OAuth start path is the slowest by design (external identity redirect), but p95 remains sub-second.

## Dashboard and User Surface Smoke
- Confirmed `200` responses for key routes:
  - `/dashboard`, `/admin`, `/admin/organizations`, `/admin/compliance-center`
  - `/athlete/dashboard`, `/athlete/progression-intelligence`, `/athlete/video-analysis`
  - `/coach/progression-intelligence`, `/coach/review-queue`, `/coach/video-analysis`
  - `/parent/dashboard`, `/parent/progression-visibility`
  - `/board`, `/board/president`, `/operations`, `/research/chat`, `/shadow`, `/shadow/scout`

## Fixes Applied (No Functional Behavior Changes)

### Admin organizations usability hardening
- File updated:
  - `apps/web/app/admin/organizations/page.tsx`
- Changes:
  - Added clear workflow guidance section.
  - Added explicit labels for all inputs/selects.
  - Added disabled-state guards to prevent invalid submissions.
  - Added in-flight action feedback and clearer success/error status messaging.
  - Kept all existing API endpoints and payload behavior unchanged.

## Missing Functions Inventory Summary
- Only one route currently supports `DELETE`:
  - `apps/web/app/api/pilot/shadow/jobs/route.ts`
- Notable lifecycle gaps (hard-delete absent):
  - Organizations, memberships, users status, athletes, goals, sessions, coach-reviews, many SHADOW read/projection endpoints.

## Priority Recommendations
1. Make intake promotion idempotent for account creation/upsert to remove duplicate-key rerun failures.
2. Fix Azure AI runtime config in production env so SHADOW chat returns model outputs.
3. Standardize lifecycle contracts for core entities (at minimum: clear soft-delete semantics, optional hard-delete for platform_owner workflows).
4. Resolve Jest open handles (`--detectOpenHandles`) and close async resources explicitly.
5. Triage production runtime warnings (Node polyfills + pg sslmode deprecation) before next platform/runtime upgrades.

## Note
- User already acknowledged chat interfaces are incomplete; this audit therefore focuses on current stability, workflow integrity, and operational risk rather than feature completeness.
