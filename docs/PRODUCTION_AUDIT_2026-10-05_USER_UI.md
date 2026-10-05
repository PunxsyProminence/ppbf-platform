# PPBF Production User/UI Audit — Run 2, 2026-10-05

This is the execution record for one audit run. It is history and evidence,
not authority. The procedure is in `docs/current/PRODUCTION_AUDIT_RUNBOOK.md`.

**Status: PARTIAL.** Four of the nine backend roles had a signed-in account.
One account (organization_admin) was completed. The coach and athlete route
sweeps finished, but their API boundary checks did not run: every Chrome tab
froze (renderer timeouts at 45 s) with Jason away from the PC. The
platform_owner sweep stopped at 14 of 42 routes for the same reason.
Overwatch directed closing this run as PARTIAL (message 2026-10-05, "Write it
as PARTIAL now ... The remaining sweeps ... go to run 3 after release 11
deploys #1224/#1229"). No production writes and no cross-role workflows were
executed: no records were named as test data.

## A. Identity

| Item | Value |
|---|---|
| Source read | `origin/main` 25e299f03830ca28d9e7a1fb1a81e8ba1924519e (read-only, `git show`) |
| Production | ac8f3e6138635a4db38cfcd859b3caadce40d34f: the `headSha` of the last successful `deploy-production` run, 37308544899 (2026-10-05T12:17:48Z, release 9). Main was 6 commits ahead at the start, including #1224 (F-002 fix) and #1229 (F-003 fix). Every observation in this record was made on this commit. |
| Later deploy | c00942a16b2354c6a86736747d42ab30180bc317, `deploy-production` 2026-10-05T17:59:30Z, deployed during the run after the browser checks had stopped. It contains #1221, #1224 and #1229 (ancestor checks). Nothing in this record was observed on it. |
| Window | 2026-10-05 12:31Z to 19:33Z |
| Auditor | Claude Code auditor lane (Opus), with two read-only sweep agents (one Chrome, one in-app browser), reporting to overwatch |
| Open PRs touching audited surfaces | #1228 (clip tags API); not an audited surface |

**Contexts.** Each was verified through `POST /api/pilot/auth/session`. The
masked hint is withheld for the athlete because its prefix is part of a
minor's name.

| Context (deviceId) | Role | Org | Board seat | Athlete link | Expected landing | Observed landing (via /login) | Verified |
|---|---|---|---|---|---|---|---|
| In-app browser | organization_admin (ORGADMIN-A, ppb…/25) | punxsy_prominence | none | no | /admin/people | /admin/people | yes, start and end of sweep |
| Chrome 9fdcef4d-9db9-4d58-8fcb-4c978831d012 | platform_owner (PO-A, Adm…/26) | ppbf-default-org | none | no | /admin/platform | /admin/platform | start only (froze before end check) |
| Chrome 76f34c25-4749-4b74-9194-f6df11916ce0 | athlete (ATH-A) | punxsy_prominence | none | yes | /athlete/dashboard | /athlete/dashboard | yes, start and end of sweep |
| Chrome b104b49e-9393-482e-8167-a857c6bf9e26 | coach (COACH-A, coa…/26) | punxsy_prominence | none | no | /coach/environment/intake-router | /coach/environment/intake-router | yes, start and end of sweep |

Device names ("Browser 1/2/3") were reassigned during the run, which is why
only deviceIds are recorded.

**Not available:** parent, board (all eight seats), staff, volunteer. A login
handoff went to overwatch at the start of the run; none were connected by its
end.

**Session note.** After the in-app pane was reopened late in the run, its
session read `{"authenticated":false}`. The cause is unverified (the pane was
recreated, not a reproduced app sign-out), so it is not a finding.

## B. Coverage

| Measure | Value |
|---|---|
| Accounts available / audited to completion | 4 / 1 (ORGADMIN-A) |
| Roles represented | 4 of 9 (5 NOT AVAILABLE) |
| Page routes on main | 163 |
| Route opens, positive | ORGADMIN-A 106/106 (103 own path, 2 redirects, 1 refusal); COACH-A 72/73; ATH-A 16/16; PO-A 14/42 |
| Route opens, negative | ORGADMIN-A 32/32; COACH-A 68/68; ATH-A 117/117; PO-A 0/93 |
| API negative checks | ORGADMIN-A 7 executed; COACH-A, ATH-A, PO-A NOT EXECUTED (tabs frozen) |
| Controls exercised | load and API level only; no control-level tests |
| Writes | 0 planned, 0 executed |
| Cross-role workflows | 0 executed |
| Responsive | 0 executed (see T) |
| Unverified items | 3 (see T) |
| Platform-blocked | 2 (see S) |

## C. Summary

| Severity | Count | Findings |
|---|---|---|
| P0 | 0 | |
| P1 | 0 | F-001 closed this run |
| P2 | 1 | F-002 (reproduced on `ac8f3e61`; fix deployed 17:59Z; READY FOR RETEST) |
| P3 | 2 | F-003 (fix deployed 17:59Z; READY FOR RETEST), R2-F-004 (NEW) |
| UX | 2 | U-001 (KNOWN OPEN, reproduced), U-002 (not retested) |

Every role boundary that was tested held.

## D. Account / role / context matrix

| Account | Role | Positive | Negative routes | Negative API | Result |
|---|---|---|---|---|---|
| ORGADMIN-A | organization_admin | PASS (one dead-end door, R2-F-004; F-002 500 on /coach/intelligence) | PASS | PASS | COMPLETE |
| COACH-A | coach | PASS except F-002, and /teach-shadow/annotation UNVERIFIED | PASS | NOT EXECUTED | PARTIAL |
| ATH-A | athlete | PASS | PASS | NOT EXECUTED | PARTIAL |
| PO-A | platform_owner | 14/42, no anomaly in that set | NOT EXECUTED | NOT EXECUTED | PARTIAL |
| (none) | parent, board, staff, volunteer | | | | NOT AVAILABLE |

## E. Route census

- Page routes (`apps/web/app/**/page.tsx` on main, route groups stripped): 163.
- Building-map doors: 139 distinct hrefs.
- `EXCLUDED` in `buildingMapCoverage.test.ts`: 18. `PENDING_TRIAGE`: 6
  (`/admin/export`, `/admin/gear`, `/admin/gear/vendors`, `/admin/athletes`,
  `/admin/organizations/test`, `/admin/platform/overview`).
- Unlisted: 1, `/store/[organizationId]` (dynamic segment of the listed
  `/store`). A lead, not a bug.
- Redirects/aliases observed: `/admin/safety-escalations` → `/admin/escalations`;
  `/dashboard` → the role's landing.
- Building-map doors whose page has no gate of its own, so other roles can
  open them by URL: `/source-control`, `/source-control/publication-workflow`,
  `/simulator` (static, self-labelled placeholders), and `/knowledge-graph`
  (its API admits every organization member through
  `SHADOW_PROJECTION_READ_ROLES`, `shadowRoleSets.ts:36`). The door's `roles`
  is visibility only, so these are INTENTIONAL DIFFERENCES between models A
  and B, not authorization bugs.

## F–R. Findings

### F-001 — /admin/consent roster never loads — CLOSED — VERIFIED

| | |
|---|---|
| Fix | #1221, merge `bb9a3d64`, in production `ac8f3e61` (ancestor check) |
| Retest path | ORGADMIN-A, in-app browser, `/admin/consent` |
| Positive | the page requests `GET /api/pilot/athletes/list` → 200, and the roster selector lists the organization's athletes (2 options: placeholder plus 1) |
| Negative control | `POST /api/pilot/athletes/list` → 405, the method the route does not answer and the one the old page used |
| Evidence level | PRODUCTION, SUBJECT `ac8f3e61` |

### F-002 — /api/pilot/coach/intelligence returns 500 — KNOWN OPEN

| | |
|---|---|
| Severity | P2, NETWORK/API BUG |
| Observed | COACH-A and ORGADMIN-A: `/coach/intelligence` shows "FAILED — Unable to load the digest"; `GET /api/pilot/coach/intelligence` → 500. Reproduced on reload. |
| Status | READY FOR RETEST: #1224 (`5e498d01`) was not in `ac8f3e61`, where the 500 was observed; it is in `c00942a1`, deployed 17:59Z after the browser checks stopped. Not retested on `c00942a1`. |

### F-003 — Board monitoring pages and platform_owner — NOT RETESTED

| | |
|---|---|
| Status | READY FOR RETEST: #1229 (`ee0feb13`) is in `c00942a1`, deployed 17:59Z. Jason's ruling is overwatch's option (A), hide those doors from the platform owner (OD-2026-10-05-006). |
| This run | PO-A's sweep froze on `/board` and `/board/at-large` before any board check returned. NOT EXECUTED. |

### R2-F-004 — "Organization Provisioning" door offered to org admins leads to a platform-owner-only page — NEW

| | |
|---|---|
| Classification | NAVIGATION/DISCOVERABILITY BUG |
| Severity | P3 |
| State | OBSERVED |
| Account | ORGADMIN-A (organization_admin), in-app browser, production `ac8f3e61` |
| URL / control | `/admin`: links "ORGANIZATION PROVISIONING" and "Open Gym Admin Provisioning" → `/admin/organizations` |
| Expected | A door is shown only to roles its page admits (building-map header; runbook §5 B vs A). |
| Observed | `/admin/organizations` shows "ACCESS DENIED / PLATFORM OWNER ACCESS REQUIRED". No API call carried data. |
| Source | Door `apps/web/components/buildingMap.ts:192` uses `ADMIN_GATE` = `['admin','platform_owner']` (org admin collapses to `admin`); page gate `apps/web/app/admin/organizations/page.tsx:138` requires `sessionRole === 'platform_owner'`. The `/admin` console links are a second door to the same page. |
| Reproduce | Sign in as an organization admin, open `/admin`, follow either provisioning link. |
| Scope | org admins only; no data exposed. Workaround: none needed. `buildingMap.ts`, `admin/page.tsx` and `admin/organizations/` are unchanged between `ac8f3e61` and `c00942a1` (git diff), so the finding is expected to persist on the later deploy (INFERRED, not observed). |
| Root cause | SUSPECTED: door visibility is wider than the page guard. |

### U-001 — refusal screen on platform-owner-only pages — KNOWN OPEN, reproduced

`/admin/platform` and `/admin/organizations` show ACCESS DENIED to COACH-A and
ATH-A and offer "SIGN IN WITH MICROSOFT" to a user who is already signed in.
This run adds `/admin/organizations` to run 1's observation. No data is shown.

### U-002 — small target on /admin/attendance — NOT RETESTED

Responsive checks did not run this run (see T).

### Self-labelled placeholders (intentional, unchanged)

`/source-control`, `/source-control/publication-workflow` (PLACEHOLDER,
SAMPLE VERSION HISTORY), `/simulator`, `/retro-lab` (SAMPLES), `/operations`
(NOT BUILT), `/help` (MIXED LIVE + PLACEHOLDER), `/admin/customize`
(PLACEHOLDER ILLUSTRATION). `/admin/shadow` and `/shadow/scout` show
"Unavailable" on empty metric tiles: an honest unknown.

### Intentional behaviour, checked

- `/research` and `/research/chat` admit every member role in the page
  (`research/page.tsx:516`), while the building-map door is narrower.
  The `shadow/library/sources` 403 for coach and athlete is the page's own
  curator probe, handled on purpose (`research/page.tsx:114`).
- `/operations` is open to the org admin (`OPERATIONS_ROLES`,
  `operationsAccess.ts:51`).
- A signed-in user who opens `/` stays on the public homepage with the
  session bar; `/login` sends each role to its landing.

### Network and console observations (not findings)

- Most refused routes load briefly and fire their own APIs before the client
  redirect; the server answers 403 (for example `admin/capabilities`,
  `coach/athletes`, `parent/consent`), and no protected content was seen.
  This closes run 1's NEG-ATH-02 blind spot at the request level.
- `/parent/progression-visibility` fetched `athletes/list` (200) for the org
  admin before redirecting; the org admin is entitled to that data.

### Deployment discrepancies

While the browser checks ran, main was ahead of production by #1224, #1229, #1223,
#1225, #1226 and #1227. F-002 and F-003 were the expected consequences, not new
discrepancies. Release `c00942a1` closed that gap later in the run.

## H. Authorization, tenant and ownership

PRODUCTION evidence level. SUBJECT is the deployed `ac8f3e61`.

| ID | Claim | Positive control | Negative control | Verdict |
|---|---|---|---|---|
| NEG-OA-01 | an org admin cannot reach another organization | own `athletes/list` → 200, all rows `punxsy_prominence` | `?organization_id=ppbf-default-org` → 200, all rows still `punxsy_prominence` (parameter ignored) | APPLICABLE |
| NEG-OA-02 | an org admin cannot read platform or board data | `admin/export/roster` → 200 | `platform/organizations`, `board/summary`, `board/compliance-summary` → 403 | APPLICABLE |
| NEG-OA-03 | an org admin cannot read an unknown athlete id | n/a | `athletes/get` `AUDIT-NONEXISTENT-001` → 403 | PARTIAL (nonexistent id, no real foreign record) |
| NEG-OA-04 | an org admin cannot open board pages or the platform console | | 30 direct navigations redirect to `/admin/people`; `/admin/platform` refuses | APPLICABLE |
| NEG-CO-R | a coach cannot open admin, board, parent or athlete pages | | 61 redirects to the coach landing, 3 in-page refusals; 4 ungated pages render (see E) | APPLICABLE (route level only) |
| NEG-ATH-R | an athlete cannot open staff pages | | 107 redirects to the athlete landing, 4 in-page refusals; ungated pages render (see E) | APPLICABLE (route level only) |

Blind spots: coach, athlete and platform_owner API negatives were not run;
no real cross-record target exists; board, parent, staff and volunteer
boundaries are untested.

## I. Authentication and session

All four contexts returned the role the server expects, and every `/login`
landing matched `pilotRoleRouting.ts`. Sign-in and sign-out were not
exercised: Jason handles credentials.

## S. Platform-blocked

1. BLOCKED BY PLATFORM — Chrome tab execution: every connected Chrome tab
   stopped answering (`Runtime.evaluate` timed out at 45 s), consistent with
   the runbook's note that minimized windows freeze tabs. Jason was away and
   could not bring the windows forward.
2. The in-app pane was recreated mid-run and came back signed out, which
   ended in-app testing.

## T. Not executed and unverified

- Parent, board (all eight seats), staff, volunteer: NOT AVAILABLE.
- COACH-A and ATH-A API negative checks, including the coach's
  `dob`/`emergency_contact` scope and the athlete's own-record-only list:
  NOT EXECUTED (tabs frozen).
- PO-A: positive routes 15–42 and all 93 negatives, F-003 retest: NOT
  EXECUTED (tab frozen).
- Production writes and cross-role workflows: NOT EXECUTED IN PRODUCTION —
  no target established as audit/test data.
- Responsive (desktop, 768, 412) and accessibility passes: NOT EXECUTED. The
  attempted in-app measurement ran on `/login` after the session dropped, so
  it does not count for any account.
- UNVERIFIED: COACH-A `/teach-shadow/annotation` stayed on "Checking access"
  with no API call after 15 s, during the period the Chrome renderer was
  freezing. Retest in run 3.
- UNVERIFIED: cold loads waiting on "SECURE SESSION — Checking access" for
  3.5 s to about 37 s (`/coach/recognition`), with the APIs themselves
  finishing in about 1 s; second loads were fast. Cause unknown.
- UNVERIFIED: in the org-admin sweep, `/board/chair` and
  `/board/community-director` froze the tab once each; a fresh load of each
  redirected normally.

## U. Test data and cleanup

None created.

## V. Reconciliation

Compared with `docs/PRODUCTION_AUDIT_2026-10-04_USER_UI.md` after the
independent pass.

| Item | Run 1 | Run 2 classification |
|---|---|---|
| F-001 | OPEN, P1 | CLOSED — VERIFIED (fix deployed, same path, negative control) |
| F-002 | OPEN, P2 | KNOWN OPEN on `ac8f3e61` (reproduced); fix since deployed, READY FOR RETEST |
| F-003 | OPEN, P3 | NOT RETESTED (tab froze); fix since deployed, READY FOR RETEST |
| U-001 | UX | KNOWN OPEN (reproduced, extended to `/admin/organizations`) |
| U-002 | UX | NOT RETESTED |
| `/coach/mental-skills` 404 | expected deployment difference | not separately re-checked |
| R2-F-004 | not reported | NEW |

`docs/PLATFORM_AUDIT_2026-08-28_ROUTE_REACHABILITY.md` was not compared this run.

## W. Repair tasks

| Finding | Task | Status |
|---|---|---|
| F-001 | none | closed |
| F-002 | #1224 | deployed in `c00942a1`; READY FOR RETEST |
| F-003 | #1229 | deployed in `c00942a1`; READY FOR RETEST |
| R2-F-004 | chip "Fix Organization Provisioning door shown to org admins (R2-F-004)" | offered, not launched |
| U-001 | none yet | available on request |

## X. Repository state

This record: `docs/PRODUCTION_AUDIT_2026-10-05_USER_UI.md`, branch
`docs/production-audit-2026-10-05-run2`, docs-only PR. The run-1 record is
not edited.

## Y. Repair order

1. Run 3 retests F-002 and F-003 on the original paths, on `c00942a1` or later.
2. Run 3 completes the coach, athlete and platform_owner API boundaries.
3. Parent, board, staff and volunteer accounts, once Jason signs them in.
4. R2-F-004.
5. U-001.
6. U-002.
