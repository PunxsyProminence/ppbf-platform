# Capability network status

Where the capability network actually stands, as opposed to where a document
says it stands.

**Verified against:** `origin/main` at `04dd116b`, merged into this branch as
`8daf27ac`. Every claim below was checked by reading the merged code, not by
copying a prior status document.

**This page will go stale.** It describes a tree that changes hourly. Before
acting on any row, re-check the file:line it cites. A row that cannot be
re-verified should be treated as unknown, not as true.

---

## Why this file exists

An external audit artifact tracks the same network. Six independent passes over
its claims found two overstated and one blocked for the wrong reason. That is not
a criticism of the audit — it says of itself that it goes stale — it is the
reason the repo needs its own copy that cites code rather than prose.

Three states are used here, not two:

- **CLOSED** — the fix is in the merged tree and does what the headline says.
- **CLOSED, RESIDUAL** — the fix is real but narrower than the headline. The
  residual is named. A flat "closed" would hide it.
- **OPEN** — not fixed.

---

## Corrections to the audit's own status

**`#446` is not closed as stated.** The audit records "Performance Analytics
forbade athlete/parent, so gaps arrived unjustified — closed by #446". The
analytics rollup API is unchanged: `app/api/pilot/analytics/performance/route.ts:27`
still gates to `['coach','admin','organization_admin']`. What shipped is a
different, narrower endpoint — `app/api/pilot/progression/gap-justification/route.ts:29`
— admitting athlete and parent, gated per-athlete, exposing nine numeric fields
and no names. Good design; different claim. And `assignments_stalled`,
`transfer_check_failed` and `competition_loss_unresolved` map to empty arrays
(`progressionSuggestions.ts:425-438`), so gaps created by the rules `#441` and
`#442` just added still reach a family **unjustified**. Roughly two-fifths
resolved.

**The clearance register is blocked for the wrong reason, and the wrong reason
costs a research task nobody needs.** The audit says it is blocked on
"establishing a real clearance vocabulary — the four seeded types are
hand-written placeholders". There are **no seeded clearance types at all**:
`infra/azure/pilot_slice_postgres_clearance_register_migration.sql` contains zero
INSERT statements, only two illustrative comments at lines 38-39. The "four" is
a misread of a 4-value `authority_kind` CHECK (line 41) — an authority taxonomy,
not clearance types. The real blocker is stated as design law in that migration's
header (lines 20-29): no write path may gate anything "without a separate,
explicit product decision". So this is blocked on an owner decision plus plain
unbuilt surface area, not on research.

---

## Closed (10 of the 12 claimed)

| Gap | PR | Evidence |
|---|---|---|
| Film Study ran with no guardian consent check | #438 | `app/api/pilot/shadow/video-analysis/route.ts:106` |
| Competition losses never reached progression | #442 | `progressionSuggestions.ts:226-243`, `:295` |
| Transfer failures never became progression gaps | #441 | `progressionSuggestions.ts:196-215`, `:337` |
| Source-submission lifecycle had no UI | #445 | `app/research/review/page.tsx:23-25`, mapped `buildingMap.ts:311` |
| No withdrawal for competition/league entries | #443 | `externalCompetition.ts:219`, `wrestlingLeague.ts:248` |
| Session-run link unreachable from UI | #444 | `components/SessionScriptLiveDelivery.tsx:231` |
| Volunteer roster and login disconnected | #448 | `staffProvisioning.ts:494-563` |
| Cross-org privilege flag unsettable | #449 | `app/api/pilot/platform/users/master-shadow-access/route.ts:19` |
| Shadow-job authorization N+1 | #431 | `shadowJobQueue.ts:558-566` |
| Video scan never filed an escalation | #439 | `videoScanSweep.ts:170-183` |

### Closed, residual

Four of the above are narrower than their headline. Recorded so a later reader
does not assume the whole class is handled:

- **#438** — consent is checked at request time only. `shadowJobProcessor.ts` and
  `filmStudyExecutor.ts` contain no consent reference, so consent withdrawn
  between enqueue and execution does not stop the vision pass.
- **#439** — an unattributed upload (`athlete_id` null) files nothing. FK-driven
  and documented, but a silent skip.
- **#433** — `escalationLadder.ts:250-281` absorbs a *sequential* retry via a 30s
  `where not exists`. Two simultaneous requests can still both insert: no partial
  unique index, no idempotency key. The code says so at `:220-227`.
- **#449** — the route uses `requirePrincipal`, not
  `requireMicrosoftAuthenticatedPrincipal`, so a PIN-issued `platform_owner`
  session passes. Identical to its four sibling cross-org routes, so this is a
  platform-wide pre-existing gap, not a regression from #449.

---

## Open, ranked by what the gap allows

1. **Guardian links accept an unvalidated `parent_id`.** The most serious open
   item in the network. `app/api/pilot/intake/domain-upsert/route.ts:132-152` and
   `app/api/pilot/intake/review-action/route.ts:355-370` take `parent_id` from the
   request body and check only that it is non-empty. The athlete side is gated
   (`access.ts:287`, coach via `:302`); the parent side is not. `upsertGuardian`
   (`intake.ts:710-730`) is an UPSERT on `(organization_id, parent_id)` that
   overwrites `account_id, full_name, phone, email`.

   Consequence: a coach with standing on one athlete can repoint another family's
   guardian row at an account they control. That guardian's existing
   `guardian_links` to other children then resolve through
   `guardianAccess.ts:64`, exposing those children's records to the actor — and
   the real guardian is severed from their own children. The careless case is the
   same shape via a mistyped id. The athlete-side gate cannot catch it: the damage
   travels through the parent row's *other* links.

   The check already exists and was not reused: `staffProvisioning.ts:455-462`
   throws "Forbidden: guardian record id is already in use by another guardian".

   **Needs an owner decision**, because a blanket refusal would break sibling
   enrollment. Narrow option: keep allowing an existing guardian to be *linked*
   to a new athlete; refuse to *overwrite* identity fields on a parent row the
   actor has no standing on.

2. **Coach Coverage grants youth-contact access with no clearance check** —
   `access.ts:64-72`, batch variant `:368-376`. Worse than the audit states:
   `active_flag` is verified only at grant time (`:131`), never at use time, so a
   coach deactivated after the grant keeps access to that child until expiry.

3. **`conditioning_only` holds enforce nothing, and the app says otherwise.**
   `trainingHolds.ts:459` scopes to `('all_training','contact_only')`; `:380`
   scopes registration to `all_training` alone. Meanwhile
   `app/parent/safety/page.tsx:38` tells a guardian "Conditioning is paused right
   now". Note also that `contact_only`'s enforcement is a near-miss *flag* that
   still keeps the record (`trainingHolds.ts:488`), not a refusal — so the audit's
   contrast between the two scopes is softer than stated.

4. **Guardian consent scope collected and never enforced.** `covers_video` and
   `public_use_allowed` are selected (`guardianConsent.ts:73`, `:173`) but the
   gates compare only `status !== 'signed'` (`:180-183`). `covers_video` defaults
   to true in three places — `intake.ts:515`, `app/api/pilot/parent/consent/route.ts:147`,
   `app/parent/consent/page.tsx:81` — plus the DB default. The UI presents the
   switches as load-bearing.

5. **Clearance register has zero callers.** Only importer is its own
   `clearanceRegister.pg.test.ts:49`. See the correction above for the real
   blocker.

6. **`/admin/escalations` renders a blank Source cell.** `escalationLadder.ts:29`
   has nine source types; the page keeps a stale six-member copy at
   `app/admin/escalations/page.tsx:11`, missing `incident`, `video_scan`,
   `compliance_violation` — the three newest filers. `SOURCE_LABEL` is keyed off
   the stale union, so `:295` renders `undefined` with no fallback.

7. **A comment claims an invariant the code does not hold.**
   `coachIntelligence.ts:13-16` says shared constants keep two attendance rules
   from drifting apart. `coachIntelligence.ts:127` uses `<`;
   `progressionSuggestions.ts:143` uses `<=`. early=4, late=2 fires the gap
   suggestion and stays silent on the coach digest.

8. **93 `*.pg.test.ts` suites share a racy teardown.** SIGTERM is Postgres *smart*
   shutdown, so lingering clients block exit; the 15s bail-out resolves anyway and
   there is no SIGKILL fallback. Correction to the audit: only 25 delete the data
   directory, and that `fs.rm` is `.catch(() => {})`, so the cost is +15s per
   suite plus open-handle noise and leaked datadirs — not ~95 assertion failures.

9. **A login test asserts nothing.** `app/api/pilot/auth/login/route.test.ts:190-202`
   is named for a durable-store outage and never simulates one — it re-sets the
   value `beforeEach` already set and asserts 200. The route's real behaviour on an
   unreachable store is untested.

### Parked or unclaimed, all verified still true

Board governance has no path to grants, volunteers or competition
(`boardWorkspaceConfig.ts:77,107`) · wrestling league has no result column
(migration lines 38-56) · Scenario Simulation and Source Governance are islands
(only cross-reference is copy at `simulator/page.tsx:43`) · Knowledge Graph
Pattern/Finding can never populate (`shadowReadModels.ts:487-490`) · volunteer
`background_check_status` is free text by design (migration lines 32-36).

---

## Documentation the merge made false

Ranked. Each was checked against code.

1. `docs/current/AUTH_CONTRACT.md:12` and `ORGANIZATION_ROLE_MODEL.md:165`
   present cross-organization authorization as role-only. #449 added a second
   dimension: `has_master_shadow_access`, read live at `auth.ts:329` and granting
   every organization's data at
   `app/api/pilot/shadow/research-bridge/session-export/route.ts:65`. Anyone
   reasoning about tenant isolation from those documents is now wrong.
2. `docs/capabilities/README.md:45` — "152 Incident Report: no incident table or
   route". `app/api/pilot/incidents/route.ts` exists.
3. `docs/capabilities/README.md:133-138`, `:101-114` — status counts are stale;
   the CSV now reads DRAFT 101 / DONE 94 / DEFERRED 6.
4. `docs/capabilities/README.md:69-71` — "no screen calls `domain-upsert`".
   `app/admin/consent/page.tsx:195` does.
5. `docs/capabilities/modules/152-incident-report-engine.md:9,12` — the route is
   write-only; reads go through `/api/pilot/escalations`.
6. `docs/current/ATTENDANCE_PRECEDENCE.md:24-33` — the "every non-test reference,
   checked individually" census omits at least `interventionEvidence.ts:45`,
   `competenceCohorts.ts:143`, `floorHours.ts`, `wallDisplay.ts`,
   `communityService.ts`. The no-cross-source headline still holds.
7. `CAPABILITY_BUILD_PLAYBOOK.md:39` — "176-192 stay DEFERRED"; only 6 of 17 are.
8. `docs/capabilities/modules/053-*.md:6` — its "future work" shipped in
   `progressionSuggestions.ts:226-241` and `:329-348`.
9. `docs/capabilities/modules/026-*.md:60,81` — add the live-delivery entry point.
10. `docs/design/PLACEHOLDER_MAP.md:29,30` — fixed in `AthleteWorkspace.tsx`
    (`e848ca3e`); row 28's Schedule-tab finding is still live.

Checked and clean: `AGENT_KERNEL.md` (all nine referenced paths exist),
`ACTIVE_WORK.md` Coach Intelligence rows.

---

## Design / visuals lane

**Not parked.** `ACTIVE_WORK.md` has nine PARKED rows and none is this lane. A PR
proposing one exists but has not merged, and by that file's own rule "nothing is
parked by silence". The lane's only standing rule is at `ACTIVE_WORK.md:29`:
asset-dependent work stays blocked, and invented assets must not be substituted.

Flow specifications for the artist live outside the repo, in a Drive folder, one
file per screen: Login, Shadow AI, Evidence Library, and the four mobile screens,
plus a refusal-state inventory. They are written from code and cite it.

State at time of writing: Login has had a second pass answering every correction
raised — establishment date removed, one organisation name, all three sign-in
methods present, a real six-digit field with the dials demoted to housing, red
confined to one success mark. Nothing has reached final approval. The remaining
mobile screens are built on an age-banded phase ladder that does not exist in the
app and would imply ranking children against each other, which the code
explicitly refuses (`achievementPaths.ts:28-31`).

---

## How to re-verify this file

Every row cites a path and a line. Open it. If the code no longer matches, the
row is wrong and this file is the thing to fix — not the code.
