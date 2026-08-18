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

## In review — 8

Open pull requests. **Not fixed until merged.** If you are about to touch one of
these files, read the PR first.

| What | PR | Files to avoid |
|---|---|---|
| Competition entry: coach-standing, training-hold and travel-waiver gates | #452 | `competitionSafetyGates.ts`, `wrestlingLeague.ts`, `externalCompetition.ts`, `trainingHolds.ts`, `waiverCompliance.ts` |
| Morning Read digest was blind to both safety registers | #450 | `coachIntelligence.ts`, `compliance.ts`, `app/coach/intelligence` |
| A rejected Film Study proposal was citable as evidence | #459 | `interventionEvidence.ts` |
| Three surfaces could render one child's record under another's name | #460 | `coach/progression-intelligence`, `ParentHub.tsx`, `parent/progression-visibility` |
| Portrait review approved a child's photo without displaying it | #461 | `app/admin/portrait-review` |
| Revenue centre showed fabricated figures as the books | #462 | `RevenueFundingCenter.tsx` |
| `GATES.md` + seven capability gate READMEs | #463 | `docs/capabilities/GATES.md` |
| Lapsed membership as a non-blocking flag at registration | branch `feat/membership-status-registration-flag` | `scheduler/route.ts`, `programMemberships.ts` |

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

**Collision control lives in `AI_COLLABORATION.md`.** Check current `main`,
`docs/current/ACTIVE_WORK.md`, and the open PR list before editing. The "in
review" table above lists the files currently spoken for.
