# Evidence applicability

**A green result is evidence only for the property and the execution path it
actually exercised.**

That sentence is the whole contract. Everything below is how to tell whether a
particular green result covers a particular claim, and how to write the answer
down so a reviewer can disagree with it.

`AGENT_KERNEL.md` already requires that a claim be no wider than the check that
ran, and `docs/AI_CONTRIBUTOR_GUARDRAILS.md` §1 already requires that a claim
have a check at all. This file answers the question neither of them asks: the
check ran, the claim is stated at exactly the width of the check, and the check
still could not have detected the defect. That is not a reporting failure and
not a missing test. It is the wrong instrument, and it has now happened enough
times here to be a class rather than a run of bad luck.

## What this is not

Four adjacent checks exist and this one replaces none of them. They stack:

| question | answered by |
|---|---|
| Did the suite that covers this actually run? | `scripts/ci-classify-paths.mjs`, `scripts/suiteAttendanceReporter.js`, `src/testing/safetyCriticalSuites.json` |
| Does the test fail when the behaviour it names is broken? | mutation: watch it go red, then restore |
| **Does this instrument measure THIS claim?** | **this file** |
| How strong is the instrument? | the evidence ladder below |
| Was deployed state observed, or inferred from source? | `docs/AI_DELIVERY_PIPELINE.md`, `docs/current/PRODUCTION_STATE.json` |

The first two can both pass while the third fails. In PR #755 four suites ran,
61 cases were green, and three of them were incapable of failing for the reason
their own titles gave. Attendance was fine. Effectiveness was the thing being
measured. Applicability was the thing that was wrong.

## The record

For every **material** claim -- a claim about authorization, safety, privacy,
safeguarding, data integrity, a race, a deployment, or anything a reader would
act on -- write these ten lines. Not for every sentence in a pull request.

- **CLAIM** — the sentence you are asking a reader to believe.
- **PROPERTY** — the state or behaviour that has to be true for the claim to
  hold. If the claim and the property read identically, one of them is too
  vague.
- **INSTRUMENT** — the test, query, workflow run, browser session, log,
  mutation, probe or human observation that measured it.
- **SUBJECT** — the exact commit (full 40 characters), branch, environment,
  database, revision, run id or artifact that was measured.
- **EXECUTION PATH** — the production function, route, runner, component or
  composition the instrument actually executed. If the answer is "none, it read
  literals", the record has already found its own defect.
- **POSITIVE CONTROL** — the case proving the legitimate behaviour still
  succeeds. A refusal test passes for free against a surface that refuses
  everything.
- **NEGATIVE CONTROL** — the mutation, adversarial input or broken-state case
  under which the evidence changes. Watched to fail, then restored.
- **EVIDENCE LEVEL** — one token from the ladder below.
- **BLIND SPOTS** — what this evidence does not establish. This is the field
  that gets left blank, and it is the one a reviewer reads first.
- **VERDICT** — `APPLICABLE`, `PARTIAL`, `UNVERIFIED` or `RETRACTED`.

If you cannot establish a claim with an applicable instrument, the verdict is
`UNVERIFIED`. Not "likely", not "should", not "expected", not "CI will
probably cover it". `UNVERIFIED` is a complete and respectable answer; a hedge
is not.

### The ladder

`NONE` · `CODE_READ` · `TYPECHECK` · `UNIT` · `INTEGRATION` · `REAL_DATABASE` ·
`BROWSER` · `LOCAL_RUNTIME` · `STAGING` · `PRODUCTION` · `HUMAN_OBSERVATION`

Weakest first. Each rung names an **instrument**, not a degree of confidence,
and **no claim inherits a level stronger than the instrument that produced
it**. A run against staging is evidence at that level for what the run
executed, and evidence of nothing at all for the rest of the release.

The last rung sits where it does for one reason: no AI lane in this project can
load a deployed page (`docs/CHATGPT-AUDIT-LANE.md`, and the kernel's known
gap). Every visual claim here is unverified by construction until a person
opens the page, and must be written that way without being asked.

`LOCAL_RUNTIME` covers a real execution somewhere that is not a deployed
environment: a container, a sandbox, or a **GitHub Actions runner**. In this
repository that last one carries most of the runtime evidence there is -- a
migration runner, a gate, the path classifier and a deploy all report from a
workflow run rather than from anyone's laptop.

The three runtime rungs -- `LOCAL_RUNTIME`, `STAGING` and `PRODUCTION` -- mean
nothing without the state they ran against, so a record at those levels must
name the environment in SUBJECT. That is the field Case A below was missing.

### Choosing the instrument

**Do not require the highest level.** The instrument has to fit the claim, and
over-specifying is its own failure -- a browser test for a question a unit test
answers completely is slower, flakier and no more applicable.

| the claim is about | the instrument that fits |
|---|---|
| a constant, a union, a registration list, a file's existence | source-structural test; `CODE_READ` or `UNIT` is complete |
| a type-level guarantee (exhaustive `Record`, discriminated union) | `npm run typecheck` — **jest does not typecheck**, so no jest suite proves this |
| a route's authorization answer | call the route; assert the status and that the read did not run |
| a SQL predicate, a constraint, a migration's effect | `.pg.test.ts` against real Postgres, with the migration applied first |
| a guarantee that depends on two components interleaving | drive both, concurrently, through the shipped functions |
| what a deployed environment contains | a run against that environment, read from the run's own output |
| what a page looks like | a person opening it |

**Mutation is not always required and saying so is not a loophole.** A
production version read has nothing to mutate. A source-only structural claim
is answerable outright. A visual acceptance claim needs eyes, not a mutant. But
where the claim is that something is *prevented* -- a gate, a lock, a
constraint, a refusal -- the negative control is the evidence, because a test
that has never been watched to fail is a hypothesis. Where mutation does not
fit, write **why** on the NEGATIVE CONTROL line. A bare "none" is not an
answer; "none — a version read has no mutation to make" is.

## Four shapes this project has actually produced

Short, because a standard nobody finishes reading enforces nothing.

**Wrong execution order — the run happened before the state existed.**
Merged as `6a17e2ea` (#821). A staging `all` migration run was cited as proof
that a repaired `athlete-check-ins` readiness gate worked against a widened
table. In that loop `athlete-check-ins` runs at position 86 and
`athlete-check-in-measures`, which does the widening, at 113. The gate was
evaluated before the table was widened, so **the old broken gate would have
passed the same run**. A second cited run never invoked the gate at all. Only a
later targeted run against an already-widened staging database exercised the
change. Real run, real green, wrong instrument.
→ *EXECUTION PATH is the field that catches this.*

**Proxy assertion — the literals agreed with each other.**
PR #755. A case titled "accounts for every role in the vocabulary, so a new one
cannot default in" asserted `[...ADMITTED, ...DENIED].sort()` equalled
`ALL_ROLES` — three literals in one test file, agreeing by construction.
Adding a tenth role to the `PilotRole` union left 4 suites and 61 tests green.
A sibling case titled "no route keeps a private reader list beside the shared
one" banned one identifier, so renaming the list defeated it. A third asserted
`expect(ADMITTED_ROLES).toContain('platform_owner')` under a title that was a
claim about the route, and never called the route.
→ *EXECUTION PATH again: "reads three arrays in this file" is not a path.*

**Composition gap — both halves covered, the join not.**
PR #785. `publication.ts` and `guardianConsent.ts` each carried the sentence
"in no interleaving does a publish survive a withdrawal unsuppressed". The
consent gate was proven exhaustively against real Postgres. The withdrawal
sweep had tests. Downstream consumers had tests with the gate **mocked**.
Nothing executed the pair together, and the failure it would have missed is a
video of a minor staying published after their guardian withdrew consent. The
repair was a real-Postgres concurrency case driven through the shipped
functions, plus a negative control asserting the sweep was observed *blocked* —
without which the case passes for the wrong reason on a sweep that simply ran
past. PR #776 is the same shape one layer up: `assertActorCanAccessAthlete` was
a bare `jest.fn()` for a whole route file, so 47 tests ran with the guardian
gate stubbed open.
→ *A mocked gate is useful for testing downstream. It is not evidence that the
gate works.*

**Wrong UI target — the right word in the wrong place.**
PR #814. The assertion was that `Unavailable` appeared somewhere on the coach
screen. It already appeared elsewhere, so the case stayed green while the
target tiles still rendered a confident `0` over a queue nobody could read. The
repair walks from a named label to its own tile and asserts that tile's value,
and adds the opposite case — a real count still renders as a number, including
a real zero — because a panel printing `Unavailable` unconditionally would
satisfy the first test while telling a coach nothing.
→ *Scope the assertion to the relationship being claimed, and pair it with its
positive control.*

## Claims about authorization, safeguarding, privacy and safety

This contract sets no policy. `docs/current/OWNER_DECISIONS.md` holds the
decisions; `AUTH_CONTRACT.md` and `ORGANIZATION_ROLE_MODEL.md` hold the
vocabulary; nothing here invents a role, a consent rule or a medical boundary.

What it does add is a question that must be asked out loud whenever a pull
request claims one of those properties:

> **Did the instrument execute the actual enforcement boundary, or was that
> boundary mocked, bypassed, inferred, or tested only in isolation?**

If the boundary was mocked, the evidence is about the caller, not the gate, and
EXECUTION PATH must say so. If the boundary was tested only in isolation, the
composition is unproven and the verdict is `PARTIAL` at best. This is a
reporting requirement, not an extra approval step: the answer may perfectly
well be "mocked, deliberately, and the gate itself is covered by
`softDeletedAthleteAccess.pg.test.ts`" — which is what #776 wrote.

## Deterministic and agentic halves

`apps/web/scripts/check-evidence-applicability.mjs` grades **form**: the fields
are present, the level is a real level, a staging claim names an environment, a
cited commit is a full SHA, a waiver carries its reason, a verdict is not a
hedge. It runs in CI on the pull request body via
`.github/workflows/migration-declaration.yml` -- the workflow that already
grades the other declaration a pull request body has to get right -- and
locally as `node apps/web/scripts/check-evidence-applicability.mjs <file>`.
There is deliberately no npm script for it: `apps/web/package.json` carries
per-migration registrations and is open in nine branches at the time of
writing, and a convenience alias is not worth a conflict in that file.

It is **opt-in**: a body carrying no record passes. Requiring a record on every
pull request would red every branch open today for a reason unrelated to its
own evidence, and would turn a filled-in form into the thing CI blesses.

**A structurally complete record is not a verified claim, and this checker
never says it is.** These questions have no deterministic answer and belong to
the reviewer:

- does the instrument genuinely measure the claim, or a proxy for it?
- could this have gone green for another reason?
- do independently tested components prove the composed guarantee?
- is the level strong enough for the conclusion being drawn?
- does an omitted limitation change the conclusion?

Do not build a score. Do not write a regex that pretends to grade prose. A
number would make the judgement look answered, and the judgement is the point.

## Two worked records

From PR #785, written after the fact in this form. Both are structurally valid,
and `evidenceApplicabilityContract.test.ts` grades them here so the contract and
its checker cannot drift apart.

### EVIDENCE APPLICABILITY — a publish in flight loses to a committed withdrawal

- CLAIM: no interleaving lets a media publish survive a guardian's consent withdrawal unsuppressed
- PROPERTY: with the publish holding FOR SHARE on pilot.guardian_links and the sweep holding FOR UPDATE, a publish racing a withdrawal ends retracted, not published
- INSTRUMENT: consentWithdrawalRace.pg.test.ts, three cases against embedded PostgreSQL, driving the shipped functions rather than restated SQL
- SUBJECT: commit 112b36e11c78c084701cbf36d0b0e7f522e947f8, embedded PostgreSQL in the build container
- EXECUTION PATH: publishToResearchLibrary with the real assertGuardianMediaConsentWithClient as verifyBeforeCommit, held open at the FOR SHARE, against suppressPublishedMediaForAthlete's sweep
- POSITIVE CONTROL: a publish with consent intact succeeds; without it the two refusal cases prove nothing
- NEGATIVE CONTROL: removing either lock reds the race case on the assertion that the sweep was observed blocked; both files restored and diffed against HEAD
- EVIDENCE LEVEL: REAL_DATABASE
- BLIND SPOTS: embedded PostgreSQL, not the deployed database; says nothing about staging or production, nor about suppressPublishedMediaForAthlete's non-race behaviour, nor about videos carrying no athlete_id
- VERDICT: APPLICABLE

### EVIDENCE APPLICABILITY — the same guarantee on the deployed database

- CLAIM: the same interleaving guarantee holds on the production database
- PROPERTY: production's lock behaviour matches what the embedded instance demonstrated
- INSTRUMENT: none — nothing was run against a deployed environment
- SUBJECT: production; not observed
- EXECUTION PATH: none exercised
- POSITIVE CONTROL: none — there is no observation to control for
- NEGATIVE CONTROL: none — a mutation needs a run to change the result of, and no run happened
- EVIDENCE LEVEL: NONE
- BLIND SPOTS: everything about the deployed database, including its PostgreSQL version and configuration
- VERDICT: UNVERIFIED
