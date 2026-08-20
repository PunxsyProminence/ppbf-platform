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

So the lanes are:

- **Claude** -- project command thread. Repository execution: code, tests,
  branches, PRs, migrations, CI, staging, and explicitly authorized production
  deployment. Reports exact evidence.
- **ChatGPT** -- independent audit, research, full-spectrum review, storage
  inventory and reconciliation, documentation, control ledger, and
  deployed-versus-specification verification. Read-only on this repository;
  no branches, commits, pushes, merges, deploys, or migrations.
- **Grok** -- image files only, per `docs/GROK-VISUAL-LANE.md`.
- **Jason** -- final authority. Priorities, scope, mutation approval,
  production authorization, acceptance, conflict resolution.

Storage authority, promotion rules and the wider AI governance chain remain
governed by the ACTIVE source in OneDrive at `Documents/Library Intake/_CONTROL
- Registers and Coverage Maps/AI_GOVERNANCE/ACTIVE_APPROVED_SOURCE/`. That
source is deliberately *not* duplicated here; it is named so a reader knows
this file is not the whole picture. Claude claimed that master did not exist --
it does, exactly where ChatGPT said. The search was of this repository and the
claim was reported without that qualifier: a real check, stated wider than it
was run.

## Independent verification duties (agreed by both lanes, 2026-08-20)

Project command, repository command and repository implementation now sit on
the same side. That puts three roles on one party, so the check has to be
structural rather than polite -- and it matters more under the 2026-08-20
decision than it did before, not less.

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
