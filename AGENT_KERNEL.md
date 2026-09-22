# PPBF Agent Kernel

The startup contract for AI work in this repository: the rules, each stated
once. The incidents behind them, and every amendment in its original wording,
are kept verbatim in `docs/archive/2026-09-21_AGENT_KERNEL_before_condense.md`.
That is history. Do not preload it.

## Read path

For ordinary implementation work, read only:

1. this file;
2. `docs/current/ACTIVE_WORK.md` for blocked and parked work;
3. the user request, approved work order, or assigned ticket, if one exists.

Before writing a test, gate, migration, or policy constant that asserts who may
do what, also read `docs/current/OWNER_DECISIONS.md` (see "A decision already
made is written down").

Read additional documents only when the task actually touches their domain:

- concurrent/multi-AI work -> `docs/AI_COLLABORATION.md`
- shipping, staging, production, or migration release work -> `docs/AI_DELIVERY_PIPELINE.md`
- SHADOW safety/model behavior -> relevant SHADOW contract/spec plus the applicable sections of `docs/AI_CONTRIBUTOR_GUARDRAILS.md`
- authentication/roles -> `AUTH_CONTRACT.md` and `ORGANIZATION_ROLE_MODEL.md`
- database/schema/migrations -> database rules in `docs/AI_CONTRIBUTOR_GUARDRAILS.md` and the existing migration/runner pattern
- visual design -> `design-system/README.md` and `design-system/ppbf.css`; Grok's contract is `docs/GROK-VISUAL-LANE.md`
- ChatGPT's lane and capabilities -> `docs/CHATGPT-AUDIT-LANE.md`
- audit/provenance/history -> `docs/current/WORK_QUEUE.md` and `docs/archive/`
- writing an evidence claim in a PR body, status report or handoff -> `docs/current/EVIDENCE_APPLICABILITY.md`

Do not preload archived audits, the historical queue, superseded plans, old build plans, or unrelated domain rules.

## Working channel

### Lanes (owner decision 2026-09-21, OD-2026-09-21-001)

- **Jason** -- final authority: priorities, scope, mutation approval, design
  and visual approval, production authorization, acceptance, conflict
  resolution. No lane turns an idea into a product decision on its own.
- **ChatGPT** -- designer (product and system specs, work orders; Jason
  approves a design before it is built) and standards enforcer (reviews). Also
  research, full-spectrum audit, documentation, storage inventory and
  reconciliation, the decision/handoff ledger, exact-head SHA and CI
  verification, and deployed-versus-specification checks. **Read-only on this
  repository:** no branches, commits, pushes, merges, deploys, or migrations.
- **Claude** -- builder: implements approved work orders. Functional and
  security engineering: backend, APIs, schema, migrations, authentication,
  authorization, organization isolation, safeguarding, medical/hold
  enforcement, business logic, SHADOW functional architecture, functional and
  migration tests, release engineering. Branches, PRs, CI, staging, and
  explicitly authorized production deployment. Writes to storage or the ledger
  only when a ChatGPT write fails, and records that it did.
  **On a visual PR Claude reviews; it does not redesign.** It checks that no
  function, role gate, organization boundary or safety rule changed, that
  nothing unsupported was invented, that no existing action disappeared, and
  that tests stayed meaningful. It may independently verify a committed plate
  against the byte gate. A visual preference that is not a defect is not
  grounds to rewrite another lane's approved work.
- **Grok** -- visual design and visual implementation, on its own feature
  branches and PRs, per `docs/GROK-VISUAL-LANE.md`. Reads current source before
  designing; explores and proposes freely; implements only what Jason
  approved. May change presentation: JSX visual structure, design-system
  classes, CSS, responsive layout, typography, visual assets,
  presentation-related accessibility markup, and the visual tests that cover
  them. May **not** change schema, migrations, API behaviour, auth,
  authorization, organization scoping, guardian/athlete access rules,
  safeguarding, medical or hold semantics, role vocabulary, business logic,
  SHADOW or progression algorithms, data models, audit semantics, or server
  security boundaries without a separate owner-approved functional task.
  Invents nothing: no roles, athlete data, metrics, statuses, navigation
  destinations, medical information, security claims, or buttons with no
  backing behaviour.
- **Codex** -- no lane. Its PR reviews are evidence, not approval.

"Designer", in the owner's words, means product and system design; visual
design stays Grok's. Several Claude lanes may run at once, each in its own
session. The **Lane model** below governs who merges.

### Repository writes

- Every change lands by PR with green CI. **Nobody pushes directly to
  `main`**, including agents that technically can. (On 2026-08-19 nine direct
  pushes from a secondary channel cut `apps/web/package.json` from 39,755
  bytes to 327 and left `main` unable to build; a docs-only CI fast path then
  painted it green.)
- Work that starts elsewhere -- designs, research, generated assets -- enters
  as a branch or PR and is reviewed before merge.
- No force-push without the owner's explicit permission and a documented
  reason. (Carried from the retired `docs/archive/AGENT_EXECUTION_POLICY.md`,
  where it was the only copy.)
- Written policy reports; branch protection enforces. Only the owner can set
  the required status checks that make this rule technical.

### Binary assets (plates)

- **Plate laws.** Real `.jpg` binary only; never base64, data URI, or
  chat-byte relay; JPEG SOI and EOI present; larger than 8 KB; at most 400 KB;
  4:4:4 with every component 1x1; only the declared landscape and portrait
  geometries (1280x720 / 2560x1440 landscape, 405x720 / 810x1440 portrait);
  filename orientation matching the image; every CSS-declared plate existing
  on disk; the exact ordered filename; no silent re-encode inside the
  repository; bad input refused rather than quietly corrected.
  `apps/web/src/design/plateBinaries.test.ts` enforces these on the bytes and
  is not to be weakened.
- **A binary is delivered when a real `git add` of the actual file lands on a
  branch.** A README, manifest, folder path, link, zip in a drive, base64
  payload, or `.jpg`-named placeholder is not a delivery, however complete its
  covering note reads.
- **Working routes:** Grok pushes the real binary to its own visual branch;
  Jason drag-drops the real files onto the branch; or Claude lands bytes it can
  actually read, when the owner directs it (ruling 2026-08-25) -- never a
  handoff asking Claude to fetch the binary from a drive. Claude never
  re-encodes or reconstructs an image. An image rebuilt from a rendering is a
  new picture that could pass the byte gate while being the wrong plate, and
  silently correcting a bad input hides that the producer's pipeline is wrong.
- `Grok-Plates-Inbox` in OneDrive is a provenance and archive drop, not a
  transport hop. Nobody polls it as a prerequisite for a Grok visual PR.

### Capabilities, by where they were checked

A capability is a fact about an environment, not a rule anyone can waive or
grant. Scope every capability claim to where it was measured.

| Capability | Claude Code on Jason's Windows PC (checked 2026-09-21) | Cloud container lanes (checked 2026-08-20..25; not re-checked) |
|---|---|---|
| Read SharePoint/OneDrive **text-file** contents | Yes -- Microsoft 365 connector `read_resource` | No -- the connector rendered for viewing; `downloadUrl` null |
| Retrieve **binary** bytes (plates, zips) from SharePoint/OneDrive | Not checked | No |
| Load a deployed page | Public pages: yes (`curl` HTTP 200; the desktop app's browser pane loaded the site). Signed-in pages need Jason to sign in; no lane enters credentials. | No -- outbound HTTPS refused |
| Re-encode a JPEG | Not checked, and forbidden by the plate laws either way | No -- `cjpeg`, `jpegtran`, ImageMagick and Pillow absent |

ChatGPT, per `docs/CHATGPT-AUDIT-LANE.md`: reads this repository; could not
load a deployed page (2026-08-20); writes to OneDrive -- observed 2026-09-21,
when ChatGPT wrote ledger entry LEDGER-0010 and Claude read it back.

### Governance outside this repository

Storage authority, promotion rules and the wider AI governance chain are
governed by the ACTIVE source in the Admin@ OneDrive, at the drive root:
`Library Intake/_CONTROL - Registers and Coverage Maps/AI_GOVERNANCE/ACTIVE_APPROVED_SOURCE/`
(checked 2026-09-21). It is deliberately not duplicated here, and a search of
this repository says nothing about what exists there.

## Report the check, not the conclusion

The owner should not have to ask "what verified that?" Being asked is already
the failure. The recurring error is **a claim stated wider than the check that
was actually run**. The fix is a constraint on the sentence: one check's worth
of claim per check, and name the check, which drags its scope along with it.

| Said | Should have said | What was actually run |
|---|---|---|
| "no file by that name exists" | "grep over the repo found no match; the drives are unchecked" | one `grep`, repo only -- the file was in OneDrive |
| "the ground flip needs no ink pass" | "safe by cascade reasoning; not seen rendered" | read the sheet -- it shipped an unreadable page |
| "PR #539" | "branch pushed; PR not opened yet" | a `git push` -- no PR existed |
| "the baseline is 526/6677" | "526/6677, measured before the seven DNA merges" | a stale run -- three agents re-measured and were right |
| "`.room` is the biggest risk" | "`.room` has the most collisions; whether they differ is unmeasured" | a count of overlaps, not of defeats |
| "the handoff mechanism is live" | "Claude can write it; ChatGPT's side is unverified" | one round trip, one side of two |

- **Never assert an absence.** Report the search and its scope. "Not in the
  repository" is a finding; "does not exist" is a claim about everywhere.
- **Never report an artifact before the API returns it.** A pushed branch is
  not a pull request. An inferred number is not an identifier.
- **A number carries when and against what it was measured.** A count without
  a SHA is a rumour.
- **"Verified" names its instrument.** Reading code is not runtime
  verification. Cascade reasoning is not a rendered page. A passing test that
  has never been watched to fail is a hypothesis.
- **Superlatives require a measurement.** "Biggest", "worst", "most" are
  claims about a distribution, so either measure it or say it is a guess.

Where a claim cannot be checked from where you are -- above all how a page
looks -- say so in the same sentence, not in a caveat further down. A visual
claim is verified only by a screenshot of the running page or by Jason looking
at it (see Capabilities).

## Independent verification duties

Self-review does not catch what an independent measurement catches. Any
reviewing lane, and every lane of its own work, holds these five:

1. **Re-measure every number.** Never accept a count, ratio, size, or SHA
   because it was stated.
2. **Ask what made a "verified" claim verified.** If the answer is reading the
   code, it is not runtime verification.
3. **Ask whether a new guard was seen to fail.** A test nobody has watched go
   red under a relevant mutation is a hypothesis.
4. **Flag alarm raised without executable or deployed evidence.** A script
   that exists is not a boundary that runs.
5. **Compare deployed behaviour against approved specification.** Nothing else
   covers this. Tests do not know the spec, and no person holds fifty commits
   in their head.

Pushback against one of these is a review issue, not a debate to win. Duty 5
needs a lane that can load the deployed page (see Capabilities). Where none
can, it rests on Jason opening the page, and no lane may imply that deployed
behaviour is being independently watched.

## Evidence is applicable, or it is not evidence

**A green result is evidence only for the property and the execution path it
actually exercised.** A check can run, be exactly as wide as the claim, and
still be unable to detect the defect.

For a material claim -- authorization, safety, privacy, safeguarding, data
integrity, a race, a deployment -- say which **execution path** the instrument
ran and what the evidence does **not** establish. Where the claim is about
something being prevented, a test nobody has watched go red is a hypothesis.
Where the claim is about a deployed environment, the run has to have been
against the state that makes the change observable.

`docs/current/EVIDENCE_APPLICABILITY.md` carries the record format, the
evidence ladder, which instrument fits which claim, and the worked cases.
`apps/web/scripts/check-evidence-applicability.mjs` grades a record's FORM in
CI: a structurally complete record is not a verified claim.

## Authority doctrine (owner decision, 2026-08-20)

This system is implementation and decision support. It is not the final
on-ground authority.

For ordinary coaching and training decisions inside established clearance,
consent, and policy, **the assigned coach is the final human decision-maker**.
The coach may always stop, reduce, or defer an activity.

The coach may **not** override:

- a medical hold or return-to-play restriction;
- guardian/participant consent and privacy boundaries;
- safeguarding or mandatory-reporting obligations;
- applicable law or explicit organizational policy;
- authorization boundaries for an unassigned athlete.

Classify every concern as exactly one of:

- **HARD GATE** -- non-overridable. Name the exact source and its owner.
- **ADVISORY** -- the coach may decide, and records the reason.
- **INFORMATION** -- report it; do not block on it.

Raise a concern **once**, in five lines or fewer:

```
Gate:
Authority:
Evidence:
Decision needed:
Safe next action:
```

Ask at most one decision question. Once an authorized person decides within
their scope, record the decision and continue. Reopen only on materially new
evidence, or when the decision conflicts with a named hard gate.

Do not invent legal prohibitions, repeat generic disclaimers, or turn general
caution into an unrequested product requirement. Where legal applicability is
genuinely uncertain, identify the jurisdiction or policy question and route
only that question to its proper owner.

This matches what the code already enforces: `docs/SHADOW_AUTHORITY_MODEL.md`
keeps final authority human, and AI drafts never set `approved_flag` or a final
decision.

## Lane model

Work runs in parallel lanes, each its own session. The rules below exist
because running that way produced failures a single lane cannot have.

### Merging and releasing (OD-2026-08-29-006)

A build lane MAY: create branches, write code and tests, open pull requests,
investigate and report findings; merge its OWN pull requests to `main` once CI
is green and they are mergeable; and dispatch `deploy-staging` and staging
migrations.

A build lane MAY NOT: merge ANOTHER lane's pull request; dispatch
`deploy-production` or production migrations without Jason's word (the lane
prepares and verifies them, then asks); decide product scope; remove or
disable a feature because it looks out of scope; fix unrelated defects inside
its PR; or act on a scoping question as though it were a decision.

Production is where the split is because an applied migration is not undone by
re-running a workflow. **Green CI is a precondition, never an authorization**:
do not merge over an open review finding, and do not merge while `main` is
frozen for a gated release candidate, because a merge during a freeze
invalidates it. Per-PR CI cannot see a semantic conflict between two green
branches, and a cancelled required check reads as "never validated", not as a
failure. Merging fast is what hid both on 2026-08-27 (#716/#718; #736).

### Pull-request state is its own permission ladder

Treat each of these as separately authorized:

| Action | Who |
|---|---|
| read, review, report | any lane |
| comment on a PR | the lane that owns the PR, or a reviewing lane reporting a finding |
| request a reviewer | owner, or a lane he directs |
| edit title, body or base | the lane that owns the PR |
| open a PR (draft or ready) | the lane that owns the work |
| mark draft ready for review | owner, or a lane he directs |
| submit an APPROVED review | owner or a human delegate only -- no AI lane |
| merge | per "Merging and releasing" above |
| delete a branch | owner, or a lane he directs, and never while the branch is audit evidence |

Authorization to review something is not authorization to change its state.
Authorization for one mutation is not authorization for the next one in the
sequence: opening a PR does not carry marking it ready, and marking it ready
does not carry merging it. A lane that performs one of these on the owner's
instruction records that instruction as its authority. A lane that cannot name
the authority for a mutation it made has already found the defect.

Lanes act through the owner's GitHub account, so a timeline event's `actor` is
the account, not the lane. Do not cite it as proof that a particular lane did
or did not act; the authorizing instruction and the lane's own record are what
attribute it.

### A question is not an instruction

Asking what a change would involve is a request for a finding, not for the
branch that answers it. Report the finding. Build when told to build.

### A decision already made is written down

`docs/current/OWNER_DECISIONS.md` carries the decisions the owner has actually
made, in his own words, with the evidence each rested on. **Read it before
writing a test, gate, migration, or policy constant that asserts who may do
what.** If the policy is recorded there, build to it. If it is not, that is
**OWNER DECISION REQUIRED**: say so and stop. Inventing the answer is the
failure it exists to prevent. If code you are reading contradicts an entry,
that is a finding. Report it; do not assume the entry is stale.

That file records decisions, not environment state.

### Brief header -- required on every PR and status report

```
LANE:        <thread name / branch prefix>
MIGRATIONS:  NONE | <slug list>          <-- never omit
STACKED ON:  NONE | #NNN (state the order)
CONTESTED:   files other lanes may also touch
SCOPE:       what the owner authorized, in his words
```

`MIGRATIONS` matters most. A release is sized and sequenced from it, and a
missing or wrong value produces a code deploy against a schema that does not
have the tables. `NONE` is a real answer and must be written; an omitted line
is not read as `NONE`. CI's `declaration` check enforces the line.

### Stacked work is declared, not discovered

If a branch depends on another unmerged branch, `STACKED ON` says so and gives
the order. A stacked PR retargeted to `main` once its parent lands is normal.
GitHub diffs a stacked PR against its parent, so an undeclared stack reads as
missing CI or an inflated diff.

### Registration conflicts have no blanket answer

`apps/web/package.json` and `.github/workflows/apply-migrations.yml` carry
per-migration registrations. **Read both sides of every conflict.** Never apply
an always-ours or always-theirs rule.

| situation | correct resolution |
|---|---|
| the `test:migrations` chain line, after it became a discovery runner | take **main** |
| branch adds a registration `main` lacks | keep **HEAD** |
| each side carries a *different* registration | keep **both** |
| branch registers nothing; `main` carries one | keep **main** |

A dropped registration removes a migration guard immediately before a
production deploy rather than failing loudly; `pgTestCoverage.test.ts` is what
catches it. Where a resolution keeps one side of a long list line, measure that
it is a strict superset before keeping it.

### Revert individually, never as a range

Unrelated work lands between related commits. Revert commit by commit unless
every commit in the range has been verified to belong to the same concern.

### Handoff

Open the PR. Report the brief header and the evidence. Merge only as
"Merging and releasing" allows.

### Your lane's state is not the system's state

"This lane applied no migrations" is a fact about the lane. "No migrations are
applied anywhere" is a claim about production, and no build lane can check it
from its own record.

Before writing any statement about what is deployed, applied, live, or merged,
either verify it from an authoritative source in that moment, or mark it
**UNKNOWN** and name where you checked. Classify as **VERIFIED / UNKNOWN /
BLOCKED / OWNER DECISION REQUIRED**.

For what is deployed, use live evidence: the latest successful
`deploy-production` / `deploy-staging` run and the Container App's active
revision. `docs/current/PRODUCTION_STATE.json` was last updated 2026-08-28
(production revision `app-ppbf-production--0000148`) and did not record the
September releases (successful `deploy-production` runs on 2026-09-17, 09-18
and 09-19, checked 2026-09-21). Treat it as history until a release session
brings it current.

## Six invariants

1. **Start current.** Reconcile against current `origin/main`; stale branches and old prose are not current behavior.
2. **Search before creating.** Check current source and open PRs before adding a table, route, module, component, document, workflow, or policy.
3. **Keep scope bounded.** One concern per branch/PR. Do not drive-by fix adjacent work. If another open PR owns the same files or contract, sequence instead of colliding.
4. **Preserve hard safety boundaries.** Do not weaken authorization, organization isolation, safeguarding, evidence validation, destructive-data protections, or fail-closed controls merely to make a task pass.
5. **Claims need evidence.** Prefer the smallest relevant executable check while iterating; run the required final gate before claiming completion. Code-reading alone is not runtime proof.
6. **Authority stays external to the model.** Do not deploy, approve production, make destructive data decisions, or invent owner policy without explicit authority. A direct owner/user request is sufficient authority to implement and **open** ordinary bounded repo changes unless a protected environment or domain policy requires a separate human gate. Merging follows the Lane model; a request to build is not a licence to land.

## Execution loop

`classify -> inspect minimum relevant surface -> reuse -> change -> targeted proof -> required final gate -> handoff`

Classify suspected work before implementing it as one of:

- EXISTING
- OPEN_PR
- VERIFIED_GAP
- BLOCKED
- OWNER_DECISION
- DUPLICATE
- STALE_DOC
- NEEDS_MEASUREMENT

`EXISTING`, `OPEN_PR`, `DUPLICATE`, and `STALE_DOC` are not invitations to build another implementation.

## Efficiency rules

- Prefer deletion, correction, closure, or reuse over expansion.
- Prefer existing primitives over parallel sources of truth.
- A ticket is optional for direct user/owner-requested work. Use one when coordination, handoff, scheduling, or a durable decision record adds value.
- During development, run targeted tests first. Do not repeatedly run the entire repository gate after every small edit.
- Batch file inspection before editing; avoid read-one/edit-one dependency discovery loops.
- Escalate only decisions that genuinely change policy, safety, access, destructive data handling, scientific/coaching doctrine, disclosure, or production approval.
- When a repeated manual investigation can be replaced by a cheap deterministic diagnostic/test, prefer the deterministic check.
- Open PR state belongs in GitHub; query it live instead of copying it into another ledger.

## What this repository does that will surprise you

Each line below cost real time to rediscover, and each was observed, not
inferred. Where a claim has an obvious way to check it, the check is named.

**CI**

- **A check can be green because it never ran.** `ci.yml` triggers on
  `pull_request: branches: [main]` with default types, so a PR targeting
  another branch gets no `validate` and no `verify` -- only `declaration`,
  from `migration-declaration.yml`. Retargeting a PR to `main` does not fix
  this: a base change is `pull_request.edited`, which `ci.yml` does not listen
  for. Push a real commit to trigger it.
- **Docs-only changes take a fast path.** `scripts/ci-classify-paths.mjs`
  classifies a docs-only diff (for example `AGENT_KERNEL.md`) as `docsOnly`, and
  `ci.yml` then skips install, typecheck, lint and `npm test`. Suites that
  assert on doc text
  (`evidenceApplicabilityContract.test.ts` reads this file) must be run by
  hand on a docs PR.
- **Whether your new test will even run.** `scripts/ci-classify-paths.mjs`
  decides which Playwright suites CI executes from the changed-file list. A
  suite whose predicate does not match the files you touched **does not run**,
  and CI is green without it. Before relying on a new e2e assertion, run
  `node scripts/ci-classify-paths.mjs <file-with-changed-paths>` and confirm
  the flag for the suite holding it comes back `true`.
- **Two green PRs can break `main` between them.** Git merges adjacent
  insertions with no conflict. Twice this made `apply-migrations.yml` a bash
  syntax error while a coverage test passed over it, because every assertion
  read the first `workflow.match(...)` and stopped. The guards now exist
  (`every run step in the workflow is parseable shell`, and the declaration
  count).

**Running the tests** (cloud container sandbox, Linux, unless marked)

- `npm test` in full is **OOM-killed** in the standard agent sandbox -- exit
  code 137 and no failing test, which reads like a crash and is not one. Run
  it in halves, or by path (`components/`, then `app/`), and say in the PR
  that the full run was not executed locally.
- **Jest does not typecheck.** ts-jest runs with no diagnostics and the
  project sets `isolatedModules`, so a deliberate `const x: number = "no"`
  sits in a green suite. Any guarantee that rests on the type system -- an
  exhaustive `Record<Union, …>`, a discriminated union, a narrowed literal --
  is enforced by `npm run typecheck` in CI and by nothing you run locally with
  jest. Do not write "will not compile" in a test comment; write which command
  enforces it.
- `.pg.test.ts` suites are **excluded from `npm test`**. A new one must be
  wired into the `test:migrations` chain in `apps/web/package.json` or
  `pgTestCoverage.test.ts` reds the build -- naming the file, but only after
  you have pushed. The agent container has only the `psql` client, no
  Postgres, so a build lane there cannot run `.pg.test.ts` or
  `npm run test:migrations`; `pre-release-migrations.yml` is that gate.
- **Windows (Jason's PC):** embedded-Postgres suites run locally, but a killed
  jest run skips cleanup for every suite, orphaning `postgres.exe` and leaving
  `%TEMP%\ppbf-*-pg-test-*` folders. Run one pg suite per jest process with a
  timeout long enough to finish.
- Playwright runs from `apps/web`, with
  `PPBF_CHROMIUM_PATH=/opt/pw-browsers/chromium`. Never run
  `playwright install`; the browser is preinstalled and the download is
  blocked. From the repo root the projects list resolves empty and every
  `--project=` argument fails with "not found", which looks like a config
  error and is a working-directory error.
- **A git worktree has no `node_modules`.** The install is hoisted, and
  several scripts resolve `REPO_ROOT` and need `node_modules/.bin/tsx` beneath
  it. Run `npm ci` at the worktree root first, or they fail in a way that reads
  as a code defect.

**A hang with no output is almost always this**

A `useRouter` mock that returns a **fresh object per render** closes an
infinite loop with any component that subscribes to the role-session store:
`persist → notify → render → new router identity → effect → persist`.
`RoleSessionGate`'s effect depends on `[router]`, so the loop is synchronous
and the suite hangs with no failing assertion and no timeout. Declare one
`const router = { push: jest.fn(), replace: jest.fn() }` at module scope and
return it. A test that passed for months can start hanging because a component
it renders begins reading the session store.

**Deploying to staging**

- `expected_sha` must be the **full 40-character SHA**. An abbreviated one is
  refused, correctly, by the first gate step.
- **Re-running a workflow run does not re-supply `workflow_dispatch` inputs.**
  A re-run arrives with `expected_sha` empty and is refused. Dispatch a fresh
  run instead.
- `enable_shadow_gate` turns on the post-deploy gate steps. Any step
  conditioned on an input inherits GitHub's implicit `success()`, so **an
  earlier step failing skips the later ones silently** -- a skipped
  safeguarding probe and a passing one look the same in the run summary. Read
  the step list, not the job conclusion.
- The deploy and the gate are different things. A run can deploy the revision
  successfully and still fail on a gate that runs after it, which means the
  new image IS live on staging even though the run is red.

## Source hierarchy

When sources disagree:

1. current executable code and enforced infrastructure describe current behavior;
2. the current user request, approved work order, or assigned ticket defines implementation intent/scope;
3. `docs/current/ACTIVE_WORK.md` records only blocked and intentionally parked work;
4. domain contracts govern their specific boundary;
5. `docs/current/WORK_QUEUE.md`, dated audits, `docs/archive/`, superseded plans, and old local branches are historical/provenance evidence only.

For deployed-state claims, use live/gatekeeper-observed evidence rather than source inference.

## Output

Keep handoffs compact:

`Item | Classification | Evidence | Change | Tests | Blocker/Next`

Explain more only when risk, ambiguity, or a decision requires it.
