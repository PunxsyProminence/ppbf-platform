# Active work

Blocked and parked work, with the condition that re-opens each; open owner
questions; the build list of decided work nobody has picked up; and the
standing owner directions that shape what gets built next.

**Not tracked here: current build work.** That is the live open PRs on GitHub
and the work orders Jason approves, which arrive in one OneDrive inbox folder
(`PPBF-AI-Lanes/ChatGPT-Handoffs` in admin@'s OneDrive; OD-2026-09-28-003). Query PR state live; do not copy it
here. Deployed state: see "Your session's state is not the system's state" in
`AGENT_KERNEL.md`.

**Dates.** This file was last brought fully up to date on 2026-08-29. Rows
carry that date unless they say otherwise; rows added or corrected on
2026-09-28 or later say so. Re-check a BLOCKED row before relying on it. The full
2026-08-29 text -- including the shipped 2026-08-15/16 queue, its evidence,
and the calibration-lab notes -- is kept verbatim in
`docs/archive/2026-09-21_ACTIVE_WORK_before_condense.md`.

Do **not** preload `docs/current/WORK_QUEUE.md` for ordinary implementation. It
is the detailed historical/verification ledger.

Repo enforcement always wins over any note here, and nothing in this file
authorizes production deploys or production migrations.

States:

- `BLOCKED` -- cannot be built correctly without a real product, safety or data decision
- `PARKED` -- valid idea or debt, but not allowed to slow unrelated work

Nothing is parked by silence: parked work gets a PARKED row below with a
concrete "Re-open when" condition. That table is the memory that parked work
exists.

## Work areas

Standing work areas so concurrent sessions divide work instead of colliding.
They are subject areas, not roles (roles: `AGENT_KERNEL.md`, OD-2026-09-28-001).
A session picks one area, works one bounded branch/PR at a time inside it, and
does not drive-by fix another area's surface.

| Area | Scope | Coordination rule |
|---|---|---|
| Product build | Driving operations-radar `PARTIAL`/`PLACEHOLDER` rows to `EXISTS` or PARKED | One radar row per branch/PR. Check open PRs for collisions before starting. |
| SHADOW / statistics | SHADOW model behavior, evidence statistics, measurement gates | Stacked PRs merge in dependency order; do not start new work that touches a surface an open stack PR owns. |
| Design / visuals | Design-system and page-visual work. The 2026-08-17 park of the whole area is lifted (OD-2026-09-28-009 item 2); the build order is `docs/ROOM-MAP.md` (item 3). | Blocked on owner-supplied assets stays blocked; do not substitute invented assets. |
| Ops / deploy | Staging, production, migrations, releases | Human-gated for production (OD-2026-08-29-006). |

Phase plan (2026-08-29): **Phase 1** -- every operations-radar row reads
`EXISTS` or is PARKED here with a re-open condition. **Phase 2** --
role-specific thin clients (route groups in this repo over the same
`/api/pilot/*` routes; no separate backend, no parallel telemetry path,
online-only writes until the offline-storage decision is made).

## Standing owner directions (2026-08-15/16)

Carried verbatim from the 2026-08-15/16 batches. They are not yet entries in
`docs/current/OWNER_DECISIONS.md`. Items 2, 3, 5 and 6 of the 2026-08-16 batch
shipped; item 3 still carries a boundary, below.

- **Merch** (owner, 2026-08-15): merchandise sales are Program-lane revenue
  when payments go live -- earned income like class fees, settling to the
  Program account. The gear catalog/vendor records that exist already carry the
  inventory half; no new lane and no schema change needed.
- **Register bar** (2026-08-16, item 1) -- narrow-but-real slices promote to
  DONE per the playbook rule ("DONE means slice shipped in code"), each with a
  slice line naming exactly what exists and what is future work.
- **Coach Cue Library (114)** (2026-08-16, item 2) -- build the read-only
  browse/search over cues already stored in drill records. No invented
  content; authoring is a later decision. *Shipped* in `3a4b1632`
  (2026-08-16): `apps/web/app/coach/cue-library/page.tsx` over
  `apps/web/app/api/pilot/coach/cue-library/route.ts` (checked on `main`
  2026-09-28).
- **Phase 2 thin clients** (2026-08-16, item 4) -- the goal is every role
  (coach, athlete, admin, parent, board members, staff), not one favored role.
  Build order is the builder's sequencing call; current sequence: athlete
  check-in first (it generates the data the other views read), then parent,
  coach, admin, board, staff.
- **Engines unlock as data gathers** (2026-08-16, item 7) -- build the
  remaining "engine" modules so each states explicit DATA PREREQUISITES and
  stays visibly locked until the org's/athlete's own records satisfy them --
  an unlock is an honesty gate, not a gamification score. Athlete-facing "rank
  up" means unlocking richer views of their OWN record (never cross-athlete
  comparison); org-level unlocks mean an organization earns engine activation
  by accumulating real data. Design to be proposed per-engine as slices come
  up.
- **Coach Intelligence Engine (111)** (2026-08-16, item 3) -- v1 ("The
  Morning Read") shipped, commit `c05c8c68`. Widening it further is a new,
  separate decision, not a resumption of this one.

### Shipped with constraints that still bind (2026-08-15 queue)

The 2026-08-15 queue shipped (release `3d2308ed`). Retired owner-decision
constraints remain binding on any change to those surfaces:

- deterministic gap suggestions: the coach confirms or dismisses; nothing
  reaches an athlete unconfirmed;
- the sports-medicine clearance board: clearance + holds only;
- the issue #345 research workspace: submission never resolves a
  requirement, structurally;
- both competition skeletons (#376/#377): deliberately skeletal by owner
  decision;
- the payment slot (#378): CAP-012 stays BLOCKED. The slot is no longer
  empty -- the connect flow (`/api/pilot/payments/connect/start` and
  `/callback`, the webhook) and `/admin/payments` are built on it (checked on
  `main` 2026-09-28); charging is not. See the Stripe row under BLOCKED.

## Last recorded build queue: video calibration lab (recorded 2026-08-29; re-checked 2026-09-21)

Each surface reads what the one before it writes, so the order is not
arbitrary. The queue as recorded at 2026-08-29, with each item's state on
`main` at 2026-09-21:

1. **OD-2026-08-29-003, the pages -- BUILT; do not rebuild.** Both
   `apps/web/app/admin/calibration/review/page.tsx` and
   `apps/web/app/admin/calibration/adjudicate/page.tsx` render the pair
   selection (`data-testid="pair-selection"`).
2. **OD-2026-08-29-005, the superseding migration -- not found on `main`.** A
   revision integer per pair, a unique constraint on (pair, revision), and the
   route translating the 23505 collision -- the translation is part of the
   ruling and owes its own test. Searched: no revision column in
   `infra/azure/pilot_slice_postgres_calibration_adjudication_migration.sql`,
   and no `23505` handling in `apps/web/app/api/pilot/calibration/adjudication/route.ts`,
   whose own comment notes no superseding column and no update path.
   Re-checked 2026-09-28: still absent. It stays on the build list below
   (OD-2026-09-28-010 item 12).
3. **`qaReadModel`** -- the module exists with no non-test importer. Read it
   before designing to it.
4. **`gold`** -- the module and its migration exist with no non-test importer.

**The calibration migrations are applied** (corrected 2026-09-28; a BLOCKED
row here said they had never been applied in any environment, and it is
removed). `apply-migrations` run 33269702024 (staging, `app-ppbf-staging`,
2026-08-29) logs `PILOT CALIBRATION ADJUDICATION MIGRATION PASS`, and run
33280673339 (production, `app-ppbf-production`, 2026-08-29T23:18Z) logs the
projects, annotations, adjudication and gold `MIGRATION PASS` lines; both
also log `PILOT SPARRING ATTEMPT CONTEXTS MIGRATION PASS` (logs read
2026-09-28). Whether the calibration surfaces work end to end was not checked.

## Build list

Work Jason has decided should be built and that has not shipped. A row goes
when it ships.

| Item | Decided by | State on `main`, checked 2026-09-28 |
|---|---|---|
| Calibration superseding migration: a revision integer per pair, a unique constraint on (pair, revision), and the adjudication route translating the 23505 collision, with its own test | OD-2026-08-29-005; kept on the list by OD-2026-09-28-010 item 12 | Not built (item 2 of the queue above). PR #929 designed it and closed unmerged on 2026-09-28. |
| Deletion scope B: everything tied to the athlete marked deleted at the same moment as the athlete, as its own change after the screen | Jason 2026-09-29: "10 C" (scope A, the screen, first; B right after, separately), OD-2026-09-29-002 item 10 | Not built (checked 2026-09-29). Scope A is the `/admin/data-deletion` screen (`apps/web/app/admin/data-deletion/page.tsx`) over the existing API. The API marks only the athlete row and the athlete's account (closing its sessions and outstanding activation codes), or the guardian account (with its membership and sessions) and the children the trigger withdraws (`apps/web/src/server/pilot/dataDeletion.ts`); nothing marks photos, videos or notes. |
| A real roster loading path: an `/admin/import` door for organization admins and coaches, with the import page and API opened to coaches (corrected 2026-09-29) | OD-2026-09-28-010 item 26; Jason 2026-09-28: "11 build ask questions if you need to" (questions go to him first); OD-2026-09-28-011 item 11; roles "9d. B", OD-2026-09-29-002 item 9d | `/admin/import` (a CSV preview, then commit, over `/api/pilot/admin/roster-import`) is linked from `/admin` as LOAD ROSTER (`apps/web/app/admin/page.tsx:1279`) but has no building-map door: `apps/web/components/buildingMapCoverage.test.ts:76` holds it as "wants a door, roles unconfirmed". Checked 2026-09-29 at `91de82ca`: the route admits organization admins only (`apps/web/app/api/pilot/admin/roster-import/route.ts:39-41`), and so does the page (`apps/web/app/admin/import/page.tsx:249-253`). |
| A One Percent Club nomination is deleted with the athlete it names | OD-2026-08-29-007 | Not built: `pilot_one_percent_nominations_athlete_fk` has no `on delete cascade` (`infra/azure/pilot_slice_postgres_one_percent_club_migration.sql:61-62`), and `apps/web/src/server/pilot/dataRetentionDeletion.pg.test.ts:1264` still expects the purge to report it as a blocker. |
| Policy-shelf move tool (added 2026-09-28): a dispatch-only workflow and script that moves approved `internal_policy` library sources from one organization to another, dry-run first; its first use is the 22 sources under `ppbf-default-org` (BLOCKED row below) | OD-2026-09-28-011 item 6 ("6yes"); gym id OD-2026-09-28-007 | Built 2026-09-29 (`apps/web/scripts/pilot-move-policy-shelf.mjs`, `.github/workflows/move-policy-shelf.yml`; unit 73/73, embedded-Postgres `movePolicyShelf.pg.test.ts` 8/8). Selects every `internal_policy` source of the from-organization whatever its approval state (reported, not filtered); capability rules are listed, never moved (open question). Next: a staging dry run, then a production dry run, then the production apply with the dry run's `plan_fingerprint` and Jason's approval in GitHub. Never dispatched yet. |
| `scripts/make-plate.mjs` room flag (added 2026-09-28), so a plate for a non-training room is not given the ring-and-bags DNA | OD-2026-09-28-009 item 5 | Not built. At `10da14c9` its only options are `--out`, `--ref`, `--subject`, `--portrait`, `--dry-run` and `--force`, and every prompt carries the lock's DNA section (`readGymDna`, :82-108; the prompt, :195-196). |
| Guard tests that still enforce retired laws 6 and 8 (added 2026-09-28): move the real contrast checks elsewhere instead of deleting them, and retire the assertions that only restate a retired law | OD-2026-09-28-009 item 1 | Not done. `apps/web/src/design/darkPanelMaterials.test.ts:8` and `apps/web/src/design/lightGroundVoices.test.ts:5` still open on law 6; the real check to keep includes the dark-on-dark sign-in board at `darkPanelMaterials.test.ts:14-23`. The review also named `familyPlateGround`, `roomBaseClass`, `buildingMapRooms` and `typeLadder` tests; not re-checked. |
| Design-system manifest generator reads the Golden Era sheet (added 2026-09-28), then `design-system/manifest.json` is regenerated | Follows OD-2026-09-28-009 (visual rules under Golden Era) | Not done. `design-system/build-manifest.mjs:63-66` reads only `foundation/ppbf-foundation.css` and `legacy/ppbf-leather-brass.css`, not `current/ppbf-golden-era.css`. The review counted 117 tokens committed and 125 on regeneration; not re-measured, because running the generator writes the file. |
| Retire the old red hue-ban browser checks (added 2026-09-29): drop the assertions that refuse `#A81E22` / `--stamp-red` as a hue in `apps/web/e2e/public-homepage.spec.ts`, `apps/web/e2e/golden-era-scope-proofs.spec.ts` and the `goldenEra*Scope` tests, keeping every check that `--locked` still means a medical stop and that refusal stamps keep red for MEDICALLY_NOT_ALLOWED (`apps/web/components/refusalStamp.test.tsx`) | OD-2026-09-29-001 ("6 B": "the test goes and the rule changes") | Not done. The repo-wide guard is deleted; these narrower checks still refuse the hue on their pages. |
| Seed data that says stamp events exist (added 2026-09-28): correct it at the next seed | OD-2026-09-28-008 (stamp-ledger design retired; never built) | Not done. `apps/web/seed-data/shadow-research/2026-08-08/physical_test_battery.csv:19` and `apps/web/seed-data/shadow-research/2026-08-07/seed_shadow_library_chunks.csv:2290` and `:6266`, and both `evidence_registry_boxing_learning.csv` copies (`apps/web/seed-data/research-evidence/2026-08-07/` and `apps/web/seed-data/shadow-research/2026-08-08/`, :288 and :785 in each), describe START_ROUND/END_ROUND stamps as emitted; `START_ROUND` appears nowhere under `apps/web/app`, `apps/web/src`, `apps/web/components` or `infra` (`git grep`). |

## BLOCKED

| Item | Blocked on | Unblocks |
|---|---|---|
| Stripe onboarding round-trip test + checkout slice (item 8, remaining half) | The connect flow is BUILT (owner instruction 2026-08-15: build ahead so onboarding can be tested "as if I'm a new gym") — `connect/start`/`connect/callback`, the deauthorization webhook, and `/admin/payments`. What blocks is the owner registering PPBF's Stripe **platform** account and Connect OAuth client (`PAYMENT_CONNECT_CLIENT_ID` + `PAYMENT_PLATFORM_SECRET_KEY` + `PAYMENT_PLATFORM_WEBHOOK_SECRET` as Container App secrets); the Giving account's 501(c)(3) verification should start in parallel (it is the slow step). | The live end-to-end onboarding test on staging, then the checkout/receipt/mirror-writing slice — staging-first behind `PPBF_PAYMENTS_ENABLED`, with CAP-012 flipping only after the slot's step-5 evidence and the owner's compliance sign-off. |
| PRODUCTION DEPLOY of the SHADOW near-miss audience gate | Owner ruling 2026-09-26, verbatim: "Nothing is real if anything is waiting." **Two of this row's original claims are no longer true and are corrected here rather than left to mislead a later session.** (1) It said the queue-empty check was still to be added by a separate PR. It is on main: `.github/workflows/deploy-production.yml`, step "Refuse To Deploy While SHADOW Jobs Are Waiting", running `apps/web/scripts/pilot-check-shadow-job-queue.mjs`. (2) It said the gate "does nothing for jobs already queued". It now does: `SHADOW_CONTEXT_CONTRACT_VERSION` is 2, and `shadowJobProcessor.ts` refuses any payload stamped below it or unstamped, so a job carrying pre-gate context is failed rather than answered. The row stays only because its remaining unblock clause is a run-time event that has not happened — no production deploy has carried this gate yet — not because anything is missing. Merging to main is unaffected: production deploy is manual dispatch. | A production deploy carrying this gate runs, with the queue-empty check passing. |
| Training holds at check-in and drill assignment | Recorded 2026-08-28 in the release record as FOR THE OWNER, not to be decided by an AI alone: training holds were not enforced at check-in or drill assignment. Not re-checked since. | An owner decision on where a training hold must block. |
| Move the 22 approved `internal_policy` library sources (7 documents, 49 chunks) from `ppbf-default-org` to `punxsy_prominence` (added 2026-09-28) | The move tool is not built (build list above). Jason said "6yes" on 2026-09-28 (OD-2026-09-28-011 item 6); the production run still needs his approval in GitHub. OD-2026-09-28-007 records the read-only count. A user's library reads their own organization plus `__platform__` (`apps/web/src/server/pilot/platformLibraryScope.ts:35-38`), so the gym does not see these sources while they sit under the root platform organization. | The gym reads its own policy sources. |
| `transfer_claims` seed (added 2026-09-28; carried from `DEPLOY_RUNBOOK_2026-08-08.md`, "Still open" item 1) | All 173 transfer claims reference a drill-id generation that resolves against neither the archive's drill library nor the 119 drills shipped here. Disposition 2026-08-09: leave `pilot.transfer_claims` empty and do not build a mapping from this side, because a guessed crosswalk fabricates evidence-backed provenance between two techniques. | A crosswalk from whoever generated the ids; then `seed:transfer-claims` can run. |
| Grappling exposure write path (added 2026-09-28; carried from `DEPLOY_RUNBOOK_2026-08-08.md`, "Still open" item 5) | What a coach is prompted to enter when a choke was completed on a child is a safeguarding-practice decision nobody has made. Checked 2026-09-28: `apps/web/app/api/pilot/multidiscipline/route.ts` is read-only by design (its comment at :14-20), and `recordGrapplingExposure` (`apps/web/src/server/pilot/multidiscipline.ts`) has no non-test caller. | The owner specifies what a coach is prompted to enter. |
| Seed loaders record the seed account's real role (added 2026-09-28): make `apps/web/scripts/seed-drill-library.mjs` and `apps/web/scripts/seed-workout-templates.mjs` look up the seed account and write its real `created_by_role`, as `import-shadow-research.mjs` does (:127, :509-517) | Jason decides whether the next gym seed waits for this. Every row of `apps/web/seed-data/drill-library/seed_drill_library.csv` (119) and `apps/web/seed-data/workout-templates/seed_workout_templates.csv` (12) says `platform_owner`, and the loaders write it as given (`seed-drill-library.mjs:269`, `seed-workout-templates.mjs:214`), so a gym seed run as `ppbf@` (organization admin; `docs/AI_DELIVERY_PIPELINE.md`, "Promote to production" step 2) records the wrong role on each new row. Rows already present are skipped, not rewritten (`on conflict ... do nothing`, `seed-drill-library.mjs:237`, `seed-workout-templates.mjs:195`). | A gym seed that writes new drill-library or workout-template rows. |

### Open owner questions (added 2026-09-28, OD-2026-09-28-010 item 15)

Questions recorded in older documents that no decision has answered, one row
each, guardian-related first. Each blocks only the work it names, and each is
answered when Jason's answer is recorded in `docs/current/OWNER_DECISIONS.md`.
"Not re-checked" means the row repeats its source and nothing was measured on
2026-09-28. Rows added or answered on 2026-09-29 say so; an answered row stays
until the check or search it asked for has finished.

| Question | Where it was recorded; what was checked |
|---|---|
| Waiver status values (guardians' signed paperwork), added 2026-09-29: add a CHECK constraint on `pilot.waivers.status` now? | OD-2026-08-29-008 (measure first), measured 2026-09-29 (its Status line; OD-2026-09-29-002 item 8a, reported by the session that ran `npm run pilot:check-waiver-statuses`): 11 rows, every one exactly `signed`; a byte-exact CHECK over `signed`, `declined`, `withdrawn`, `missing` would refuse 0 rows; no CHECK exists. |
| Should `GET /api/pilot/progression/assignments` stop sending the assigning coach's `assigned_by_account_id` to athlete and guardian callers? | Left open by OD-2026-09-19-001 (W-D4B interpretation 4). Checked 2026-09-28: the route admits `athlete` and `parent` (`apps/web/app/api/pilot/progression/assignments/route.ts:30`) and returns rows that carry the field (`apps/web/src/server/pilot/progression.ts:85-94`). |
| Should a linked guardian get the athlete-safe projection from `/api/pilot/drill-library` instead of the coach shape? | Left open by OD-2026-09-19-001 (W-D4B interpretation 5). Checked 2026-09-28: only `role === 'athlete'` is narrowed; a parent reads the same shapes as a coach (`apps/web/app/api/pilot/drill-library/route.ts:70-80`). |
| Who may edit a session note after the athlete writes it? | OD-2026-09-25-003, "Still open": the create and update routes accept `organization_admin` and `coach` as well as `athlete`, and the row has no author column. Not re-checked. |
| Should an athlete read the coach's notes on their video? | Delivery ledger slice 10 (`docs/archive/2026-09-28_ATHLETE_DELIVERY_LEDGER.md`): the API returns them and nothing renders them. Not re-checked. |
| May the athlete's sparring page say a coach sees their ordinary sparring observations, now that a coach screen reads values derived from them? | `docs/PLATFORM_AUDIT_2026-08-28_ROUTE_REACHABILITY.md`, "One thing a reader should still know": what to tell a child about their own data is the owner's. Checked 2026-09-28: the copy rule is still the comment at `apps/web/app/athlete/dashboard/sparring/page.tsx:291-297`. |
| Authorize the slice that stores coach-set limits for minors (heat time, % of body weight, contact level, supervision) as data. | OD-2026-09-21-001 item 4: no limits table exists, and building one is its own slice that entry does not authorize; until then the AI asks for each limit. Checked 2026-09-28: no such table among the `create table` statements in `infra/azure/*.sql` (searched for limit, heat, weight_cut and supervision). |
| Check-out records no duration or end time, so SHADOW Session Load cannot be computed: does that belong to the check-out work or to a SHADOW slice? | Delivery ledger slice 4: an open scoping call. Not re-checked. |
| Should a session nobody checks out of be closed automatically? | Delivery ledger slice 4: a separate product decision. Not re-checked. |
| What is the "Athlete Schedule" half of the athlete-workspace slice 8? | Delivery ledger slice 8: no requirement for it is recorded anywhere. Not re-checked. |
| Is "expandable Floor cards" satisfied by the deep link? | Delivery ledger slice 9. Not re-checked. |
| Must a final signed-in staging check run before a production deploy? | Delivery ledger slice 11 planned one before production; production shipped without it, and the ledger left the choice between plan and practice to the owner. Not re-checked. |
| Should at least one coaching cue be required on a drill? It would block 34 of 119 drills, including 23 of the 25 conditioning drills. | OD-2026-09-19-001, "Owner decisions left open, not guessed". Not re-checked. |
| Are the 114 drafts marked REQUIRES FLOOR VALIDATION adoptable as they are? | OD-2026-09-19-001, same list. Not re-checked. |
| Should blank equipment on the 5 source-manual drills count as missing? | OD-2026-09-19-001, same list. Not re-checked. |
| Should adopting a change proposal on a retired lineage be refused? Today it brings the drill back under a new operational id, a second path around Restore. | OD-2026-09-19-001, same list. Not re-checked. |
| May a coach reinstate an earlier version of a drill, or only the newest? The build allows only the newest. | OD-2026-09-19-001, same list. Not re-checked. |
| Should adopting a newer reference version go through the adopted drill (OD-2026-09-16-001 clause 5) rather than promote a separate operational drill? | OD-2026-09-19-001, same list; latent while no reference row has been superseded. Not re-checked. |
| What does `pilot.drill_library.source_ref` mean? The cue ruling (OD-2026-09-15-001) does not extend to it. | `docs/current/OWNER_DECISIONS.md`, "Open questions -- NOT decided". |
| Who may write platform library rows, beyond an operator running the importer? | `docs/PLATFORM_EVIDENCE_BASELINE_HANDOFF.md`, "Open decisions the owner has not made", item 4. Not re-checked. |
| Account cleanup: does `coach@` stay, and what happens to each held identity? | `docs/PLATFORM_EVIDENCE_BASELINE_HANDOFF.md`, same section, item 7, which names the held identities; the cleanup run had not been made when it was written. Not re-checked. |
| Who makes the branch-protection change that makes `declaration` a required check on `main`: Jason, or Claude with his yes for that one write? | Decided in OD-2026-09-28-010 item 11; the setting is not changed. Checked 2026-09-28 (`gh api .../branches/main/protection`): the only required check is `validate`, and admin enforcement is off. |
| The no-route modules at `docs/current/SIGN_OFF_GUIDE.md:497-504`: build each missing screen, or accept API-only? | Documentation review 2026-09-28 (F72): each needs an owner decision that is not tracked. The rest of that finding, the modules with no ManualVerification row, is answered ("9a. B", OD-2026-09-29-002 item 9a; see "Verification debt" below). 7 of the 36 in that answer are on the guide's no-route list (1, 27, 45, 82, 131, 133, 135), so the guide gives them no page to try, or only a read side. The list is partly out of date: holds (45, 82) are now placed and lifted on `/coach/sports-medicine` (`apps/web/app/coach/sports-medicine/page.tsx:30`, :237-238 at `91de82ca`). `docs/capabilities/SIGN_OFF_WALKTHROUGH.md` ("Nothing to try yet", 2026-09-29) is the later list for its 48 modules. |
| Turn `docs/SHADOW_EVENT_MODEL.md` section 6, Event Source Confidence (:129-155), into a pointer, as the 2026-09-28 documentation review planned (F154)? Added 2026-09-29. | The review's plan waited on a production check, now run ("8A", OD-2026-09-29-002 item 8b): `shadow-event-model` is not in the production library, so the edit re-approves no stored copy; the next seed registers it as `pending_review` and it is approved at `/evidence` before SHADOW reads it. What the pointer points to is not recorded in this repository. |
| Where are the two 2026-08-22 owner documents, `PPBF_OWNER_DECISION_IDENTITY_ACCESS_GOVERNANCE_MULTI_ORG_2026-08-22.md` and `PPBF_OWNER_PRODUCT_DIRECTION_v2_2026-08-22.md`, or are they lost? Search running 2026-09-29 ("9b. B", OD-2026-09-29-002: every OneDrive, Google Drive and SharePoint folder, read-only). | Documentation review 2026-09-28 (F137). Checked 2026-09-28: `PRODUCT_CAPABILITIES.json`, the approved product list (OD-2026-09-28-010 item 21), cites them 75 and 36 times; `git log --all` finds neither in any commit. The review did not find them at the top level of ACTIVE_APPROVED_SOURCE or by M365 or Drive search; subfolders were not listed. |
| PR #941 (the coach drill library redone as a drill cabinet): answered 2026-09-29, "5 A" (OD-2026-09-29-002): check it against `main`, close it if `main` already has what it adds, otherwise tell Jason what is missing. Check in progress. | Checked 2026-09-28: open; its `validate` check fails; its head is 14 commits behind `main` (`10da14c9`). The review also noted that plate-09 now exists for it and that it edits the font-retirement guard; not re-checked. |
| The leftover GitHub branches: answered 2026-09-29, "4 A" (OD-2026-09-29-002): compare each with `main`, delete those already in `main`, keep `archive/` and `rescue/`, list for Jason any with real unique work. In progress. | Documentation review 2026-09-28 counted 85 in four groups (8 `archive/` and `rescue/`; 19 head branches of merged PRs with later commits; 35 of closed, unmerged PRs, the #929 branch staying until its migration ships; 23 that never had a PR). 2026-09-29: all 95 remote refs (`main` included) backed up to `Documents/PPBF-local-backups/github-branches-2026-09-29/all-remote-branches.bundle` before any deletion. Progress is not copied here: read it live (`git ls-remote --heads origin`). |

## PARKED

| Item | Why it is parked | Re-open when |
|---|---|---|
| SHADOW near-miss text delivered before the audience gate | Closed on the owner's statement of 2026-09-26, quoted in OD-2026-09-26-002: "NONE HAS BEEN SENT". That is his knowledge of who has used SHADOW, not a measurement -- no conversation, database or log was read, and the OD entry says so. Parked rather than deleted because a closure resting on an unmeasured statement leaves nothing to prompt a re-check, and the conversation-history loader re-feeds recent turns, so delivered text could resurface after the gate -- bounded to that loader's window and only where the model repeated it into a saved reply. | Any data pull, audit or report shows near-miss content in an athlete or parent CONVERSATION. Note the limit of that trigger: a conversation pull can only find text the model repeated into a saved reply, never text that sat in the prompt and was not repeated, so it is a floor and not a census. Stored job payloads were ruled OUT OF SCOPE by the owner on 2026-09-26 (OD-2026-09-26-002) and are not covered by this row. |
| `BACKLOG-activity-log-backfill` | Legacy attendance sources cannot support a trustworthy synthetic history. Do not invent a backfill. `pilot.activity_log` is go-forward evidence. | A specific requirement appears for importing legacy history with an explicit provenance/conflict policy. |
| `BACKLOG-triage-keyboard` | A one-key approval path is not meaningful until the queue exposes a review-complete/eligible action. | The review queue has a deterministic eligibility signal. |
| `BACKLOG-offline-write-queue` | Persisting minors' check-ins on a shared tablet creates identity, attribution, and data-at-rest problems. | A concrete identity-scoped encrypted/offline storage design is selected. |
| `BACKLOG-grant-packet` | The rendering foundation exists; the unresolved question is what aggregate minor-related data may be disclosed externally. | A real grant/export request defines the disclosure set and privacy threshold. |
| `BACKLOG-coach-development-visibility` | Every route over a coach's development record is self-scoped: `/api/pilot/coach/development` takes no account id on any method and answers for the caller, matching `/api/pilot/coach/credentials`. Whether a head coach or an organization admin may READ their staff's development goals is a real question, and building the cross-coach read first and gating it afterwards is how such a question gets answered by accident. | The owner states who may see another coach's development record, and for what purpose. The data layer already scopes by account, so the change is an added, gated read path -- not a loosening of the existing one. |
| `BACKLOG-coach-mentorship-pairing` | Coach self-development shipped goals and recorded work (`pilot.coach_development_goals` / `pilot.coach_development_activities`, `/coach/development`), and deliberately stopped short of a coach-to-coach mentorship RELATIONSHIP. A row saying "Coach B mentors Coach A" names a second member of staff, and who may assert it, whether B consents, and who may see it are product and consent decisions nobody has made. `pilot.mentorships` is not it: both its FKs point at `pilot.athletes` and a CHECK forbids self-pairing, so it cannot express a coach at all. A coach can already record a mentorship SESSION THEY ATTENDED as an activity in their own words, which claims nothing about anybody else's role. | The owner decides who may assert a staff mentorship, whether the named mentor must agree, and who may read it. Until then the activity record covers the coach's own half. |
| `BACKLOG-open-route-gates` | Route visibility and authorization are not the same thing; changing `buildingMap.ts` alone protects nothing. | A route is shown to expose a real unintended surface, then fix that route's own guard directly. |
| `BACKLOG-video-skill-scoring` | Owner decision 2026-08-15: per-skill AI video scoring (punch detection, footwork, etc.) is parked for Phase 2+. Human Film Study IS the analysis pathway; shipping machine scores about minors' athletic ability without proven accuracy is the risk being refused. Teach Shadow teaches recognition only and does not re-open this (OD-2026-09-28-006, ruling 5). | Phase 1 is complete AND a scoring approach with explicit evidence standards has been selected by the owner. |
| `BACKLOG-publication-automation` | Queue item 9, assessed 2026-08-15 under the owner's standing approval for recommendations: the internal publication machinery that exists (video compliance console + consent gating, research evidence review, retraction surveillance) is human-gated on purpose — there is no automatable step left that does not cross a gate deliberately. What automation would add is outward publication to a "destination registry", and no destination, content set, or disclosure rules exist. Automating external disclosure of content about or derived from minors ahead of those decisions is the same risk `BACKLOG-grant-packet` refuses. | The owner names a real destination and content type (e.g. "approved research summaries to the public site") with an explicit disclosure set. Automation then means moving already-approved items — never approving them. |
| `BACKLOG-safety-alert-transport` | An unacknowledged high/critical safety escalation now reaches a coach IN THE APP, on every surface, via the persistent count on the session bar (`components/SafetyAttentionBadge.tsx`, reading the existing `/api/pilot/escalations` — no second queue). What is deliberately NOT built is an EXTERNAL transport: push notification, email, or SMS. That is a separate decision, and the blocking part is not the plumbing. It is content and privacy: an external message about a minor leaves the platform's access controls entirely, lands on a lock screen or in an inbox somebody else may read, and cannot be scoped the way a page can. Nobody has decided what such a message may say — whether it may name an athlete, name a severity, name a source, or only say "open the platform" — nor who may receive one, nor what happens when a coach's assignment or coverage lapses between sending and reading. Sending a safeguarding notification about a child before those are answered is the same risk `BACKLOG-grant-packet` refuses, arriving by a different door. | The owner selects a transport AND records the content rules for it: exactly what an external message may contain about a minor, which recipients may receive one, and the retention/revocation posture for messages already sent. Implementation then means delivering an already-decided payload — never deciding it. |
| `BACKLOG-wearables` | Owner "add all" decision 2026-08-16 deliberately EXCLUDED wearables/HR streams: biometric hardware for minors needs a consent, privacy, and device-ownership decision no code can make. | The owner selects a device approach and records the consent/privacy posture for minors' biometric data; integration then reads into the attempts/readiness spine. |
| `BACKLOG-quickbooks-sync` | Owner request 2026-08-15 ("Treasurer also needs the QuickBooks login"): the treasurer's QuickBooks access itself is an Intuit-side action (invite as accountant user), not platform work. The platform half — pushing the payment mirror ledger into QuickBooks so nobody keys in donations by hand — is the Revenue Center's "QuickBooks Placeholder \| Future Integration" row and stays parked until money actually flows. | The payment lanes are live (CAP-012 flipped) and real transactions exist in `pilot.payment_transactions` to sync; the integration then gets its own compliance review per the placeholder's own label. |
| `BACKLOG-engine-unlock-proposals` (added 2026-09-28) | Fourteen engine-unlock proposals under `docs/capabilities/proposals/engine-unlock/` (modules 015, 016, 017, 018, 021, 023, 024, 025, 029, 030, 031, 032, 033, 035), each marked PROPOSAL and awaiting owner approval since 2026-08-16. Parked as one row and otherwise left untouched (OD-2026-09-28-010 item 20). The 036 proposal and the 036a design are not among them. | Jason takes up a named proposal. |
| `BACKLOG-general-discipline-row` (added 2026-09-28) | `docs/current/OWNER_DECISIONS.md`, "Open questions -- NOT decided": what to do with a real `general` discipline row. That list recorded on 2026-08-28 (#791) that none existed in production or in any seed or fixture, and that the foreign key refuses `general`, so one could only arrive by a write that predates the key. Not re-checked. | A `general` row is found anywhere. |
| `BACKLOG-superseded-reference-promotion` (added 2026-09-28) | OD-2026-09-17-001, "What it does not decide": when a reference drill is superseded, the coach's remedy -- promote the newer version -- is blocked by `pilot_drills_one_name_per_org` while the old promoted drill is still active under the same name. Latent: that entry recorded that no reference row had ever been superseded. It needs its own slice. | A reference drill row is superseded in any environment. |
| `BACKLOG-release-deferred-2026-08` (added 2026-09-28) | Items the release record deferred in August and `docs/current/AI_RELEASE_CONTROL.md` routes here: the coach roster row click (held for #606, closed unmerged 2026-08-25); #602's `path.relative` Windows separators (the guard fails loud, and CI runs on Linux); rendering of UNKNOWN-method historical RPE (measure production data first); the track-assignments silent autosave; the athlete "Messages 0" tile. Original wording: `docs/archive/2026-09-21_AI_RELEASE_CONTROL_before_condense.md`, DEFERRED. Not re-checked since. | A change touches one of those surfaces; re-check that item's state first. |
| `BACKLOG-button-size-collision` (added 2026-09-29) | Jason, "9c. B" (OD-2026-09-29-002): parked until the look-board redesign. The CSS `.btn`/`--tap` repair (R1; documentation review 2026-09-28, F9). Checked 2026-09-28: `apps/web/scripts/css-layer-collisions.mjs` reports 101 BROKEN collisions (a utility class the unlayered sheet silently overrides). Whether 23 `.btn` sites render at 44px instead of the 55px of law 5 is UNVERIFIED; the scanner may be masking them. | The look-board redesign (OD-2026-09-28-012) starts. |

## Verification debt

Historical runtime-verification gaps (including T-001/T-002 and the PR-238 bulk
deployment) are evidence debt, not a blanket blocker on new development. Run
the relevant runtime probe when touching or releasing the affected surface.
Sparring failure contexts (2026-08-16, item 5) shipped at the DB and
application layers, and its migration is applied: `apply-migrations` runs
33269702024 (staging) and 33280673339 (production), both 2026-08-29, log
`PILOT SPARRING ATTEMPT CONTEXTS MIGRATION PASS` (logs read 2026-09-28).

DONE modules nobody has tried (added 2026-09-29; "9a. B", OD-2026-09-29-002
item 9a): 48 module files carry `ManualVerification | PENDING_SIGN_OFF`,
labelled "built, not yet tried by a person", and
`docs/capabilities/SIGN_OFF_WALKTHROUGH.md` gives one way to try each on the
tablet. Tests do not show whether a screen works; Jason or a coach trying it
does. The question named 36; the other 12 were added by Claude and not yet
put to Jason (same item).

## History

For audit/provenance questions only, use `docs/current/WORK_QUEUE.md` and
`docs/archive/`. Those records are evidence, not the ordinary build workflow.
