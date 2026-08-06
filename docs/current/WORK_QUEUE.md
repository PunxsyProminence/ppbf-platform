# Work queue — current

The single authoritative queue. Supersedes
[docs/WORK_QUEUE.md](../WORK_QUEUE.md) and
[docs/WORK_QUEUE_2026-08-01.md](../WORK_QUEUE_2026-08-01.md), both marked
superseded and left in place as history. If either contradicts this file,
this file wins.

Process: [docs/AI_DELIVERY_PIPELINE.md](../AI_DELIVERY_PIPELINE.md). Rules of
conduct: [docs/AI_CONTRIBUTOR_GUARDRAILS.md](../AI_CONTRIBUTOR_GUARDRAILS.md).
Current production truth:
[docs/current/PRODUCTION_STATE.json](PRODUCTION_STATE.json).

## State machine

```
BACKLOG → READY → CLAIMED → IMPLEMENTING → PR_OPEN → CI_GREEN
        → INTEGRATION_REVIEW → STAGING_READY → STAGING_DEPLOYED
        → RUNTIME_VERIFIED → PRODUCTION_READY → PRODUCTION_DEPLOYED
        → PRODUCTION_VERIFIED → DONE
```

Side states, reachable from anywhere above: `BLOCKED`, `DUPLICATE`,
`REFUTED`, `SUPERSEDED`, `ABANDONED`. A ticket that lands in one of these
stops moving forward; record why in its row.

| State | Means | Who may set it |
|---|---|---|
| `BACKLOG` | Identified, not yet written as a ticket | anyone (audit, owner, gatekeeper) |
| `READY` | Ticket file exists in `intake/tickets/`, owner approved it for pickup | owner |
| `CLAIMED` | A builder has it; row names the builder and the date | builder, recorded by gatekeeper |
| `IMPLEMENTING` | Builder is actively working | builder |
| `PR_OPEN` | Draft PR exists (Lane A) or drop has landed and gatekeeper opened a PR (Lane B) | builder or gatekeeper |
| `CI_GREEN` | GitHub `validate` check passed on the PR | observed by gatekeeper, not asserted by builder |
| `INTEGRATION_REVIEW` | Gatekeeper is running the verification steps (pipeline doc, "What the gatekeeper runs") | gatekeeper only |
| `STAGING_READY` | Merged to `main`, about to be staged | gatekeeper only |
| `STAGING_DEPLOYED` | `deploy-staging` succeeded for this SHA; digest recorded in the row | **gatekeeper only** |
| `RUNTIME_VERIFIED` | Gatekeeper ran the acceptance-criteria probe against staging and it passed | **gatekeeper only** |
| `PRODUCTION_READY` | Staging evidence attached, no open release blocker, owner has what they need to approve | **gatekeeper only** |
| `PRODUCTION_DEPLOYED` | `deploy-production` succeeded; the owner's environment-gate approval already happened as part of that run | **gatekeeper only**, after the owner's GitHub approval click |
| `PRODUCTION_VERIFIED` | Gatekeeper re-read the live container app's SHA + digest and ran smoke checks against production | **gatekeeper only** |
| `DONE` | Ticket moved to `intake/tickets/done/` with its Shipped section filled in | **gatekeeper only**, for runtime features |

Documentation-only tickets (no code path affected) may define their own
completion rule in the ticket body — e.g. "DONE when merged to main" — and
skip the staging/production states entirely. State that explicitly in the
ticket so nobody assumes it needs a deploy.

**No item may skip a state.** A ticket does not reach `DONE` because code
exists on a branch, and it does not reach `PRODUCTION_READY` without a
`STAGING_DEPLOYED` row and a `RUNTIME_VERIFIED` row above it, unless it is
documentation-only.

## Queue

| ID | Pri | Title | Owner | Type | State | Depends on | Files/area | Risk | PR | Env | Verified by | Blocker | Updated |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| T-001 | P3 | Admin activation-code console (or remove dead route) | unclaimed | build | READY | none | `admin/activation-codes/**` | low | — | — | — | Ticket makes builder decide build-vs-delete first | 2026-08-06 |
| T-002 | P1 | Covering coach cannot access an athlete they don't own | unclaimed | build | READY | none | `access.ts`, new migration | medium — auth + schema | — | — | — | Builder must pick coverage model, state rejected alternative | 2026-08-06 |
| T-003 | P0 | Admin console for quarantined-video scan-review escalation | unclaimed | build | READY | none | `admin/video-review/**` | medium — safeguarding, minors' footage | — | — | — | none | 2026-08-06 |
| PR-238a | P1 | Attendance Engine (#122): reporting rollup, bulk check-in, parent-method attribution fix + migration | session B (remote) | build | PR_OPEN | none | `schedulerDb.ts`, `attendanceReporting.ts`, `scheduler/**`, `admin/attendance`, 1 migration | medium — schema + role attribution | [#238](https://github.com/PunxsyProminence/ppbf-platform/pull/238) | — | — | none | 2026-08-06 |
| PR-238b | P1 | Safety Gate Matrix (#3/#43): `safety_gates` + `safety_gate_evaluations`, contactClearanceGate as first row, teaching-moment lesson | session B (remote) | build | PR_OPEN | PR-238a (same branch) | `safetyGateMatrix.ts`, `safetyGateSeeds.ts`, `contactClearanceGate.ts`, `auth.ts`, 1 migration | high — safety substrate, minors | [#238](https://github.com/PunxsyProminence/ppbf-platform/pull/238) | — | — | none | 2026-08-06 |
| PR-238c | P1 | Red Flag Escalation ladder (#194): `safety_escalations`, auto-escalation from near misses, `/admin/escalations`, pattern detector | session B (remote) | build | PR_OPEN | PR-238b (same branch) | `escalationLadder.ts`, `shadowNearMisses.ts`, `api/pilot/escalations`, `admin/escalations`, 1 migration | high — safety substrate, minors | [#238](https://github.com/PunxsyProminence/ppbf-platform/pull/238) | — | — | none | 2026-08-06 |

**PR-238a/b/c predate this queue and its ticket process** — they were claimed
and built under the prior `docs/WORK_QUEUE.md` (rows preserved there) on one
branch because that session is constrained to a single branch. Registered
here at `PR_OPEN` so the gatekeeper has the rows the collision rules require;
three logical capabilities, one PR, cherry-pickable per the PR body. Builder
does not assert `CI_GREEN` per this table's own rule — observe it on the PR.

**Refuted, not queued**: an automated audit pass flagged "athlete onboarding
creates live accounts on a shared, guessable PIN with no safeguard" as a
Tier-1 security gap. Verified false on direct code read: the shared PIN is a
documented design (`pinPolicy.ts`'s own comment: "public knowledge by
design"), and `must_change_pin` is enforced by `requirePrincipal` on every
route except the PIN-change route itself (confirmed by grep — exactly one
route uses the bypass variant). The narrower real gap underneath it —
`admin/activation-codes` has no UI — is T-001, at P3, not P0. This is why
gap-register claims get a row here only after a human or gatekeeper spot-
check, not straight from an audit agent's output.

## Filling this table

The gap register comes from an adversarially-verified audit run (7 parallel
readers over capabilities/markers/API/UI/queues/contrib-docs/open-PRs, each
missing/stub claim independently refuted-or-confirmed before it's trusted).
Do not hand-add items ahead of that without marking them `BACKLOG` and citing
where they came from — the whole point of this queue is that a row means
something was checked, not assumed.

## Collision rules (unchanged from the prior queue, still in force)

1. One capability = one branch = one PR = one row in this table.
2. Claim before implementing — set `CLAIMED` and name the builder before any
   code is written.
3. If two tickets need the same files or a shared contract: sequence them,
   split the contract into its own ticket first, or make the second one
   audit-only until the first lands.
4. Builders rebase/re-derive against current `origin/main` before
   `INTEGRATION_REVIEW` — this repo merges fast; a stale base is the most
   common source of silent conflict.
5. Builders never merge around a conflict. Return it to the gatekeeper.
6. Search for an existing implementation before adding a table, route,
   service, component, or doc. `packages/` is legacy v21 code that no
   application code imports — do not extend it; the live app is under
   `apps/web`.
7. Deliberate overlap requires the owner's approval, recorded in this
   table's Blocker column.

## Emergency release blocker

A safety or data-integrity issue found in production does not wait for the
queue's normal cadence. It still goes through the gatekeeper — never a
direct push, never a bypass of the `production` environment approval — but
it jumps to the front: `BACKLOG → READY` same session, builder assignment
immediate, and the gatekeeper may compress verification steps it judges
redundant with the specific fix, stating which ones and why in the PR. It
does not skip the owner's production approval click. Record the compression
in the ticket's row, not just the PR — future audits need to see it happened.
