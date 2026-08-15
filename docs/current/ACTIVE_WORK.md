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

The 2026-08-15 queue is built through its buildable end. Items 1–5.5 shipped and were promoted to production in the 2026-08-15 release wave (sha `3d2308ed`, digest `sha256:be7c516d…` — see `PRODUCTION_STATE.json`): performance analytics, the SHADOW operational feed, deterministic gap suggestions (coach confirms or dismisses; nothing reaches an athlete unconfirmed), the sports-medicine clearance board (clearance + holds only), the internal grant-obligations ledger, and all three slices of the issue #345 research workspace (submission never resolves a requirement, structurally). Items 6–7 (both competition skeletons, deliberately skeletal by owner decision) merged as PRs #376/#377. Item 8's ledger tables merged as PR #378 (the payment slot's three reserved names, empty; CAP-012 stays BLOCKED). Item 9 was assessed and PARKED (see below). Retired owner-decision constraints remain binding on any change to those surfaces.

Merch note (owner, 2026-08-15): merchandise sales are Program-lane revenue when payments go live — earned income like class fees, settling to the Program account. The gear catalog/vendor records that exist already carry the inventory half; no new lane and no schema change needed.

## BLOCKED

| Item | Blocked on | Unblocks |
|---|---|---|
| Stripe connect flow (item 8, remaining half) | Owner registering PPBF's Stripe **platform** account and its Connect OAuth client (`PAYMENT_CONNECT_CLIENT_ID`), per `docs/PAYMENT_SERVICE_SLOT.md` step 1; the Giving account's 501(c)(3) verification should start in parallel (it is the slow step). | The connect round trip (`connect/start`/`connect/callback`), the webhook with deauthorization handling, and the checkout/receipt lane — built staging-first behind `PPBF_PAYMENTS_ENABLED`, with CAP-012 flipping only after the slot's step-5 evidence and the owner's compliance sign-off. |

## PARKED

| Item | Why it is parked | Re-open when |
|---|---|---|
| `BACKLOG-activity-log-backfill` | Legacy attendance sources cannot support a trustworthy synthetic history. Do not invent a backfill. `pilot.activity_log` is go-forward evidence. | A specific requirement appears for importing legacy history with an explicit provenance/conflict policy. |
| `BACKLOG-triage-keyboard` | A one-key approval path is not meaningful until the queue exposes a review-complete/eligible action. | The review queue has a deterministic eligibility signal. |
| `BACKLOG-offline-write-queue` | Persisting minors' check-ins on a shared tablet creates identity, attribution, and data-at-rest problems. | A concrete identity-scoped encrypted/offline storage design is selected. |
| `BACKLOG-grant-packet` | The rendering foundation exists; the unresolved question is what aggregate minor-related data may be disclosed externally. | A real grant/export request defines the disclosure set and privacy threshold. |
| `BACKLOG-open-route-gates` | Route visibility and authorization are not the same thing; changing `buildingMap.ts` alone protects nothing. | A route is shown to expose a real unintended surface, then fix that route's own guard directly. |
| `BACKLOG-video-skill-scoring` | Owner decision 2026-08-15: per-skill AI video scoring (punch detection, footwork, etc.) is parked for Phase 2+. Human Film Study IS the analysis pathway; shipping machine scores about minors' athletic ability without proven accuracy is the risk being refused. | Phase 1 is complete AND a scoring approach with explicit evidence standards has been selected by the owner. |
| `BACKLOG-publication-automation` | Queue item 9, assessed 2026-08-15 under the owner's standing approval for recommendations: the internal publication machinery that exists (video compliance console + consent gating, research evidence review, retraction surveillance) is human-gated on purpose — there is no automatable step left that does not cross a gate deliberately. What automation would add is outward publication to a "destination registry", and no destination, content set, or disclosure rules exist. Automating external disclosure of content about or derived from minors ahead of those decisions is the same risk `BACKLOG-grant-packet` refuses. | The owner names a real destination and content type (e.g. "approved research summaries to the public site") with an explicit disclosure set. Automation then means moving already-approved items — never approving them. |
| `BACKLOG-quickbooks-sync` | Owner request 2026-08-15 ("Treasurer also needs the QuickBooks login"): the treasurer's QuickBooks access itself is an Intuit-side action (invite as accountant user), not platform work. The platform half — pushing the payment mirror ledger into QuickBooks so nobody keys in donations by hand — is the Revenue Center's "QuickBooks Placeholder | Future Integration" row and stays parked until money actually flows. | The payment lanes are live (CAP-012 flipped) and real transactions exist in `pilot.payment_transactions` to sync; the integration then gets its own compliance review per the placeholder's own label. |

## Verification debt

Historical runtime-verification gaps (including T-001/T-002 and the PR-238 bulk deployment) are evidence debt, not a blanket blocker on new development. Run the relevant runtime probe when touching or releasing the affected surface; do not force every unrelated builder to reconstruct the entire deployment history.

## Historical ledger

For audit/provenance questions only, use `docs/current/WORK_QUEUE.md`. It retains the old detailed state machine, deployment evidence, collision notes, and shipped history. Those records are evidence, not the ordinary build workflow.
