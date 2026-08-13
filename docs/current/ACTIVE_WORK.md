# Active work

This is the small builder-facing view of work that can affect what gets built next.

Do **not** preload `docs/current/WORK_QUEUE.md` for ordinary implementation. That file is the detailed historical/verification ledger and preserves prior deployment evidence, collision history, and unresolved audit context.

## Builder rule

A direct owner/user request may go straight to a bounded branch/PR after checking current source and open PRs. A ticket is optional unless the work needs coordination, handoff, scheduling, or a durable decision record.

Use only these working states here:

- `NOW` — buildable current work
- `BLOCKED` — cannot be built correctly without a real product/safety/data decision
- `PARKED` — valid idea or debt, but not allowed to slow unrelated work

Open PR state belongs in GitHub and should be queried live rather than copied here.

## NOW

No standing queue item currently has to be completed before user-directed platform work can proceed.

## BLOCKED

None. A blocked item should only live here when it is genuinely on the critical path for current work.

## PARKED

| Item | Why it is parked | Re-open when |
|---|---|---|
| `BACKLOG-activity-log-backfill` | Legacy attendance sources cannot support a trustworthy synthetic history. Do not invent a backfill. `pilot.activity_log` is go-forward evidence. | A specific requirement appears for importing legacy history with an explicit provenance/conflict policy. |
| `BACKLOG-triage-keyboard` | A one-key approval path is not meaningful until the queue exposes a review-complete/eligible action. | The review queue has a deterministic eligibility signal. |
| `BACKLOG-offline-write-queue` | Persisting minors' check-ins on a shared tablet creates identity, attribution, and data-at-rest problems. | A concrete identity-scoped encrypted/offline storage design is selected. |
| `BACKLOG-grant-packet` | The rendering foundation exists; the unresolved question is what aggregate minor-related data may be disclosed externally. | A real grant/export request defines the disclosure set and privacy threshold. |
| `BACKLOG-open-route-gates` | Route visibility and authorization are not the same thing; changing `buildingMap.ts` alone protects nothing. | A route is shown to expose a real unintended surface, then fix that route's own guard directly. |

## Verification debt

Historical runtime-verification gaps (including T-001/T-002 and the PR-238 bulk deployment) are evidence debt, not a blanket blocker on new development. Run the relevant runtime probe when touching or releasing the affected surface; do not force every unrelated builder to reconstruct the entire deployment history.

## Historical ledger

For audit/provenance questions only, use `docs/current/WORK_QUEUE.md`. It retains the old detailed state machine, deployment evidence, collision notes, and shipped history. Those records are evidence, not the ordinary build workflow.
