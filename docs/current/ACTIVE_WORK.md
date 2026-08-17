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

Owner decisions 2026-08-16 (asked as a batch, answered individually):
1. **Register bar** — narrow-but-real slices promote to DONE per the playbook rule ("DONE means slice shipped in code"), each with a slice line naming exactly what exists and what is future work. Applied to modules 27, 39, 42, 104, 124, 131, 133, 135.
2. **Coach Cue Library (114)** — build the read-only browse/search over cues already stored in drill records. No invented content; authoring is a later decision.
3. **Coach Intelligence Engine (111)** — owner chose "define minimal v1 now": a concrete minimal definition goes to the owner for approval BEFORE any build. Nothing builds on a guess.
4. **Phase 2 thin clients** — the goal is every role (coach, athlete, admin, parent, board members, staff), not one favored role. Build order is the builder's sequencing call; current sequence: athlete check-in first (it generates the data the other views read), then parent, coach, admin, board, staff.

Owner decision 2026-08-17 — video action classification (narrowed from the parked `BACKLOG-video-skill-scoring`):
1. **Action identification** (jab, cross, hook, and named gym-specific variants — e.g. "power jab") is buildable now. This is classification against a taxonomy, not a judgment about the athlete, and is not the thing the 2026-08-15 parking refused.
2. **Both identification and conformance checking necessarily produce a number — that was wrong to deny.** Classification confidence and template-match similarity are scores by construction; there is no version of either that isn't. The distinction that actually matters is what the number is measured against and how it's shown: a match score against this gym's own coach-defined form for a named variant, never an invented "how good is this athlete" grade, and never surfaced as a bare number — always shown alongside what it matched against, through the human gate in point 3.
3. Every output — identification and conformance check alike — stays routed through the existing Film Study proposal gate (`shadowFilmStudyProposals.ts`): written as a proposal, never touches an athlete record until a human coach accepts it. Nothing in this decision removes that gate.
4. This surface is being built in a parallel session. This entry is the sync point — if the build produces a numeric score anywhere, that's outside this decision and should stop for a re-check against the 2026-08-15 concern it was narrowed from.
5. Separately surfaced during review, not part of this decision but relevant to it: `D10` in `SHADOW_PATTERN_FORMATION_CONTRACT.md`, flagged there as the highest-severity item in that audit. Traced further here: the medical-sensitivity gate on `/api/pilot/shadow/decisions` is armed by `isMedicallySensitive`, which is `decisionMedicallySensitive` in `apps/web/app/coach/decision-loop/page.tsx` — a plain checkbox a coach manually ticks. Nothing server-side checks `decisionText`/`expectedOutcome` against the risk-language detector (`HIGH_RISK_MESSAGE_PATTERNS`) that already exists elsewhere in the codebase. A coach who writes a return-to-play or full-contact-clearance decision and forgets the checkbox gets no gate at all. Any video-derived recommendation feeding this same route inherits this exposure until D10 is resolved.

## BLOCKED

| Item | Blocked on | Unblocks |
|---|---|---|
| Stripe onboarding round-trip test + checkout slice (item 8, remaining half) | The connect flow is BUILT (owner instruction 2026-08-15: build ahead so onboarding can be tested "as if I'm a new gym") — `connect/start`/`connect/callback`, the deauthorization webhook, and `/admin/payments`. What blocks is the owner registering PPBF's Stripe **platform** account and Connect OAuth client (`PAYMENT_CONNECT_CLIENT_ID` + `PAYMENT_PLATFORM_SECRET_KEY` + `PAYMENT_PLATFORM_WEBHOOK_SECRET` as Container App secrets); the Giving account's 501(c)(3) verification should start in parallel (it is the slow step). | The live end-to-end onboarding test on staging, then the checkout/receipt/mirror-writing slice — staging-first behind `PPBF_PAYMENTS_ENABLED`, with CAP-012 flipping only after the slot's step-5 evidence and the owner's compliance sign-off. |

## PARKED

| Item | Why it is parked | Re-open when |
|---|---|---|
| `BACKLOG-activity-log-backfill` | Legacy attendance sources cannot support a trustworthy synthetic history. Do not invent a backfill. `pilot.activity_log` is go-forward evidence. | A specific requirement appears for importing legacy history with an explicit provenance/conflict policy. |
| `BACKLOG-triage-keyboard` | A one-key approval path is not meaningful until the queue exposes a review-complete/eligible action. | The review queue has a deterministic eligibility signal. |
| `BACKLOG-offline-write-queue` | Persisting minors' check-ins on a shared tablet creates identity, attribution, and data-at-rest problems. | A concrete identity-scoped encrypted/offline storage design is selected. |
| `BACKLOG-grant-packet` | The rendering foundation exists; the unresolved question is what aggregate minor-related data may be disclosed externally. | A real grant/export request defines the disclosure set and privacy threshold. |
| `BACKLOG-open-route-gates` | Route visibility and authorization are not the same thing; changing `buildingMap.ts` alone protects nothing. | A route is shown to expose a real unintended surface, then fix that route's own guard directly. |
| `BACKLOG-video-skill-scoring` | **Superseded 2026-08-17, moved to NOW as a narrower slice** — see below. Owner reconsidered the 2026-08-15 parking after separating two things the original decision treated as one: identifying the action (jab/cross/hook, named variants like "power jab") vs. judging quality of execution. Only the second is what 2026-08-15 refused. | — |
| `BACKLOG-publication-automation` | Queue item 9, assessed 2026-08-15 under the owner's standing approval for recommendations: the internal publication machinery that exists (video compliance console + consent gating, research evidence review, retraction surveillance) is human-gated on purpose — there is no automatable step left that does not cross a gate deliberately. What automation would add is outward publication to a "destination registry", and no destination, content set, or disclosure rules exist. Automating external disclosure of content about or derived from minors ahead of those decisions is the same risk `BACKLOG-grant-packet` refuses. | The owner names a real destination and content type (e.g. "approved research summaries to the public site") with an explicit disclosure set. Automation then means moving already-approved items — never approving them. |
| `BACKLOG-wearables` | Owner "add all" decision 2026-08-16 deliberately EXCLUDED wearables/HR streams: biometric hardware for minors needs a consent, privacy, and device-ownership decision no code can make. | The owner selects a device approach and records the consent/privacy posture for minors' biometric data; integration then reads into the attempts/readiness spine. |
| `BACKLOG-quickbooks-sync` | Owner request 2026-08-15 ("Treasurer also needs the QuickBooks login"): the treasurer's QuickBooks access itself is an Intuit-side action (invite as accountant user), not platform work. The platform half — pushing the payment mirror ledger into QuickBooks so nobody keys in donations by hand — is the Revenue Center's "QuickBooks Placeholder | Future Integration" row and stays parked until money actually flows. | The payment lanes are live (CAP-012 flipped) and real transactions exist in `pilot.payment_transactions` to sync; the integration then gets its own compliance review per the placeholder's own label. |

## Verification debt

Historical runtime-verification gaps (including T-001/T-002 and the PR-238 bulk deployment) are evidence debt, not a blanket blocker on new development. Run the relevant runtime probe when touching or releasing the affected surface; do not force every unrelated builder to reconstruct the entire deployment history.

## Historical ledger

For audit/provenance questions only, use `docs/current/WORK_QUEUE.md`. It retains the old detailed state machine, deployment evidence, collision notes, and shipped history. Those records are evidence, not the ordinary build workflow.
