# Active work

This is the small builder-facing view of work that can affect what gets built next.

Do **not** preload `docs/current/WORK_QUEUE.md` for ordinary implementation. That file is the detailed historical/verification ledger and preserves prior deployment evidence, collision history, and unresolved audit context.

## Builder rule

A direct owner/user request may go straight to a bounded branch/PR after checking current source and open PRs. A ticket is optional unless the work needs coordination, handoff, scheduling, or a durable decision record.

Owner authorization (2026-08-15, **superseded 2026-08-27**): this note read "ordinary bounded PRs may be merged by the authoring session once every required check and branch-protection requirement on the repository passes -- 'i give permission for all merges.'" That was written when one session held both the building and the releasing role.

It no longer holds. `AGENT_KERNEL.md`'s Lane model and its amended invariant 6 give a build lane authority to implement and **open** a bounded change; **one release-control lane merges**. Green CI is a precondition, not an authorization.

This correction matters more than most stale prose, because `AGENT_KERNEL.md` sends every lane to this file second, immediately after reading the invariant that contradicts the old sentence. `docs/capabilities/NETWORK_STATUS.md` already records this exact sentence, read literally by several sessions at once, as how `main` broke.

Unchanged: repo enforcement always wins over any note here, and nothing in this file authorizes production deployment or migrations against protected environments. Those were never covered and still require an explicit release task from the owner.

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
3. **Coach Intelligence Engine (111)** — SHIPPED. v1 ("The Morning Read") built and merged per the owner's 2026-08-16 approval (commit `c05c8c68`): `apps/web/app/coach/intelligence/page.tsx`, `apps/web/app/api/pilot/coach/intelligence/route.ts`, `apps/web/src/server/pilot/coachIntelligence.ts`. Widening it further is a new, separate decision, not a resumption of this one.
4. **Phase 2 thin clients** — the goal is every role (coach, athlete, admin, parent, board members, staff), not one favored role. Build order is the builder's sequencing call; current sequence: athlete check-in first (it generates the data the other views read), then parent, coach, admin, board, staff.
5. **Sparring failure contexts** — SHIPPED at the DB layer. Failure capture covers the kinds of sparring distinctly: `technical_sparring`, `sparring_games`, `sparring_drills`, `open_sparring` are first-class attempt contexts (widening migration; where an attempt fails is part of the fact). `infra/azure/pilot_slice_postgres_sparring_attempt_contexts_migration.sql` widens the `pilot.training_attempts.context_type` check constraint; the runner (`apps/web/scripts/pilot-apply-sparring-attempt-contexts-migration.mjs`) and its `pilot:apply-sparring-attempt-contexts` / `test:migrations:sparring-attempt-contexts` entries are registered in `apps/web/package.json`, the migration is in `.github/workflows/apply-migrations.yml`'s dropdown and `all` loop, and `sparringAttemptContexts.pg.test.ts` exists and is wired into the test chain. Application-layer use is also confirmed, not just inferred from the schema: `trainingAttempts.ts`'s `ATTEMPT_CONTEXT_TYPES` validates writes, the coach `/coach/attempt-log` page offers all four contexts in its context selector and POSTs the chosen one, and `falseProgress.ts`'s `LIVE_CONTEXTS` reads them back in its transfer-fact query. Not independently confirmed as part of this pass: whether this migration/runner has actually been dispatched against the staging or production database (see `docs/current/PRODUCTION_STATE.json`'s migration log, which does not yet name it).
6. **Stripe slot instructions** — `/admin/payments` shows the owner the exact one-time platform-account walkthrough (Stripe account → Connect client id → secret key → webhook signing secret → the three Container App secret names) whenever the platform is unregistered. The slot documents itself; no code work remains on the platform side of onboarding.
7. **Engines unlock as data gathers** (direction, physical training engines and similar): build the remaining "engine" modules so each states explicit DATA PREREQUISITES and stays visibly locked until the org's/athlete's own records satisfy them — an unlock is an honesty gate, not a gamification score. Athlete-facing "rank up" means unlocking richer views of their OWN record (never cross-athlete comparison); org-level unlocks mean an organization earns engine activation by accumulating real data. Design to be proposed per-engine as slices come up.

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
| `BACKLOG-video-skill-scoring` | Owner decision 2026-08-15: per-skill AI video scoring (punch detection, footwork, etc.) is parked for Phase 2+. Human Film Study IS the analysis pathway; shipping machine scores about minors' athletic ability without proven accuracy is the risk being refused. | Phase 1 is complete AND a scoring approach with explicit evidence standards has been selected by the owner. |
| `BACKLOG-publication-automation` | Queue item 9, assessed 2026-08-15 under the owner's standing approval for recommendations: the internal publication machinery that exists (video compliance console + consent gating, research evidence review, retraction surveillance) is human-gated on purpose — there is no automatable step left that does not cross a gate deliberately. What automation would add is outward publication to a "destination registry", and no destination, content set, or disclosure rules exist. Automating external disclosure of content about or derived from minors ahead of those decisions is the same risk `BACKLOG-grant-packet` refuses. | The owner names a real destination and content type (e.g. "approved research summaries to the public site") with an explicit disclosure set. Automation then means moving already-approved items — never approving them. |
| `BACKLOG-safety-alert-transport` | An unacknowledged high/critical safety escalation now reaches a coach IN THE APP, on every surface, via the persistent count on the session bar (`components/SafetyAttentionBadge.tsx`, reading the existing `/api/pilot/escalations` — no second queue). What is deliberately NOT built is an EXTERNAL transport: push notification, email, or SMS. That is a separate decision, and the blocking part is not the plumbing. It is content and privacy: an external message about a minor leaves the platform's access controls entirely, lands on a lock screen or in an inbox somebody else may read, and cannot be scoped the way a page can. Nobody has decided what such a message may say — whether it may name an athlete, name a severity, name a source, or only say "open the platform" — nor who may receive one, nor what happens when a coach's assignment or coverage lapses between sending and reading. Sending a safeguarding notification about a child before those are answered is the same risk `BACKLOG-grant-packet` refuses, arriving by a different door. | The owner selects a transport AND records the content rules for it: exactly what an external message may contain about a minor, which recipients may receive one, and the retention/revocation posture for messages already sent. Implementation then means delivering an already-decided payload — never deciding it. |
| `BACKLOG-wearables` | Owner "add all" decision 2026-08-16 deliberately EXCLUDED wearables/HR streams: biometric hardware for minors needs a consent, privacy, and device-ownership decision no code can make. | The owner selects a device approach and records the consent/privacy posture for minors' biometric data; integration then reads into the attempts/readiness spine. |
| `BACKLOG-quickbooks-sync` | Owner request 2026-08-15 ("Treasurer also needs the QuickBooks login"): the treasurer's QuickBooks access itself is an Intuit-side action (invite as accountant user), not platform work. The platform half — pushing the payment mirror ledger into QuickBooks so nobody keys in donations by hand — is the Revenue Center's "QuickBooks Placeholder | Future Integration" row and stays parked until money actually flows. | The payment lanes are live (CAP-012 flipped) and real transactions exist in `pilot.payment_transactions` to sync; the integration then gets its own compliance review per the placeholder's own label. |
| `BACKLOG-design-visuals-lane` | Owner decision 2026-08-17: the whole Design/visuals lane (`docs/VISUAL_BUILD_MAP.md` layers L1–L5) is parked while the owner squares away the three outstanding inputs — real gym photos + one committed staff photo (`apps/web/src/shared/gymPhotos.ts`), real coach sayings (`apps/web/components/gymSayings.ts` — **corrected 2026-08-22: this said "ships empty on purpose — no invented lines", and it no longer ships empty.** The file holds 12 real entries the owner confirmed 2026-08-19, recorded in the file's own header against Drive doc `2026-08-19_EGGS-LOAD-FIRST-12.md`. The "no invented lines" rule stands and is why the file waited; the waiting is over. Whether that discharges this input, and whether the lane un-parks on it, is the owner's call — the other two inputs, real gym photos and the Canva pick, are still outstanding: `gymPhotos.ts` still carries placeholder SVGs and a staff card with `photo: null`), and a Canva social-card pick. This is a blanket park, not just the 🔒 rows — some layers (L1–L3, L5 template work, L4a/L4b) are technically 🔓 unblocked, but the owner asked to hold the whole lane rather than have sessions work the unblocked layers piecemeal while assets are being gathered. **Scoped exception, owner instruction 2026-08-19:** the Grok/Claude "SHADOW-UI" design package's P0 set — Bell/login three-method + refusal stamps, `/shadow` deny/allowed states, role-landing routing, Training Hold banner — is explicitly resumed. None of that set depends on the three outstanding inputs (it's token/class conversion against already-real states, not gym photography or coach sayings), so it is out from under the park; the rest of the lane (L4c sayings, L4e photos, L5 Canva) stays parked on the three inputs as before. | Owner delivers the three inputs and un-parks the rest of the lane, or explicitly asks to resume further layers before that. |

## Verification debt

Historical runtime-verification gaps (including T-001/T-002 and the PR-238 bulk deployment) are evidence debt, not a blanket blocker on new development. Run the relevant runtime probe when touching or releasing the affected surface; do not force every unrelated builder to reconstruct the entire deployment history.

## Deploy status — read PRODUCTION_STATE.json, not this file

**This section used to restate the deployed SHAs, the undeployed commit count
and the pending migration count. It is now a pointer, deliberately, because
that duplication is what kept going wrong.**

The numbers here were re-measured on 2026-08-22 and were correct that day. By
2026-08-28 they said production ran `a11ea7c1` with 22 commits and 2 migrations
undeployed. The real gap at that point was 205 commits. A release lane sizing
from this block would have been out by an order of magnitude — which is the
exact failure the block's own predecessor note describes ("an audit reading it
sized this release at 25 migrations and 62 commits").

It drifted for a structural reason, not a careless one: two files recorded one
fact. `docs/current/PRODUCTION_STATE.json` is updated by the session that runs
a release, minutes after it lands, and carries the instrument used for every
field. This file was updated when someone remembered. So the fix is not another
correction — it is to stop keeping a second copy.

**Single source of truth: `docs/current/PRODUCTION_STATE.json`.** It records,
per environment, the deployed SHA, the image digest, the deployment run, the
revision, the timestamp, and what was actually observed to establish each one.
Superseded records are carried rather than overwritten, so the trail of what was
true when survives.

To size an undeployed batch, read the deployed SHA out of that file and measure
against it directly:

    git rev-list --count <deployed_sha>..origin/main
    git diff --name-only <deployed_sha>..origin/main -- 'infra/azure/*.sql'

That is two commands against live git, and it cannot go stale.

## Historical ledger

For audit/provenance questions only, use `docs/current/WORK_QUEUE.md`. It retains the old detailed state machine, deployment evidence, collision notes, and shipped history. Those records are evidence, not the ordinary build workflow.
