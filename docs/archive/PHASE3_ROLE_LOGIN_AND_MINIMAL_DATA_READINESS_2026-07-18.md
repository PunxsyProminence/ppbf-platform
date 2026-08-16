# PHASE 3 Role Login and Minimal Data Readiness (2026-07-18)

## 1. Executive Summary
- Scope: production readiness for controlled pilot use after Phase 2 hardening.
- Outcome: role authentication for core pilot roles (platform owner, org admin, coach, athlete, parent) is working in production with session and cross-org protections validated.
- Key limitation: board and operations are frontend session roles, not backend account roles; server-side board/operations auth is not implemented.
- Recommendation at this stage: controlled pilot data is feasible for core roles only, with strict operational guardrails.

## 2. Phase 2 Baseline Confirmation
- Baseline docs reviewed:
  - docs/PHASE2_HARDENING_REPORT_2026-07-18.md
  - docs/PHASE2_PRODUCTION_VERIFICATION_2026-07-18.md
- Both critical blockers were verified fixed in production per Phase 2 evidence:
  - SHADOW rerun duplicate-key blocker fixed.
  - Azure AI runtime configured and model-backed response restored.
- Current active production revision:
  - latestRevisionName: app-ppbf-production--0000043
  - latestReadyRevisionName: app-ppbf-production--0000043
- Remaining Phase 2 risks carried forward:
  - production workflow can overwrite AZURE_AI env-name bindings unless workflow env list is updated.
  - non-blocking runtime warnings remain (Next polyfills, pg SSL-mode warning).
- Items still marked NOT VERIFIED from Phase 2:
  - sustained load/performance re-validation.
  - full adversarial cross-tenant penetration testing.

## 3. Role Login Verification
Production disposable role test run (evidence JSON captured):
- Test orgs: org_phase3_20260718225332, org_phase3b_20260718225332
- Roles created and login/session verified:
  - platform_owner
  - organization_admin
  - coach
  - athlete
  - parent

Verified results:
- account can exist: yes for all 5 roles above.
- login succeeds: yes for all 5 roles.
- session endpoint role/org context: correct role and org returned for all 5 roles.
- cross-org read block: verified (org2 admin could not read org1 athlete; found=false).
- logout/session clearing: verified (coach logout then authenticated=false on session).

Board and operations role implementation check:
- Attempted backend creation for role board-president: 400 Unsupported role.
- Attempted backend creation for role operations: 400 Unsupported role.
- Conclusion: board/operations are not backend account roles in current production auth model.

## 4. Session/Authorization Verification
Server-side authorization checks verified by controlled negative tests:
- coach calling platform user-create endpoint: 403.
- athlete calling athlete-create endpoint: 403.
- parent calling athlete-get for unlinked athlete: 403.
- cross-org data isolation on athlete-get: effective.

Relevant enforcement paths:
- API auth/session/logout endpoints under app/api/pilot/auth/*.
- role checks via src/server/pilot/access.ts and src/server/pilot/http.ts.

Frontend routing caveat:
- many dashboard routes are rendered and then gated client-side through RoleSessionGate and roleSession local storage.
- direct HTTP GET smoke of dashboards returns 200 for all checked routes, so route blocking evidence is primarily client-session behavior plus server API authorization, not server-side page HTTP status.

## 5. Minimal Seed Readiness
### 5.1 Real PPBF organization record
- Path: app/api/pilot/platform/organizations/route.ts (POST), also admin UI app/admin/organizations/page.tsx.
- Required fields: organization_id, organization_name.
- Duplicate handling: createOrganization uses upsert semantics (on conflict update/re-activate).
- Org ownership: platform_owner only.
- Inactive/archive behavior: status management exists via app/api/pilot/platform/organizations/status/route.ts (active/inactive/suspended/pending).

### 5.2 Platform owner/admin
- Path: app/api/pilot/admin/bootstrap/route.ts (bootstrap role platform_owner) and app/api/pilot/admin/bootstrap/platform-owner-microsoft/route.ts.
- Required fields: bootstrap key header, account_id, pin (for local bootstrap).
- Duplicate handling: createOrRotateAdminAccount upserts account + rotates sessions.
- Org ownership: bound to target org.
- Inactive handling: app/api/pilot/platform/users/status/route.ts.

### 5.3 Coach
- Path: app/api/pilot/platform/users/create/route.ts role=coach.
- Required fields: organization_id, account_id, role, pin.
- Duplicate handling: createCoachAccount upsert.
- Org ownership: membership assignment enforced to target org.
- Inactive handling: users/status + memberships endpoints.

### 5.4 Athlete
- Path: app/api/pilot/platform/users/create/route.ts role=athlete plus athlete_id.
- Required fields: organization_id, account_id, role, pin, athlete_id.
- Duplicate handling: createOrUpdateAthleteAccount upsert.
- Org ownership: account + membership tied to org; athlete entity uses org-scoped upsert key.
- Inactive handling: users/status endpoint.

### 5.5 Parent/guardian linked to athlete
- Parent account path: app/api/pilot/platform/users/create/route.ts role=parent (upsert).
- Guardian-athlete link path: app/api/pilot/intake/domain-upsert/route.ts entity_type=guardian_link.
- Required link fields: athlete_id, payload.parent_id (+ relationship optional default).
- Duplicate handling: guardian upsert + guardian_links insert/update in intake layer.
- Org ownership: guarded by principal org and athlete access assertions.

## 6. Workout/Observation Readiness
### 6.1 Workout template
- Status: NOT IMPLEMENTED as a first-class template API.
- Evidence: no dedicated workout-template create/list/update route in pilot API surface.

### 6.2 Assigned workout
- Path: app/api/pilot/progression/assignments/route.ts (POST).
- Required fields: gap_id, athlete_id, drill_name, drill_description.
- Org scoping: assignment writes use principal.organizationId.
- Edit/correct: assignDrill path supports assignment creation; update semantics are limited in current surface.

### 6.3 Coach observation
- Path: app/api/pilot/intake/domain-upsert/route.ts with entity_type=coach_note.
- Required fields: athlete_id and payload.note_text (note_type default available).
- Org scoping: enforced via principal org + actor access assertion.
- Edit/correct: create path exists; dedicated update endpoint for coach observations not evidenced.

### 6.4 SHADOW evidence/intake item
- Path: app/api/pilot/shadow/upload/route.ts.
- Required payload: multipart file, auth role coach or organization_admin.
- Org scoping: principal.organizationId bound on write.
- Doctrine safety: authority checks + SHADOW event/telemetry/research requirement chain enforced before and after write.

## 7. SHADOW Evidence Intake Readiness
- Upload and review/promotion pipeline is live and already validated in Phase 2 production verification.
- Relevant paths:
  - app/api/pilot/shadow/upload/route.ts
  - app/api/pilot/intake/review-action/route.ts
  - app/api/pilot/intake/domain-upsert/route.ts
- Doctrine drift check: no doctrine change introduced in this phase; high-risk and authority controls remain active.

## 8. Role Access Matrix
| Role | Dashboard access | User management | Organization management | Athlete data access | Parent/guardian access | SHADOW access | Admin/compliance access | Cross-org blocked |
|---|---|---|---|---|---|---|---|---|
| platform owner | VERIFIED | VERIFIED | VERIFIED | BLOCKED (org-private athlete endpoints) | NOT VERIFIED | VERIFIED | VERIFIED | VERIFIED |
| org admin | VERIFIED | NOT VERIFIED (platform user-create is platform_owner only) | NOT VERIFIED (platform org routes are platform_owner only) | VERIFIED | VERIFIED (via intake domain upsert/linking paths) | VERIFIED | VERIFIED | VERIFIED |
| coach | VERIFIED | BLOCKED | BLOCKED | VERIFIED | NOT VERIFIED | VERIFIED | VERIFIED (limited endpoints) | VERIFIED |
| athlete | VERIFIED | BLOCKED | BLOCKED | VERIFIED (self scope) | BLOCKED | VERIFIED | BLOCKED | VERIFIED |
| parent | VERIFIED | BLOCKED | BLOCKED | VERIFIED (linked scope only) | VERIFIED (link path available for admins/coaches) | VERIFIED | BLOCKED | VERIFIED |
| board | PARTIAL (frontend role routes) | NOT IMPLEMENTED (backend role) | NOT IMPLEMENTED (backend role) | NOT VERIFIED | NOT VERIFIED | NOT VERIFIED | PARTIAL (frontend compliance view exists) | NOT VERIFIED |
| operations | PARTIAL (frontend route) | NOT IMPLEMENTED (backend role) | NOT IMPLEMENTED (backend role) | NOT VERIFIED | NOT VERIFIED | NOT VERIFIED | NOT VERIFIED | NOT VERIFIED |

## 9. Commands Run
Required checks:
- npm --workspace web run lint
- npm --workspace web run test
- npm --workspace web run build
- npm --workspace web run pilot:preflight

Relevant role/auth/session gates:
- npm --workspace web run gate:pilot:multiorg (production base URL + disposable identities) -> PASS

Production role/session verification:
- controlled disposable production script using auth/login, auth/session, auth/logout, platform/users/create, athletes/get.
- board/operations backend-role create attempts (expected unsupported-role behavior).

Production dashboard smoke checks:
- HTTP GET checks across /login, /admin, /operations, /coach/review-queue, /athlete/dashboard, /parent/dashboard, /board/president, /board/compliance-monitoring, /shadow, /research/chat.

## 10. Pass/Fail Table
| Check | Result |
|---|---|
| Baseline blockers fixed confirmation | PASS |
| Current revision captured | PASS |
| Lint | PASS |
| Test | PASS |
| Build | PASS |
| Pilot preflight | PASS |
| Multi-org gate | PASS |
| Core role login (PO/org admin/coach/athlete/parent) | PASS |
| Session role/org context | PASS |
| Cross-org block | PASS |
| Logout/session clear | PASS |
| Board backend role support | FAIL (not implemented) |
| Operations backend role support | FAIL (not implemented) |
| Workout template API | FAIL (not implemented) |

## 11. Remaining Risks
- deployment workflow can overwrite required AZURE_AI env-name bindings if workflow env list is not updated.
- board/operations are frontend session roles without backend role model and server-side role issuance.
- dashboard route protection is largely client-session gating; server-side API authorization is stronger than page-level HTTP protections.
- minimal pilot seed paths are safe, but bulk imports and high-volume onboarding were intentionally not validated.

## 12. NOT VERIFIED Items
- real human PPBF account testing in production (this run used disposable accounts only).
- full board workflow authorization against backend role tokens (backend board role not implemented).
- operations-specific backend authorization model.
- full edit/correction lifecycle for workout assignments and coach observations.
- stress/load re-validation in this phase.

## 13. Recommendation
- Recommendation for controlled pilot data: READY with constraints.
- Constraints:
  - use only core backend-auth roles (platform_owner, organization_admin, coach, athlete, parent).
  - do not treat board/operations as backend-authenticated production roles yet.
  - use minimal seed only; no bulk import; no multi-gym onboarding expansion in this phase.
