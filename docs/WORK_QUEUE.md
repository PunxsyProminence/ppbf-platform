# Work queue — shared between agent sessions

> **Superseded.** The current queue is
> [docs/current/WORK_QUEUE.md](current/WORK_QUEUE.md). Kept here because the
> incidents below are real history worth keeping, not because this table is
> still authoritative — do not claim an item from it.

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

- [ ] **Deploy `main` to production.** Migrations first (`apply-migrations`,
      target=production — it now carries board-seats, compliance-rule-seeds,
      announcement-placements, drills, rabbit-holes, feedback), then the image
      promotion. Two approval clicks, in that order.
      *Until this happens, production still runs the pre-audit image: a new
      athlete cannot complete their first sign-in, publications fail every
      time, pain reports are rejected. None of the day's fixes are live.*
- [ ] **Open the two Stripe accounts** — giving first (501(c)(3) verification
      is the slow half). Everything in the payment slot waits behind it.
- [ ] **Ingest the punxsy-corpus into the SHADOW Library.** Semantic search is
      armed in both environments and the Library is empty, so SHADOW answers
      without the evidence base it was designed around.
- [ ] **Supply a short training clip** for the Film Study measurement
      diagnostic.

---

## Ready to build — unclaimed

Ordered by a floor-readiness trace run 2026-08-01.

### The pilot cannot honestly start without these

- [ ] **Backup and export. Neither exists.** A repo-wide search for `pg_dump`,
      `text/csv` and `Content-Disposition` returns zero matches;
      `scripts/backup-export.ps1` is eleven `Write-Host` lines telling you to
      back up Supabase, a database this platform no longer uses. No workflow
      has a schedule. **This is the only item here that cannot be repaired
      after the fact** — lose the database in week three and forty children's
      records are gone. Needs a scheduled dump of the `pilot` schema to durable
      storage, plus a roster export in the product.
- [ ] **`/admin` writes 13 fabricated capability rows into the production
      database the first time it is opened** (`app/admin/page.tsx` seeds,
      hydrates, and POSTs them back). This is where demo data stops being a UI
      artifact and becomes a record nobody can distinguish from a real one.
- [ ] **Do not invite anyone as "Parent / Guardian" until guardian linking has
      a screen.** `createOrUpdateMicrosoftStaffAccount` writes `pilot.accounts`
      and never touches `pilot.parents`, while every parent read path joins
      `pilot.parents` on `account_id`. The parent signs in fine, the People
      list shows them healthy, and they see an empty list of children with no
      error. Silent, and discovered with a parent watching.
- [ ] **Decide the consent posture and write it down.** `pilot.waivers`,
      `pilot.medical_intake` and `pilot.emergency_contacts` exist with correct
      writers; **zero `.tsx` files reference any of them**. Build the capture
      screens or commit to paper — but say which, to the board and the insurer,
      because the seeded "Medical Clearance Status" rule currently tells your
      Safety Director the platform is verifying forms it cannot store.

### Needed for a usable first session

- [ ] **An athlete record cannot be corrected or deactivated.** `POST
      /api/pilot/athletes/update` works and has no UI caller. With 40
      hand-typed records a mistyped date of birth is a certainty, and today it
      is permanent without direct SQL. No offboarding path either.
- [ ] **Coach coverage.** The scheduler lists every athlete in the gym, but
      writes call `assertCoachAssignedToAthlete` and 403. A coach covering
      someone else's class picks the child in front of them and gets an error
      they cannot resolve. That is a coach stuck mid-session.
- [ ] **A pain report does not name the child on the coach's screen.** The
      write path is the best-engineered thing in the platform — it fails the
      request rather than storing a child's pain unannounced. The read path
      renders `SHADOW_ATHLETE_PAIN_REPORT_PENDING_REVIEW` with no name, no
      severity and no body location, in a mixed feed on a non-default tab.
- [ ] **Athlete check-out loses notes silently.** Session state is in-memory
      React state, never rehydrated from the server. A reload or a recycled tab
      makes the Check Out button vanish, the session row stays open forever,
      and the notes written for the coach are gone.
- [ ] **The coach review form cannot be completed.** Its first required field
      is a session ID minted in the *athlete's* browser and shown on no screen.
- [ ] **Per-athlete starting PIN.** Every account is created on `123456` with a
      guessable hand-typed sign-in ID. `must_change_pin` genuinely blocks reads
      and brute-force protection is real, but neither stops someone guessing
      `ath-001` + `123456` before the child's first sign-in. Creating 40
      accounts a week early widens that window 40-fold. Interim mitigation:
      create each account minutes before handing over the credentials.
- [ ] **Bulk athlete + guardian import.** `npm run seed:data` cannot start —
      four independent failures (no ts-node, no csv-parse, no root tsconfig for
      its `@/` import, no config file) — and even repaired it writes no logins
      and no guardians. Hand entry is 8 mandatory fields per athlete plus
      inventing and tracking 80 unique IDs: 1.5–2 hours for 40, and a coach
      must be fully provisioned first or the form will not submit.

### Honesty sweep before real families see it

- [ ] **Fabricated donations** in `RevenueFundingCenter.tsx` — "Community Donor
      A, $250" and "Sponsor Family B, $75" with no placeholder marker, so a
      treasurer reads $325 of giving that does not exist.
- [ ] **`scripts/data/` ships five invented minors** with real-looking dates of
      birth, in the exact folder the seed guide says to put the real roster in.
- [ ] **`/public` advertises seven programs and seven FAQ answers**, hardcoded.
      That is the page a Punxsutawney family lands on. Read it once and confirm
      it matches what PPBF actually runs; changing it needs a deploy today.
- [ ] **Two platform-owner routes return a full roster of minors' names**
      (`athlete-pin-directory`, `athlete-accounts`), contradicting the boundary
      `access.ts` states three files away.
- [ ] **Rabbit Hole seed content** — re-author the original Biomechanics lesson
      through the real path so the feature ships with something in it.
- [ ] **`drillsPersistence.pg.test.ts` runs nowhere.** No `test:migrations:*`
      script names it, so a 397-line Postgres suite never executes.

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

**Free for the other session** — none of the above, and none of these files:
`scripts/`, `.github/workflows/`, `apps/web/app/admin/page.tsx`,
`apps/web/app/admin/people/page.tsx`, `apps/web/components/CoachWorkspace.tsx`,
`apps/web/components/AthleteWorkspace.tsx`,
`apps/web/src/server/pilot/{staffProvisioning,access,drills,feedback,rabbitHoles}.ts`.

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
