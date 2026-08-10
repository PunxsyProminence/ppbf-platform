# Module 082 — Stop / Hold / Regress Engine

| Field | Value |
|-------|-------|
| Status | **DONE** |
| Active | false |
| Promotion required | true |
| Category | Safety / Recovery / Health (`safetyRecoveryHealth`) |
| Source | `2.0.0-draft-merged` |
| Parent original-25 | 11 Safety Gate |

## Intent
The engine owns the durable, attributed, expiring pause on an athlete's
training (`pilot.training_holds`) and its enforcement. The three title words
mean, per owner decision 2026-08-06: **Stop** — an active `all_training`
hold blocks class registration at request time, inside the registration
transaction, with the hold's own explanation; **Hold** — training paused
until a person lifts it or it expires, one active hold per athlete, linear
history; **Regress** — a scope-restricted hold (`contact_only` /
`conditioning_only`): training continues at reduced permitted intensity.
What regresses is the intensity, **never the athlete's standing** — the
platform has no athlete ranks, by recorded doctrine (the achievements
migration: "a greyed-out rung is how a system tells somebody they are the
incomplete version of somebody else"; the profile-identity migration
refuses the same ordering), and this module must never introduce one.
It must never write `gym_status` (membership, not safety), never add an
override path to the gate matrix, and never block a post-action record
(refusing a sparring log only hides the contact — under-reporting is the
failure mode that hurts an athlete).

## Boundaries
- Does **not** auto-approve progression, medical, or board decisions.
- Does **not** expose athlete-level data to board / public aggregates without suppression rules.
- Does **not** invent metrics that are not stored by the platform.
- Does **not** own skill-content regression — that is #23 Regression Library / #62 Skill Regression Engine.
- Does **not** own the graduated return ramp — that is #34 Return-to-Training.
- Does **not** compute fatigue or recovery — #81/#77 may later *trigger* holds; v1 holds are placed by people only.
- Does **not** let resolving the hold's escalation lift the hold — an escalation resolves when a human has looked; a hold lifts when a person lifts it.

## Dependencies
- Upstream: Safety Gate Matrix (#3/#43 — the `training_hold` gate row; the hold is a condition the gate reads, never an override), escalation ladder (#194 — `source_type='training_hold'`, filed in the placement transaction), audit vocabulary (`safety_hold_placed`/`safety_hold_lifted`)
- Downstream: scheduler registration (the STOP), contact observation flagging (the REGRESS rung's near miss), athlete workspace banner, guardian hold visibility (athlete-safe projection; full fidelity is #84's contract)
- Related original-25 capability: 11 Safety Gate

## Acceptance criteria
- [x] Data model / tables named — `pilot.training_holds` (+ base-schema copy, shape-diff-alarmed); no new columns on `pilot.athletes`
- [x] API surface listed — `GET/POST /api/pilot/training-holds` (place/lift); registration refusal via the scheduler route's `training_hold` outcome
- [x] Roles that may read / write — coaches place and lift for their own athletes (owner decision), org admins any; athletes and guardians read only the athlete-safe projection (explanation, lift condition, scope — never `reason_text`); board and platform_owner get nothing
- [x] Safety / refusal cases — one active hold per athlete (partial unique index); blank `athlete_explanation` refused by the database; guarded lift transition (no silent re-lift); 42P01 pre-migration windows degrade to pre-#82 behavior on every read path; contact during a covering hold flags (never blocks) at `high`
- [x] Audit events — `safety_hold_placed` / `safety_hold_lifted` (vocabulary widened in `auditEventTypes.ts` + both SQL homes)
- [x] UI surface — athlete workspace banner (non-punitive, self-contained), `/admin/escalations` renders hold escalations; place/lift is API-only in v1

## Implementation notes
Built 2026-08-06 on PR #238. Owner decisions recorded: all three rungs built
(regress = scope restriction, not demotion); coaches and admins both place
AND lift; enforcement at class registration. Deliberately deferred:
auto-placed holds (a system that stops a child by itself needs its own
review), a stale-hold review surface for indefinite holds, guardian
full-fidelity visibility (#84), and the pre-existing unaccountable coach
`gym_status` write (its own ticket). The #34 tracker marks Return-to-Training
DONE with no code behind it — flagged for owner correction; this module's
boundary assumes #34 is unbuilt.

## Audit log
| Date | Actor | Note |
|------|-------|------|
| 2026-08-03 | scaffold-script | Stub created from PPBF_CAPABILITIES.json |
| 2026-08-06 | session B (remote) | Built on PR #238: training_holds table, gate row, escalation wiring, registration block, contact flag, athlete banner. Scope decisions taken with owner. Status stays inactive pending promotion review. |
