# Pass 10 — Tests & CI

Pinned to `origin/main` at `04dd116b`. Read-only: no application code, test, or
workflow was modified in producing this. The one file written is this one.

The question this pass answers is not "is there coverage". There is a great deal
of coverage, it is unusually well-commented, and it is green. The question is
**what the tests actually pin, and what they would let through** — specifically,
for each child-safety gate, whether a test exists that would go red if the gate
were deleted.

---

## Method

### What was run

| Command | Result |
|---|---|
| `npm run typecheck` | clean, 29.3 s |
| `npm run lint` | **0 errors, 11 warnings**, 62.2 s |
| `npm test` (the CI fast suite) | **482 suites, 5,997 tests, 0 snapshots, all passing, 152.6 s** |
| `npm run test:migrations:training-holds` | 1 suite, 16 tests, passing, 11.5 s |
| `npm run test:migrations:athlete-check-ins` | 1 suite, 7 tests, passing, 5.4 s |

Two `*.pg.test.ts` suites only, per the disk constraint. `df -h /` before: 27 %
used, 28 G available. After, including cleanup: 26 % used, 28 G available.
`rm -rf /tmp/ppbf-*-pg-test-*` was run afterwards and removed four directories —
one created by this pass and three that predated it. The leak that produced them
is finding **T-02** below.

I also ran a controlled, out-of-tree probe of the embedded-Postgres wrapper
(a copy of `apps/web/scripts/test-embedded-pg-server.mjs` with the two `catch`
blocks instrumented, run from `/tmp` against a symlinked `node_modules`) to
establish *why* the data directory survives. Nothing in the repository was
changed to do this.

### What was measured, not estimated

Every count below came from a command, not an eye.

| Measurement | How | Value |
|---|---|---|
| Test files under `apps/web/src/server/pilot/` | `find … -name "*.test.ts"` | 281 |
| — of those, Postgres-backed | `find … -name "*.pg.test.ts"` | 93 |
| — of those, fast/unit | difference; cross-checked with `jest --listTests` | 188 |
| Postgres suites repo-wide (incl. `apps/web/scripts/`) | `find src scripts -name "*.pg.test.ts"` | 94 |
| `test:migrations` chain length | parsed `package.json` in node | 94 entries, `&&`-joined |
| Chain entries missing a `.pg.test.ts` / duplicated | same parse | 0 / 0 |
| Postgres suites tearing down with `kill('SIGTERM')` | grep | 93 of 93 in `pilot/` |
| Postgres suites using `SIGINT` | grep | 0 |
| Postgres suites that delete their own `DATA_DIR` | grep `fs.rm(` | 25 of 94 |
| Postgres suites that **do not** | complement | **69 of 94** |
| Suites using `fs.rm` retry options (`maxRetries`) | grep | 0 |
| Bail-out timer values | grep `setTimeout(finish, …)` | 89 × `15_000`, 4 × `10_000` |
| `.skip` / `.only` / `xit` / `xdescribe` / `xtest` / `.todo` | grep across `apps` + `packages` | **0** |
| Snapshot assertions | jest run output | **0 snapshots, total** |
| API route handlers (`app/api/**/route.ts`) | `find` | 228 |
| — with no sibling `*.test.ts` in their directory | script | 89 |
| — with no sibling test **and** no test file importing them | script | **70** |
| Workflows triggering on `pull_request` | grep `on:` blocks in all 15 | **2** (`ci.yml`, `research-bridge-ci.yml`) |

### What was read in full

`AGENT_KERNEL.md`; `docs/capabilities/NETWORK_STATUS.md` (recovered from
`origin/docs/agent-handoff-briefs` — it does **not** exist on `main` or on this
branch, see *Could not establish*); the testing/CI sections and §13 addendum of
`PLATFORM_AUDIT_2026-08-17_FULL_SPECTRUM.md`; `PASS-02`, `PASS-03` and `PASS-04`
of this audit for de-duplication; `.github/workflows/ci.yml`,
`research-bridge-ci.yml`, `run-checks.yml` and the `on:` block of the other
twelve; `scripts/ci-classify-paths.mjs`; `apps/web/jest.config.js`;
`apps/web/scripts/test-embedded-pg-server.mjs`; and the gate modules and their
tests: `trainingHolds.ts` + `.test.ts` + `.pg.test.ts`, `guardianConsent.ts` +
`.test.ts` + `guardianMediaConsentMigration.pg.test.ts`, `access.ts` +
`.test.ts`, `contactClearanceGate.ts` + `.test.ts`, `escalationLadder.ts` +
`.test.ts`, `safetyGateMatrix.ts` + `.test.ts`, `waiverCompliance.ts`,
`readinessMath.ts` + `.test.ts`, `dataDeletion.ts` + `.test.ts` +
`dataRetentionDeletion.pg.test.ts`, `pgTestCoverage.test.ts`,
`organizationScope.convention.test.ts`, `formulaRoutes.test.ts`,
`scheduler/route.test.ts`, `training-holds/route.test.ts`,
`auth/login/route.test.ts`.

### How the sample was chosen

Three passes, deliberately different so they would not all fail the same way.

1. **Gate-first.** Start from the six gate families named in the brief, find
   every enforcement call site by grep, and ask of each: is there a test whose
   failure is caused by deleting *this call*? This is the only method that
   answers the headline question, and it is what produced T-01.
2. **Machine hunt for fake tests.** Three scripted heuristics over all 482 test
   files: (a) test files that `jest.mock` their own subject module; (b) tests
   whose *name* claims a negative behaviour (outage, refuse, forbid, expire,
   race) while the body contains no negative assertion; (c) test files that
   import lower-case symbols from a relative path and never call any of them.
   (a) returned 4 hits, all legitimate adapter tests. (b) returned 433 hits and
   was too noisy to be evidence. (c) returned 156 files, almost all false
   positives caused by the `jest.mocked(x)` aliasing idiom this repo uses.
   **The single high-quality signal came from the linter, not from my
   heuristics**: `@typescript-eslint/no-unused-vars` on a test file that imports
   the functions it is named for and never calls them. That is T-04.
3. **Refutation.** Every candidate finding was re-checked against a shared
   helper, a `beforeEach`, a sibling `.pg.test.ts`, a route-level test, and the
   three sibling audit passes, before being written down. Two candidates died
   this way and are recorded under *Checked and found sound* rather than
   deleted, because a refuted finding is worth as much as a confirmed one to the
   next reader.

### Not reached

- The full `test:migrations` run (94 sequential embedded-Postgres suites) — out
  of scope by instruction. All claims about it are from static analysis of the
  chain plus two measured single-suite runs.
- Playwright E2E (`apps/web/e2e/*.spec.ts`, 2 files) was read for skips but not
  executed; it needs browsers this box does not have installed.
- GitHub branch-protection settings. See *Could not establish*.
- 179 of the 188 fast pilot unit-test files were not read line by line. The
  gate-relevant ones were.

---

## Do the safety gates have tests that would fail if the gate were removed?

The honest summary first: **the gate *modules* are protected. Four of the six
gate families have genuinely strong tests that would go red if the logic were
removed. The weakness is not in the modules — it is in the wiring**: one
route that carries two gates has no test that exercises it with a triggering
input, and two of the six "gates" are not gates at all, so there is nothing for
a test to protect.

| Gate | Is there a test that fails if the gate is removed? | Where | Notes |
|---|---|---|---|
| **Training hold — STOP** (`all_training` blocks class registration) | **Yes, and it is excellent** | `apps/web/src/server/pilot/trainingHolds.pg.test.ts:264-270` drives the *real* `registerForClassTransactionally` against real rows; `apps/web/app/api/pilot/scheduler/route.test.ts:161-181` pins the 403 and the gate-evaluation record | Deleting the `findRegistrationBlockingHold` call from `schedulerDb.ts:221` fails both. Also pinned: escalation-and-hold atomicity (`:283-300`), lift-reopens-the-door, one-active-hold-per-athlete |
| **Training hold — REGRESS** (`contact_only` flags contact) | **Module: yes. Wiring: no.** | Module: `trainingHolds.pg.test.ts:303-336` and `trainingHolds.test.ts:385-456`. Wiring: **none** | The only caller is `observations/route.ts:141`, and no test posts a contact observation to that route. See **T-01** |
| **Training hold — `conditioning_only`** | n/a — no enforcement exists to protect | — | Already recorded in `NETWORK_STATUS.md` and PASS-04 F-06. A test cannot protect a gate that was never built |
| **Guardian media consent** | **Yes, at three layers** | Module logic: `guardianConsent.test.ts:42-133`; against real Postgres: `guardianMediaConsentMigration.pg.test.ts:307-521`; call sites: `shadow/video-analysis/route.test.ts:122-144`, `publications/publish/route.test.ts:252-274`, `admin/video-compliance/route.test.ts:483-540` | Each route test asserts `toHaveBeenCalledWith(org, athlete)` **and** that a rejection produces a 4xx, so removing the call fails on the first assertion. Zero-guardian is pinned as *not* vacuously ok |
| **Guardian consent *scope*** (`covers_video`, `public_use_allowed`) | No — and a test actively pins the *absence* | `guardianConsent.test.ts:53-66` | Enforcement gap already reported (PASS-03 HIGH, `NETWORK_STATUS.md`). What is new here is that the test suite would have to be *edited* to fix it — see **T-05** |
| **Waiver gates** (`general`, `medical_release`, `travel`) | **No gate exists.** Nothing to protect | `waiverCompliance.ts` is a read-only rollup with one caller, `admin/waiver-status/route.ts` | Grep of every non-test reader of `pilot.waivers` finds exactly one enforcement path, and it is `photo_media`. Consistent with PASS-03 §"Exactly one waiver type is consulted by any gate" |
| **Contact medical clearance** (`contact_medical_clearance`) | **Module: yes, thoroughly. Wiring: no.** | Module: `contactClearanceGate.test.ts` (19 tests incl. gate-deactivation, dedup, pre-migration fallback). Wiring: **none** | Sole caller is `observations/route.ts:126`. See **T-01** |
| **Authorization helpers** (`access.ts`) | **Yes** | `access.test.ts` (702 lines) covers every role branch of `assertActorCanAccessAthlete` and `accessibleAthleteIds` incl. platform_owner and board denial-before-lookup; `boardRoleBoundaries.test.ts` drives 8 athlete-scoped surfaces as board and asserts 403; `organizationScope.convention.test.ts` is a filesystem-walking convention gate over `app/api` | The strongest area in the repo. Note it protects the *helpers* and one role; it does not prove every route calls one — see **T-06** |
| **Escalation filing** (`fileEscalation`) | **Yes, at all six call sites** | `escalationLadder.test.ts:36-44` pins the auto-escalate threshold; `shadowNearMisses.test.ts:130-170`, `compliance.test.ts:224-300`, `videoScanSweep.test.ts`, `behaviorStandards.test.ts`, `athleteVoice.test.ts`, `trainingHolds.pg.test.ts:262-270` each pin their own filing | Six non-test call sites of `fileEscalation` exist; all six have a test file that references it. Atomicity ("the hold and its escalation are one transaction") is proved by dropping `safety_escalations` mid-placement |
| **Formulas that gate training** | **No formula gates training.** The one module that looks like a gate is dead code | `readinessMath.ts` has zero importers; `formulas/registry.ts` results have no enforcement consumer | Orphan already recorded as PASS-04 F-08. The test angle is new — see **T-07** |
| **Safety gate matrix** (`enforcement: 'block' \| 'flag'`) | Partially | `safetyGateMatrix.test.ts` (61 lines) tests only `getGuardianGateSummary`, a read-only display function. `safetyGateMatrix.pg.test.ts` (617 lines) covers the evaluation records | The unit test's name would let a reader believe the matrix is unit-tested; it tests the parent-facing projection |

**The single most valuable line of this pass:** every gate that *is* wired has a
module-level test that would fail if the logic were removed. The one thing no
test protects is the two-line wiring in
`apps/web/app/api/pilot/shadow/formulas/observations/route.ts` that connects the
contact-clearance gate and the hold REGRESS rung to the only path that records
contact for a child. Both would survive deletion with all 5,997 tests green.

---

## Tests that pin nothing

### 1. The only route carrying two contact gates is tested only with a non-contact input

`apps/web/app/api/pilot/shadow/formulas/observations/route.ts` has no sibling
test file. Its only test is one directory up:

`apps/web/app/api/pilot/shadow/formulas/formulaRoutes.test.ts:17`:

> ```
> import { POST as postObservation } from './observations/route';
> ```

That file mocks `requirePrincipal`, `assertActorCanAccessAthlete`,
`assertShadowRuntimeReadiness`, `flagNearMiss`, `emitShadowEvent`,
`saveFormulaObservation` and the formula runner. It does **not** mock
`flagContactWithoutClearance` or `flagContactDuringHold` — they run for real.
And they short-circuit, because every observation the file posts is this one:

`formulaRoutes.test.ts:80-89`:

> ```
> const validObservationBody = {
>   athleteId: 'athlete-1',
>   contextId: 'session-1',
>   kind: 'session_rpe',
>   value: 5,
>   unit: 'rpe_0_10',
>   dimensions: {},
>   observedAt: '2026-07-28T10:00:00.000Z',
>   idempotencyKey: 'client-request-1',
> };
> ```

`session_rpe` is not a contact kind, so `isContactObservation` returns `false`
at `contactClearanceGate.ts:43` and both gates return before touching anything.

**What it would let through:** deletion of both gate calls. See finding T-01.

### 2. `dataDeletion.test.ts` — six tests, zero calls into the module

`apps/web/src/server/pilot/dataDeletion.test.ts:1-5` imports the three functions
the file is named for. The linter is the witness that it never uses them:

> ```
> /home/user/ppbf-platform/apps/web/src/server/pilot/dataDeletion.test.ts
>    2:3  warning  'deleteAthleteRecord' is defined but never used         @typescript-eslint/no-unused-vars
>    3:3  warning  'deleteGuardianAccount' is defined but never used       @typescript-eslint/no-unused-vars
>    4:3  warning  'getDeletionStatus' is defined but never used           @typescript-eslint/no-unused-vars
> ```
> — `npm run lint`, run 2026-08-18

Every assertion is a tautology over a literal the test itself just wrote:

`dataDeletion.test.ts:25-29`:

> ```
>     test('verifies admin role requirement', () => {
>       // Test that admin roles are allowed
>       const adminRoles = ['organization_admin', 'admin'] as const;
>       expect(adminRoles).toContain(mockActor.role);
>     });
> ```

`dataDeletion.test.ts:65-68`:

> ```
>     test('athletes retain for 2 years', () => {
>       const retentionDays = 365 * 2;
>       expect(retentionDays).toBe(730);
>     });
> ```

The module's real retention window is not a `retentionDays` constant at all —
it is SQL:

`dataDeletion.ts:208-213`:

> ```
>     const athleteDelete = await client.query(
>       `delete from pilot.athletes
>        where deleted_at is not null
>          and deleted_at < (now() - interval '2 years')
>        returning athlete_id`,
>     );
> ```

**What it would let through:** stubbing `deleteAthleteRecord`,
`deleteGuardianAccount` and `getDeletionStatus` to no-ops; deleting the
authorization guards at `dataDeletion.ts:35` and `:122`; and — jointly with the
`.pg.test.ts`, see T-03 — narrowing `interval '2 years'` to any shorter window.

### 3. `safetyGateMatrix.test.ts` tests the parent-facing projection, not the matrix

All four tests in `apps/web/src/server/pilot/safetyGateMatrix.test.ts` call
`getGuardianGateSummary`. `recordSafetyGateEvaluation`,
`getSafetyGateDefinition` and the `'block' | 'flag'` enforcement distinction —
the substance of the module — appear in the file only as an import that is never
exercised. This is not a fake test (the four assertions are real and one of them,
`expect(String(sql)).not.toContain('reason')`, is a genuinely good privacy pin);
it is a **mis-scoped filename**. The evaluation behaviour is covered in
`safetyGateMatrix.pg.test.ts` (617 lines), which runs only under
`test:migrations`. A reader counting test files sees a unit test next to the
module and concludes the module is unit-tested.

### 4. `readinessMath.test.ts` — eleven green assertions over unreachable code

Eleven `expect`s over `calculateReadinessL14`, `calculateDeltaRPE` and
`isDeltaRPELocked`. `grep -rn` across `apps`, `packages` and `scripts` returns
the module, its test, and nothing else. The suite is a coverage mirage: it makes
"readiness clamps, RPE lockouts" look defended by tests while nothing in the
application calls them. (Orphan itself already recorded as PASS-04 F-08; the
test angle is the addition here.)

### 5. The login route's outage test — confirmed as reported, but the consequence is smaller than it reads

`NETWORK_STATUS.md` records this and it is still true on `main` and on every
remote branch:

`apps/web/app/api/pilot/auth/login/route.test.ts:190-202`:

> ```
>   test('a durable store outage does not lock anyone out', async () => {
>     mockCheckRateLimit.mockReturnValue({ isLimited: false });
>     // checkDurableRateLimit swallows its own errors and reports not-limited.
>     mockCheckDurable.mockResolvedValue({ isLimited: false });
>     mockLogin.mockResolvedValueOnce({
>       principal: { accountId: 'acct-outage', role: 'athlete', organizationId: 'org-1' },
>       token: 'tok',
>     });
> 
>     const res = await POST(request('acct-outage'));
> 
>     expect(res.status).toBe(200);
>   });
> ```

`mockResolvedValue({ isLimited: false })` is the happy path. Nothing rejects,
nothing throws, no outage is simulated. Two further mocks in the same file are
declared and never used (`mockRecordFailedAttempt`, `mockClearRateLimit`, both
flagged by the linter) — the shape of a file written expecting to assert more
than it does. **See the refutation in T-08: the underlying property is in fact
covered, one tier down.**

---

## The Postgres teardown race

`NETWORK_STATUS.md` diagnoses it as:

> **93 Postgres test suites share a racy teardown.** `kill('SIGTERM')` is Postgres
> *smart* shutdown, which waits for clients to disconnect; a lingering connection
> means it never exits, a 15-second bail-out resolves anyway, and the data
> directory is deleted while the server is still writing — `ENOTEMPTY` on
> `pg_wal`. […] Fix is `SIGINT` (fast shutdown) plus `fs.rm(..., { maxRetries, retryDelay })`.

**Two of its facts are right and the mechanism is wrong.** Corrected below,
against the code as it stands, with the chain traced end to end.

### First: there is no shared helper. The teardown is copy-pasted 93 times.

The brief asked me to find "the actual helper". There isn't one. Every
`*.pg.test.ts` under `apps/web/src/server/pilot/` carries its own near-identical
`afterAll`. This is the training-holds copy:

`apps/web/src/server/pilot/trainingHolds.pg.test.ts:226-240`:

> ```
> afterAll(async () => {
>   await new Promise<void>((resolve) => {
>     let done = false;
>     const finish = () => {
>       if (done) return;
>       done = true;
>       clearTimeout(safetyTimer);
>       resolve();
>     };
>     const safetyTimer = setTimeout(finish, 15_000);
>     safetyTimer.unref();
>     serverProcess.once('exit', finish);
>     serverProcess.kill('SIGTERM');
>   });
> });
> ```

93 of 93 use `kill('SIGTERM')`; 89 use `15_000`, 4 use `10_000`; **none** use
`SIGINT`; **none** use `maxRetries`. A one-line fix therefore has to be applied
93 times, or the copies have to be collapsed into a helper first. That is a
material difference from what the existing diagnosis implies.

### Second: SIGTERM does not reach Postgres. Postgres already gets SIGINT.

`serverProcess` is not Postgres. It is a Node wrapper script:

`apps/web/scripts/test-embedded-pg-server.mjs:31-46`:

> ```
> async function shutdown(exitCode) {
>   try {
>     await pg.stop();
>   } catch {
>     // best-effort
>   }
>   try {
>     await fs.rm(dataDir, { recursive: true, force: true });
>   } catch {
>     // best-effort -- a lingering temp dir is not a correctness issue
>   }
>   process.exit(exitCode);
> }
> 
> process.on('SIGTERM', () => shutdown(0));
> process.on('SIGINT', () => shutdown(0));
> ```

`pg.stop()` is `embedded-postgres`, and it already sends the fast-shutdown
signal:

`node_modules/embedded-postgres/dist/index.js:258`:

> ```
>                     (_c = this.process) === null || _c === void 0 ? void 0 : _c.kill('SIGINT');
> ```

So the recommended fix — "use `SIGINT` (fast shutdown)" — describes what the
code already does. Postgres is **not** being smart-shut-down, does **not** wait
for clients, and the 15-second bail-out is **not** being reached: my
instrumented probe measured `pg.stop()` resolving in **14 ms**.

### Third: the real defect is that the child's own cleanup never runs

`embedded-postgres` installs a process-wide exit hook of its own:

`node_modules/embedded-postgres/dist/index.js:397`:

> ```
> AsyncExitHook(gracefulShutdown);
> ```

and `async-exit-hook` claims `SIGTERM` for itself:

`node_modules/async-exit-hook/index.js:93`:

> ```
> 		add.hookEvent('SIGTERM', 128 + 15);
> ```

Once its async hook completes, it terminates the process on the next tick:

`node_modules/async-exit-hook/index.js:24`:

> ```
> 			process.nextTick(process.exit.bind(null, code));
> ```

So one SIGTERM starts **two** shutdowns. The wrapper's `shutdown()` awaits
`pg.stop()` and then begins `fs.rm` of a ~200 MB PGDATA tree.
`async-exit-hook`'s handler awaits the same `instance.stop()` — which resolves in
14 ms — and then kills the process. The `fs.rm` never finishes, its `catch` never
fires (there is no error; the process is simply gone), and the directory
survives.

**Measured, not inferred.** The instrumented probe printed
`PROBE stop() ok in 14 ms` and then exited without ever reaching either the
success or the failure branch of the `fs.rm`. In the real suite:

- `npm run test:migrations:training-holds` — passes, 16/16 — left
  `/tmp/ppbf-training-holds-pg-test-1787017613259`, **263 MB**, behind.
- `npm run test:migrations:athlete-check-ins` — passes, 7/7 — left **nothing**.

The difference is that `athleteCheckIns.pg.test.ts:176` adds a *parent-side*
delete after the child has exited:

> ```
>   await fs.rm(DATA_DIR, { recursive: true, force: true }).catch(() => {});
> ```

**25 of 94 suites do that. 69 do not.** Three orphaned directories from earlier
sessions were already on this box when the pass started (50 MB, 203 MB, 203 MB).

### Verdict on the existing diagnosis

| Claim | Verdict |
|---|---|
| 93 suites share a racy teardown | **Confirmed** (94 including `scripts/`) — but by copy-paste, not a shared helper |
| `kill('SIGTERM')` is Postgres smart shutdown | **Incorrect.** SIGTERM goes to a Node wrapper; Postgres receives `SIGINT` (fast) from `embedded-postgres` |
| A lingering connection means it never exits | **Not observed.** `pg.stop()` resolved in 14 ms |
| The 15-second bail-out resolves anyway | **Not reached** in either measured run |
| The directory is deleted while the server is writing → `ENOTEMPTY` on `pg_wal` | **Not reproduced.** `ENOTEMPTY` appears nowhere in the repository, and the failure I measured is the opposite: the directory is *not* deleted at all |
| Fix is `SIGINT` | **Already the case** — no change available there |
| Fix is `fs.rm(..., { maxRetries, retryDelay })` | Would not help; nothing is retrying, because nothing is failing |
| ~95 chances per PR to fail for no reason | **Wrong shape, right worry.** The suites do not fail randomly; they fill the disk deterministically, and *that* is what fails the run |

The corrected fix is different in kind: either have the parent do the delete
(the pattern 25 suites already use — the cheapest correct change), or stop
racing the library's exit hook.

---

## CI gates

Fifteen workflows. **Exactly two run on `pull_request`**, and only one of them
runs for an ordinary change.

### `ci.yml` — job `validate`, one job, sequential steps, first failure aborts the rest

| # | Step | `ci.yml` | Condition |
|---|---|---|---|
| 1 | `node scripts/verify-entrypoint-contracts.mjs` | `:41-42` | always — runs before `npm ci`, so it must be dependency-free |
| 2 | inline self-test of the path classifier | `:44-91` | always |
| 3 | classify changed surface (`base.sha` → `github.sha`) | `:93-114` | always |
| 4 | documentation-only fast path (echo, then done) | `:116-119` | `docs_only == 'true'` |
| 5 | `npm ci` | `:121-123` | not docs-only |
| 6 | **`npm run typecheck`** | `:125-127` | not docs-only |
| 7 | `npm run lint` | `:129-131` | not docs-only |
| 8 | **`npm test`** (482 suites, ~153 s) | `:133-135` | not docs-only |
| 9 | **`npm run test:migrations`** (94 suites) | `:137-139` | not docs-only **and** `migrations == 'true'` |
| 10 | Playwright install | `:141-143` | board or homepage E2E selected |
| 11 | board governance E2E | `:145-147` | `board_e2e == 'true'` |
| 12 | public homepage E2E | `:149-151` | `homepage_e2e == 'true'` |
| 13 | `npm run build` | `:153-155` | not docs-only |

Everything is **blocking** — there is no `continue-on-error` anywhere in the
file. Nothing is advisory. Because it is one job with ordered steps, **typecheck
failing means the tests never run at all.** That is precisely the shape of the
"`main` went red three times in one day" incident: an exhaustive
`Record<SuggestionRule, …>` broke at step 6, so every open PR reported red
without a single test having executed.

`test:migrations` runs only when the classifier says so. `migrations` is true for
any path under `infra/azure/`, `apps/web/src/server/pilot/` or
`apps/web/scripts/pilot-`, or for either `package.json`
(`scripts/ci-classify-paths.mjs:12-24`). That covers every gate module, so the
gate proofs do run when the gates change — but it does **not** cover
`apps/web/app/api/**`, so a change confined to route handlers never runs a
single Postgres suite.

The `docs_only` fast path is `files.every((file) => file.startsWith('docs/') || file.endsWith('.md'))`
(`ci-classify-paths.mjs:56-58`), so a markdown-only PR skips install, typecheck,
lint, test and build. That is deliberate and reasonable.

`unknown_code` is computed (`ci-classify-paths.mjs:61-66`), emitted
(`:77`), summarised (`:111`), and asserted in ci.yml's own self-test (`:86`) —
and **consumed by no step in any workflow.** Dead output.

### `research-bridge-ci.yml` — job also named `validate`, path-filtered

Triggers only on changes under `apps/research-bridge/**`, `package.json`,
`package-lock.json` or its own file. Node 24, scoped `npm ci`, typecheck → test →
build. On a PR that touches nothing in that list, it does not run, so it produces
no status check. Both workflows naming their job `validate` is worth knowing when
reading the required-checks list.

### Everything else is `workflow_dispatch` (or a nightly cron), not a merge gate

`apply-migrations`, `approve-library-baseline`, the legacy SWA deploy,
`branch-cleanup`, `check-database`, `deploy-production`, `deploy-staging`,
`import-shadow-research`, `rescope-library-baseline`, `run-checks`,
`seed-reference-data` — all manual. `backup.yml` (07:10 UTC) and
`retention-cleanup.yml` (07:40 UTC) are cron. None of these gate a merge.
`run-checks.yml` is a genuinely well-built read-only diagnostic suite for a live
database, guarded by `BEGIN TRANSACTION READ ONLY`, and it is manual by design.

### "Require branches to be up to date before merging" — is there a workflow-level substitute?

**No.** Measured:

- No `merge_group:` trigger in any of the 15 workflows (grep returns nothing).
- No `CODEOWNERS`, no rulesets, no repository-configuration file in `.github/`
  (contents are exactly `dependabot.yml`, `pull_request_template.md`,
  `workflows/`).
- `ci.yml` uses `actions/checkout@v7` with no `ref:`, so on `pull_request` it
  tests GitHub's merge commit of the PR head with `main` **as of when the run
  started**. That is a real check — but it goes stale the moment another PR
  merges, and nothing re-runs it.
- `cancel-in-progress` is `true` only for pull requests (`ci.yml:19`), with a
  well-reasoned comment about why `main` runs must not be cancelled. It cancels
  on a *new push to the PR*; a change to `main` is not an event this workflow
  listens for on that PR.

So the semantic-merge-conflict class remains entirely uncovered by CI. Three
`main` breakages in one day is the expected rate for parallel merging without it,
not bad luck. The mitigation is a repository setting or a merge queue; the
serial-merge convention that `NETWORK_STATUS.md` recommends is a social
substitute for a mechanical one, and it will fail the first time two sessions
read the same authorization at the same minute — which is what already happened.

---

## Findings

### [CRITICAL] The contact-clearance gate and the hold REGRESS rung are wired into one route, and no test exercises that route with a contact observation

`apps/web/app/api/pilot/shadow/formulas/observations/route.ts` is the single
path that records contact for a child (PASS-04 confirms this:
"*Only one path writes contact observations. `saveFormulaObservation` has one
caller*"). Two safety gates hang off it:

`observations/route.ts:126`:

> ```
>     const clearance = await flagContactWithoutClearance({
> ```

`observations/route.ts:141`:

> ```
>     await flagContactDuringHold({
> ```

The route has **no sibling test file**. Its only test is
`formulaRoutes.test.ts`, which posts `kind: 'session_rpe'` in every case
(`:80-89`), plus `pain_report` in two (`:162`, `:200`) and a sparring recovery
note in one (`:219`). `session_rpe` is not a contact kind:

`apps/web/src/server/pilot/contactClearanceGate.ts:27-31`:

> ```
> export const CONTACT_OBSERVATION_KINDS: readonly ObservationKind[] = [
>   'contact_level',
>   'contact_rounds',
>   'punch_absorbed',
> ];
> ```

so both gates return at `isContactObservation` before doing anything observable.

**Refutation attempted, four ways, all failed.**

1. *Is the wiring covered by another test file?* `grep -rn "observations/route"`
   across all `*.test.ts(x)` returns exactly one line —
   `formulaRoutes.test.ts:17`. No other test loads this route.
2. *Does some test post a contact kind here?* Nine test files mention
   `contact_level`. None of them import the route: they are the module tests
   (`contactClearanceGate.test.ts`, `trainingHolds.test.ts`,
   `trainingHolds.pg.test.ts`), formula-engine tests, migration tests, and three
   client-component tests that stub `fetch`.
3. *Does the module test cover the wiring?* No. `trainingHolds.pg.test.ts:320`
   calls `flagContactDuringHold` directly. That proves the function works; it
   cannot notice that the route stopped calling it.
4. *Would `lint` or `typecheck` catch removal?* No. Removing the calls **and**
   their imports (`route.ts:4-5`) leaves both clean — verified by running both;
   the current warnings are all pre-existing unused-variable noise elsewhere.

**Consequence.** An agent refactoring this route — for instance to move the
gates after the store, or to make them non-blocking, or simply deleting a block
it read as duplicated with `alertCoachToPainReport` directly below — would see
482 green suites and 5,997 green tests. The result is that contact logged for a
child with `not_cleared` or `restricted` medical status, or for a child under an
active `contact_only` training hold, would be silently recorded with no near
miss and no escalation. Note that the route's own comments state the ordering as
load-bearing ("*Runs BEFORE the observation is stored, so a failure here aborts
the whole request rather than quietly persisting contact nobody was alerted to*",
`:122-124`) — the invariant is written down and unenforced.

This is a CRITICAL by the audit's own standard: a missing test leaving a
child-safety gate unprotected against regression. It is the only one in this
pass.

### [HIGH] 69 of 94 Postgres suites leak a full data directory; a complete `test:migrations` run is a deterministic disk-filling machine

Measured above. `npm run test:migrations:training-holds` passed 16/16 and left
263 MB in `os.tmpdir()`; `athleteCheckIns`, which deletes in the parent, left
nothing. The cause is the double SIGTERM handler traced in *The Postgres teardown
race*: `async-exit-hook` exits the wrapper process before the wrapper's own
`fs.rm` of the ~200 MB tree can complete.

`apps/web/scripts/test-embedded-pg-server.mjs:37-41`:

> ```
>   try {
>     await fs.rm(dataDir, { recursive: true, force: true });
>   } catch {
>     // best-effort -- a lingering temp dir is not a correctness issue
>   }
> ```

The comment is the problem in miniature. A lingering temp dir is not a
correctness issue; sixty-nine of them, at 50–263 MB apiece, in one sequential
run, is.

**Refutation attempted.** *Is the cleanup elsewhere?* Yes for 25 suites — they
add a parent-side `fs.rm(DATA_DIR, …)` after the child exits, and I confirmed
by measurement that those genuinely clean up. For the other 69 there is no
second delete: grep for `fs.rm`, `rmSync` and `rimraf` across all 94 files
returns 25. *Is it a permissions problem specific to this box?* No — the probe
ran as root, and a standalone `fs.rm` on the same leaked directory succeeded
immediately. *Is `embedded-postgres` deleting it?* No: the wrapper sets
`persistent: true` precisely so the library will not, and the library's own
delete is guarded on `persistent === false` (`index.js:263-267`).

**Consequence.** `test:migrations` is the only thing that runs 93 of the
repository's safety proofs — the training-hold registration block, the guardian
media-consent contract against real rows, the escalation-ladder transitions, the
safety-gate matrix, the clearance register, the retention purge. If it dies
partway through on disk, those proofs did not run, and the failure looks like
infrastructure rather than like a gap in evidence. This box's own operating
instructions record the suite having exhausted the disk before; that is
corroboration, not coincidence.

### [HIGH] `test:migrations` is a 94-link `&&` chain, so one failure hides the other 93 suites

`apps/web/package.json:90` is a single line joining 94 npm scripts with `&&`:

> ```
>     "test:migrations": "npm run test:migrations:session && npm run test:migrations:library && npm run test:migrations:library-coverage && … && npm run test:migrations:one-percent-club",
> ```

`&&` short-circuits. The first suite to exit non-zero — for any reason,
including running out of disk from finding T-02 — prevents every later suite from
running. `test:migrations:training-holds` is entry 47 of 94;
`test:migrations:safety-escalations` and `test:migrations:safety-gate-matrix` sit
at 42 and 41. A failure anywhere in the first forty entries means none of the
gate proofs execute, and CI reports one red step whose message names only the
first failure.

**Refutation attempted.** *Does a runner-level setting mitigate this?* No.
`ci.yml:137-139` invokes the chain as a single `run:` step with no
`continue-on-error`, no retry and no matrix fan-out; there is no per-suite
reporting. *Does the meta-test help?* `pgTestCoverage.test.ts` guarantees every
`.pg.test.ts` is *reachable* from the chain — I re-verified its property
independently (94 files, 94 chain entries, zero missing, zero duplicated) — but
reachability is not execution.

**Consequence.** A green `main` and a red `main` are both compatible with "the
safety-gate Postgres proofs did not run this time", and nothing in the output
distinguishes them.

### [MEDIUM] `dataDeletion.test.ts` is six tautologies under the name of the child-data deletion module

Quoted in full under *Tests that pin nothing* §2. Every assertion is over a
literal the test itself constructed. The module's two authorization guards
(`dataDeletion.ts:35`, `:122`) and its retention SQL (`:208-213`) are untouched.

**Refutation attempted, and partly successful.** The *route*-level gate is
genuinely covered: `app/api/pilot/admin/data-deletion/route.test.ts:53-62`
asserts a non-admin gets 403 with the real message, and `:85-94` asserts a
service-layer `Forbidden` surfaces at 403. The cascade and purge behaviour is
covered by `dataRetentionDeletion.pg.test.ts`. So the *reachable* path is
defended, and the module's own guards are defence-in-depth. That is why this is
MEDIUM, not HIGH.

**Consequence.** The residual harm is a false coverage signal: a file named
`dataDeletion.test.ts` sits next to `dataDeletion.ts` and is green, so a reviewer
counting test files — or an agent asked "is this module tested?" — concludes yes.
It also carries a specific hole; see the next finding.

### [MEDIUM] Nothing in the suite would catch the retention window being *narrowed*

`dataDeletion.test.ts:65-68` asserts `365 * 2 === 730` — arithmetic, not the
module. The Postgres suite seeds its fixture three years back:

`apps/web/src/server/pilot/dataRetentionDeletion.pg.test.ts:215-219`:

> ```
>     await client.query(
>       `update pilot.athletes set deleted_at = now() - interval '3 years'
>         where organization_id = $1 and athlete_id = $2`,
>       [ORG_ID, EXPIRED_ATHLETE_ID],
>     );
> ```

Three years is comfortably past two, so the test asserts only that a very old row
is purged. Changing `interval '2 years'` at `dataDeletion.ts:212` to
`interval '2 months'` leaves both files green: the pg fixture is still older than
the window, and the unit test never reads the module. Widening the window *would*
be caught (the row would survive and the assertion `expect(gone.rowCount).toBe(0)`
would fail) — so the suite is asymmetric in exactly the wrong direction.

**Refutation attempted.** I checked whether a boundary fixture exists anywhere:
grep for `interval '2 years'`, `730`, and `deleted_at` across all test files
finds no case seeded near the boundary, and no test that reads the window from
the module. `docs/DATA_RETENTION.md` states the policy in prose, and no test
reads that either.

**Consequence.** A minor's records being hard-deleted earlier than the stated
retention policy is a compliance failure that this suite would report as green.
PASS-03 already records that the retention *documentation* overstates what is
deleted; this is the complementary point that the *window* is untested.

### [MEDIUM] A guardian who declines video is asserted to be "ok" for the video gate

`apps/web/src/server/pilot/guardianConsent.test.ts:53-66`:

> ```
>   test('ok when every linked guardian has a current signed row', async () => {
>     mockQuery
>       .mockResolvedValueOnce([{ parent_id: 'p1' }, { parent_id: 'p2' }]) // guardian_links
>       .mockResolvedValueOnce([
>         { parent_id: 'p1', status: 'signed', covers_video: true, public_use_allowed: false, created_at: '2026-08-01T00:00:00Z' },
>         { parent_id: 'p2', status: 'signed', covers_video: false, public_use_allowed: false, created_at: '2026-08-02T00:00:00Z' },
>       ]); // current consent per guardian
> 
>     const result = await checkGuardianMediaConsent('org-a', 'ath-1');
> 
>     expect(result.ok).toBe(true);
> ```

The fixture deliberately includes a guardian with `covers_video: false` and
asserts the media gate returns `ok`. The same shape recurs at
`guardianMediaConsentMigration.pg.test.ts:417-433` ("two guardians: both sign —
consent is ok"), where one guardian signs with `coversVideo: false`.

**Refutation attempted.** Is this a deliberate pin of a recorded decision? The
non-enforcement of `covers_video` *is* a recorded MVP cut (`NETWORK_STATUS.md`;
PASS-03 HIGH). But neither test says so — there is no comment marking the
`false` as intentional, and the test name ("every linked guardian has a current
signed row") does not mention scope at all. So this is not a documented pin; it
is an incidental fixture value that has since become load-bearing.

**Consequence.** The enforcement gap is already reported. What is new is that
**closing it now requires editing two tests**, one of them a Postgres contract
test — and an agent who makes `covers_video: false` block the video path will see
two red suites and may reasonably conclude they have broken something. That is
how a correct fix gets reverted. Whoever picks up the PASS-03 finding should be
told these two fixtures are part of the change.

### [MEDIUM] 70 of 228 API routes are loaded by no test, including the setter for the status the contact gate reads

Measured: 89 route directories have no sibling `*.test.ts`; of those, 70 are
imported by no test file anywhere in the tree. Two matter for safety:

- `app/api/pilot/shadow/medical-status/route.ts` — the route that **sets** the
  medical administrative status `contactClearanceGate` reads. Its role gate is
  `requireRole(principal, [...SHADOW_PHI_ROLES]);` at `:27` and `:57`, with the
  comment "*organization-private health information and platform_owner must never*".
- `app/api/pilot/auth/activate/route.ts` — account activation, the PIN entry
  point.

**Refutation attempted, and partly successful for the first.** The constant
itself is well pinned: `shadowRoleSets.test.ts:53-54` asserts
`expect(SHADOW_PHI_ROLES).not.toContain('platform_owner')` and that
`requireRole` throws for that role. So the *policy* cannot drift. What is not
pinned is that this route still applies it: deleting both `requireRole` lines
from `medical-status/route.ts` breaks nothing. I looked for a convention test
that walks `app/api` asserting every route calls an auth helper — the repo has
exactly that shape of test for tenancy
(`organizationScope.convention.test.ts`, which walks `app/api` and requires a
guard whenever `organization_id` comes off the request) but no equivalent for
authentication or role.

**Consequence.** The tenancy boundary has a machine-enforced convention; the
role boundary does not. The 70 routes are a standing surface where a role gate
can be dropped in a refactor without any test noticing. PASS-02 covers the
substance of route authorization; this is the coverage-of-that-substance view.

### [LOW] The login route's durable-outage test still pins nothing — and is unfixed on every branch, contrary to the record

Quoted under *Tests that pin nothing* §5. Two things to record.

**First, the fix was reported as made and was not.** The 2026-08-17 full-spectrum
audit's §13 addendum lists, under "Fixed by this session, in this PR": "*A
login-route test named for verifying durable-store-outage tolerance that never
actually simulated an outage.*" I searched every remote branch for a version of
`apps/web/app/api/pilot/auth/login/route.test.ts` containing
`mockCheckDurable.mockRejected`: **zero branches have one.** The file is
byte-identical on `origin/main` and on this audit branch. The addendum's own
hedge ("*Status of each … is recorded in this PR's own description*") is doing a
lot of work; the code shows no fix anywhere.

**Second, the underlying property is nonetheless covered — one tier down.**

`apps/web/src/server/pilot/durableRateLimit.pg.test.ts:317-330`:

> ```
>   test('a missing table degrades to the volatile limiter instead of denying', async () => {
>     await db.query('alter table pilot.auth_rate_limit_buckets rename to auth_rate_limit_buckets_hidden');
>     try {
>       const key = 'pin_account:no-table-1';
> 
>       // The durable half cannot answer, and the caller is not denied.
>       await expect(rateLimit.checkDurableRateLimit(key)).resolves.toMatchObject({ isLimited: false });
> ```

That is a real outage, really simulated, against real Postgres, and it proves
exactly the property the login test's name claims. `NETWORK_STATUS.md` is right
that the login test pins nothing; it is worth recording that the *consequence* is
much smaller than "a durable store outage would lock every athlete out is
untested" — because it isn't. The correct fix is to rename or delete the login
test, not to panic about the property.

### [LOW] `readinessMath.test.ts` gives a dead safety formula the appearance of test coverage

Eleven assertions over three functions with zero importers (the orphan itself is
PASS-04 F-08). The prior full-spectrum audit separately records that
`/operations` renders a "Signed & Active" certification stamp over claims
including "readiness clamps, RPE lockouts". A green test file with the right
name is the third layer of that same illusion. Deleting the module and its test
together is the honest move; if the clamp is meant to be wired, the test should
fail loudly until it is.

### [LOW] Two workflows both name their job `validate`, and one is path-filtered

`ci.yml:23` and `research-bridge-ci.yml`'s jobs block both declare `validate`.
`research-bridge-ci.yml` runs only on paths under `apps/research-bridge/**`
(plus the two lockfile/manifest files and itself), so on most PRs it produces no
check at all. `ci.yml:16-19`'s own comment refers to "*the branch protection's
required `validate` context*". Whether the required context resolves
unambiguously is a repository setting I could not read (see below); it is worth a
human glancing at the required-checks list once.

---

## Checked and found sound

- **Zero disabled tests.** `.skip`, `.only`, `xit`, `xdescribe`, `xtest`,
  `test.todo`, `it.todo` across `apps/` and `packages/`: **not one occurrence.**
  One commented-out assertion exists, in
  `shadowTokenBudget.workflow.test.ts:10`, and it is an explanatory comment about
  a superseded threshold, not a disabled check. Playwright specs carry no
  `test.skip` or `.fixme`. For a codebase this size that is genuinely unusual and
  worth saying.
- **Zero snapshot tests.** The jest run reports `Snapshots: 0 total`. The scope
  asked me to look for snapshots pinning formatting instead of logic; there are
  none to find.
- **`trainingHolds.pg.test.ts` is the model the rest should be measured
  against.** It mocks `./db` to route into a real embedded Postgres, implements a
  real `BEGIN`/`COMMIT`/`ROLLBACK` (with a comment at `:36-43` explaining that an
  earlier autocommit passthrough could not reproduce SQLSTATE 25P02 and therefore
  could not prove the SAVEPOINT fix either way), runs the *real*
  `registerForClassTransactionally`, and proves atomicity destructively by
  dropping `safety_escalations` mid-placement. Deleting the gate, the escalation,
  or the transaction each fails a different test.
- **`app/api/pilot/training-holds/route.test.ts` is 24 tests of real authority
  boundaries** — the coach assignment gate on place and lift, parent-link gate,
  board and platform_owner refused, athlete-safe projection, "a coach probing
  another roster's hold id gets the same Missing as a bogus id", a required
  athlete explanation, and expiry-buffer validation. Nothing decorative.
- **`organizationScope.convention.test.ts` is a real machine-enforced
  convention**: it walks `app/api`, finds every route that reads
  `organization_id` off the request, and requires one of four named guard shapes
  or an allowlist entry with a recorded reason. Its header cites the actual
  near-miss that motivated it. This is the pattern the role boundary lacks.
- **`pgTestCoverage.test.ts` does what it says.** I re-derived its property
  independently: 94 `.pg.test.ts` files, 94 chain entries, zero unreachable, zero
  duplicated. Its header records that the chain had silently lost seven suites
  before this test existed.
- **Escalation filing is covered at every writer.** Six non-test call sites of
  `fileEscalation`; six test files that reference it; the `high`/`critical`
  threshold pinned by `test.each` in both directions
  (`escalationLadder.test.ts:36-44`).
- **`access.test.ts` covers every role branch**, including the two denials that
  matter most (`platform_owner` and `board`) and the assertion that board is
  denied *before* any athlete lookup is attempted.
- **The login route's unused-import lint warnings are not a bug.** I checked:
  `recordFailedAttempt` and `clearRateLimit` are imported and unused at
  `login/route.ts:12` and `:14`, which reads like a missing volatile-limiter
  write — but `recordDurableFailedAttempt` already does it, at
  `rateLimit.ts:236`: `const fallback = recordFailedAttempt(key);`. The comment
  in the route ("*the durable helpers write the volatile entry too*") is accurate.
  Candidate finding, refuted, recorded here rather than dropped.
- **`board/chat/route.test.ts` mocking `shadow/chat/route` is correct.** My
  automated hunt flagged four route tests that mock a route module; all four are
  thin adapters whose contract *is* "forward to the canonical route with the
  organization scope stripped", and mocking the downstream route is the right way
  to assert that. Not fake tests.
- **CI's ordering comments are load-bearing and correct.** `ci.yml:16-19`
  explains why `cancel-in-progress` is PR-only ("*a cancelled check reads as
  'never validated'*"). `run-checks.yml`'s header explains why it has no
  `confirm_target` where `apply-migrations.yml` does ("*These scripts cannot
  write*"). These are the kind of comments that stay true.

---

## Could not establish

- **`docs/capabilities/NETWORK_STATUS.md` does not exist on `main` or on this
  branch.** It exists only on `origin/docs/agent-handoff-briefs` (added by
  `782e8649`). I read it from there. Anyone told to "read
  `docs/capabilities/NETWORK_STATUS.md` first" will get *No such file or
  directory* — including the README of this very audit, which cites that path as
  though it were on `main`. Not a test/CI finding, but it will cost the next
  reader time.
- **GitHub branch-protection configuration.** No `gh` CLI on this box, and the
  available GitHub MCP tools expose branches, commits and files but not
  `/branches/main/protection`. Everything above about *which* contexts are
  required — including whether the duplicate `validate` job name matters — is
  therefore about what the workflows *emit*, not about what the repository
  *requires*. The `ci.yml` comment asserts a required `validate` context exists;
  I could not verify it.
- **Whether the leak actually exhausts a GitHub-hosted runner.** I measured the
  per-suite leak (263 MB for training-holds; 50 MB and 203 MB for two
  pre-existing orphans) and the count (69 of 94). I did **not** measure free disk
  on `ubuntu-latest`, nor whether `os.tmpdir()` there resolves to the root volume
  or to a larger mount. The arithmetic is alarming; the conclusion "CI will run
  out of disk" is not established, only "CI accumulates on the order of ten
  gigabytes of PGDATA during one `test:migrations` run".
- **Whether `test:migrations` currently passes end to end.** Not run, by
  instruction. Two of its 94 suites were run individually and passed.
- **Per-test assertion quality across the 179 pilot unit-test files I did not
  read.** My three scripted heuristics produced too many false positives to serve
  as evidence (433 and 156 hits respectively, dominated by the repo's
  `jest.mocked(x)` aliasing idiom). I am not claiming the fake-test census is
  complete. The one high-signal detector that worked was the linter's
  unused-import warning on a test file, and it found exactly one such file.
- **Playwright E2E content.** Read for skips (none) and not executed.
