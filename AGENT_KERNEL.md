# PPBF Agent Kernel

The shortest authoritative startup contract for AI work in this repository.

## Read path

For ordinary implementation work, read only:

1. this file;
2. `docs/current/WORK_QUEUE.md` for current work and collisions;
3. the assigned ticket in `intake/tickets/`.

Read additional documents only when the task actually touches their domain:

- shipping, staging, production, or gatekeeper work -> `docs/AI_DELIVERY_PIPELINE.md`
- SHADOW safety/model behavior -> relevant SHADOW contract/spec plus the applicable sections of `docs/AI_CONTRIBUTOR_GUARDRAILS.md`
- authentication/roles -> `AUTH_CONTRACT.md` and `ORGANIZATION_ROLE_MODEL.md`
- database/schema/migrations -> database rules in `docs/AI_CONTRIBUTOR_GUARDRAILS.md` and the existing migration/runner pattern
- visual design -> `design-system/README.md` and `design-system/ppbf.css`

Do not preload archived audits, superseded queues, old build plans, or unrelated domain rules.

## Six invariants

1. **Start current.** Reconcile against current `origin/main`; stale branches and old prose are not current behavior.
2. **Search before creating.** Check source, current queue, tickets, and open PRs before adding a table, route, module, component, document, workflow, or policy.
3. **Keep scope bounded.** One concern per branch/PR. Do not drive-by fix adjacent work. If another open PR owns the same files or contract, sequence instead of colliding.
4. **Preserve hard safety boundaries.** Do not weaken authorization, organization isolation, safeguarding, evidence validation, destructive-data protections, or fail-closed controls merely to make a task pass.
5. **Claims need evidence.** Prefer the smallest relevant executable check while iterating; run the required final gate before claiming completion. Code-reading alone is not runtime proof.
6. **Authority stays external to the model.** Do not merge, deploy, approve production, make destructive data decisions, or invent owner policy unless the assigned role/ticket explicitly grants that authority.

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
- During development, run targeted tests first. Do not repeatedly run the entire repository gate after every small edit.
- Batch file inspection before editing; avoid read-one/edit-one dependency discovery loops.
- Escalate only decisions that genuinely change policy, safety, access, destructive data handling, scientific/coaching doctrine, disclosure, or production approval.
- When a repeated manual investigation can be replaced by a cheap deterministic diagnostic/test, prefer the deterministic check.

## Source hierarchy

When sources disagree:

1. current executable code and enforced infrastructure describe current behavior;
2. `docs/current/WORK_QUEUE.md` describes current work ownership/state;
3. the assigned ticket defines implementation scope and acceptance criteria;
4. domain contracts govern their specific boundary;
5. dated audits, archived documents, superseded plans, and old local branches are historical evidence only.

For deployed-state claims, use live/gatekeeper-observed evidence rather than source inference.

## Output

Keep handoffs compact:

`Item | Classification | Evidence | Change | Tests | Blocker/Next`

Explain more only when risk, ambiguity, or a decision requires it.
