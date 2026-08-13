# Intake

Optional handoff space for work that benefits from a durable ticket or for complete output produced by an AI without repository execution.

Ordinary owner-directed work may proceed directly through the normal path in `AGENT_KERNEL.md`:

```text
request -> current source/open PR check -> bounded branch -> targeted proof -> CI -> review if warranted -> merge
```

Repository rules: [docs/AI_CONTRIBUTOR_GUARDRAILS.md](../docs/AI_CONTRIBUTOR_GUARDRAILS.md). Release procedure: [docs/AI_DELIVERY_PIPELINE.md](../docs/AI_DELIVERY_PIPELINE.md).

```text
intake/
  tickets/        optional durable briefs, one file per unit of work
  tickets/done/   historical shipped tickets with evidence
  drops/          gitignored candidate output from chat-only AIs, mirroring repo paths
```

## Tickets

Use a ticket when coordination, scheduling, a durable decision record, or a self-contained handoff adds value. A ticket is not required merely to authorize coding after Jason has directly requested the work.

## Chat-only AI drops

A drop is candidate material, not trusted repository state.

1. Save complete files or a complete patch under `drops/<ticket-or-task-id>/`.
2. Any current repo-capable AI/session may reconcile that material with current `main` on a bounded branch.
3. The integrating session runs the relevant targeted checks and relies on CI for the final gate.
4. Failed or stale output is corrected in normal development or discarded; it is not silently forced through a special gatekeeper role.

There is no permanent builder, gatekeeper, deploy coordinator, or production bot. AI responsibilities are assigned per task. Jason retains product, safety, destructive-data, rollback, and production-approval authority.

## Production

Merging work does not automatically deploy it. When Jason opens a release lane, the current repo-capable AI/session follows `docs/AI_DELIVERY_PIPELINE.md`; GitHub Actions performs the technical gates, and Jason approves the protected production environment.
