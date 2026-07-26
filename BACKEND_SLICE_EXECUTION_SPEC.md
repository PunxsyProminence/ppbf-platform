# BACKEND_SLICE_EXECUTION_SPEC

Status: APPROVED
Date: 2026-07-13
Scope: Pilot backend vertical slice

## 1. Canonical Backend Choice
- Azure PostgreSQL is the single source of truth for:
  - Athlete
  - Goal
  - Session
  - Coach Review
  - SHADOW Intake
- Dataverse remains unchanged and limited to document ingest and future Microsoft integration work.
- No dual-write.
- No second source of truth.

## 2. Pilot Login Policy
- Admin creates athlete accounts.
- Athlete login = Athlete ID + PIN.
- No self-signup.
- No OAuth.
- No MFA.

Session policy:
- Persistent login.
- Session remains active until:
  - user logs out
  - admin revokes account/session
  - PIN reset occurs
- Remember-device enabled.

## 3. Role Rules
### Admin
- Full create/save access to all slice entities.

### Coach
- Create Athlete
- Save Athlete
- Create Goal
- Save Goal
- Create Session
- Save Session
- Create Coach Review
- Save Coach Review
- Limited to assigned athletes.

### Athlete
- View own profile
- Update limited profile fields
- Create Goal
- Save own Goal
- Create Session
- Save own Session

Athlete cannot:
- change role
- change coach assignment
- change status flags

## 4. Frozen Minimal Entity Fields
Do not add additional fields.

### Athlete
- athlete_id
- full_name
- dob
- weight_class
- gym_status
- emergency_contact
- active_flag
- coach_id
- created_at
- updated_at

### Goal
- goal_id
- athlete_id
- title
- target_date
- metric
- status
- created_at
- updated_at

### Session
- session_id
- athlete_id
- date
- rpe
- notes
- completed_flag
- created_at
- updated_at

### Coach Review
- review_id
- session_id
- coach_id
- decision
- notes
- approved_flag
- created_at
- updated_at

## 5. SHADOW Routing Map
- Session Note -> Session Queue
- Athlete Profile Update Candidate -> Athlete Review Queue
- Coach Review Candidate -> Coach Review Queue
- Unclassified -> Admin SHADOW Queue

Rule:
- No automatic writes.
- All routed records require human approval before modifying operational records.

## 6. Retention, Storage, and Audit
Retention:
- Keep all audit records. No purge window.

Uploads:
- Store files in Azure Blob Storage.
- Store metadata in database.

Audit events required:
- Create
- Update
- Login
- Logout
- SHADOW Classification
- SHADOW Routing

## 7. Environment Ownership
Jason provides:
- AZURE_POSTGRES_CONNECTION_STRING
- AZURE_STORAGE_CONNECTION_STRING
- PPBF_PILOT_BOOTSTRAP_KEY

Until supplied:
- Use environment placeholders only.
- Never hardcode credentials.

## 8. Migration Safety
- Fresh pilot schema for this slice.
- Do not retrofit legacy schemas into this slice.
- Isolated pilot schema for:
  - Athlete
  - Goal
  - Session
  - Coach Review
  - SHADOW Intake
- Preserve legacy artifacts until migration review confirms safe removal.

## 9. Mandatory Pass/Fail Gate
System is not complete until this scenario passes end-to-end:
- Create Athlete
- Create Goal
- Create Session
- Create Coach Review
- Logout
- Login
- Reload

Pass criteria:
- All records remain available.
- All records are correctly linked.

---

## Dependency-Ordered Todo List (Autopilot Build Queue)

### Phase 0 - Contract Lock
1. Create pilot schema namespace/tables for frozen entities only.
2. Freeze API contracts to frozen fields only.
3. Define role-action matrix in code constants.

### Phase 1 - Auth Foundation
4. Implement Athlete ID + PIN auth tables and hashed PIN verification.
5. Implement persistent session token/cookie model (remember-device behavior).
6. Implement logout, admin session revoke, and PIN reset invalidation logic.
7. Add audit logging for login/logout/revoke/reset events.

### Phase 2 - Core Entity Persistence
8. Implement Athlete create/save APIs with role enforcement and assigned-athlete checks.
9. Implement Goal create/save APIs with ownership/assignment enforcement.
10. Implement Session create/save APIs with ownership/assignment enforcement.
11. Implement Coach Review create/save APIs with assignment enforcement.
12. Add create/update audit writes for all four entities.

### Phase 3 - SHADOW Intake
13. Implement SHADOW upload API (file to Azure Blob Storage + metadata row).
14. Implement deterministic classification stage and persistence.
15. Implement routing stage to review queues and persistence.
16. Enforce no automatic operational writes from SHADOW intake outputs.
17. Add SHADOW classification/routing audit events.

### Phase 4 - UI Wiring
18. Wire login/logout UI to new persistent auth APIs.
19. Wire Athlete/Goal/Session/Coach Review create/save UI calls to backend APIs.
20. Keep excluded domains untouched (AI/compliance/publication/progression).

### Phase 5 - Verification Gates
21. Execute mandatory end-to-end pass/fail scenario.
22. Verify refresh/logout/login/reload persistence and relational integrity.
23. Verify role boundaries and forbidden athlete field changes.
24. Verify SHADOW intake stores files, classifies, routes, and awaits human approval.

## Out of Scope (Do Not Build in This Slice)
- AI features
- Compliance automation
- Publication workflow automation
- Progression intelligence automation
- Non-slice domain expansions

---

## PPBF V1 Launch Queue Amendment - Platform Audit Reconciliation Lane

Placement rule for execution order:
- Insert this remediation lane after the current onboarding incident lane.
- Execute this lane before athlete onboarding or SHADOW expansion lanes.

Non-negotiable provenance rule:
- The referenced platform audit was performed against `C:\Projects\ppbf-platform` in a dirty checkout that was behind `origin/main`.
- Never treat those findings as verified current truth until they are reconciled against current source and deployed versions.
- Never modify that dirty checkout as part of remediation validation.

### Phase 0 - Verify Every Finding on Current Truth

1. Fetch current `origin/main`.
2. Create a clean isolated read-only audit worktree.
3. Identify:
  - current main SHA;
  - exact production release SHA;
  - exact staging release SHA.
4. Recheck every finding against:
  - current `origin/main`;
  - the exact production source version;
  - current deployment workflow configuration.
5. Classify each finding:
  - confirmed current;
  - production-only;
  - resolved since the audited checkout;
  - stale;
  - false positive;
  - requires runtime verification.
6. Provide exact file, line, contract, test, and runtime evidence.
7. Search counts and absence of `requirePrincipal()` are not sufficient proof; routes may use alternate centralized authorization.
8. Do not duplicate fixes already merged.
9. Update this launch queue with reconciled outcomes.

### Fix Order if Confirmed

#### P0.1 - Unify Microsoft and Frontend Session Authority

Investigate and fix together:
- session endpoint GET/POST mismatch;
- `authProvider` versus `auth_provider` contract mismatch;
- Microsoft callback server cookie versus client-local role session;
- `RoleSessionGate` behavior;
- platform-owner organization-context resolution;
- post-login and onboarding redirects.

Required architecture:
- Signed server session and server-resolved principal are authoritative.
- Local storage or client-selected role can never grant or preserve access.
- Frontend may cache display state, but must revalidate against server.
- Role and organization are returned through one typed session contract.
- Organization context is explicit and membership-validated.
- PIN sessions expose athlete navigation only.
- Privileged navigation requires Microsoft authentication.
- Direct URLs and APIs enforce the same rules as UI.
- Logout, expiration, revocation, and membership deactivation update UI immediately.

UI/flow acceptance:
- clear signing-in state;
- clear session-loading state without redirect loops;
- friendly forbidden and expired-session messages;
- correct destination after Microsoft callback;
- correct destination after onboarding completion;
- browser refresh preserves a valid session;
- stale client cache cannot preserve privileged access;
- mobile/tablet navigation matches authenticated role.

Tests:
- Microsoft callback -> session -> onboarding -> admin application;
- refresh and new-tab behavior;
- expired and revoked sessions;
- missing client-local state with valid server session;
- forged client role with invalid server authorization;
- platform owner with and without active gym-admin membership;
- PIN athlete attempting privileged navigation;
- contract tests verifying method and field naming.

Definition of done:
- one authoritative session model controls both backend and frontend behavior.

#### P0.2 - Secure Announcement Organization Scope

If current routes still accept caller-controlled `organization_id` without principal-derived authorization:
1. Derive organization scope from authenticated principal and validated membership.
2. Reject client attempts to substitute another organization.
3. Require appropriate roles for read and write operations.
4. Retire shared operator-PIN path from normal application traffic.
5. Preserve genuine emergency path only behind separately isolated control plane.
6. Add cross-organization and malicious-identifier tests.
7. Ensure PIN athletes cannot post privileged announcements.
8. Audit announcement mutations without logging announcement-sensitive contents.

Definition of done:
- caller cannot select or infer another organization through announcement APIs.

#### P1.1 - Isolate Bootstrap and Migration Control Routes

If key-based bootstrap or migration routes remain deployed:
- determine whether production application traffic still needs them;
- prefer migrations through established authenticated deployment workflow;
- disable or remove public runtime exposure when no longer required;
- if an emergency endpoint must remain:
  - isolate from ordinary app navigation;
  - require narrow workflow/identity authorization;
  - apply rate limiting;
  - audit invocation;
  - fail closed;
  - never accept organization or target scope solely from caller input.
- do not broaden Azure permissions;
- do not rotate or expose keys during this work without explicit approval.

Definition of done:
- ordinary web clients cannot invoke platform bootstrap or database migration operations.

#### P1.2 - Make the Real Test Suite Authoritative

If root test command still performs simulated file checks:
1. Replace or rename so `npm test` cannot falsely imply application tests passed.
2. Make release-required command run the real fast suite.
3. Keep migration tests, lint, build, and integration tests as explicit gates.
4. Ensure GitHub CI invokes the same authoritative commands.
5. `No checks` never counts as green.
6. Add lightweight test proving root command reaches real test suites.

Definition of done:
- local, CI, and release reports cannot confuse simulated checks with real tests.

#### P1.3 - Eliminate Deployment-Target Ambiguity

Constraint:
- production app may intentionally reside in a resource group whose name includes `staging`.
- do not rename or move resources during this slice.

Required controls:
- resolve exact resource IDs;
- hard-assert subscription, tenant, resource group, Container App, registry, and environment before mutation;
- assert production and staging targets differ;
- assert exact release promoted from staging;
- keep production workflow manual and gated;
- add clear workflow comments explaining intentional legacy naming;
- fail before deployment on target mismatch;
- never infer environment solely from resource-group name.

Definition of done:
- confusing names cannot cause workflow to target wrong application.

#### P2.1 - Documentation Truth and Audit Lifecycle

- Add obvious audit date, source SHA, scope, and superseded/current status.
- Do not silently rewrite historical audits.
- Create one current index pointing to authoritative audits and marking stale ones.
- Separate code findings from runtime/infrastructure findings.
- Never treat old `no CI/CD` statements as current after workflows exist.

Definition of done:
- engineers can distinguish current truth from historical audit evidence.

#### P2.2 - API Style Is Not a Launch Blocker

- High POST-to-GET ratio and action-oriented style are maintainability observations, not proof of security defect.
- Do not refactor all routes before V1.
- Fix only routes with demonstrated contract, authorization, idempotency, or organization-scope problems.
- Record broader API normalization as post-V1 technical debt.

#### Process Finding - Branch Drift

Treat dirty/behind local checkout as operator/process condition, not application defect.

Continue enforcing:
- isolated worktrees;
- fresh `origin/main`;
- exact-SHA testing;
- no edits to dirty local main;
- no rebasing or force-pushing shared work;
- production promotion from verified releases.

### UI, Flow, and Formatting Requirement

For every confirmed remediation:
- review complete user journey, not only API;
- use consistent PPBF typography, spacing, buttons, forms, errors, loading states, and navigation;
- test at 320, 360, 768, and 1024 pixel widths;
- test tablet portrait and landscape;
- meet WCAG 2.2 AA;
- preserve form state after recoverable errors;
- prevent duplicate submissions;
- never expose raw internal errors or identifiers;
- add deterministic visual-regression coverage for critical authentication and onboarding states;
- baseline screenshot changes require intentional review; do not auto-accept.

### SHADOW Queue Corrections

Apply these corrections to previously supplied SHADOW queue:
1. Add a Phase 0 provenance/formula-registry gate before formula implementation.
2. Treat supplied handoffs as truncated and claimed 88-file Register as unavailable until located.
3. Move immutable audit history, basic uncertainty/abstention, red-flag enforcement, and escalation routing into foundation before any recommendation ships.
4. Keep data-quality confidence separate from recommendation calibration/reliability.
5. Chat remains read-only until structured response, fail-closed parser, and cross-organization/cross-athlete tests pass.
6. Learning writes require authenticated append-only events, idempotency, explicit human action, retry/failure visibility, and audit provenance.
7. No feedback event may automatically change production formulas, policies, model weights, or access.
8. Block only affected formula when exact definition is unavailable; continue independent infrastructure, UI, and verified formulas.

### PR and Release Structure

Do not combine all findings into one large PR.

Recommended slices:
1. session-contract and frontend-auth unification;
2. announcement organization authorization;
3. bootstrap/migration control-plane isolation;
4. authoritative test entrypoint and CI;
5. deployment hard assertions;
6. documentation audit index.

For each slice:
- fresh worktree from current main;
- focused regression tests;
- full required verification;
- real CI;
- staging deployment and acceptance where applicable;
- gated production release;
- rollback plan;
- sanitized queue update.

If a slice reaches a hard blocker:
- leave it safely unmerged;
- document exact blocker;
- continue unrelated slices.

After this remediation lane completes:
- resume existing athlete-onboarding and SHADOW queues.

### Execution Log - 2026-07-26

Phase 0 classification progress:
- Confirmed current: session endpoint method/field contract mismatch and frontend local-session gate divergence.
- Confirmed current: announcement routes accepted caller-controlled `organization_id` and relied on shared operator PIN path.
- Verified current: root `npm test` already dispatches to the real repo test runner, so P1.2 is not an active implementation blocker.

Implemented this session:
1. P0.1 (partial complete)
  - Session introspection endpoint now supports both POST and GET.
  - Session payload now includes both `auth_provider` and `authProvider` for compatibility.
  - Platform owner onboarding auth check switched to POST and normalized provider parsing.
  - `RoleSessionGate` now validates access from server session authority, with role mapping from principal role to UI role.
2. P0.2 (complete for route hardening)
  - Announcement read scope now derives organization from authenticated principal.
  - Announcement write scope now derives organization and actor from authenticated principal.
  - Shared `PPBF_OPERATOR_PIN` write-path removed from normal announcement post flow.
3. P1.1 (complete for control-plane isolation)
  - Bootstrap, multi-org migration, and Microsoft platform-owner bootstrap routes now require explicit internal control-plane intent headers.
  - Ordinary app navigation cannot invoke these routes without the control-plane header.
4. P1.3 (complete for deployment-target hardening)
  - Production deploy workflow now explicitly guards the intended Container App and resource group.
  - Workflow comments document the intentional legacy resource-group naming so operators do not infer environment from the name.
5. P2.1 (complete for documentation truth and audit lifecycle)
  - Added a single audit truth index at `docs/AUDIT_INDEX.md`.
  - Master navigation now points to the audit truth index.
  - Historical audits remain unchanged and are categorized by current, historical, or stale-reverification status.
6. P1.2 (complete for authoritative test entrypoint)
  - Root `npm test` now runs the real workspace test suites.
  - Simulated file-presence checks were removed from `scripts/run-tests.ps1`.
  - `npm test` passed after installing the missing workspace dependency and rerunning the full suite.
7. Current-session revalidation notes
  - `apps/web/app/api/pilot/shadow/debug/route.ts` is currently principal-gated and role-gated.
  - `apps/web/app/api/pilot/video/list/route.ts` is currently principal-gated with role and athlete-ownership checks.
  - These findings are reverified non-blockers, not active launch-slice fixes.

Verification evidence:
- `npm --prefix apps/web run -s build` passed after both slices.
