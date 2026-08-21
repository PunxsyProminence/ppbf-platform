# Intake

Optional handoff space. A ticket is OPTIONAL: direct owner-requested work
proceeds through the normal path in `AGENT_KERNEL.md` with no ticket at all.
Use a ticket only when coordination, scheduling, a durable decision record,
or a self-contained handoff adds value.

```text
intake/
  tickets/   optional durable briefs (T-nnn), one file per unit of work
  drops/     gitignored drop zone for complete output from chat-only AIs
```

## Ticket lifecycle (all in place — files are not moved)

1. Copy `tickets/T-000-template.md` to `tickets/T-nnn-<slug>.md`.
2. Track state on the `Status:` line (in practice: READY, CLAIMED, BACKLOG,
   RESOLVED). On completion, set RESOLVED and append a delivery or
   reconciliation note with PR/verification evidence to the same file.
3. The PR template asks for "T-nnn from `intake/tickets/`, or
   `untracked: <why this exists>`" — untracked is normal for direct requests.

## Drops

A drop is candidate material, never trusted repository state. Chat-only AIs
save complete files or a patch under `drops/<ticket-or-task-id>/`; any
repo-capable session reconciles it onto a bounded branch, runs targeted
checks, and relies on CI. Stale output is fixed in normal development or
discarded. Jason retains product, safety, destructive-data, rollback, and
production-approval authority (release lane: `docs/AI_DELIVERY_PIPELINE.md`).
