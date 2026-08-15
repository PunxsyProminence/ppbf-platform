# Active work

This is the small builder-facing view of work that can affect what gets built next.

Do **not** preload `docs/current/WORK_QUEUE.md` for ordinary implementation. That file is the detailed historical/verification ledger and preserves prior deployment evidence, collision history, and unresolved audit context.

## Builder rule

A direct owner/user request may go straight to a bounded branch/PR after checking current source and open PRs. A ticket is optional unless the work needs coordination, handoff, scheduling, or a durable decision record.

Owner authorization (2026-08-15): ordinary bounded PRs may be merged by the authoring session once every required check and branch-protection requirement on the repository passes — "i give permission for all merges." Repo enforcement always wins over this note. The authorization does not extend to production deployment, migrations against protected environments, or anything the guardrails place behind a separate human gate; those still require an explicit release task from the owner.

Use only these working states here:

- `NOW` — buildable current work
- `BLOCKED` — cannot be built correctly without a real product/safety/data decision
- `PARKED` — valid idea or debt, but not allowed to slow unrelated work

Open PR state belongs in GitHub and should be queried live rather than copied here.

## Lanes

Standing work lanes so concurrent sessions divide work instead of colliding. A session picks one lane, works one bounded branch/PR at a time inside it, and does not drive-by fix another lane's surface. Open PR state stays in GitHub — query it live.

| Lane | Scope | Coordination rule |
|---|---|---|
| Product build | Driving operations-radar `PARTIAL`/`PLACEHOLDER` rows to `EXISTS` or PARKED | One radar row per branch/PR. Check open PRs for collisions before starting. |
| SHADOW / statistics | SHADOW model behavior, evidence statistics, measurement gates | Stacked PRs merge in dependency order; do not start new work that touches a surface an open stack PR owns. |
| Design / visuals | Design-system and page-visual work | Blocked on owner-supplied assets stays blocked; do not substitute invented assets. |
| Ops / deploy | Staging, production, migrations, releases | Human-gated. Requires an explicit release task from the owner; never entered from another lane. |

Phase plan: **Phase 1** — every operations-radar row reads `EXISTS` or is PARKED here with a re-open condition. **Phase 2** — role-specific thin clients (route groups in this repo over the same `/api/pilot/*` routes; no separate backend, no parallel telemetry path, online-only writes until the offline-storage decision is made).

Parking rule: a radar row parked during Phase 1 must gain a PARKED row below with a concrete "Re-open when" condition — that table is the memory that parked work exists. Nothing is parked by silence.

## NOW

Phase 1 build queue, sequenced by the owner's decisions of 2026-08-15 (asked and answered one at a time; each row below that needed a decision carries it):

| # | Item | Owner decision constraining it |
|---|---|---|
| 2 | SHADOW Monitoring radar row: wire a read-only operational alert feed from existing SHADOW event/telemetry routes into the operations hub; correct the row to what is true | — (read-only; no model-behavior change) |
| 3 | Gap detection v1 | Deterministic rules only (readiness falling, training days dropping, assignments stalled) producing SUGGESTED gaps a coach confirms or dismisses. Nothing reaches an athlete unconfirmed. No ML. |
| 4 | Sports-medicine coach surface | Clearance status + active training holds with athlete-safe explanations ONLY. No diagnoses, no clinical notes, nothing beyond what the athlete themselves sees. Sequenced behind the medical-gate PR landing. |
| 5 | Grant compliance, internal half | Obligation tracking (deadlines, deliverables, reporting periods) as internal admin records. The external-disclosure question stays parked (see `BACKLOG-grant-packet`). |
| 5.5 | SHADOW Research Workspace (issue #345), in three slices | Owner-authored product contract; slotted here by owner approval 2026-08-15 ("all my approvals to go with your recommendations"). Slice 1: the `shadow_research_submissions` link record + computed answer-state ladder — a submission NEVER resolves a requirement, structurally. Slice 2: the three-tab `/research` workspace. Slice 3: general-research intake. Issue #345 stays the durable spec; do not collapse it into one upload button. |
| 6 | Wrestling League minimal skeleton | Owner chose to build both skeletons knowing requirements are guessed until a real league exists — keep them deliberately skeletal. |
| 7 | External Competition minimal skeleton | Same constraint as #6. |
| 8 | Revenue backend | Full payment integration on the existing two-Stripe-account design (Giving + Program lanes, `paymentSetup.ts`). Ledger tables land first; processor wiring waits on owner's Stripe onboarding, and switch-on waits on the owner compliance sign-off the payment slot already requires. |
| 9 | Publication Workflow Automation | Assess build-vs-park on arrival. |

Item 1 (Performance Analytics) shipped. Numbering is the build order; the sports-medicine item may float later if the medical-gate PR has not landed when its turn comes.

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
| `BACKLOG-video-skill-scoring` | Owner decision 2026-08-15: per-skill AI video scoring (punch detection, footwork, etc.) is parked for Phase 2+. Human Film Study IS the analysis pathway; shipping machine scores about minors' athletic ability without proven accuracy is the risk being refused. | Phase 1 is complete AND a scoring approach with explicit evidence standards has been selected by the owner. |

## Verification debt

Historical runtime-verification gaps (including T-001/T-002 and the PR-238 bulk deployment) are evidence debt, not a blanket blocker on new development. Run the relevant runtime probe when touching or releasing the affected surface; do not force every unrelated builder to reconstruct the entire deployment history.

## Historical ledger

For audit/provenance questions only, use `docs/current/WORK_QUEUE.md`. It retains the old detailed state machine, deployment evidence, collision notes, and shipped history. Those records are evidence, not the ordinary build workflow.
