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
