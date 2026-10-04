# PPBF Production User/UI Audit — Runbook

The one current procedure for auditing what each real production account can
see and do. Ask for it with: **"Run the PPBF production user/UI audit again."**

Each run writes a dated execution record at
`docs/PRODUCTION_AUDIT_<YYYY-MM-DD>_USER_UI.md`. That record is history and
evidence. It is never the expected answer for the next run. This runbook
holds no results.

Created 2026-10-04 from Jason's audit prompt ("PPBF PRODUCTION APPLICATION
AUDIT"), which authorized the audit and saving it here.

## 1. Purpose and scope

The audit establishes, with direct evidence, five things for every available
production **account**:

1. what the account should see and do;
2. what it actually sees and does;
3. whether each meaningful control works;
4. whether role, organization, athlete, dependent, assignment and board
   boundaries hold, both through the UI and directly by URL or API;
5. whether production differs from current source.

The unit of the audit is the account, not the role. Two accounts with the same
role are separate subjects whenever their relationships can differ.

The auditor does **not** repair. Each confirmed finding becomes a bounded
repair task that Jason may launch (§14).

## 2. Authority order

1. Jason's latest instruction.
2. `docs/current/OWNER_DECISIONS.md`.
3. `AGENT_KERNEL.md`.
4. Current domain sources: `AUTH_CONTRACT.md`, `ORGANIZATION_ROLE_MODEL.md`,
   `docs/capabilities/GATES.md`.
5. Current code on `origin/main`.
6. Tests, as implementation evidence only.
7. Earlier audits, only during reconciliation (§13).

If code contradicts an owner decision, report the conflict. Do not pick a
winner.

## 3. Startup read path

Read these first:

- `AGENT_KERNEL.md`
- `docs/current/ACTIVE_WORK.md`
- `docs/current/OWNER_DECISIONS.md`
- `docs/current/EVIDENCE_APPLICABILITY.md`
- `AUTH_CONTRACT.md`
- `ORGANIZATION_ROLE_MODEL.md`
- `docs/capabilities/GATES.md`

Then read the source that holds the three models (§5):

- `apps/web/src/server/pilot/{contracts,access,credentialPolicy,boardSeats}.ts`
- `apps/web/src/shared/pilotRoleRouting.ts` (the server's landing routes)
- `apps/web/components/{roleRoutes,buildingMap,roleSession}.ts`
- `apps/web/components/{RoleSessionGate,GlobalRoleHeader,SignInPanel}.tsx`
- `apps/web/components/buildingMapCoverage.test.ts` (the exclusion list)
- `apps/web/e2e/support/signIn.ts`

Do not preload earlier audits.

Record the baseline before testing anything:

- repo path, branch and full HEAD;
- `origin/main` SHA;
- working-tree state;
- open PRs that touch the surfaces under test;
- the **production commit**, from the last successful `deploy-production`
  run's `headSha` (`gh run list --workflow deploy-production --limit 1`);
- observation time.

When main is ahead of production, source and deployed behaviour can
legitimately differ. Treat such a difference as a DEPLOYMENT DISCREPANCY until
its cause is proven.

Read source with `git show origin/main:<path>`. Never switch a shared checkout
to do it.

## 4. Browser and account model

Each signed-in browser is an independent authentication context:

- the Claude desktop in-app browser;
- each Chrome profile connected through the Claude extension, listed with
  `list_connected_browsers` and chosen with `select_browser` by deviceId.

Device names ("Browser 1", "Browser 2" and so on) get reassigned whenever a
browser connects. Record the deviceId, not the name.

**Verify the identity in every context** through the app's own endpoint. Run
this in the page:

`fetch('/api/pilot/auth/session',{method:'POST',body:'{}',headers:{'content-type':'application/json'}})`

From the response, record only `role`, `organization_id`, whether
`athlete_id` is present, `board_seat`, and a masked account hint: the first 3
characters plus the length. Never record tokens, cookies, PINs or full
account ids. Signed out, the endpoint returns `{"authenticated":false}`.

Re-verify the identity after any sign-in, sign-out or suspected account
switch.

Build two tables:

- **Accounts:** Context (deviceId) | Role | Org | Board seat | Athlete link /
  dependents / assignment | Expected landing | Actual landing | Verified.
- **Coverage:** keep account coverage and role coverage separately. A role
  with no signed-in account is `NOT AVAILABLE`, never PASS.

**Login handoff.** Jason enters every credential: PIN, password, Microsoft,
MFA and magic links. When an account is needed, stop that step only. Output
`AUDIT CHECKPOINT` (completed accounts and roles, findings, verified
contexts), then `LOGIN HANDOFF REQUIRED` (target role, context, URL, the
action needed, and the condition for resuming). Re-verify after Jason signs
in. Do not redo completed work.

The Chrome tool drives one browser at a time. Parallel coverage means
background agents, each told which deviceId to use, with no two agents on the
same browser. Never claim parallel coverage that was not observed.

## 5. Three models: keep them separate

- **A. Authorization.** For each backend role from `contracts.ts`, record
  what `access.ts` and the route guards allow: organization, athlete,
  dependent and assignment scope, board restrictions, and credential class.
- **B. Navigation.** Landing routes (`pilotRoleRouting.ts`), `roleRoutes.ts`,
  building-map doors, header and dashboard links. Navigation is not
  authorization: a door's `roles` is visibility only.
- **C. Observed production.** What the account actually sees, reaches,
  retrieves, submits and completes.

Every difference between A, B and C is an audit target.

## 6. Route census

1. Enumerate `apps/web/app/**/page.tsx` on `origin/main`. Strip route groups
   and keep dynamic segments.
2. Compare the list with the building-map hrefs and the exclusion list in
   `buildingMapCoverage.test.ts`.
3. Report: total page routes, building-map routes, intentional exclusions,
   pending triage, unlisted routes, aliases and redirects, and any route
   whose access or purpose is unresolved.

An unlisted route is a lead to investigate, not a bug.

## 7. Per-account passes

**Sweep instrument.** Navigate to the route. Wait about 3 s. Then record:

- the final `location.pathname`;
- every `/api/` resource whose `responseStatus` is 400 or higher;
- visible text matching error, failed, unavailable, placeholder, sample or
  demo wording.

Iframe and popup sweeps do not work, because the site's headers block framing
and popups are blocked. Use real navigation, at most 12 routes per batch.
Hand long sweeps to a background agent that returns anomalies only.

### 7.1 Positive pass

Every route the account should reach must load, stay on its own path, and
show no failing requests or false error text.

Then census the controls on the account's primary surfaces:

- buttons, links, tabs, forms, filters;
- create, edit, remove;
- upload, export, print;
- media, SHADOW, logout.

Trace the important ones: control → handler → route/API → guard →
persistence → readback.

A control is not functional because it accepted a click. Verify the outcome
it represents.

### 7.2 Negative authorization

- Navigate directly to the forbidden routes and expect a redirect or an
  honest refusal.
- Call the relevant APIs and expect 403, with no prohibited data in the
  response.
- Check for protected content flashing before the redirect.

Controlled targets only:

- the account's own records;
- a supplied audit account's records;
- a nonexistent id such as `AUDIT-NONEXISTENT-001`;
- records Jason has named as testable.

Never use a random real member record to manufacture a negative case. When
no controlled target exists, mark the case `NOT EXECUTED — controlled
resource unavailable`. Never brute-force identifiers.

### 7.3 Special boundaries

Check each of these against current guards:

- **platform_owner:** no organization-private athlete data.
- **board:** aggregates only.
- **coach:** assigned athletes, plus `coach_coverage` grants.
- **athlete:** own record only.
- **parent:** linked dependents only.
- **organization_admin:** own organization only. Test that a foreign
  `organization_id` parameter is ignored or refused.
- **staff and volunteer:** no coach authority.

### 7.4 Responsive

Check primary workspaces at desktop width, about 768 px, and 412 px.

Look for:

- clipping, overlap, horizontal overflow;
- disappearing actions;
- touch targets;
- whether the workflow can still be finished.

### 7.5 Accessibility and semantics

Check what can be observed:

- roles and accessible names;
- labels;
- keyboard reach and visible focus;
- dialogs;
- status announcements;
- state that does not depend on colour alone.

Never claim WCAG certification.

### 7.6 Network and console

Correlate each important action: UI action → request (method, endpoint,
non-secret shape) → status → resulting UI → persisted state.

Look for:

- no request, or duplicate requests;
- the wrong method;
- 4xx or 5xx responses;
- swallowed errors and false success;
- a stale UI after a success.

Record application exceptions, hydration errors and failed resources. Ignore
extension noise.

### 7.7 Data honesty

Distinguish EMPTY, ZERO, UNKNOWN, NOT LOADED, LOAD FAILED, NOT AUTHORIZED,
NOT BUILT, PLACEHOLDER, FABRICATED/DEMO and REAL. An error must never pass as
zero or empty.

## 8. Cross-role workflows

Derive workflows from current source, not from examples. Typical ones:

- a coach assigns, the athlete sees it;
- an athlete submits, the coach reviews;
- an admin changes something, a member sees the change;
- a parent's view of a dependent;
- board aggregates.

For each workflow:

1. Capture the starting state in every participating context.
2. Perform the initiating action.
3. Verify it persisted.
4. Check the receiving context.
5. Check that roles that should not see it don't.
6. Carry it through to completion or cancellation.
7. Verify the final state everywhere.

A workflow can fail even when every page passes on its own. Classify that as
a CROSS-ROLE WORKFLOW BUG.

## 9. Production writes

Write only to records established as audit/test data, such as the "Audit Test
Gym" organization or records Jason names.

For each write, in order:

1. Identify the target.
2. Prove it is test data.
3. Capture the state before.
4. Act.
5. Inspect the request and response.
6. Check the UI.
7. Reload or read back.
8. Record the cleanup.

If the target's status is uncertain, record `NOT EXECUTED IN PRODUCTION —
target not established as audit/test data`.

Never mutate real member data, never change auth policy or schema, never run
migrations and never deploy from the auditor session.

## 10. Results, evidence and classification

**Result states:** PASS · FAIL · PARTIAL · NOT EXECUTED · NOT AVAILABLE ·
BLOCKED BY PLATFORM · UNVERIFIED.

PASS requires an executed check that can establish the behaviour.

These are not PASS:

- the source looks right;
- a test exists;
- a button exists;
- a route is hidden;
- another account with the same role passed;
- an old audit said so.

**Material claims** (auth, privacy, tenant, writes, production state) use the
`EVIDENCE_APPLICABILITY.md` record:

CLAIM / PROPERTY / INSTRUMENT / SUBJECT / EXECUTION PATH / POSITIVE CONTROL /
NEGATIVE CONTROL / EVIDENCE LEVEL / BLIND SPOTS / VERDICT.

Browser checks against production are `PRODUCTION` level, and SUBJECT names
the deployed SHA.

**Classifications:** FUNCTIONAL BUG · CROSS-ROLE WORKFLOW BUG ·
AUTHORIZATION BUG · TENANT/OWNERSHIP BUG · AUTHENTICATION BUG · MISSING
FUNCTION · DEAD CONTROL · MISWIRED CONTROL · NAVIGATION/DISCOVERABILITY BUG ·
DATA-HONESTY BUG · UI DISCREPANCY · RESPONSIVE BUG · ACCESSIBILITY/SEMANTIC
BUG · NETWORK/API BUG · DEPLOYMENT DISCREPANCY · VISUAL/UX OPPORTUNITY ·
INTENTIONAL DIFFERENCE · UNVERIFIED · BLOCKED BY PLATFORM.

**Severity:**

- **P0:** a critical auth, privacy, tenant or session failure, or a
  production-wide outage.
- **P1:** a core workflow fails, or a serious authorization or function
  failure.
- **P2:** a meaningful secondary defect, misleading state, or a significant
  UI, responsive or accessibility defect.
- **P3:** a minor defect.
- **UX:** an improvement, not a confirmed defect.

**Rules:**

- **Missing control** needs evidence the account should have the action.
- **Extra control** needs evidence it should not be offered.
- **Dead control:** it does nothing.
- **Miswired control:** it does the wrong thing.
- Never infer expected behaviour from another account's UI alone.
- **Minimum proof:** once unauthorized access is shown, capture just enough
  to establish it. Stop that path, then continue elsewhere.
- **Deduplicate by root cause:** one ROOT FINDING lists every affected
  account and route.

**Finding package:**

- ID; classification; severity; OBSERVED / INFERRED / REPORTED / UNVERIFIED.
- Account, role, context, board seat.
- Environment and SHA; URL; control.
- Expected (with its authority) and observed.
- Reproduction steps.
- Evidence: screenshot reference, network, console.
- Source location where relevant.
- Persistence and reload result.
- Scope and workaround.
- Root cause: PROVEN, SUSPECTED or UNKNOWN.

Emit a FINDING card as soon as a finding is confirmed. Do not wait for the
report.

**Privacy:** minors' names, faces and records never go into chat, GitHub or
the record. Use safe ids (ATH-A, COACH-A).

## 11. Platform limits

When the Claude platform itself stops an operation, record `BLOCKED BY
PLATFORM — <operation>`. It is not a PPBF bug. Known limits as of 2026-10-04:

- The extension redacts some JS results ("[BLOCKED: …]"). Re-query narrower
  fields.
- The auto-mode classifier may refuse browser switching or session reads
  until Jason authorizes them in chat.
- The in-app browser's batch output is verbose. Delegate its long sweeps.

## 12. Coverage ledger

**Per row:** Account | Role | Context | Route | Expected access | Opened |
Controls tested | Positive | Negative auth | Write | Responsive | Evidence |
Result.

**Totals:**

- accounts available and audited;
- roles known and represented;
- routes identified and opened;
- controls identified and exercised;
- negative tests planned and executed;
- workflows planned and executed;
- responsive checks planned and executed;
- writes planned and executed;
- unverified;
- platform-blocked.

Do not call a run a full audit while supplied accounts remain materially
untested.

After each account, output a checkpoint:

- `ACCOUNT/ROLE COMPLETE: <id/role>`;
- the context;
- routes, controls and negative checks as x / y;
- workflow participation;
- findings added;
- unverified items;
- records created;
- whether the session is still valid;
- the next account.

## 13. Re-runs and reconciliation

A re-run means:

1. Re-read authority.
2. Re-establish main and production state.
3. Rediscover roles, routes and signed-in contexts.
4. Run an **independent** pass first.
5. Only then compare with the immediately prior execution record. Classify
   each finding NEW, KNOWN OPEN, REPORTED FIXED BUT REPRODUCED, PREVIOUSLY
   REPORTED / NOT REPRODUCED, SUPERSEDED or DUPLICATE.
6. Specifically retest the prior record's OPEN and READY FOR RETEST items.
7. Write a **new** dated record. Never rewrite an old one.

Never reuse an old PASS as a current PASS. Failing to reproduce is not proof
of a fix unless the same execution path was tested.

## 14. Repairs and closure

For each confirmed actionable finding, offer a repair task: a desktop chip,
a new session, or a ready-to-copy prompt. Never start it yourself. The task
opens with:

"Investigate PPBF finding <ID>. Read AGENT_KERNEL.md, ACTIVE_WORK, current
owner authority and all finding evidence. Check current PR/work state for
collision. Stay bounded to this finding or explicitly grouped root-cause
findings. First answer CAN / CAN'T / NOT SURE. If NOT SURE, perform the
smallest safe check first."

When Jason launches a task, that authorizes the builder actions for that
finding only: edit, test, branch, commit and PR. It does not authorize a
merge, a deploy, a migration or other findings.

Findings that share a root cause get one task. Parallel tasks are allowed
only when their scopes don't overlap.

**Lifecycle:** OPEN → FIX IN PROGRESS → READY FOR RETEST → CLOSED — VERIFIED.

Only the auditor's retest closes a finding, on the original production path,
with its negative control, after the fix has deployed.

## 15. Stop conditions

Stop the whole audit only when one of these happens:

- production can't be established;
- browser integration is down everywhere;
- authentication can't progress;
- an authority conflict blocks further action;
- an unapproved write type would be needed;
- a material fact would have to be guessed;
- production corruption is verified.

Record localized failures and continue.

## 16. Final report

The final report has these sections:

- **A** Identity: SHA, branch, production commit, time, contexts, accounts,
  roles.
- **B** Coverage totals.
- **C** Executive summary by severity.
- **D** Account / role / context matrix.
- **E** Route census.
- **F–R** Findings by class: functional; workflow; authorization and tenant;
  auth and session; missing; dead and miswired; navigation; data honesty;
  network and console; responsive; accessibility; UX; deployment
  discrepancies.
- **S** Platform-blocked tests.
- **T** Unverified and not-executed tests.
- **U** Test data and cleanup.
- **V** Reconciliation.
- **W** Repair tasks and their status.
- **X** Repository state of the audit docs (paths, PR).
- **Y** Repair order: P0 → P1 → auth/tenant boundaries → primary workflows →
  cross-role → missing → P2 → P3 → UX.

The execution record carries sections A–Y. Save it on an audit-docs branch
and PR, never with application fixes. Never record secrets.
