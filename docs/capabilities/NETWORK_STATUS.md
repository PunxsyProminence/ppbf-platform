# Capability network — status

What the capability audit found, and what has happened to each finding since.
Written for an agent picking up work who needs to know what is already done,
already in review, or deliberately parked — before spending an afternoon on
something that merged this morning.

**Status as of `origin/main` at `04dd116b`, 2026-08-17 23:30 UTC.** This file
carries the commit it was written against because it will go stale. Check
`git log` and the open PR list before trusting any row.

There is a visual version of this at
`https://claude.ai/code/artifact/adc821bb-d309-485a-9ff3-db3e830d4e24`. It is
private unless the owner shares it from the page's share menu, so **this file is
the source of truth** — do not wait on the link.

## How the audit was run, so you can judge it

Eight agents each mapped one cluster of capabilities into nodes (files, tables,
roles) and edges (what reads what). A synthesis pass merged them into one graph.
A third pass hunted only for cross-cluster links the cluster-by-cluster view
structurally could not see. Later passes required every finding to carry a
**verbatim quote** from the file, and had a separate agent re-read that file to
confirm, correct, or retract.

**Treat a "confirmed" finding as _the quote is real_, not _the reasoning is
sound_.** In the last run, fifteen findings produced zero retractions — and the
first high-severity one checked by hand still contained a false sub-claim. Open
the file yourself before acting on any row below.

---

## Live right now — two audits running, plus one thing that needs a merge

Written 2026-08-18. This section is the coordination surface between the
sessions currently working. If you are joining, read this first — it is the part
most likely to save you from redoing somebody's afternoon.

**This file is not on `main`.** It lives only on branch `docs/agent-handoff-briefs`
(PR #437, draft). Anyone told "coordinate through NETWORK_STATUS.md" who checks
out `main` finds nothing. Until #437 merges, the coordination instruction is
inert for every session that has not been handed the branch name explicitly.
That is the single highest-priority thing in this section, because everything
else here depends on people being able to read it.

### The two audits, and how they divide

They are not competitors and neither is redoing the other.

- **Full-spectrum audit** — `docs/PLATFORM_AUDIT_2026-08-17_FULL_SPECTRUM.md`,
  branch `claude/app-audit-ux-ui-report-78o4cm`, **PR #456** (draft). 13 sections:
  role-by-role UX, route census, capability status matrix, DB/infra, SHADOW,
  forms inventory, governance. Its section 13 already reconciles itself against
  the capability-network audit, checked open PRs before touching anything, and
  fixed three items this file had listed as unfixed (`/admin/escalations` blank
  Source cell, the login test that pinned nothing, the `coachIntelligence.ts`
  false invariant comment). Treat those three as **done, on that branch**.
- **Full-spectrum audit, second run** — `docs/audit-2026-08-18/`, branch
  `docs/full-spectrum-audit-2026-08-18`, pinned to `origin/main` at `04dd116b`.
  Thirteen enforcement-side passes, each writing its own file, indexed by
  `docs/audit-2026-08-18/README.md` with live status. It de-duplicates against
  both the above and this file before reporting anything.

If you are a third session: **do not start a third audit.** Read those two and
pick up something from "Unclaimed" below instead.

### Two sessions are working this audit. Here is the split.

**Do not both work the same pass.** The thirteen passes are indexed in
`docs/audit-2026-08-18/README.md` with live status. Six are claimed and running
on branch `docs/full-spectrum-audit-2026-08-18`; **three are deliberately left
for the other session**, chosen because they are self-contained, need no
coordination with the passes already running, and match work that session has
already done well.

| Pass | Scope | Who |
|---|---|---|
| 1 Authentication & session | Login, magic link, PIN, bootstrap key, session issuance and invalidation, `AUTH_CONTRACT.md` conformance | claimed |
| 2 Authorization & tenancy | done — findings below | claimed |
| 3 Minors' data & consent | done — findings below | claimed |
| 4 Safety gates | done — findings below | claimed |
| 5 API surface | Validation, `jsonError` prefix conformance, idempotency, rate limits, `hiddenNotFound` | claimed |
| 6 Data layer | 88 migrations vs. code, constraints, tenancy columns, policy hiding in DDL | claimed |
| **7 Frontend & design system** | **125 screens: design-system conformance, fabricated-data disclosure, refusal treatment under Law 7, dead ends** | **open — yours** |
| 8 SHADOW subsystem | Authority model as specified vs. built, event model, what drives the job processor | claimed |
| 9 Formulas & thresholds | Registry status vs. callers, provenance of every constant gating a child's training | claimed |
| 10 Tests & CI | What the suites actually pin; would any test fail if a safety gate were deleted | claimed |
| **11 Build, infra & secrets** | **Dockerfiles, deploy config, env handling, secret exposure, `staticwebapp.config.json`** | **open — yours** |
| 12 Docs vs. code | 425 docs: claims contradicted by source | claimed |
| **13 Cross-cutting synthesis** | **Defects visible only between passes — the class that broke `main` three times. Runs last, after every pass reports.** | **open — yours, and best done by whoever did not write the passes** |

Pass 13 is the one worth arguing for. A synthesis written by the session that
wrote the passes will inherit that session's blind spots; written by the other
one it is a genuine second reading. If you take nothing else, take that.

**The standard those passes are held to**, so a hand-off does not lower it:
every finding carries a verbatim quote with `path:line`; a second pass whose job
is to *refute* re-reads each one; "confirmed" means the quote is real, not that
the reasoning is sound; no gap-filling — an admitted hole beats a plausible
number; and nothing gets fixed from inside the audit if it narrows a role gate
or reverses an owner decision.

One result from running that standard, worth knowing before you start: a
severity has already been **raised** on review (safety-flags, HIGH → CRITICAL,
grounds recorded in the audit README) and this file's own prior claim about
training-hold scopes was **corrected as understated**. Both directions happen.
Verifying is not a formality here.

### Merge decision waiting — a child can be entered into a match under an active hold

Pass 4 of the second audit confirmed this on current `main`, and the fix already
exists and is already green.

`addCompetitionEntry` (`externalCompetition.ts`) and `addLeagueRosterEntry`
(`wrestlingLeague.ts`) check exactly two things — the competition or season
exists in the org, and the athlete exists in the org — and then insert. Neither
reads `pilot.training_holds`, medical status, `pilot.safety_gates`, the
clearance register, or any waiver. The athlete picker on
`operations/external-competition` lists every athlete with no badge and no
filter. So a child under an active `all_training` hold can be entered into an
external boxing competition or added to a league season roster with one
authenticated request.

**PR #452 fixes it, is not a draft, and its `validate` check is green.** No new
work is needed here and nobody should write a second fix. What is needed is a
merge, and per this repository's own rule only the session holding the merge
queue should perform it. If that is you: rebase onto current `main`, let CI
finish on the rebased head, then merge.

### Findings from pass 4 that are new — do not re-find these

Recorded here rather than left in the audit file, because the whole point of
this surface is that the next session does not rediscover them. Each was
confirmed against a verbatim quote; open the file before acting.

- **A hold does not cancel registrations that already exist.** The STOP rung is
  checked once at registration and never again; attendance check-in re-checks
  only that the registration exists. Placing a hold on a child today does
  nothing about the sessions they are already on the roster for. *Corrected on
  verification:* an earlier version of this bullet also said no coach-facing
  screen shows the hold at the door. **That was false** — `CoachWorkspace.tsx:895`
  fetches open escalations and renders `training_hold` cards naming the athlete,
  and `/coach/progression-intelligence` is a second hold reader. A coach is not
  blind to it. Downgraded HIGH → MEDIUM.
- **`/admin/safety-review` double-counts** one compliance violation twice and
  every hold twice in its headline number. This is the *second* instance of the
  collision class that was caught pre-merge on the Morning Read digest — which
  makes it a pattern, not an accident. Before adding a reader of a shared
  register, enumerate every writer.
- **`raiseConductConcern` bypasses the incident-report severity floor** and the
  30-second dedup added by #433, by filing `source_type: 'incident'` directly.
  The same route has no athlete-scope check.
- **All three hold scopes overstate enforcement**, not only `conditioning_only`
  as this file previously recorded. That row was understated and is corrected
  here rather than quietly tightened.
- **`readinessMath.ts` has zero callers** — already known — but the *mechanism*
  is new: the stored readiness score is taken raw from the request body, so the
  clamp and the delta-RPE lock exist in a module nothing calls.
- **`assertShadowAuthority` is inert at two of its three call sites** — the
  medical and waiver intake writes, which are the two that matter. *Corrected on
  verification:* this file previously said it could not deny at **any** of the
  three. That headline was falsified. `review-action/route.ts:86-88` computes
  `lowRisk: action !== 'promote'` rather than asserting it, so `action:'promote'`
  with `automation_mode:'automatic'` genuinely denies. The substance survives,
  the "anywhere" did not.
- **That one working denial branch is evadable.** `automation_mode` is
  unvalidated at two of three sites and carries no column CHECK, so sending
  `"Automatic"` instead of `"automatic"` slips past it. Found by the pass
  verifying the finding above, not by the pass that made it.
- **A covering coach can lift a `medical` hold.** Coach Coverage was already
  recorded here as granting youth-contact access with no clearance check; the
  consequence not previously drawn is that the same assertion admits coverage
  holders to the hold-*lift* path.
- **`TrainingHoldScope` is defined five times** across the codebase, feeding
  three exhaustive maps, one of which has no fallback. This is the same shape as
  the `Record<SuggestionRule, …>` drift that broke `main` three times.

### Findings from pass 2 (authorization) — a second thing needing a decision today

**`/api/pilot/safety-flags` has no athlete-scope check** — not at the route, and
not inside `resolveSafetyFlag`, which scopes its `update` by `organization_id`
and `flag_id` alone. Any coach can therefore read the whole gym's open safety
queue (the codes include `medical_clearance_missing` and
`concussion_rest_period`), raise a flag against any child, and **bypass** an open
flag on a child they hold no standing on. Clearing another child's concussion
rest flag is the thing this platform exists to prevent.

The sibling routes refuse exactly this, which is what makes it a miss rather
than a trade-off: `training-holds` carries the comment "no org-wide hold roster"
and calls `assertCoachAssignedToAthlete` at three separate points; `escalations`
scopes coaches to their own athletes. Real mitigations, for the record: an
`external_rule` flag cannot be bypassed (database-constraint backed), and every
resolution writes an audit event with the actor's id and role — but `flag_class`
is set by whoever raises the flag rather than derived from the flag code, so the
class that protects the worst codes is not guaranteed to be on them.

**A coach can overwrite another family's guardian record.**
`POST /api/pilot/intake/domain-upsert` with `entity_type: 'guardian_link'` gates
the athlete side correctly and then passes a raw body `parent_id` *and*
`account_id` into `upsertGuardian`, whose `on conflict … do update` **rewrites**
the named record: phone and email are nulled when omitted (that is the emergency
channel for a minor), and repointing `account_id` hands a chosen account the
guardian role over every child that record carries — **including siblings the
coach has no standing on**.

This matters for how the parked `parent_id` decision gets framed. Both prior
audits describe this route as a *linking* problem. It is also a *rewriting*
problem, and the rewriting half can be fixed without narrowing anything a
legitimate intake edit needs — so **it should not inherit the parked status of
the linking half.** That is the one substantive change to how this file
previously recorded the guardian-link question.

Two smaller ones worth not rediscovering: `multidiscipline` and
`competence-cohorts` use an exact-match `requireRole(principal, ['coach','admin'])`,
so every provisioned `organization_admin` gets a 403 on a child's
grappling-exposure history — fail-closed, but it will read as a broken page
during a safeguarding investigation, and the tests miss it because they drive
the legacy `'admin'` value. And `DELETE /api/pilot/achievements/mentorships`
authorizes only the mentor side, *after* the `UPDATE` has already committed, so
an unauthorized coach ends the pairing and then receives the 403.

**The reassuring result, which belongs here too.** Pass 2 was sent to find out
whether the "one side checked, the other not" shape behind the `parent_id`
finding repeats elsewhere. It traced roughly 120 two-party link inserts and
found **all but two validate both ends**, several with comments explaining why.
`addCompetitionEntry`, `addLeagueRosterEntry`, `assignBoardSeat`,
`grantCoachCoverage`, the mentorship `POST` and the scheduler's coaching-request
approval all check both sides. So that shape is the exception here, not the
house pattern — do not go hunting it as a systemic problem.

**What pass 2 did not do**, because it matters for how much to lean on it: of
228 routes it classified all of them mechanically, deep-read 31, inspected 22
more at handler level, and **did not open the remaining 175**. No code was run.
Reproduce findings against a live coach session before acting on any severity.

### Findings from pass 3 (minors' data and consent) — also do not re-find these

Pass 3 found **no live exposure** — nothing here means a child is exposed right
now, and it is worth saying that plainly rather than leaving it implied. What it
found is a set of gaps that need a deliberate act, a race window, or an unlikely
sequence to bite. That is a materially different thing from the pass 4 CRITICAL,
which needs one authenticated request.

- **Film Study checks guardian consent at enqueue and never again**, and the
  withdrawal sweep cancels no running job — `cancelJobForActor`'s only caller is
  a user-driven DELETE. There are zero consent references anywhere in the job
  path. That gap is real and worth closing.

  *Corrected on verification, and this file previously told you worse than the
  truth.* An earlier version said the executor "re-validates only the actor's
  role" and that a guardian could withdraw consent and have frames sent
  afterwards. Both overstated. `shadowJobProcessor.ts:172-178` re-loads the actor
  from the live database and re-runs `assertActorCanAccessAthlete` on the subject
  athlete. And the queue *is* driven — `instrumentation.ts:31-39` starts an
  in-process drain loop and the production deploy workflow sets
  `PPBF_SHADOW_WORKER_ENABLED=true` — so the race window is about **30 seconds**
  (`shadowJobWorker.ts:20`), capped at 24h by `expires_at`, not open-ended.
  **HIGH → MEDIUM.** Fix it, but do not treat it as an emergency.
- **Consent scope is enforced by nothing, and defaults to permissive.** This
  file already recorded `covers_video` and `public_use_allowed` as a documented
  MVP cut. What is new: `covers_video` defaults `true` in three places,
  *including on every non-media waiver row*, and the guardian-facing UI presents
  these as controls. Collecting a switch that does nothing is one problem;
  defaulting it to "yes" is another.
- **A coach can silently overwrite an existing guardian's `pilot.parents`
  binding**, severing a real parent from their own child's consent-withdrawal
  path. This is the same "one side checked, the other not" shape as the known
  `parent_id` finding, on the same route. **Both are owner decisions — they
  narrow a role gate coaches use daily, and they should be decided together
  rather than one at a time.** Do not implement either.
- **60-minute unaudited SAS bearer URLs to minors' video, minted in bulk.**
  Anyone holding the URL has the video for an hour, and nothing records who
  minted or used it.
- **A hard-deleted athlete record silently reclassifies a surviving account from
  minor to staff**, releasing the portrait to every coach and admin. Whether
  this has already happened depends on whether the retention purge has ever run
  in `APPLY` mode, which needs Actions run history nobody in these sessions can
  see.
- **`DATA_RETENTION.md` promises deletion that no code performs.** Per-category
  deletion of photos, videos, medical records and waivers is documented; no blob
  byte is ever deleted. A second, unguarded copy of the destructive purge exists
  with zero callers.

**One of the two questions pass 3 could not settle is now answered, from the
repository itself.** What drives the SHADOW job queue: `instrumentation.ts:31-39`
starts an in-process drain loop, enabled in production by
`PPBF_SHADOW_WORKER_ENABLED=true` in the deploy workflow. Nobody needed
production access — it was in the tree the whole time, and this audit had
promoted it to a headline open question. Recorded as a miss, not quietly closed.

**Still unestablished:** whether the retention purge has ever run in `APPLY`
mode. That decides whether the hard-delete reclassification is theoretical or
has already happened, and it needs Actions run history.

**Two new findings came from the pass that was verifying pass 3, not from pass 3:**

- **`profile/roster` does not filter `athletes.deleted_at`.** A withdrawn child
  stays on the live coach roster — name, date of birth, portrait — for the whole
  retention window.
- **The unauthenticated gym wall was cleared as sound, and is not.** Pass 3 filed
  it under "checked and found sound" because `wall_display_full_name` has no
  writer. But `waiver_type` carries no database constraint
  (`pilot_slice_postgres.sql:413`) and `domain-upsert` writes it verbatim from
  the request body, so a coach can mint exactly that row; `signed_by_role` is
  self-declared text, defeating `wallDisplay.ts`'s guardian-signer check. The
  only real brake is an unset environment flag. **A false "sound" is more
  dangerous than a false finding, because nobody re-reads it** — treat every
  "checked and found sound" entry in these audits accordingly.

### Verification is running, and it is moving things — in both directions

Every finding here is re-read by a pass whose job is to **refute** it. Both have now reported. On pass 4's ten findings: **zero retracted, two
downgraded, one narrowed, one corrected — and four of the ten carried a factual
error in their supporting text.** On pass 3's nine: **zero retracted, four
downgraded**, with every re-extracted quote character-exact at its cited line —
so nothing was fabricated; what broke was reasoning and reach.

Two of those errors had already been written into this file and are corrected
above rather than quietly edited: a coach *is* shown training holds, and
`assertShadowAuthority` is inert at two sites rather than all three. If you read
this file before now, those are the two rows that changed.

The refutation pass also found two findings the pass it was checking had missed
entirely. That is the argument for running one at all, and it is why **a
"confirmed" row here means the quote is real, not that the reasoning is sound.**
Open the file before acting on any of it.

The escalation register is now fully enumerated — eight writer call paths across
seven source types, six readers, and one declared source type
(`safety_gate_evaluation`) with no writer at all. That table is in
`docs/audit-2026-08-18/PASS-04-safety-gates.md`; consult it before adding either
a writer or a reader.

---

## Closed — 12, merged

| Gap | Closed by |
|---|---|
| Film Study analysis ran with no guardian consent check on the footage | #438 |
| A blocked/infected video scan never filed a safety escalation | #439 |
| Competition losses stranded on their own page, never reaching progression | #442 |
| Transfer failures never became suggested progression gaps | #441 |
| Performance Analytics forbade athlete/parent, so gaps arrived unjustified | #446 |
| Research source-submission lifecycle fully built with no UI to reach it | #445 |
| No withdrawal action for competition entries or league rosters | #443 |
| Session-run link accepted by the API but unreachable from the UI | #444 |
| Volunteer roster and login access were permanently disconnected records | #448 |
| A cross-org privilege flag read at login with no way to set it | #449 |
| Shadow-job list authorization ran one query per row | #431 |
| Incident reports could be double-filed by a retry | #433 |

## In review — query GitHub, not this file

At the time of writing, eight of the findings below were addressed by open pull
requests. **Their live state is not copied here on purpose.**
`docs/current/ACTIVE_WORK.md` already rules that "open PR state belongs in
GitHub and should be queried live rather than copied here", and it is right: a
table of PR numbers in a markdown file is stale the moment somebody merges, and
a *stale* list of which files are spoken for is worse than no list, because it
reads as authoritative.

An earlier version of this file carried that table. It was a mistake, and
removing it is the correction.

**To find what is currently in flight and which files it owns:**

```
gh pr list --state open        # or the GitHub UI
git diff --name-only origin/main...origin/<branch>
```

Findings that had a PR open when this was written: the competition-entry
gates, the Morning Read digest's blind spot, rejected Film Study proposals as
evidence, the three child-data fetch races, portrait review, the revenue
centre's fabricated figures, the gate inventory, and lapsed-membership
flagging. Search open PRs by those descriptions rather than by a number that
may already have merged.

## Found after the map — 5, none fixed

**Guardian links accept an unvalidated `parent_id` — HIGH.** The athlete side is
gated by `assertActorCanAccessAthlete`; the parent side is not checked at all. A
coach with legitimate standing on one athlete can attach *any* guardian in the
organisation to them, and that guardian's account then reads the child's
training holds, messages and safety surfaces. Cross-org is blocked;
cross-family within an org is not. The fix narrows a role gate coaches may use
daily — **needs an owner decision, do not just implement it.**

**`/admin/escalations` renders a blank Source cell** for `video_scan`,
`compliance_violation` and `incident` — a stale local copy of
`SafetyEscalationSourceType`, on the page whose own header says a red flag
"lands here, and only here". Both new filers merged today. Clean, small fix.

**93 Postgres test suites share a racy teardown.** `kill('SIGTERM')` is Postgres
*smart* shutdown, which waits for clients to disconnect; a lingering connection
means it never exits, a 15-second bail-out resolves anyway, and the data
directory is deleted while the server is still writing — `ENOTEMPTY` on
`pg_wal`. `test:migrations` runs ~95 of these sequentially, so every PR gets ~95
chances to fail for no reason. Fix is `SIGINT` (fast shutdown) plus
`fs.rm(..., { maxRetries, retryDelay })`, which retries exactly this errno.

**A comment claims an invariant the code does not hold.** `coachIntelligence.ts`
says shared constants make two attendance rules "never drift apart"; they use
different comparison operators and disagree on the exact-half case.

**A test that pins nothing.** The login route's "a durable store outage does not
lock anyone out" test never simulates an outage — it is byte-for-byte the happy
path.

## Still open from the map — 10

### Blocked on something real — 4

- **The Act 153 / SafeSport clearance register has zero callers.** Complete and
  migrated; wiring it is blocked on establishing the real clearance vocabulary,
  because its four seeded types are hand-written placeholders. See
  `HANDOFF_RESEARCH.md` item 1.
- **Coach Coverage grants youth-contact access with no clearance check** — it
  verifies only that the covering coach is an active account. Blocked on the
  register above.
- **Guardian consent scope is collected and never enforced.** `covers_video` and
  `public_use_allowed` are recorded and read by no gate. Documented as a
  deliberate MVP cut — but the UI collects the switches as though they were
  load-bearing, and `covers_video` defaults to `true`.
- **`conditioning_only` holds enforce nothing.** By design, scoped holds mean
  "training continues at reduced scope" — but `contact_only` got an enforcement
  path and `conditioning_only` got none, while `/parent/safety` tells a guardian
  "Conditioning is paused right now".

### Parked by owner decision — 3

Do not "fix" these. Each is a recorded decision, and reopening one without the
owner is how a parked question becomes an argument.

- Board governance has no path to grants, volunteers, or competition activity.
- Wrestling league has no match results, so the "a loss requires a lesson note"
  rule its sibling enforces has nothing to attach to.
- `LEGACY-READINESS` stays unwired — registered `experimental_unsupported`,
  "must not clear, restrict, or prescribe training". Sent to research framed as
  **validate or retire**, never "wire it in".

### Unclaimed — 3

The most useful place to start if you are looking for work nobody owns.

- Scenario Simulation and Source Governance are islands with zero data edges,
  whose own copy claims hand-offs that no code implements.
- Knowledge Graph's "Pattern" and "Finding" columns are permanently empty —
  nothing emits an event matching those filters.
- Volunteer records carry a free-text `background_check_status` an admin types
  by hand, competing with the structured clearance register.

---

## Two things this exercise taught, worth knowing before you add a PR

**Parallel delivery produced its own defect class.** Twenty-four PRs merged in a
day, and the two worst problems were in none of them individually:

1. `RULE_JUSTIFICATION_FIELDS` is typed `Record<SuggestionRule, …>` — exhaustive
   over a union. Three PRs added a union member without adding the entry. Each
   was green alone; the break existed only in the merge. Since `typecheck` runs
   before any test, **every open PR went red for a defect in none of them** and
   deploys blocked. Three times, on the same type.
2. Two capabilities independently began auto-filing into a register a third
   capability read, so one incident surfaced twice on one screen. The two
   collisions needed *different* fixes, because one register's coverage was
   wider than the thing it duplicated and the other's was narrower.

Neither is visible to per-PR review or per-PR CI. Before adding a reader of a
shared register, ask **who else writes it**; before adding a member to a union,
grep every exhaustive consumer.

The durable mitigation for (1) is a repository setting — "require branches to be
up to date before merging" — not code. It is **not enabled**; raise it rather
than assuming somebody has.

Until it is, the mitigation available today is **serial merging.**
`docs/current/ACTIVE_WORK.md` authorizes an "ordinary bounded PR" to be "merged
by the authoring session once every required check passes" — and that
authorization, read literally by several sessions at once, is precisely how
`main` broke. Each session was obeying it, each PR was green, and the break
lived only in the merge. The authorization is not wrong; what it lacks is an
ordering. So when more than one session is landing work in the same window,
have **one** session own the merge queue: rebase onto current `main`, let CI
finish on the rebased head, merge, then take the next one. Serial merging is
slower by minutes and it is the difference between three broken-`main` incidents
in a day and none. A session that merges its own PR while another PR is in
flight is not doing anything forbidden — it is just skipping the only check
that would have caught this class.

**Collision control lives in `AI_COLLABORATION.md`.** Check current `main`,
`docs/current/ACTIVE_WORK.md`, and the open PR list before editing. The open PR
list is what tells you which files are currently spoken for — this file does not
try to, for the reason given above.

---

## If you are another agent working alongside this one

This file is the shared surface, and it is meant to be written to, not just
read. There is no direct channel between agent sessions — no messaging, and a
published artifact is private to whoever published it — so the repository is
the only place two of us can actually coordinate. That makes this file the
handoff, and a stale one costs somebody real work.

**Claim by lane, and open the PR early.** Coordination here is by *surface*,
not by role — `docs/current/ACTIVE_WORK.md` defines the standing lanes (product
build, SHADOW/statistics, design/visuals, ops/deploy) and the rule that a
session picks one lane and "does not drive-by fix another lane's surface". Pick
a lane, open a draft PR early so the claim is visible in GitHub where it stays
current, and check open PRs for collisions before starting. Do not record your
claim in this file — see the note above about why copied PR state is worse than
none.

Note that **roles are not lanes.** A researcher, a wirer and an auditor can all
collide on one file, because a lane is a territory and a role is a job. This
repository already tried role-based sequencing (Architect → Implementer →
Reviewer → QA) and retired it — `docs/MULTI_AI_EXECUTION_PLAN.md` is marked
SUPERSEDED and says not to reconstruct it, because two overlapping systems
forced agents to reconcile role rules against lane rules. Staff by role if that
suits the humans; coordinate by lane regardless.

**Record the shape of what you found, not just that you fixed it.** Two of the
worst problems here were invisible to per-PR review — an exhaustive `Record`
three PRs each extended, and capabilities that began writing to a register a
third one read. Those are only catchable if the previous agent wrote down the
*shape*. If you find a third such class, put it in the "two things this
exercise taught" section above, with the question a future PR should ask.

**Move rows rather than deleting them.** When your PR merges, add its row to
"closed" with its number and remove it from wherever it sat before. When a
finding turns out to be wrong, move it out and say so — a retraction recorded is
more useful than a row that quietly disappears, because the next agent would
otherwise re-find it.

**Correct this file when it is wrong about you.** If a row misdescribes your
work, or claims something is parked that the owner has since unparked, fix it
here in the same PR. Two of this document's own findings were overstated when
first written and were corrected in place rather than quietly tightened; that
is the standard, not an exception.

**What needs a human, not a commit.** Anything that narrows a role gate,
reverses a recorded owner decision, or changes what a guardian or coach is
allowed to see. Those are listed as "needs a decision" above deliberately —
implementing one because it looks like a bug is how a settled question becomes
an argument.
