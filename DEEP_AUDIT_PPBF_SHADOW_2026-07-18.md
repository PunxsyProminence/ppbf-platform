# FULL SPECTRUM APP AUDIT - PPBF / SHADOW

Date: 2026-07-18  
Scope: Entire repository (code-evidence based)  
Method: Static code inspection + build/test execution in current workspace  
Constraint: If evidence is missing, marked as: **NOT VERIFIED - NO CODE EVIDENCE FOUND.**

## 1) EXECUTIVE SUMMARY

### Current build status
- Build: PASS (Next.js production build completed with 116/116 pages generated).
- Test command: PASS, but tests are simulated/file-presence checks, not functional/integration assertions: [scripts/run-tests.ps1](scripts/run-tests.ps1#L46).

### Production readiness score (0-100)
- **58 / 100**

### Top 10 critical risks
1. Operator auth bypass in frontend local session flow with hardcoded PIN: [apps/web/components/roleSession.ts](apps/web/components/roleSession.ts#L5), [apps/web/app/login/page.tsx](apps/web/app/login/page.tsx#L416).
2. Hardcoded server fallback PIN for announcements (`15715`) if env var absent: [apps/web/app/api/pilot/announcements/post/route.ts](apps/web/app/api/pilot/announcements/post/route.ts#L38).
3. Unauthenticated announcement read endpoint allows caller-supplied organization_id: [apps/web/app/api/pilot/announcements/get/route.ts](apps/web/app/api/pilot/announcements/get/route.ts#L13).
4. SQL injection risk via interpolated jobType in query builder: [apps/web/src/server/pilot/shadowJobQueue.ts](apps/web/src/server/pilot/shadowJobQueue.ts#L134).
5. Over-broad video list access (non-athlete roles get org-wide list without role restriction): [apps/web/app/api/pilot/video/list/route.ts](apps/web/app/api/pilot/video/list/route.ts#L41).
6. Debug endpoint exposes partial secrets and performs outbound AI probe in live route: [apps/web/app/api/pilot/shadow/debug/route.ts](apps/web/app/api/pilot/shadow/debug/route.ts#L20).
7. Deployment drift risk: production workflow points at staging resource group: [/.github/workflows/deploy-production.yml](.github/workflows/deploy-production.yml#L28).
8. Dual SWA config files with mismatch (app-level empty config): [apps/web/staticwebapp.config.json](apps/web/staticwebapp.config.json#L1), [staticwebapp.config.json](staticwebapp.config.json#L1).
9. N+1 network pattern in athlete progression page (per-assignment completions fetch): [apps/web/app/athlete/progression-intelligence/page.tsx](apps/web/app/athlete/progression-intelligence/page.tsx#L122).
10. “All core tests passed” signal is non-assertive and can create false confidence: [scripts/run-tests.ps1](scripts/run-tests.ps1#L5), [scripts/run-tests.ps1](scripts/run-tests.ps1#L46).

### Top 10 quick wins
1. Remove client-side role-only operator login path; enforce backend session for all roles.
2. Remove all hardcoded PIN defaults; fail closed when env vars missing.
3. Require authentication for announcements get/post and derive org from principal, not request body.
4. Replace dynamic SQL interpolation in job filter with parameterized query.
5. Enforce role checks on video list route (coach/admin only unless athlete self).
6. Restrict or disable debug route in production build/runtime.
7. Fix production workflow resource group/env targeting.
8. Consolidate to one SWA config file and validate rewrite/auth behavior.
9. Replace simulated tests with API integration and tenant-isolation tests.
10. Add batched completion endpoint to eliminate N+1 front-end calls.

---

## 2) ARCHITECTURE AUDIT

### Frontend
- Next.js app router with many route surfaces; build succeeds.
- Significant planned/placeholder surfaces are explicitly labeled (not hidden): [apps/web/app/operations/page.tsx](apps/web/app/operations/page.tsx#L114), [apps/web/app/source-control/publication-workflow/page.tsx](apps/web/app/source-control/publication-workflow/page.tsx#L7).

### Backend
- API routes under app router + server modules in pilot namespace.
- Shared DB access through pooled pg client: [apps/web/src/server/pilot/db.ts](apps/web/src/server/pilot/db.ts#L7).

### API design
- Consistent route grouping under /api/pilot.
- Mixed security patterns (some strict principal+role, some key-based, some unauthenticated announcement endpoints).

### Authentication
- Server cookie auth used for athlete path and API principal resolution: [apps/web/app/api/pilot/auth/login/route.ts](apps/web/app/api/pilot/auth/login/route.ts#L43), [apps/web/src/server/pilot/auth.ts](apps/web/src/server/pilot/auth.ts#L69).
- Frontend also supports local role session path independent of backend auth for non-athlete roles: [apps/web/app/login/page.tsx](apps/web/app/login/page.tsx#L416).

### Authorization
- Strong helper-based role and athlete access checks exist: [apps/web/src/server/pilot/access.ts](apps/web/src/server/pilot/access.ts#L45).
- Some endpoints rely on weaker controls (announcement pin model, non-role video list route).

### State management
- LocalStorage role session on client for UI gating: [apps/web/components/roleSession.ts](apps/web/components/roleSession.ts#L22).
- Server-side state in PostgreSQL for pilot domain.

### Service boundaries
- Shadow modules are separated by concern (router, classifier, context, feedback, authority, telemetry).
- Some boundaries drift due to mixed mock/planned and production logic in same app surfaces.

### Multi-tenant architecture
- Organization-scoped schema and PK/FK patterns present broadly: [infra/azure/pilot_slice_postgres.sql](infra/azure/pilot_slice_postgres.sql#L58).
- Route-level enforcement exists in many APIs; exceptions noted in findings.

### Organization isolation
- Access rules for athlete ownership and coach assignment implemented: [apps/web/src/server/pilot/access.ts](apps/web/src/server/pilot/access.ts#L45).
- Data-access exceptions found (announcements endpoint pattern, video listing breadth).

### Scalability
- Build/runtime supports dynamic API routes.
- Potential bottlenecks: N+1 client fetch loops and async job queue filtering SQL construction.

### Technical debt
- Placeholder features mixed into production UI.
- Simulated test suite and duplicate SWA config indicate operational debt.

### Tight coupling
- UI role session and backend auth models are coupled but inconsistent.

### Hidden dependencies
- Bootstrap and migration behavior depends on secret headers and env vars.

### Circular dependencies
- **NOT VERIFIED - NO CODE EVIDENCE FOUND.**

### Single points of failure
- Bootstrap key and operator PIN patterns.
- Environment variable correctness for AI and DB runtime.

### Architectural drift
- Static export vs standalone runtime toggle can diverge from deployment assumptions: [apps/web/next.config.ts](apps/web/next.config.ts#L8).

---

## 3) SHADOW DOCTRINE ALIGNMENT AUDIT

### Verified alignment evidence
- High-risk fallback responses defer medical authority: [apps/web/app/api/pilot/shadow/chat/route.ts](apps/web/app/api/pilot/shadow/chat/route.ts#L67).
- Automatic clearance/medical authority actions blocked in authority checks: [apps/web/src/server/pilot/shadowAuthority.ts](apps/web/src/server/pilot/shadowAuthority.ts#L82).
- Coach/athlete context access checks exist in SHADOW context retrieval: [apps/web/src/server/pilot/shadowChat.ts](apps/web/src/server/pilot/shadowChat.ts#L254).

### Doctrine drift findings
- Readiness exists as explicit table and surfaced concept in platform data model: [infra/azure/pilot_slice_postgres.sql](infra/azure/pilot_slice_postgres.sql#L300).
- No hard evidence found that a single readiness score governs all decisions platform-wide.
  - Status: **NOT VERIFIED - NO CODE EVIDENCE FOUND.**
- Hidden safety-first drift across all decision paths:
  - Status: **NOT VERIFIED - NO CODE EVIDENCE FOUND.**
- AI authority drift globally prevented:
  - Partial evidence exists in SHADOW routes, not full-system proof.

Conclusion:
- SHADOW doctrine controls are present in key modules, but system-wide doctrinal guarantees are **partially verified**, not complete.

---

## 4) DATABASE AUDIT

### PostgreSQL schema, relationships, constraints
- Composite org-scoped keys and FKs are used extensively: [infra/azure/pilot_slice_postgres.sql](infra/azure/pilot_slice_postgres.sql#L58), [infra/azure/pilot_slice_postgres.sql](infra/azure/pilot_slice_postgres.sql#L430).

### Indexes
- Many relevant indexes exist (sessions, goals, intake, readiness, feedback, messages): [infra/azure/pilot_slice_postgres.sql](infra/azure/pilot_slice_postgres.sql#L480).

### Multi-organization separation
- Strong schema-level organization_id presence and constraints.

### Missing indexes
- No obvious critical missing index found in inspected core schema.
- Full workload-based index adequacy: **NOT VERIFIED - NO CODE EVIDENCE FOUND.**

### N+1 risks
- Frontend calls completions endpoint in loop per assignment: [apps/web/app/athlete/progression-intelligence/page.tsx](apps/web/app/athlete/progression-intelligence/page.tsx#L122).

### Security risks
- SQL injection risk in job queue type filter interpolation: [apps/web/src/server/pilot/shadowJobQueue.ts](apps/web/src/server/pilot/shadowJobQueue.ts#L134).

### Data leakage risks
- Announcement endpoint accepts arbitrary organization_id without principal auth: [apps/web/app/api/pilot/announcements/get/route.ts](apps/web/app/api/pilot/announcements/get/route.ts#L13).

### Orphan records
- Cascade constraints are present in many relations.
- Runtime orphan checks from data snapshot: **NOT VERIFIED - NO CODE EVIDENCE FOUND.**

### Migration risks
- Runtime/admin migration routes exist and can mutate schema with key-only auth: [apps/web/app/api/pilot/admin/migrate-multiorg/route.ts](apps/web/app/api/pilot/admin/migrate-multiorg/route.ts#L11), [apps/web/app/api/pilot/shadow/migrate/route.ts](apps/web/app/api/pilot/shadow/migrate/route.ts#L14).

---

## 5) SECURITY AUDIT

### Authentication
- Cookie auth implemented with httpOnly + secure in production + sameSite lax: [apps/web/app/api/pilot/auth/login/route.ts](apps/web/app/api/pilot/auth/login/route.ts#L43).
- Parallel client-side role-only auth path exists with hardcoded PIN: [apps/web/components/roleSession.ts](apps/web/components/roleSession.ts#L5).

### JWT/session handling
- Opaque token session table approach (no JWT in inspected auth path).

### API protection and RBAC
- Many pilot routes use requirePrincipal + requireRole.
- Exceptions: announcements endpoints and key-only operational routes.

### Tenant isolation
- Broadly enforced by org filters and access helpers.
- Exceptions noted above.

### Input validation
- Some handlers validate required fields; comprehensive schema validation is inconsistent across routes.

### XSS
- React escapes content by default in inspected components.
- Stored content rendering controls not fully audited.
  - **NOT VERIFIED - NO CODE EVIDENCE FOUND.**

### CSRF
- No anti-CSRF token mechanism found in inspected cookie-auth POST routes.
  - **NOT VERIFIED - NO CODE EVIDENCE FOUND.**

### SSRF
- External fetch targets mainly from fixed env endpoints (Azure AI), low direct user-provided URL usage in inspected routes.

### SQL injection
- Confirmed risk in shadow job queue query construction: [apps/web/src/server/pilot/shadowJobQueue.ts](apps/web/src/server/pilot/shadowJobQueue.ts#L134).

### Secrets management
- Uses env vars and secretref in deployment.
- Debug endpoint reveals masked prefixes of secrets and endpoint info: [apps/web/app/api/pilot/shadow/debug/route.ts](apps/web/app/api/pilot/shadow/debug/route.ts#L20).

### Severity classification
- Critical: Operator auth bypass pattern; hardcoded PIN fallback; SQL interpolation vulnerability.
- High: Unauthenticated org-scoped announcements; over-broad video listing; deployment RG drift.
- Medium: Debug endpoint sensitivity; simulated tests masking risk.
- Low: Duplicate SWA config drift; minor dead code.

---

## 6) AI SYSTEM AUDIT

### Azure AI integration
- Direct Azure OpenAI calls with endpoint/key/deployment env vars in SHADOW chat and job processor.

### Prompt architecture
- Strong doctrinal system prompt and high-risk fallback handling: [apps/web/app/api/pilot/shadow/chat/route.ts](apps/web/app/api/pilot/shadow/chat/route.ts#L63).

### Memory systems
- User profile, remembered facts, open questions, recent topics in DB-backed model.

### AI routing
- Tiered routing model (quick/heavy/vision) exists; heavy model availability flags present: [apps/web/src/server/pilot/shadowRouter.ts](apps/web/src/server/pilot/shadowRouter.ts#L26).

### Token usage and cost controls
- Max token caps are present in route and router logic.
- End-to-end cost budget enforcement and tenant budget quotas:
  - **NOT VERIFIED - NO CODE EVIDENCE FOUND.**

### Failure handling
- Graceful fallback message when AI unavailable in chat route.

### Hallucination controls
- Request and response validation logic exists, including prohibited response patterns: [apps/web/src/server/pilot/shadowChat.ts](apps/web/src/server/pilot/shadowChat.ts#L294).

### Authority drift checks
- Explicit block on automatic clearance actions: [apps/web/src/server/pilot/shadowAuthority.ts](apps/web/src/server/pilot/shadowAuthority.ts#L82).

---

## 7) MULTI-TENANT AUDIT

### Verified
- Org-scoped schema and composite PK/FK patterns are pervasive.
- Access helpers enforce actor/athlete constraints.

### Potential crossover paths
1. Unauthenticated announcements get route with caller-supplied organization_id.
2. Announcement post route also allows caller-supplied organization_id + PIN model.
3. Video listing route role breadth may expose org-wide media metadata to non-coach roles.

### Result
- Multi-tenant readiness is **partial** due to endpoint-level exceptions.

---

## 8) DEPLOYMENT AUDIT

### Azure Static Web Apps
- SWA workflow deploys app output .next: [/.github/workflows/azure-static-web-apps-purple-bush-04c73e010.yml](.github/workflows/azure-static-web-apps-purple-bush-04c73e010.yml#L33).
- App-local SWA config is empty while root config has rewrites; deployment behavior can drift by artifact path: [apps/web/staticwebapp.config.json](apps/web/staticwebapp.config.json#L1), [staticwebapp.config.json](staticwebapp.config.json#L1).

### Azure Container Apps / PostgreSQL / env vars
- Staging/prod workflows use secretrefs for DB/storage/bootstrap in container app deploy.

### Production readiness
- Build pipeline exists; smoke checks exist in deploy-production.
- Workflow drift issue found (production app name with staging resource group): [/.github/workflows/deploy-production.yml](.github/workflows/deploy-production.yml#L28).

### Rollback capability
- Tagged images (sha and prod-latest) suggest rollback path exists, but no explicit automated rollback step found.

### Backup / disaster recovery
- DR strategy and backup automation are not evidenced in inspected deployment code.
  - **NOT VERIFIED - NO CODE EVIDENCE FOUND.**

---

## 9) PERFORMANCE AUDIT

### Bundle/build
- Production build completed successfully with static/dynamic route generation.

### Queries/API latency
- No runtime APM traces provided in code audit.
  - **NOT VERIFIED - NO CODE EVIDENCE FOUND.**

### Rendering
- Heavy client-side pages with multiple fetches and loops.

### Caching
- SHADOW context has in-memory 5-minute cache: [apps/web/src/server/pilot/shadowChat.ts](apps/web/src/server/pilot/shadowChat.ts#L7).

### Bottlenecks identified
- N+1 completion fetch loop in athlete progression page.
- Potentially expensive archival full-table operations in shadow archival utility.

---

## 10) UX AUDIT

### Athlete workflow
- Progression page functional but likely slow due multi-call pattern.

### Coach workflow
- Video console functional for upload/list/play, with clear planned labels for ML.

### Parent workflow
- Progression visibility is marked planned in multiple surfaces.

### Admin/Board workflow
- Compliance monitoring route is live and data-driven.

### Friction points
- Role login model is inconsistent (athlete backend auth vs operator local PIN).
- Many surfaces labeled planned/placeholder may reduce trust if exposed as production capability.

### Improvement recommendations
- Unify all role authentication through backend session.
- Add capability-state badges globally with route-level guardrails for non-implemented features.
- Batch progression APIs to reduce load and improve responsiveness.

---

## 11) COMPLIANCE AUDIT (Nonprofit / Youth / Privacy)

### Verified
- Doctrine language repeatedly blocks medical authority drift in SHADOW routes.
- Audit/event logging tables exist.

### Missing controls (evidence status)
- Explicit youth consent record lifecycle verification beyond schema presence:
  - **NOT VERIFIED - NO CODE EVIDENCE FOUND.**
- Data retention policy enforcement jobs for all PII domains:
  - **NOT VERIFIED - NO CODE EVIDENCE FOUND.**
- Privacy delete/export workflows:
  - **NOT VERIFIED - NO CODE EVIDENCE FOUND.**

---

## 12) FAILURE MODE REVIEW

### Attempted break paths (code-level)
1. Permission escalation via client-only role session: feasible for UI access path.
2. Tenant crossover via announcements get/post organization_id parameterization.
3. SQL injection vector in job queue type filter.
4. False confidence from simulated tests labeled as pass.

### Additional requested modes
- Alert fatigue / data collection fatigue / survivorship bias / math authority drift at runtime behavior level:
  - **NOT VERIFIED - NO CODE EVIDENCE FOUND.**

---

## 13) DEAD CODE AUDIT

### Findings
- Unused function in SHADOW page: [apps/web/app/shadow/page.tsx](apps/web/app/shadow/page.tsx#L279).
- Duplicate/competing SWA configs (one empty) indicate config drift rather than pure dead code.

### Unused files/components/APIs full certainty
- **NOT VERIFIED - NO CODE EVIDENCE FOUND.** (would require symbol-level usage graph or runtime tracing across workspace)

---

## 14) FINAL REPORT

### A) RED ISSUES (Must fix)

1. Severity: Critical  
Evidence: Hardcoded operator PIN and local role session creation.  
File: [apps/web/components/roleSession.ts](apps/web/components/roleSession.ts#L5), [apps/web/app/login/page.tsx](apps/web/app/login/page.tsx#L416)  
Root cause: Authentication split between backend session and client-only role state.  
Recommended fix: Remove createRoleSession operator path; require backend login for all roles.  
Risk if ignored: Privilege spoofing at UI/workflow level and policy bypass confusion.

2. Severity: Critical  
Evidence: Server default PIN fallback to 15715.  
File: [apps/web/app/api/pilot/announcements/post/route.ts](apps/web/app/api/pilot/announcements/post/route.ts#L38)  
Root cause: Fail-open secret fallback.  
Recommended fix: If PPBF_OPERATOR_PIN missing, return 500 and block route.  
Risk if ignored: Predictable control-plane action authorization.

3. Severity: Critical  
Evidence: SQL string interpolation for job type filter.  
File: [apps/web/src/server/pilot/shadowJobQueue.ts](apps/web/src/server/pilot/shadowJobQueue.ts#L134)  
Root cause: Dynamic SQL concatenation with request-derived filter path.  
Recommended fix: Enumerate allowed JobType and parameterize filter condition.  
Risk if ignored: Potential SQL injection and queue manipulation.

4. Severity: High  
Evidence: Announcement read accepts arbitrary organization_id and has no principal requirement.  
File: [apps/web/app/api/pilot/announcements/get/route.ts](apps/web/app/api/pilot/announcements/get/route.ts#L13)  
Root cause: Public endpoint design with caller-controlled tenant selector.  
Recommended fix: Require principal and use principal.organizationId only.  
Risk if ignored: Cross-organization information disclosure.

5. Severity: High  
Evidence: Production workflow uses staging RG variable.  
File: [/.github/workflows/deploy-production.yml](.github/workflows/deploy-production.yml#L28)  
Root cause: Environment drift in CI configuration.  
Recommended fix: Use dedicated production RG secret/variable and protected environment gates.  
Risk if ignored: Misdeployments and rollback complexity.

### B) YELLOW ISSUES (Should fix)

1. Severity: Medium  
Evidence: Video list route has broad non-athlete path without explicit role check.  
File: [apps/web/app/api/pilot/video/list/route.ts](apps/web/app/api/pilot/video/list/route.ts#L41)  
Root cause: Missing least-privilege role enforcement for media metadata access.  
Recommended fix: Restrict to coach/admin/staff scopes and parent-linked athlete subsets.  
Risk if ignored: Overexposure of org media metadata.

2. Severity: Medium  
Evidence: Debug route exposes masked env snippets and performs external AI probe.  
File: [apps/web/app/api/pilot/shadow/debug/route.ts](apps/web/app/api/pilot/shadow/debug/route.ts#L20)  
Root cause: Operational diagnostics exposed in runtime API.  
Recommended fix: Disable in production or hard-gate behind platform owner + feature flag + IP allowlist.  
Risk if ignored: Increased reconnaissance surface.

3. Severity: Medium  
Evidence: Test suite checks file existence and prints simulated pass.  
File: [scripts/run-tests.ps1](scripts/run-tests.ps1#L46)  
Root cause: Placeholder testing not representative of runtime behavior.  
Recommended fix: Add integration/e2e tests for auth, tenant isolation, and SHADOW guardrails.  
Risk if ignored: False release confidence.

4. Severity: Medium  
Evidence: N+1 completion fetch loop in athlete progression page.  
File: [apps/web/app/athlete/progression-intelligence/page.tsx](apps/web/app/athlete/progression-intelligence/page.tsx#L122)  
Root cause: Per-assignment API fetch in client loop.  
Recommended fix: Add backend batch endpoint returning assignments with completions.  
Risk if ignored: Latency spikes and unnecessary API load.

5. Severity: Low  
Evidence: Empty SWA config under app path, non-empty root config.  
File: [apps/web/staticwebapp.config.json](apps/web/staticwebapp.config.json#L1), [staticwebapp.config.json](staticwebapp.config.json#L1)  
Root cause: Configuration duplication/drift.  
Recommended fix: Keep one authoritative SWA config and validate in CI.  
Risk if ignored: Route behavior inconsistencies across deployments.

### C) GREEN AREAS (Good)

1. Multi-tenant schema design uses organization-scoped keys and constraints broadly: [infra/azure/pilot_slice_postgres.sql](infra/azure/pilot_slice_postgres.sql#L58).
2. Core SHADOW authority checks block automated medical/clearance actions: [apps/web/src/server/pilot/shadowAuthority.ts](apps/web/src/server/pilot/shadowAuthority.ts#L82).
3. Cookie auth settings are reasonably hardened for production transport: [apps/web/app/api/pilot/auth/login/route.ts](apps/web/app/api/pilot/auth/login/route.ts#L43).
4. Build pipeline currently produces successful production artifact.

---

## SCORECARD

1. Production Readiness Score: **58/100**
2. SHADOW Doctrine Alignment Score: **71/100**
3. Security Score: **49/100**
4. Scalability Score: **64/100**
5. Multi-Tenant Readiness Score: **67/100**

## Top 5 Actions Before Production

1. Remove client-side operator authentication and hardcoded PIN patterns.
2. Fix announcements auth model (principal-bound org, no public tenant selector).
3. Eliminate SQL interpolation in shadow job queue filtering.
4. Correct production deployment resource targeting and formalize rollback runbook.
5. Replace simulated tests with real auth/tenant/AI-guardrail integration tests.

