# PPBF Production User/UI Audit — Run 1, 2026-10-04

This is the execution record for one audit run. It is history and evidence,
not authority. The procedure is in `docs/current/PRODUCTION_AUDIT_RUNBOOK.md`.

**Status: PARTIAL.** Four of the nine backend roles had a signed-in account.
No production writes or cross-role workflows were executed, because no
records were established as test data.

## A. Identity

| Item | Value |
|---|---|
| Source read | `origin/main` f785206803a3d63b6a64b4c39e92b4fbfb2893fa (read-only, `git show`) |
| Production | 6a5927461ce3f787900df8fec23c7ff6f2d39cbf, the `headSha` of the last successful `deploy-production` run (2026-10-04T20:40Z, release 8). Main was 9 PRs ahead. |
| Window | 2026-10-04 ~21:55Z – 22:30Z |
| Auditor | Claude Code (overwatch session), Opus, plus two Sonnet sweep agents |

**Contexts.** Each was verified through `POST /api/pilot/auth/session`.

| Context | Role | Org | Landing (observed = expected) |
|---|---|---|---|
| In-app browser | organization_admin (ORGADMIN-A) | punxsy_prominence | /admin/people ✔ |
| Chrome 76f34c25 | athlete (ATH-A) | punxsy_prominence | /athlete/dashboard ✔ |
| Chrome b104b49e | coach (COACH-A, assigned to ATH-A) | punxsy_prominence | /coach/environment/intake-router ✔ |
| Chrome 9fdcef4d | platform_owner (PO-A) | ppbf-default-org | /admin/platform ✔ |

**Not available:** parent, board (and all eight seats), staff, volunteer.
The legacy `admin` role is an alias of `organization_admin` and is covered by
ORGADMIN-A.

## B. Coverage

| Measure | Value |
|---|---|
| Accounts audited | 4 of 4 available |
| Roles | 4 of 9 represented (5 NOT AVAILABLE) |
| Page routes on main | 163 |
| Building-map routes | 139 |
| Route opens, all at load level | 218: ORGADMIN-A 103, COACH-A 75, ATH-A 20, PO-A 22 (plus some negatives) |
| Negative authorization tests | about 60 executed (API and direct-route) |
| Cross-account negative tests against real records | NOT EXECUTED (no controlled target) |
| Controls | not systematically exercised (load and API level only) |
| Writes | 0 planned, 0 executed (no established test data) |
| Cross-role workflows | 0 executed |
| Responsive | ORGADMIN-A at 412 and 768: 4 surfaces. Athlete and coach: NOT EXECUTED. |
| Platform-blocked | 3 (see S) |

## C. Summary

| Severity | Count | Findings |
|---|---|---|
| P0 | 0 | |
| P1 | 1 | F-001 |
| P2 | 1 | F-002 |
| P3 | 1 | F-003 |
| UX | 2 | U-001, U-002 |

Every role boundary tested held.

## E. Route census

- 163 page routes; 139 are building-map doors.
- 24 have no door:
  - 17 EXCLUDED in `buildingMapCoverage.test.ts`;
  - 6 PENDING_TRIAGE: `/admin/export`, `/admin/gear`, `/admin/gear/vendors`,
    `/admin/athletes`, `/admin/organizations/test`,
    `/admin/platform/overview`;
  - the dynamic `/store/[organizationId]`.
- Observed aliases and redirects:
  - `/admin/safety-escalations` → `/admin/escalations`;
  - for athletes, `/dashboard`, `/notices` and `/chalkboard` → the athlete
    landing;
  - for coaches, `/dashboard` and `/operations` → the coach landing.

## F–R. Findings

### F-001 — /admin/consent roster never loads

| | |
|---|---|
| Severity | P1 |
| Classification | FUNCTIONAL BUG / NETWORK/API BUG |
| Status | READY FOR RETEST (fixed by #1221, `bb9a3d64`; live in production with release 9, deploy run 37308544899 on `ac8f3e61`; status updated 2026-10-05) |
| Affected | organization_admin and coach |
| Defect | `app/admin/consent/page.tsx:134-138` loads the roster with `POST /api/pilot/athletes/list`. `app/api/pilot/athletes/list/route.ts:10` exports only `GET`. |
| Observed | Production answers 405 and the page shows "ROSTER UNAVAILABLE — The roster could not be loaded." A GET from the same session returns 200 with the roster. |
| Main | Still present on main. |
| Why tests missed it | `page.test.tsx` mocks by URL only (~line 72), so the method was never asserted. |
| Root cause | PROVEN |
| Repair | Chip offered: "Fix /admin/consent roster request method (F-001)". Not launched. |

### F-002 — /api/pilot/coach/intelligence returns 500

| | |
|---|---|
| Severity | P2 |
| Classification | NETWORK/API BUG |
| Status | FIX MERGED, awaiting release 10 (#1224, merged as `5e498d01`; READY FOR RETEST once released; status updated 2026-10-05) |
| Affected | organization_admin and coach (both sweeps) |
| Observed | `/coach/intelligence` shows FAILED. A direct replay returned `500 {"error":"Internal server error"}`. |
| Guard | Allows coach, organization_admin and admin (`route.ts:34`). |
| Root cause | UNKNOWN. Server logs were not read: Azure CLI returned nothing from this machine. |

### F-003 — Board monitoring pages admit platform_owner; their APIs do not

| | |
|---|---|
| Severity | P3 |
| Classification | MISWIRED CONTROL / DATA-HONESTY BUG |
| Status | FIX MERGED, awaiting release 10 (#1229, merged as `ee0feb13`; status updated 2026-10-05; see the correction below) |
| Affected | platform_owner only; no data exposed |
| Defect | `board/compliance-monitoring/page.tsx:158` and `board/escalation-monitoring/page.tsx:116` gate on `['board','platform_owner']`, and the building-map `BOARD_GATE` matches. But `board/compliance-summary/route.ts:11` and `board/escalation-summary/route.ts:17` require `['board']`. |
| Observed | 403, and the page shows "Unavailable — could not be read", so a refusal reads as a failure. `/board/aggregates` fires `volunteer-summary` (403), then redirects. |
| Root cause | PROVEN as a mismatch. Which side is right is Jason's decision. |

**Correction (2026-10-05).** The Defect row above is left as recorded. Its
claim that "the building-map `BOARD_GATE` matches" was wrong: on main, before
the fix, the building-map doors for `/board/compliance-monitoring`,
`/board/escalation-monitoring` and `/board/aggregates` were already
`roles: ['board']`, not `BOARD_GATE` (`apps/web/components/buildingMap.ts:579-592`
at `ee0feb13^`). The real gaps were:

1. the two page gates admitting platform_owner
   (`compliance-monitoring/page.tsx:158` and `escalation-monitoring/page.tsx:116`,
   `['board','platform_owner']`);
2. the fetching hooks on `/board/aggregates` running outside the page's gate, so
   the summaries were requested (403) before the redirect;
3. the "Hand-Filed Compliance Register" link on `BoardMemberDashboard`, shown to
   the platform owner;
4. the "Compliance Monitoring" entry on the `/operations` dev lab.

Jason chose option A (the platform owner is not served board aggregates;
OD-2026-10-05-006) and approved the stamp line (OD-2026-10-05-007). Fixed by
#1229 (`ee0feb13`), not yet released.

### U-001 — /admin/platform refusal screen for other roles (UX)

The refusal is honest, but it is inconsistent with every other gated route,
which redirects. It also offers "GO TO ADMIN DASHBOARD" and "SIGN IN WITH
MICROSOFT" to an athlete. Only the session API was called, so no data leaked.

### U-002 — Small target on /admin/attendance (UX)

At 412px, one control on `/admin/attendance` is under 24px.

### Expected deployment difference (not a finding)

`/coach/mental-skills` returns 404 in production because it merged after
release 8 (#1215). It ships with the next release.

### Self-labelled placeholders (intentional)

These pages say on screen that they are placeholders, not built or samples,
so none is fabricated data posing as real:

- `/source-control` and `/source-control/publication-workflow` (PLACEHOLDER,
  sample);
- `/simulator` (NOT BUILT);
- `/retro-lab` (SAMPLES);
- `/operations` (NOT BUILT lines);
- `/help` (MIXED LIVE + PLACEHOLDER);
- `/board/president` (catalogue not built, labelled).

`/admin/shadow` shows "Effectiveness: Unavailable" next to 0 reviewed
outcomes. That is an honest unknown.

### Intentional behaviour, checked

- `/staff-credentials` is open to athletes: building-map line 269 and the
  owner request quoted in `route.ts:37`.
- `/audit` is open to coaches: building-map line 626, with the coach
  allow-list in `audit/get`.
- On `/research`, `shadow/library/sources` returns 403 for coach and athlete.
  This is the page's own curator probe (`research/page.tsx:205-215`), which
  hides the panel when refused.

## H. Authorization, tenant and ownership

Every check below is at PRODUCTION evidence level. SUBJECT is the deployed
6a5927461ce3f787900df8fec23c7ff6f2d39cbf.

| ID | Claim | Positive control | Negative control | Verdict |
|---|---|---|---|---|
| NEG-PO-01 | platform_owner cannot read ATH-A's records | ATH-A reads its own records: 200, with items (POS-ATH-01) | PO on 8 athlete APIs → 403 | APPLICABLE |
| NEG-PO-02 | platform_owner cannot read org-private admin data | ORGADMIN-A gets 200 on the same routes | PO on 9 admin APIs → 403, also with `?organization_id=punxsy_prominence` | APPLICABLE |
| NEG-ATH-01 | an athlete cannot read another athlete's record | own records → 200 | `AUDIT-NONEXISTENT-001` → 403 "athlete cannot access another athlete record" | PARTIAL |
| NEG-ATH-02 | an athlete cannot open staff pages | | 13 direct navigations → redirect to the athlete landing | APPLICABLE |
| NEG-CO-02 | a coach cannot read unassigned athletes | assigned ATH-A → 200, and `coach_id` equals the session | nonexistent id → 403 "coach not assigned" | PARTIAL |
| NEG-CO-05 | a coach cannot open admin, board or parent pages | | 8 direct navigations → redirect | APPLICABLE |
| NEG-OA-02 | an org admin cannot reach another organization | own org → 200 | foreign `organization_id` → ignored (byte-identical response) | APPLICABLE |

Blind spots:

- NEG-ATH-01 and NEG-CO-02 used a nonexistent id, not a real foreign record,
  because no controlled target existed.
- NEG-ATH-02 did not capture requests fired before the redirect.
- The board, parent, staff and volunteer boundaries are untested.

## I. Authentication and session

Every context returned the role the server expects, and every landing route
matched `pilotRoleRouting.ts`. Sign-out and sign-in were not exercised: Jason
handles credentials.

## S. Platform-blocked

1. The auto-mode classifier refused Chrome browser switching and the session
   read until Jason authorized them in chat.
2. Hidden-iframe and popup sweeps were blocked (the site's framing headers
   and the popup blocker), so sweeps used real navigation.
3. The extension redacted some JS results ("[BLOCKED: …]"); they were
   re-queried narrower.

## T. Not executed

- Parent, board (plus 8 seats), staff and volunteer accounts: not available.
- Production writes and all cross-role workflows: no established test data.
  The "Audit Test Gym" organization exists but has no signed-in accounts.
- Real cross-athlete and cross-coach negative cases: no controlled target.
- Control-level positive tests (forms, create, edit, remove): not exercised.
- Responsive checks for the athlete and coach contexts: those Chrome windows
  were minimized, and resizing them was not done.
- Accessibility pass beyond target size: not executed.

## U. Test data and cleanup

None created.

## V. Reconciliation

Not performed in run 1, which was the independent pass. Run 2 should compare
with this record and with `docs/PLATFORM_AUDIT_2026-08-28_ROUTE_REACHABILITY.md`.

## W. Repair tasks

| Finding | Task | Status |
|---|---|---|
| F-001 | chip "Fix /admin/consent roster request method (F-001)" | not launched (as of run 1). 2026-10-05: fixed by #1221, released in release 9; READY FOR RETEST |
| F-002 | needs log access first (root cause unknown) | none (as of run 1). 2026-10-05: #1224 merged; FIX MERGED, awaiting release 10 |
| F-003 | needs Jason's decision on which side is right | none (as of run 1). 2026-10-05: decided (option A), #1229 merged; FIX MERGED, awaiting release 10 |

## Y. Repair order

1. F-001
2. F-002 (read the production logs first)
3. F-003 (after Jason decides)
4. U-001
5. U-002
