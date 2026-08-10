# Work queue — shared between agent sessions

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

> **This file is the only queue.** It supersedes `docs/WORK_QUEUE_2026-08-01.md`,
> which was written by the other session against the same repository on the same
> day and merged as #157. Two queues of record is the exact failure this file
> opens by describing, so the older one has been deleted and everything in it
> that was still live has been folded in below — the SHADOW follow-ups, the
> runtime-verification items, the two owner decisions, and its checked-and-dropped
> list. Nothing was dropped silently.

---

## Which session can do what

The two sessions are not interchangeable, and the asymmetry decides ownership
rather than preference.

| | Remote (Claude Code on the web) | VS Code (local) |
|---|---|---|
| Writes code, tests, docs | yes | yes |
| Runs lint / typecheck / jest | yes | yes |
| Opens PRs | yes | yes |
| **Merges** | only when told | yes |
| **Deploys** | no — no credentials | **yes, and only VS Code** |
| **Applies migrations** | no | **yes** |
| Verifies behavior in a real browser | no | **yes** |
| Reads Azure state, logs, secrets | no | **yes** |

**Remote cannot observe runtime.** Every Remote finding is read from source.
Anything whose truth depends on what production actually does is VS Code work by
nature. Seeding real data from the share drives is likewise VS Code's — nothing
is mounted in the Remote container and it carries no database credentials.

---

## Open PRs

| PR | State | What it needs |
|---|---|---|
| [#150](https://github.com/PunxsyProminence/ppbf-platform/pull/150) — reviewer video access, `blocked` administrator | **draft, green, complete** | Undraft and merge. Called unfinished once from its draft flag alone; that was wrong. Oldest open branch, untouched since 04:35 |
| [#151](https://github.com/PunxsyProminence/ppbf-platform/pull/151) — Law 5 tap floor, design laws rewrite | ready | A human read on the *laws rewrite*. The tap fixes are verified in-browser and are a real accessibility defect (`Engage Medical Lock` at 38px) |
| [#153](https://github.com/PunxsyProminence/ppbf-platform/pull/153) — SHADOW surfaces/spec audit | draft, green | Docs only. Merge whenever; blocks nothing |
| [#155](https://github.com/PunxsyProminence/ppbf-platform/pull/155) — app on its own design system | draft | Unreviewed |
| [#161](https://github.com/PunxsyProminence/ppbf-platform/pull/161) — this branch | ready, green | 104 files, ~19.7k insertions, one green check, no human review |

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

- [x] **Backup and export.** ✅ Built on this branch: `.github/workflows/backup.yml`,
      `scripts/pilot-export-verify-dump.mjs` (a dump that verifies itself),
      a rebuilt `scripts/backup-export.ps1`, and an in-product roster export
      (`/admin/export` + `api/pilot/admin/export/roster`). The CSV serializer
      guards formula injection, always-quotes, emits a UTF-8 BOM, and sanitizes
      the filename against `Content-Disposition` header injection.
      **Still needs the deploy to be real** — see the owner block above.
- [x] **`/admin` writes 13 fabricated capability rows into the production
      database the first time it is opened.** ✅ Fixed by
      [#158](https://github.com/PunxsyProminence/ppbf-platform/pull/158), already
      in `main`. `mergeSeedCapabilities` no longer exists. The defect was worse
      than filed: the save effect fired on the hydration merge itself, so
      archiving a capability could not stick — the removal saved, and the next
      page load added it back and rewrote it, attributed to whoever opened the
      page.
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
- [x] **A pain report does not name the child on the coach's screen.** ✅ Fixed
      on this branch (`formulas/painReportAlert.ts`, `api/pilot/coach/pain-reports`).
      The write path was already the best-engineered thing in the platform — it
      fails the request rather than storing a child's pain unannounced. It was
      the read path that rendered `SHADOW_ATHLETE_PAIN_REPORT_PENDING_REVIEW`
      with no name, no severity and no body location.
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
- [x] **Postgres suites that ran nowhere.** ✅ Fixed. Two suites were unreachable
      by construction — `npm test` excludes `\.pg\.test\.ts$` by pattern, and
      `npm run test:migrations` is a hand-written chain that named neither:

      | Suite | Lines | Was |
      |---|---|---|
      | `drillsPersistence.pg.test.ts` | 397 | self-flagged here |
      | `guardianInviteLink.pg.test.ts` | 334 | **unflagged — nobody knew** |

      Both are now wired (`test:migrations:drills-persistence`,
      `test:migrations:guardian-invite-link`) and in the chain, which is 24
      suites. Both were run before wiring and pass — 8/8 and 9/9. They were
      never failing, only never executing, so this buys coverage rather than
      fixing a break. `guardianInviteLink` is the one that mattered: guardian
      integrity is in this PR's own title, and its only Postgres coverage had
      never run once.

**When adding a `.pg.test.ts`, adding the file is not enough.** It must also get
a `test:migrations:<name>` script *and* be appended to the `test:migrations`
chain, or it silently never runs and CI stays green.

### SHADOW follow-ups

- [ ] **Two sources of truth for the quick tier's completion budget.** The quick
      path sends the environment value (`resolveShadowMaxCompletionTokens()`,
      `api/pilot/shadow/chat/route.ts`), while `shadowRouter.ts` computes a
      `maxTokens` at seven sites that **only** `shadowHeavyBag.ts` ever reads. So
      every per-model budget in the registry is dead config on the quick path —
      including `gpt-5-mini`'s, which is below its own measured need and would
      matter the moment anything started reading it. Nothing is broken today:
      both environments send 8192. **Needs an owner call on which source wins**
      before either is touched, because the environment variable is also the
      lever you would want mid-incident.
- [ ] **SHADOW response validator** `[DESIGN]`. Two unsafe-advice patterns still
      pass `validateShadowResponse`. Deliberately unwritten: the two cases are
      grammatically indistinguishable from six benign coaching lines that were
      tested against, so a pattern-based fix over-filters legitimate coaching.
      The real path is a curated high-risk-practice list or a small classifier.
      Wants design, not a regex.

### Runtime verification — VS Code only

Not defects. **Claims nobody has checked**, and Remote structurally cannot.

- [ ] **Exercise `/admin/shadow` per role in a browser.** The 2026-08-01 audit
      states its own limit plainly: findings are from source. Its per-role access
      table (`organization_admin` 8/8 … `athlete` 1/8) is derived from
      `requireRole` lists, not observed. Worth an hour with real sessions — a
      coach at 5/8 is the case the audit reasoned hardest about and never saw.
- [ ] **Confirm the SHADOW runtime migration is live and the restore path works.**
      `evidence_tier` and `handoff` were added to the conversation-message table
      and the client falls back to `RESEARCH_NEEDED` for older rows. The migration
      was confirmed applied via workflow run history, **not by inspecting the
      schema**. Verify the columns exist, then reload a conversation older than
      the migration and confirm it restores without drawing a confidence badge it
      has no basis for.
- [ ] **Watch the Heavy Bag rate limiter after deploy.** #154 is merged but not
      live. Once it is, confirm a real Heavy Bag turn is charged, an admin is
      not, and a Quick Round is not. The tests assert this and were verified to
      fail without the fix, but they are unit tests against a mocked bucket.

### Owner decisions that stall whoever reaches them

- [ ] **Scout Reports — build or retitle.** `/shadow/scout` is linked and titled
      for Scout Reports. The generation pipeline (`generateScoutReport`) was
      deliberately deleted — only a tombstone remains at `shadowHeavyBag.ts` —
      and the spec's `GET /shadow/scout-reports` never existed. The page shows
      the generic job list. Neither option is a bug fix, which is why it has sat:
      retitling adds no function, building the pipeline is a feature. **It should
      not be picked by whichever session gets there first.**
- [ ] **Board seat data.** Seats route correctly; roughly thirty metric tiles
      read "Unavailable." Program & Safety Director and Secretary are the two
      seats whose data already exists (compliance escalations; the audit trail).
      **The Treasurer, whose duty is clearest, has the least data** — the platform
      collects nothing financial until the payment slot is built. Filling these is
      a project, not a queue item; listing which seats *could* be filled today is
      the useful first step.

### Also open, unowned

- [ ] Team-wide (athlete-less) videos cannot be published.
- [ ] Athlete goal category and progress are read by the UI and stored nowhere —
      confirmed: `pilot.goals` carries `title`, `target_date`, `metric`, `status`
      and no category or progress column
      (`infra/azure/pilot_slice_postgres.sql`).

---

## Checked and dropped — do not re-file these

Recorded so the next audit does not spend the same hours.

- **`/source-control` shows sample data.** True — `sampleStateLanes` and
  `sampleVersionHistory`, zero fetches, linked from six real surfaces. **But the
  page labels itself** `PLANNED | FRONT-END PLACEHOLDER | NOT YET AUTOMATED |
  BACKEND REQUIRED` in five places, including the surface header. It is honest
  about what it is, so it is not the `/audit` defect class. Whether to keep
  shipping a placeholder is a product call, not a truth-on-screen violation.
- **Board seats are unimplemented.** False. Fully built: `boardSeats.ts`,
  `api/pilot/board/seats/`, `admin/board-seats/`, `BoardSeatWorkspace.tsx`, a
  migration, and both unit and pg tests. What remains is the board seat *data*
  item above.
- **The orphaned `migrations/` DDL file needs wiring up.** Obsolete — the
  directory is gone, and the four undocumented tables it described were resolved
  by #160.
- **Cross-athlete goal takeover in `entities.ts`.** Was real; is fixed.
  `upsertGoal` no longer keys on `goal_id` alone — it updates
  `where organization_id = $1 and goal_id = $2`, closing the cross-tenant path.
  What remains is that reusing a `goal_id` with a different `athlete_id`
  reassigns the goal within one gym, which reads as intended behavior.

---

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
program copy), and the two platform-owner routes returning minors' names.

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
- **The other session's merge pass** — #154 (Heavy Bag capped per user), #157
  (its queue, now retired into this file), #158 (capability console), #159
  (compliance rules for gyms made through the app), #160 (**the database is
  buildable from nothing** — the four `*_chat_audit` tables that existed in an
  environment with no DDL anywhere in the repository are resolved).
  **All of it is in `main` and none of it is deployed.**
- SHADOW's quick tier no longer caps completion tokens below its own measured
  need (#81). The remaining question is which source owns that number — see the
  SHADOW follow-ups above.

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
