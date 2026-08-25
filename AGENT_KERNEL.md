# PPBF Agent Kernel

The shortest authoritative startup contract for AI work in this repository.

## Read path

For ordinary implementation work, read only:

1. this file;
2. `docs/current/ACTIVE_WORK.md` for current blockers/parked work;
3. the user request or assigned ticket, if one exists.

Read additional documents only when the task actually touches their domain:

- concurrent/multi-AI work -> `docs/AI_COLLABORATION.md`
- shipping, staging, production, or migration release work -> `docs/AI_DELIVERY_PIPELINE.md`
- SHADOW safety/model behavior -> relevant SHADOW contract/spec plus the applicable sections of `docs/AI_CONTRIBUTOR_GUARDRAILS.md`
- authentication/roles -> `AUTH_CONTRACT.md` and `ORGANIZATION_ROLE_MODEL.md`
- database/schema/migrations -> database rules in `docs/AI_CONTRIBUTOR_GUARDRAILS.md` and the existing migration/runner pattern
- visual design -> `design-system/README.md` and `design-system/ppbf.css`
- audit/provenance/history -> `docs/current/WORK_QUEUE.md`

Do not preload archived audits, the historical queue, superseded plans, old build plans, or unrelated domain rules.

## Working channel (owner decision, 2026-08-19)

All repository work runs through the owner's primary Claude Code session. No
other channel -- another AI session, a connector, a chat tool relaying
commits -- commits, pushes, or merges here on its own authority. Work
originating elsewhere (designs, research, generated assets) enters as a
branch or PR that the primary session or the owner reviews before merge;
binary assets enter through real file upload, never re-encoded through a
chat channel.

Direct pushes to `main` are prohibited for everyone, including agents that
technically can. Every change lands by PR with green CI. This rule exists
because on 2026-08-19 nine direct-to-main pushes from a secondary channel
destroyed `apps/web/package.json` (39,755 bytes -> 327), left `main` unable
to build, test, or migrate, and a docs-only CI fast path then painted it
green; the same channel's base64 relay truncated a binary asset mid-file.
Written policy reports; branch protection enforces -- only the owner can
set the required status checks that make this rule technical rather than
textual.

**Scope (owner decision, 2026-08-20).** As written on 2026-08-19 this section
governed *repository* work only. Claude read repository execution control as
project command control; ChatGPT read the text as repository-scoped and was
correct about what the text said.

The owner then decided the question rather than the reading: **the primary
Claude session is the PPBF project command thread**, not only the repository
one. ChatGPT operates as the independent audit, research, storage,
documentation and verification lane.

Both facts are recorded because they are different things. The 2026-08-19 text
did not say project-level; the 2026-08-20 decision does. A later reader
resolving the chain cold should not have to guess which.

**Amendment (owner decision, 2026-08-22).** The 2026-08-19 text made this
session the *only* repository-writing channel, and that clause is now
narrowed: **Grok writes to this repository too**, on feature branches, by PR,
for visual work it designed and the owner approved. Everything else in this
section stands unchanged -- nobody direct-pushes `main`, every change lands by
PR with green CI, and binary assets still enter by real file upload rather
than through a chat channel.

**Amendment (owner decision, 2026-08-24).** The 2026-08-22 amendment let Grok
write code to this repository but left the *binary* on a relay: an approved
plate went Grok -> OneDrive inbox -> Claude -> GitHub. That hop is removed.
**Grok uploads the real JPEG binary directly into its own visual feature
branch at the correct repository path**, performs its own 4:4:4 preparation
and verification, makes any approved visual/CSS/test change the plate needs,
and opens the PR. The path is now:

    Grok real binary -> Grok feature branch -> PR -> independent review and
    gates -> merge

**Claude is removed from the transport step for plate binaries.** On a Grok
visual PR, Claude reviews -- functional behaviour, auth, authorization,
organization isolation, safeguarding, medical and hold semantics, role
vocabulary, business logic, SHADOW logic, tests, scope, CI -- and may
independently verify the committed plate against the byte gate. It does not
download a plate from OneDrive in order to commit it, and does not relay,
reconstruct, re-encode, rename, or otherwise courier a binary. `Grok-Plates-
Inbox` is retained as a provenance and archive drop under storage governance;
it is **no longer a mandatory transport hop, and Claude must not poll it as a
prerequisite for a Grok visual PR.** A Grok visual PR must be able to ship
without it.

The reason is the same failure the relay was meant to prevent, arriving from
the other direction. On 2026-08-24 Claude spent several exchanges trying to
retrieve six approved plates it could see but could not fetch: the connector
returns a rendered image rather than bytes, and the storage host is refused at
the sandbox proxy. Nothing was wrong with the plates. The courier could not
carry them, and the only ways past that -- reconstructing an image from a
rendering, or relaying it through a chat channel -- are precisely what the
plate laws forbid, for the reason recorded above. A step that can only be
completed by breaking the rule it serves is not a step.

**No plate law changes.** Real `.jpg` binary only; never base64, data URI, or
chat-byte relay; JPEG SOI and EOI present; larger than 8 KB; at most 400 KB;
4:4:4 with every component 1x1; only the declared landscape and portrait
geometries (1280x720 / 2560x1440 landscape, 405x720 / 810x1440 portrait);
filename orientation matching the image; every CSS-declared plate existing on
disk; the exact ordered filename; no silent re-encode inside the repository;
bad input refused rather than quietly corrected.
`apps/web/src/design/plateBinaries.test.ts` enforces these on the bytes and is
not to be weakened. Moving who carries the file changes nothing about what the
file must be.

**Amendment (owner ruling, 2026-08-25).** Jason, verbatim: *"the document that
gets it live, accept the binary, is correct."* **The blanket courier
prohibition above is lifted.** Where the owner directs it, Claude may accept a
binary and land it on a branch like any other file, and no round should be
spent arguing about whose job that is.

The ruling settles a policy question that was never the actual obstacle, so the
obstacle is now written down here rather than rediscovered every few days.
**Claude cannot retrieve bytes out of SharePoint or OneDrive in this
environment.** The Microsoft 365 connector *renders* an image for viewing; it
does not return file contents. There is no download action, no unzip
capability, and `downloadUrl` comes back null. A zip is completely
inaccessible. This is a capability fact, checked rather than preferred: it is
not a rule anyone can waive, and an instruction of the form "Claude downloads
the package from OneDrive and commits it" does not run. Four delivery rounds
were spent on handoffs written that way.

Two clauses from 2026-08-24 survive the ruling, on different grounds.
**Re-encode** stands because the tools are absent -- no `cjpeg`, no `jpegtran`,
no ImageMagick, no Pillow -- and because silently correcting a bad input hides
that the producer's pipeline is wrong. **Reconstruct** stands because an image
rebuilt from a rendering is a new picture, not the approved file, and would
pass the byte gate while being the wrong plate.

**And a definition, since four rounds turned on it: a binary is delivered when
a real `git add` of the actual file lands on a branch.** A README, a manifest,
a folder path, a link, a zip in a drive, a base64 payload, or a `.jpg`-named
placeholder is not a delivery however complete its covering note reads. The
record: three chat-relay rounds arrived as 11-, 24- and 41-byte stubs; a fourth
arrived at 2.3 KB with a valid JPEG start-of-image marker, no end-of-image
trailer and the wrong dimensions; and PR #643 (2026-08-25) contained no
binaries at all -- a manifest naming twelve JPEGs held in OneDrive, plus a
ten-byte `_smoke_binary_test.jpg` reading `REPLACE_ME`. The working routes are
Grok pushing to its own branch, Jason drag-dropping onto the branch, or Claude
landing bytes it can actually read. `apps/web/public/plates/README.md` and
`docs/GROK-VISUAL-LANE.md` carry the detail.

The reason for the change is drift, and it is worth stating plainly because
the original rule was not wrong when it was written. Routing every visual
design through one party to be re-implemented by another lost fidelity at the
handoff: the implementer had to re-derive intent from a picture, and the
designer never saw what shipped. Keeping design and implementation in one
lane removes that translation step. It does *not* remove the independent
check -- it moves it to where it belongs, on the PR.

So the lanes are:

- **Claude** -- functional and security engineering: backend, APIs, schema,
  migrations, authentication, authorization, organization isolation,
  safeguarding, medical/hold enforcement, business logic, SHADOW functional
  architecture, functional and migration tests, release engineering. Branches,
  PRs, CI, staging, and explicitly authorized production deployment. Reports
  exact evidence.

  **On visual PRs Claude is an independent reviewer, not a redesigner.** It
  checks that no function, role gate, organization boundary or safety rule
  changed, that nothing unsupported was invented, that no existing action
  disappeared, and that tests stayed meaningful. It may independently verify a
  committed plate against the byte gate. Since 2026-08-25 it may also accept
  and land a binary where the owner directs it; it still does not re-encode or
  reconstruct one, and it **cannot** fetch bytes out of SharePoint/OneDrive at
  all -- that last one is a capability limit rather than a rule, so no
  instruction can grant it. A visual preference that is not a defect is not
  grounds to rewrite another lane's approved work.
- **ChatGPT** -- independent audit, research, full-spectrum review, storage
  inventory and reconciliation, documentation, control ledger, exact-head SHA
  and CI verification, scope auditing, and deployed-versus-specification
  verification. Read-only on this repository; no branches, commits, pushes,
  merges, deploys, or migrations.
- **Grok** -- visual design **and** visual implementation, including
  committing approved plate binaries to its own feature branch (2026-08-24),
  per `docs/GROK-VISUAL-LANE.md`. When Grok's own tooling cannot push a binary,
  the fallback is Jason drag-dropping the real files onto the branch, never a
  handoff asking Claude to fetch them from a drive. Reads current source before designing; explores
  and proposes freely; implements only what the owner approved. May change
  presentation: JSX visual structure, design-system classes, CSS, responsive
  layout, typography, visual assets, presentation-related accessibility
  markup, and the visual tests that cover them. May **not** change schema,
  migrations, API behaviour, auth, authorization, organization scoping,
  guardian/athlete access rules, safeguarding, medical or hold semantics, role
  vocabulary, business logic, SHADOW or progression algorithms, data models,
  audit semantics, or server security boundaries without a separate
  owner-approved functional task. Invents nothing -- no roles, athlete data,
  metrics, statuses, navigation destinations, medical information, security
  claims, or buttons with no backing behaviour.
- **Jason** -- final authority. Priorities, scope, mutation approval,
  visual approval, production authorization, acceptance, conflict resolution.
  No lane converts a visual idea into a product decision on its own.

Storage authority, promotion rules and the wider AI governance chain remain
governed by the ACTIVE source in OneDrive at `Documents/Library Intake/_CONTROL
- Registers and Coverage Maps/AI_GOVERNANCE/ACTIVE_APPROVED_SOURCE/`. That
source is deliberately *not* duplicated here; it is named so a reader knows
this file is not the whole picture. Claude claimed that master did not exist --
it does, exactly where ChatGPT said. The search was of this repository and the
claim was reported without that qualifier: a real check, stated wider than it
was run.

## Report the check, not the conclusion (owner instruction, 2026-08-20)

The owner should not have to ask "what verified that?" Being asked is already
the failure.

Every error Claude made on 2026-08-20 was the same shape: **a claim stated
wider than the check that was actually run.** The underlying work was mostly
sound. The reporting was not, and it reached the owner every time.

The fix is a constraint on the sentence, not a resolution to be careful. If
one check ran, the sentence may carry one check's worth of claim. Naming the
check drags the scope along with it automatically.

| Said | Should have said | What was actually run |
|---|---|---|
| "no file by that name exists" | "grep over the repo found no match; the drives are unchecked" | one `grep`, repo only -- the file was in OneDrive |
| "the ground flip needs no ink pass" | "safe by cascade reasoning; not seen rendered" | read the sheet -- it shipped an unreadable page |
| "PR #539" | "branch pushed; PR not opened yet" | a `git push` -- no PR existed |
| "the baseline is 526/6677" | "526/6677, measured before the seven DNA merges" | a stale run -- three agents re-measured and were right |
| "`.room` is the biggest risk" | "`.room` has the most collisions; whether they differ is unmeasured" | a count of overlaps, not of defeats |
| "the handoff mechanism is live" | "Claude can write it; ChatGPT's side is unverified" | one round trip, one side of two |

Rules that follow:

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

Where a claim genuinely cannot be checked from here -- anything about how a
page looks, above all -- say so in the same sentence rather than in a caveat
further down. `docs/CHATGPT-AUDIT-LANE.md` records that no AI lane can load a
deployed page, so **every visual claim in this project is unverified by
construction** and must be stated that way without being asked.

## Independent verification duties (agreed by both lanes, 2026-08-20)

Project command, repository command and repository implementation sat on the
same side under the 2026-08-20 decision. That put three roles on one party, so
the check had to be structural rather than polite.

The 2026-08-22 amendment splits visual implementation back out to Grok, which
relieves that specific concentration and creates a different one: a lane that
designs its own work and then implements it grades its own homework unless
someone else looks. Either way the answer is the same, which is why these
duties are unchanged -- they were never about *which* party held the roles,
only about the fact that self-review does not catch what an independent
measurement catches.

What actually caught Claude's errors on 2026-08-20 was never Claude reviewing
Claude: it was an independent party *measuring*, a mechanical process, or the
owner looking at the live page. Design accordingly.

Any reviewing lane -- and Claude, of its own work -- holds these five:

1. **Re-measure every number.** Never accept a count, ratio, size, or SHA
   because it was stated. Three agents were handed a stale test baseline that
   day; all three re-measured, and all three were right.
2. **Ask what made a "verified" claim verified.** If the answer is reading the
   code, it is not runtime verification. A ground flip was called safe on that
   basis and shipped an unreadable page.
3. **Ask whether a new guard was seen to fail.** A test nobody has watched go
   red under a relevant mutation is a hypothesis. Two of four guards written
   that day passed every mutation put to them until they were rewritten.
4. **Flag alarm raised without executable or deployed evidence.** A gate was
   reported as an abandoned safety boundary because a script existed; the
   script could not run and the boundary was covered three other ways.
5. **Compare deployed behaviour against approved specification.** Nothing else
   covers this. Tests do not know the spec, and no person holds fifty commits
   in their head.

Pushback against one of these is a review issue, not a debate to win.

**Known gap, stated rather than implied:** as of 2026-08-20 no AI lane can
load a deployed page. Claude's sandbox refuses outbound HTTPS; ChatGPT's
browser tool could not load the staging URL. Duty 5 therefore rests entirely
on the owner opening the page. No lane should imply deployed behaviour is
being independently watched while that holds.

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

This is consistent with what the codebase already enforces and makes the
specifics explicit: `docs/SHADOW_AUTHORITY_MODEL.md` states final authority
remains human, six `docs/capabilities/modules/*.md` state AI drafts never set
`approved_flag` or final decisions, and invariant 4 below already forbids
weakening safeguarding, authorization, and fail-closed controls. What this adds
is who decides, which boundaries are not theirs to move, and the shape of
raising it.

## Six invariants

1. **Start current.** Reconcile against current `origin/main`; stale branches and old prose are not current behavior.
2. **Search before creating.** Check current source and open PRs before adding a table, route, module, component, document, workflow, or policy.
3. **Keep scope bounded.** One concern per branch/PR. Do not drive-by fix adjacent work. If another open PR owns the same files or contract, sequence instead of colliding.
4. **Preserve hard safety boundaries.** Do not weaken authorization, organization isolation, safeguarding, evidence validation, destructive-data protections, or fail-closed controls merely to make a task pass.
5. **Claims need evidence.** Prefer the smallest relevant executable check while iterating; run the required final gate before claiming completion. Code-reading alone is not runtime proof.
6. **Authority stays external to the model.** Do not deploy, approve production, make destructive data decisions, or invent owner policy without explicit authority. A direct owner/user request is sufficient authority to implement and open/merge ordinary bounded repo changes unless a protected environment or domain policy requires a separate human gate.

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

## Source hierarchy

When sources disagree:

1. current executable code and enforced infrastructure describe current behavior;
2. the current user request or assigned ticket defines implementation intent/scope;
3. `docs/current/ACTIVE_WORK.md` records only critical-path blockers and intentionally parked work;
4. domain contracts govern their specific boundary;
5. `docs/current/WORK_QUEUE.md`, dated audits, archived documents, superseded plans, and old local branches are historical/provenance evidence only.

For deployed-state claims, use live/gatekeeper-observed evidence rather than source inference.

## Output

Keep handoffs compact:

`Item | Classification | Evidence | Change | Tests | Blocker/Next`

Explain more only when risk, ambiguity, or a decision requires it.
