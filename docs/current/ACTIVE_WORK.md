# Active work

Blocked and parked work, with the condition that re-opens each, plus the
standing owner directions that shape what gets built next.

**Not tracked here: current build work.** That is the live open PRs on GitHub
and the work orders Jason approves (OD-2026-09-21-001). Query PR state live;
do not copy it here. Deployed state: see "Your lane's state is not the
system's state" in `AGENT_KERNEL.md`.

**Dates.** This file was last brought fully up to date on 2026-08-29. Rows
carry that date unless they say otherwise; re-check a BLOCKED row before
relying on it. The full 2026-08-29 text -- including the shipped 2026-08-15/16
queue, its evidence, and the calibration-lab notes -- is kept verbatim in
`docs/archive/2026-09-21_ACTIVE_WORK_before_condense.md`.

Do **not** preload `docs/current/WORK_QUEUE.md` for ordinary implementation. It
is the detailed historical/verification ledger.

Repo enforcement always wins over any note here, and nothing in this file
authorizes production deploys or production migrations.

States:

- `BLOCKED` -- cannot be built correctly without a real product, safety or data decision
- `PARKED` -- valid idea or debt, but not allowed to slow unrelated work

Nothing is parked by silence: parked work gets a PARKED row below with a
concrete "Re-open when" condition. That table is the memory that parked work
exists.

## Work lanes

Standing lanes so concurrent sessions divide work instead of colliding. A
session picks one lane, works one bounded branch/PR at a time inside it, and
does not drive-by fix another lane's surface.

| Lane | Scope | Coordination rule |
|---|---|---|
| Product build | Driving operations-radar `PARTIAL`/`PLACEHOLDER` rows to `EXISTS` or PARKED | One radar row per branch/PR. Check open PRs for collisions before starting. |
| SHADOW / statistics | SHADOW model behavior, evidence statistics, measurement gates | Stacked PRs merge in dependency order; do not start new work that touches a surface an open stack PR owns. |
| Design / visuals | Design-system and page-visual work | Blocked on owner-supplied assets stays blocked; do not substitute invented assets. |
| Ops / deploy | Staging, production, migrations, releases | Human-gated for production (OD-2026-08-29-006). |

Phase plan (2026-08-29): **Phase 1** -- every operations-radar row reads
`EXISTS` or is PARKED here with a re-open condition. **Phase 2** --
role-specific thin clients (route groups in this repo over the same
`/api/pilot/*` routes; no separate backend, no parallel telemetry path,
online-only writes until the offline-storage decision is made).

## Standing owner directions (2026-08-15/16)

Carried verbatim from the 2026-08-15/16 batches. They are not yet entries in
`docs/current/OWNER_DECISIONS.md`. Items 3, 5 and 6 of the 2026-08-16 batch
shipped; item 3 still carries a boundary, below.

- **Merch** (owner, 2026-08-15): merchandise sales are Program-lane revenue
  when payments go live -- earned income like class fees, settling to the
  Program account. The gear catalog/vendor records that exist already carry the
  inventory half; no new lane and no schema change needed.
- **Register bar** (2026-08-16, item 1) -- narrow-but-real slices promote to
  DONE per the playbook rule ("DONE means slice shipped in code"), each with a
  slice line naming exactly what exists and what is future work.
- **Coach Cue Library (114)** (2026-08-16, item 2) -- build the read-only
  browse/search over cues already stored in drill records. No invented
  content; authoring is a later decision.
- **Phase 2 thin clients** (2026-08-16, item 4) -- the goal is every role
  (coach, athlete, admin, parent, board members, staff), not one favored role.
  Build order is the builder's sequencing call; current sequence: athlete
  check-in first (it generates the data the other views read), then parent,
  coach, admin, board, staff.
- **Engines unlock as data gathers** (2026-08-16, item 7) -- build the
  remaining "engine" modules so each states explicit DATA PREREQUISITES and
  stays visibly locked until the org's/athlete's own records satisfy them --
  an unlock is an honesty gate, not a gamification score. Athlete-facing "rank
  up" means unlocking richer views of their OWN record (never cross-athlete
  comparison); org-level unlocks mean an organization earns engine activation
  by accumulating real data. Design to be proposed per-engine as slices come
  up.
- **Coach Intelligence Engine (111)** (2026-08-16, item 3) -- v1 ("The
  Morning Read") shipped, commit `c05c8c68`. Widening it further is a new,
  separate decision, not a resumption of this one.

### Shipped with constraints that still bind (2026-08-15 queue)

The 2026-08-15 queue shipped (release `3d2308ed`). Retired owner-decision
constraints remain binding on any change to those surfaces:

- deterministic gap suggestions: the coach confirms or dismisses; nothing
  reaches an athlete unconfirmed;
- the sports-medicine clearance board: clearance + holds only;
- the issue #345 research workspace: submission never resolves a
  requirement, structurally;
- both competition skeletons (#376/#377): deliberately skeletal by owner
  decision;
- the payment slot (#378): the three reserved names, empty; CAP-012 stays
  BLOCKED.

## Last recorded build queue: video calibration lab (2026-08-29, not re-checked)

Each surface reads what the one before it writes, so the order is not
arbitrary. Remaining at 2026-08-29:

1. **OD-2026-08-29-003, the pages.** The API accepts a pair selection
   (`resolveComparisonPair` in `comparison.ts`, wired to both routes); neither
   page offered the choice.
2. **OD-2026-08-29-005, the superseding migration.** A revision integer per
   pair, a unique constraint on (pair, revision), and the route translating the
   23505 collision -- the translation is part of the ruling and owes its own
   test.
3. **`qaReadModel`** -- read the module before designing to it.
4. **`gold`.**

## BLOCKED

| Item | Blocked on | Unblocks |
|---|---|---|
| Stripe onboarding round-trip test + checkout slice (item 8, remaining half) | The connect flow is BUILT (owner instruction 2026-08-15: build ahead so onboarding can be tested "as if I'm a new gym") — `connect/start`/`connect/callback`, the deauthorization webhook, and `/admin/payments`. What blocks is the owner registering PPBF's Stripe **platform** account and Connect OAuth client (`PAYMENT_CONNECT_CLIENT_ID` + `PAYMENT_PLATFORM_SECRET_KEY` + `PAYMENT_PLATFORM_WEBHOOK_SECRET` as Container App secrets); the Giving account's 501(c)(3) verification should start in parallel (it is the slow step). | The live end-to-end onboarding test on staging, then the checkout/receipt/mirror-writing slice — staging-first behind `PPBF_PAYMENTS_ENABLED`, with CAP-012 flipping only after the slot's step-5 evidence and the owner's compliance sign-off. |
| Calibration study surfaces (comparison, adjudication) actually working | The calibration migrations have **never been applied in any environment** (as of 2026-08-29). `pilot.calibration_adjudications` and its sibling are declared, registered and dispatchable, so the first `POST` to `/api/pilot/calibration/adjudication` returns a 500 until they run. Under OD-2026-08-29-006 the first production apply is the owner's call; staging is a build lane's. | The QA read-out and gold nomination, which read what adjudication writes. |

## PARKED

| Item | Why it is parked | Re-open when |
|---|---|---|
| `BACKLOG-activity-log-backfill` | Legacy attendance sources cannot support a trustworthy synthetic history. Do not invent a backfill. `pilot.activity_log` is go-forward evidence. | A specific requirement appears for importing legacy history with an explicit provenance/conflict policy. |
| `BACKLOG-triage-keyboard` | A one-key approval path is not meaningful until the queue exposes a review-complete/eligible action. | The review queue has a deterministic eligibility signal. |
| `BACKLOG-offline-write-queue` | Persisting minors' check-ins on a shared tablet creates identity, attribution, and data-at-rest problems. | A concrete identity-scoped encrypted/offline storage design is selected. |
| `BACKLOG-grant-packet` | The rendering foundation exists; the unresolved question is what aggregate minor-related data may be disclosed externally. | A real grant/export request defines the disclosure set and privacy threshold. |
| `BACKLOG-coach-development-visibility` | Every route over a coach's development record is self-scoped: `/api/pilot/coach/development` takes no account id on any method and answers for the caller, matching `/api/pilot/coach/credentials`. Whether a head coach or an organization admin may READ their staff's development goals is a real question, and building the cross-coach read first and gating it afterwards is how such a question gets answered by accident. | The owner states who may see another coach's development record, and for what purpose. The data layer already scopes by account, so the change is an added, gated read path -- not a loosening of the existing one. |
| `BACKLOG-coach-mentorship-pairing` | Coach self-development shipped goals and recorded work (`pilot.coach_development_goals` / `pilot.coach_development_activities`, `/coach/development`), and deliberately stopped short of a coach-to-coach mentorship RELATIONSHIP. A row saying "Coach B mentors Coach A" names a second member of staff, and who may assert it, whether B consents, and who may see it are product and consent decisions nobody has made. `pilot.mentorships` is not it: both its FKs point at `pilot.athletes` and a CHECK forbids self-pairing, so it cannot express a coach at all. A coach can already record a mentorship SESSION THEY ATTENDED as an activity in their own words, which claims nothing about anybody else's role. | The owner decides who may assert a staff mentorship, whether the named mentor must agree, and who may read it. Until then the activity record covers the coach's own half. |
| `BACKLOG-open-route-gates` | Route visibility and authorization are not the same thing; changing `buildingMap.ts` alone protects nothing. | A route is shown to expose a real unintended surface, then fix that route's own guard directly. |
| `BACKLOG-video-skill-scoring` | Owner decision 2026-08-15: per-skill AI video scoring (punch detection, footwork, etc.) is parked for Phase 2+. Human Film Study IS the analysis pathway; shipping machine scores about minors' athletic ability without proven accuracy is the risk being refused. | Phase 1 is complete AND a scoring approach with explicit evidence standards has been selected by the owner. |
| `BACKLOG-publication-automation` | Queue item 9, assessed 2026-08-15 under the owner's standing approval for recommendations: the internal publication machinery that exists (video compliance console + consent gating, research evidence review, retraction surveillance) is human-gated on purpose — there is no automatable step left that does not cross a gate deliberately. What automation would add is outward publication to a "destination registry", and no destination, content set, or disclosure rules exist. Automating external disclosure of content about or derived from minors ahead of those decisions is the same risk `BACKLOG-grant-packet` refuses. | The owner names a real destination and content type (e.g. "approved research summaries to the public site") with an explicit disclosure set. Automation then means moving already-approved items — never approving them. |
| `BACKLOG-safety-alert-transport` | An unacknowledged high/critical safety escalation now reaches a coach IN THE APP, on every surface, via the persistent count on the session bar (`components/SafetyAttentionBadge.tsx`, reading the existing `/api/pilot/escalations` — no second queue). What is deliberately NOT built is an EXTERNAL transport: push notification, email, or SMS. That is a separate decision, and the blocking part is not the plumbing. It is content and privacy: an external message about a minor leaves the platform's access controls entirely, lands on a lock screen or in an inbox somebody else may read, and cannot be scoped the way a page can. Nobody has decided what such a message may say — whether it may name an athlete, name a severity, name a source, or only say "open the platform" — nor who may receive one, nor what happens when a coach's assignment or coverage lapses between sending and reading. Sending a safeguarding notification about a child before those are answered is the same risk `BACKLOG-grant-packet` refuses, arriving by a different door. | The owner selects a transport AND records the content rules for it: exactly what an external message may contain about a minor, which recipients may receive one, and the retention/revocation posture for messages already sent. Implementation then means delivering an already-decided payload — never deciding it. |
| `BACKLOG-wearables` | Owner "add all" decision 2026-08-16 deliberately EXCLUDED wearables/HR streams: biometric hardware for minors needs a consent, privacy, and device-ownership decision no code can make. | The owner selects a device approach and records the consent/privacy posture for minors' biometric data; integration then reads into the attempts/readiness spine. |
| `BACKLOG-quickbooks-sync` | Owner request 2026-08-15 ("Treasurer also needs the QuickBooks login"): the treasurer's QuickBooks access itself is an Intuit-side action (invite as accountant user), not platform work. The platform half — pushing the payment mirror ledger into QuickBooks so nobody keys in donations by hand — is the Revenue Center's "QuickBooks Placeholder \| Future Integration" row and stays parked until money actually flows. | The payment lanes are live (CAP-012 flipped) and real transactions exist in `pilot.payment_transactions` to sync; the integration then gets its own compliance review per the placeholder's own label. |
| `BACKLOG-design-visuals-lane` | Owner decision 2026-08-17: the whole Design/visuals lane (`docs/VISUAL_BUILD_MAP.md` layers L1–L5) is parked while the owner squares away three inputs: real gym photos + one committed staff photo (`apps/web/src/shared/gymPhotos.ts`, still placeholder SVGs and a staff card with `photo: null` at 2026-08-22), real coach sayings (`apps/web/components/gymSayings.ts` — since 2026-08-19 it holds 12 real entries the owner confirmed; whether that discharges this input is the owner's call), and a Canva social-card pick. A blanket park: the owner asked to hold the whole lane rather than have sessions work unblocked layers piecemeal. **Scoped exception, owner instruction 2026-08-19:** the SHADOW-UI P0 set — Bell/login three-method + refusal stamps, `/shadow` deny/allowed states, role-landing routing, Training Hold banner — is resumed, because none of it depends on the three inputs. | Owner delivers the three inputs and un-parks the rest of the lane, or explicitly asks to resume further layers before that. |

## Verification debt

Historical runtime-verification gaps (including T-001/T-002 and the PR-238 bulk
deployment) are evidence debt, not a blanket blocker on new development. Run
the relevant runtime probe when touching or releasing the affected surface.
Sparring failure contexts (2026-08-16, item 5) shipped at the DB and
application layers; whether its migration was dispatched to staging or
production was not confirmed as of 2026-08-29.

## History

For audit/provenance questions only, use `docs/current/WORK_QUEUE.md` and
`docs/archive/`. Those records are evidence, not the ordinary build workflow.
