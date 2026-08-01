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

Ordered by what the pilot needs first.

- [ ] **Bulk athlete + guardian import.** A roster arrives as a spreadsheet.
      One-at-a-time creation is the only path today. Needs: a CSV shape, a
      dry-run that reports what it *would* create, guardian linking, and an
      idempotent re-run. This is the difference between an evening of data
      entry and a coffee.
- [ ] **An export / "give me my data back" path.** A family in the pilot can
      ask for their child's records, and there is no answer today. Also the
      only real backup story.
- [ ] **Consent and waiver capture.** Nothing records that a guardian agreed to
      anything, or to what. For a coaches-and-their-own-kids pilot this is a
      conversation rather than a form, but the record still has to exist.
- [ ] **Demo-data sweep before real families see it.** Owner's standing
      instruction: fake data goes before real athletes. Much was removed
      already; the floor-readiness trace produces the remaining inventory.
- [ ] **Rabbit Hole seed content.** The mechanism ships empty by design. The
      original hardcoded lesson (Biomechanics of Kinetic Force Transfer) should
      be re-authored through the real path so the feature has something in it.
- [ ] **`drillsPersistence.pg.test.ts` runs nowhere.** No `test:migrations:*`
      script names it, so a 397-line Postgres suite never executes. Register it
      or fold it into `drills.pg.test.ts`.
- [ ] **Athlete PIN sign-in on a shared gym device.** Verify how a session ends
      so the next athlete is not inside the previous athlete's account. This is
      a floor reality, not a theoretical one.

---

## In progress — claimed

| Item | Session | Branch |
|---|---|---|
| Knowledge + feedback (drills, Rabbit Holes, feedback box) | this session | `feature/knowledge-and-feedback` |

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
