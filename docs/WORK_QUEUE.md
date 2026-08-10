# Work queue — shared between agent sessions

> # ⛔ SUPERSEDED — DO NOT PLAN OR CLAIM FROM THIS FILE
>
> **The authoritative queue is [docs/current/WORK_QUEUE.md](current/WORK_QUEUE.md).**
> If this file contradicts it, that file wins.
>
> This one is kept only because the incidents recorded below are real history worth
> keeping. **Every task table in it is historical.** Items marked open may be long
> since finished; items marked done may have regressed. Nothing here is maintained.
>
> **This banner was made this loud on 2026-08-09 because it failed.** An agent
> session read this file from the middle, never saw the four-line note that used to
> sit here, reconciled the whole "Ready to build" table against the repository, and
> reported the result as the live plan — including telling the owner it was "the
> single largest drag on the build". Ten items were correctly identified as finished
> and none of it mattered, because no one should have been reading this table at all.
> If you are here to find work, stop and open the file linked above.

Two Claude sessions work this repository at the same time. Today that cost real
duplicated work: the same nine compliance/progression/publication tables were
ported to migrations twice (once as one file, once as three), and video release
was built twice — a scan-and-promote sweep in one session, a coach release
action in the other. Both duplications were caught late, and reconciling the
video one turned out to matter: the coach path would have let a coach overturn
a content-screen refusal of footage of a minor.

This file exists so that stops happening. It is the queue and the ownership
record. **Read it before starting anything; claim what you take.**

Goal for this stretch: the platform is going to be used for **supervised
real-world testing with coaches and their own children**. That is the bar to
build against — real minors' data, informed adults present, failures
recoverable. It is not a public launch, and it is not a demo.

---

## The rules that stop us colliding

1. **Check `origin/main` first, every time.** Not the local checkout. The other
   session merges frequently, and twice today work was written against a `main`
   that had already moved.
2. **Claim before you build.** Move an item to *In progress* with your session
   marker in this file, and push that change before writing code. An unclaimed
   item is fair game; a claimed one is not.
3. **Stage explicit paths, never `git add -A`,** when another session or a
   background agent might be mid-write. That mistake swept half-finished work
   into a commit today.
4. **Schema before code**, and one migration per concern. If an item needs a
   table, the migration, its runner, its `pilot:apply-*` and
   `test:migrations:*` scripts, all three `apply-migrations.yml` lists, and a
   real-Postgres suite with a negative control ship together.
5. **If you find the other session already did it, stop and reconcile** rather
   than finishing yours. Say so in the PR. The right answer is usually theirs
   plus whatever yours protects that theirs does not.
6. **No non-ASCII in SQL files.** A box-drawing character in a migration failed
   against every non-UTF-8 Postgres while passing CI, and cost an evening of
   misdiagnosis.

---

## Blocked on the owner — nobody can build past these

- [x] ~~**Deploy `main` to production.**~~ Done. #275 records production on `fbb8155` with
      application and database on the same commit, verified from run 31288537060's own steps.
      The consequences listed here — first sign-in broken, publications failing, pain reports
      rejected — no longer apply.
- [ ] **Decide the consent posture and write it down.** `app/admin/athlete-consent/page.tsx`
      exists, so this is no longer "build a screen or commit to paper" — it is deciding which of
      those the half-built surface becomes, and telling the board and the insurer. It stays here
      because the seeded "Medical Clearance Status" rule currently tells your Safety Director the
      platform is verifying forms it may not be able to store, and only the owner can resolve
      that mismatch.
- [ ] **Author `what_to_watch` and `what_to_fix` for the two `controlled_sparring` blocks.**
      `pilot_ssb_content` blocks the session-script seed on three empty blocks, two of which are
      the highest-contact blocks in the script (#278). 65 blocks and 3 scripts do not seed, and
      the coach floor surface in #279 returns `SESSION_SCRIPT_HAS_NO_BLOCKS` for them. #278
      recorded that reclassifying them to `transition`/`arrival`/`close` would satisfy the
      constraint by declaring a controlled-sparring block a transition, hiding contact exposure —
      so authoring the content is the only route whose result is true, and it is the gym's to
      write.
- [ ] **Open the two Stripe accounts** — giving first (501(c)(3) verification
      is the slow half). Everything in the payment slot waits behind it.
- [ ] **Ingest the punxsy-corpus into the SHADOW Library.** Semantic search is
      armed in both environments and the Library is empty, so SHADOW answers
      without the evidence base it was designed around.
- [ ] **Supply a short training clip** for the Film Study measurement
      diagnostic.

---

## Ready to build — unclaimed

**RECONCILED 2026-08-09 against the repo at `b1839ee`.** The ordering below came from a
floor-readiness trace run 2026-08-01 and eight of its items had since been completed without
being struck off. Every item now carries the evidence that was checked, so the next reader does
not re-derive it. Verify before building anyway — that is the lesson of this section, not an
exception to it.

### Done since the trace — do not rebuild

- [x] ~~**Backup and export. Neither exists.**~~ `.github/workflows/backup.yml` carries a daily
      `cron: '10 7 * * *'`, `docs/BACKUP_RUNBOOK.md` documents restore plus a drill checklist, and
      `app/api/pilot/admin/export/roster/` ships a CSV with `Content-Disposition`. #232 also
      verified four consecutive successful scheduled runs.
- [x] ~~**Guardian linking has no writer at all.**~~ Writers exist — `intake.ts:650` and
      `staffProvisioning.ts:381` both populate `pilot.parents` and `pilot.guardian_links`, and a
      guard refuses a parent invite naming no athlete. **Only that half is closed. See the open
      atomicity item below — this is NOT safe to treat as finished.**
- [x] ~~**Two platform-owner routes return a full roster of minors' names.**~~
      `admin/athlete-pin-directory` requires `organization_admin`, explicitly **excludes**
      `platform_owner`, carries a redundant `isOrganizationAdminRole` check, and states the
      boundary in a comment at the call site.
- [x] ~~**An athlete record cannot be corrected or deactivated.**~~ `app/admin/athletes/page.tsx`
      calls `athletes/update` and has its own test.
- [x] ~~**Fabricated donations in `RevenueFundingCenter.tsx`.**~~ No "Community Donor" or
      "Sponsor Family" strings remain; no dollar figures in the file.
- [x] ~~**`drillsPersistence.pg.test.ts` runs nowhere.**~~ `test:migrations:drills-persistence`
      exists and is in the `test:migrations` chain, which `ci.yml` runs.
- [x] ~~**"Zero `.tsx` files reference `pilot.waivers` / `medical_intake` /
      `emergency_contacts`."**~~ That claim is stale — `app/admin/athlete-consent/page.tsx` exists.
      **Only the claim is closed. Deciding the consent posture is NOT done** and sits in
      owner-blocked: a screen existing is not a posture chosen, and the seeded "Medical Clearance
      Status" rule still tells the Safety Director the platform verifies forms it may not store.
- [x] ~~**`scripts/data/` ships invented minors UNLABELLED, in the folder the seed guide names
      for the real roster.**~~ Now `athletes.example.csv`, `goals.example.csv`,
      `sessions.example.csv` — labelled as examples. **Only the labelling is closed**; the row
      contents were never audited, which is now its own open item below.

- [x] ~~**Coach coverage.**~~ **Done.** `grantCoachCoverage` in `access.ts` issues a TTL-bounded
      grant that `assertCoachAssignedToAthlete` admits, validates the grantee is an active coach
      in the granting organization (a typo'd id would otherwise hand coach-level access to a
      minor's record to whatever account it names), and `app/admin/coach-coverage/` ships the
      surface plus a test.
- [x] ~~**A pain report does not name the child on the coach's screen.**~~ **Done.**
      `CoachWorkspace.tsx:402-436` fetches `/api/pilot/coach/pain-reports` on mount and its
      always-visible section at `754-824` renders the athlete name, severity/score and body
      location, served by `app/api/pilot/coach/pain-reports/route.ts:17-76`.
      *An earlier draft of this reconciliation left this unknown because it searched only for the
      old event constant `SHADOW_ATHLETE_PAIN_REPORT_PENDING_REVIEW`, which the implementation does
      not use — a grep for a symbol that was replaced cannot find the thing that replaced it.*

### Still real — verified 2026-08-09

- [ ] **Bulk import writes no logins and no guardians.** The "cannot start / four independent
      failures" half of this item is **stale** — `seed:data` runs. It uses `tsx` (not the
      undeclared `npx ts-node` it once did), imports `db.ts` relatively rather than through the
      `@/` alias that only ever resolved for the editor, and `csv-parse` is in the lockfile. A
      dry-run against `seed-data.config.example.ts` loads, reports the organization, warns
      honestly that coach-existence checks are skipped without a database, and then asks for
      `scripts/data/athletes.csv` — which is the intended workflow, not a defect.
      **What remains is real and is the substantive gap:** the script inserts
      `pilot.athletes`, `pilot.goals` and `pilot.sessions`, and only *reads* `pilot.accounts`.
      It writes no account, no PIN and no `pilot.parents`/`pilot.guardian_links` row, so a
      successful bulk import still leaves 40 children with records and no way to sign in, and 40
      families unlinked. That is the remaining time cost, and it is an additive change to this
      script rather than a repair of it.
      *Verification note: an earlier draft of this reconciliation asserted the four startup
      failures were confirmed today. They were not — that reading came from a checkout 173
      commits behind `main`. Recorded because a reconciliation pass that gets an item wrong is
      the same defect it exists to fix.*
- [ ] **Audit the row contents of `scripts/data/*.example.csv`.** They are labelled as examples now,
      but nobody has checked whether those rows still carry real-looking dates of birth for invented
      minors. Labelling fixed where they sit; it did not fix what they say.
- [ ] **`/public` advertises seven programs and seven FAQ answers, hardcoded.** Confirmed: 25
      program/FAQ references in `app/public/page.tsx`. That is the page a Punxsutawney family
      lands on, and changing it needs a deploy. Needs an owner read-through, not a code fix.
- [ ] **Guardian provisioning is not atomic, so a parent can sign in with no linked child.**
      `app/api/pilot/intake/review-action/route.ts:348-370` awaits
      `createOrUpdateMicrosoftStaffAccount` — which commits its own transaction — and only then
      calls `upsertGuardian` and `linkGuardianAthlete`, which are two further independent
      `await query()` calls (`intake.ts:649` and `:669`). Three transactions, not one. If either
      later write fails or the request is interrupted, the committed account still signs in and
      resolves no children, which is exactly the silent failure the original item described.
      *Verified 2026-08-09 after an earlier draft of this reconciliation wrongly claimed all three
      writes shared the account's transaction and struck the item off on that basis.*
- [ ] **`/admin` writes fabricated capability rows into the database the first time it is opened.
      CONFIRMED, not merely suspected** — an earlier draft of this reconciliation called it
      "unsettled either way", which removed an actionable production-data defect from the queue.
      The path is deterministic and needs no user input:
      `app/api/pilot/admin/capabilities/route.ts:34-44` returns an empty array for any organization
      with no `admin_capability_registry` row; `app/admin/page.tsx:578-589` therefore leaves the
      seeded `fallbackCapabilities` state intact and sets `capabilitiesHydrated`; the effect at
      `598-610` then POSTs that entire seed array back. Opening the page creates the rows.
      This is the item that turns demo data into records nobody can distinguish from real ones.

### Not fully verified in this pass — treat as unknown

Each item states what was and was not checked. Where it says nothing was checked, **verify before
building** — the struck-off items above are what happens when nobody does. Two entries that started
in this section have since been resolved and moved up; that they were ever here is the point.

- [ ] **Athlete check-out loses notes silently** — session state in-memory, never rehydrated. A
      grep for "Check Out"/"checkOut" in `.tsx` found nothing, so this surface may have moved or
      been renamed; the underlying pattern is the one #279 fixed for coach sessions.
- [ ] **The coach review form cannot be completed** — first required field is a session ID minted
      in the athlete's browser and shown on no screen.
- [ ] **Per-athlete starting PIN — a known accepted risk, NOT an unimplemented feature.**
      `pinPolicy.ts` documents the whole design: `DEFAULT_FIRST_LOGIN_PIN` is a bootstrap
      credential written *only* alongside `must_change_pin = true`, and `assertChosenPinAllowed`
      refuses it when someone chooses it for themselves. Two account paths exist and differ on
      purpose — `auth.ts:752` creates an athlete account with `pin_hash = null, active_flag =
      false`, while `auth.ts:580` and the admin reset in `people/page.tsx` issue the bootstrap PIN.
      **The mitigation is a design constraint, not a workaround:** `pinPolicy.ts` says in terms to
      create the account when you are with the athlete, *not in a batch the week before*. Any work
      that bulk-creates athlete accounts would widen the exact window this names, 40-fold, and
      must not be built without the owner overriding that decision deliberately.
- [ ] **Rabbit Hole seed content** — re-author the Biomechanics lesson through the real path.
## In progress — claimed

| Item | Session | Branch |
|---|---|---|
| Knowledge + feedback (drills, Rabbit Holes, feedback box) | session A | `feature/knowledge-and-feedback` |
| Backup + roster export | session A | `feature/knowledge-and-feedback` |
| Pain report names the child on the coach's screen | session A | `feature/knowledge-and-feedback` |
| Guardian invite silent failure | session A | `feature/knowledge-and-feedback` |
| `/admin` seeding fabricated capabilities into the database | session A | `feature/knowledge-and-feedback` |
| Athlete record correction + deactivation | session A | `feature/knowledge-and-feedback` |
| Athlete check-out losing notes | session A | `feature/knowledge-and-feedback` |
| Coach coverage (403 on a covered class) | session A | `feature/knowledge-and-feedback` |
| Attendance Engine (#122, per `docs/CAPABILITY_BUILD_PLAN_2026-08-03.md`): attendance reporting/rollup, bulk class check-in, parent-check-in method attribution fix | session B | `claude/remaining-capabilities-ab0q7d` — PR [#238](https://github.com/PunxsyProminence/ppbf-platform/pull/238), ready for review |
| Safety Gate Matrix (#3 + #43, per `docs/CAPABILITY_BUILD_PLAN_2026-08-03.md` Phase 1): `pilot.safety_gates` + `pilot.safety_gate_evaluations` substrate, `contactClearanceGate.ts` wired in as its first (flag-type) gate, per-org seeding on org creation | session B | `claude/remaining-capabilities-ab0q7d` — same PR [#238](https://github.com/PunxsyProminence/ppbf-platform/pull/238) |
| Red Flag Escalation Protocol (#194, per `docs/CAPABILITY_BUILD_PLAN_2026-08-03.md` Phase 1): `pilot.safety_escalations`, `escalationLadder.ts`, auto-escalation from `shadowNearMisses.ts`, `/admin/escalations`, repeated-pattern detector, board-safe summary | session B | `claude/remaining-capabilities-ab0q7d` — same PR [#238](https://github.com/PunxsyProminence/ppbf-platform/pull/238) |

### PR #238 — ready for VS Code

Three items above are in one PR (single-branch constraint this session; see
the PR body for why). Remote's side is done: typecheck/lint clean, full unit
suite green (3726 tests), all four new `test:migrations:*` suites green
against embedded Postgres, `list-check` equivalent passed locally. A GitHub
Copilot review caught 4 real issues (a foreign-key crash risk on a
pre-migration organization, an N+1 + race in the bulk attendance upsert, a
raw-string category field with no compile-time link to the DB's CHECK
constraint, an unvalidated `since` query param that could 500 instead of
400) — all four fixed and covered by new/updated tests in the same PR. One
comment (RoleSessionGate missing `organization_admin`) was investigated and
found incorrect for this codebase (`mapPilotRoleToClubRole` already
normalizes `organization_admin` to the client-side `admin` role before
`RoleSessionGate` ever sees it) — not changed, replied on the PR explaining
why.

**What VS Code needs to do, in order:**
1. Confirm CI is green on #238 (Remote cannot see runtime, only dispatch and
   local results).
2. Merge #238.
3. Dispatch `apply-migrations` with target=whichever environment is being
   updated, migration=`all` (or individually: `attendance-parent-method`,
   `safety-gate-matrix`, `safety-escalations` — no ordering dependency
   between them, but all three must land before the image that expects
   them). **Migrations before image promotion**, per this file's standing
   rule.
4. Promote the image.
5. Runtime verification Remote cannot do: exercise `/admin/attendance` as a
   coach and as an org admin; exercise a contact observation against an
   athlete with no medical clearance and confirm the near miss, the lesson
   text, AND a new row in `/admin/escalations` all appear; confirm a parent
   test account's check-in records `method: 'parent'` in
   `pilot.scheduler_attendance`, not `coach_override`; acknowledge/resolve
   an escalation as coach and as admin and confirm the role split holds.

**Free for the other session** — none of the above, and none of these files:
`scripts/`, `.github/workflows/`, `apps/web/app/admin/page.tsx`,
`apps/web/app/admin/people/page.tsx`, `apps/web/components/CoachWorkspace.tsx`,
`apps/web/components/AthleteWorkspace.tsx`,
`apps/web/src/server/pilot/{staffProvisioning,access,drills,feedback,rabbitHoles}.ts`.

Session B's attendance work stays inside `pilot.scheduler_attendance` (the
existing check-in store), `schedulerDb.ts`, `app/api/pilot/scheduler/**`, a
new `attendanceReporting.ts` module, a new `app/admin/attendance` page, and a
new migration — it does not touch `CoachWorkspace.tsx`'s hardcoded
`attendance: 'Unknown'` roster column, since that file is session A's. That
wiring is real follow-up work, left for whoever has that file free next.

Good unclaimed candidates: per-athlete starting PIN, the honesty sweep
(fabricated donations, the example minors in `scripts/data/`, `/public`
program copy), the two platform-owner routes returning minors' names, and
`drillsPersistence.pg.test.ts` running nowhere.

---

## Landed today, do not redo

- The full audit and its 13 owner decisions (#144, #149).
- Board seats made real; two seats given the records they are accountable for.
- Video: scan-and-promote (#147/#148) **plus** coach release. **The rule: a
  person resolves what the scan could not (`needs_human_review`,
  `unconfigured`) and never overturns what it refused (`blocked`, `infected`).
  Do not loosen this.**
- Feedback box with safeguarding routing. The route is decided at write time
  and stored; the confirmation is byte-identical whichever way it went; a
  safeguarding body never leaves its own gym.
- Gyms created after the seed migration now get their compliance rules.
- Payments reserved as two Stripe accounts, connected by OAuth button.

---

## Decisions already made — reopen only with cause

Recorded in `docs/PLATFORM_AUDIT_2026-07-31_DECISIONS_MADE.md`. Read it before
revisiting any of them; the reasoning is there rather than in a chat log.

Deliberately deferred: fine-tuning metadata capture (E3/E4) until that lane is
real; review-queue sort (F6/F7) until triage sorts on that column.

---

## Known and accepted for the pilot — tell the coaches, do not fix tonight

Real, and survivable with informed adults in the room. Discovering them
mid-session is what is not.

- **No offline support of any kind.** No service worker, no queue, no
  `navigator.onLine` handling. In a metal-roofed gym every attendance mark,
  pain report and session note silently does not exist whenever signal drops.
- **Shared-device hygiene is one Logout button.** The session cookie lasts 24
  hours with no idle timeout, no kiosk mode, no "switch athlete". A kid who
  walks away without tapping Logout leaves the next kid inside their account.
  **Assign an adult to own the tablet.**
- **The mobile header overruns a phone viewport**, forcing horizontal scroll on
  every screen. A Pixel 7 Playwright project is configured; no coach, athlete
  or attendance flow has any mobile coverage.
- **No audit event exists for READING a record** — the vocabulary is create,
  update, login, logout and three shadow types. Nobody can answer "who looked
  at my daughter's medical file", and `intake/domain-get` returns a child's
  complete medical intake while writing no audit row.
- **Nothing ever deletes a child's record** and there is no retention schedule.
  A child who joins at eight still has their medical record and sparring video
  at twenty-eight.
- **A guardian cannot request erasure or get a copy.** The only deletion
  endpoint covers the caller's own SHADOW chat and writes to a table nothing
  reads.
- **Volunteer background check gates nothing.** `background_check_status` is
  free text and approval never consults it. Handle it outside the platform and
  document that you did — it is the first question an insurer asks.
- **The platform sends no email, ever.** Every coach, staff member, volunteer
  and guardian needs a hand-made Azure Entra B2B guest invitation and their own
  Microsoft account. For 40 families that is 40 portal actions plus 40 parents
  creating accounts — the largest hidden cost in the rollout.
- **Coaches cannot write session records or observations about a child.**
  `pilot.sessions` is written only from the athlete's browser, so every note a
  coach wants to leave lives on paper.
- **`/coach/decision-loop` works fully and is linked from nowhere.** Bookmark it
  on the coach's phone before the first session.
