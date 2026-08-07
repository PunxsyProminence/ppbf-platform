# Capability Build Plan — mapping the 200 and sequencing the rest of the app

**Date:** 2026-08-03 · **Built against:** `main` @ `2aa2ded` ·
**Source of the 200:** [`PPBF_CAPABILITIES.json`](../PPBF_CAPABILITIES.json)
(`expandedDetailedCapabilities`, 18 groups, 200 items)

This document does three things:

1. **Maps all 200 detailed capabilities against what is actually in the code today**
   (139 API routes, 68 pages, ~90 server modules under `apps/web/src/server/pilot/`),
   marking each **Built**, **Partial**, or **Not started**.
2. **Sequences the remaining work into eight phases**, ordered by dependency and
   pilot value, not by list order.
3. **Codifies the delivery process** — the same one that has already shipped this
   platform — so every capability lands the same proven way.

Statuses here are **source-read** (the Remote agent cannot observe runtime — see
[WORK_QUEUE_2026-08-01.md](WORK_QUEUE_2026-08-01.md) for that asymmetry). Where a
status depends on runtime behavior it says so.

---

## 1. Where the platform actually is

Rough scoreboard across the 200 detailed items:

| Status | Count (approx.) | Meaning |
|---|---|---|
| ✅ Built | 21 marked, 20 distinct | A dedicated module + route + surface exists and is tested. #113/#166 are the same code under two capability numbers (drift-checked 2026-08-06 — see below) |
| 🟡 Partial | ~54 | Real code covers part of the capability's scope |
| ⬜ Not started | ~125 | No dedicated code found |

**Drift check, 2026-08-06:** every row marked ✅ was audited against the actual codebase (does the cited evidence exist, still do what's claimed, and get reached by a real route/UI?). 16 of 21 confirmed clean. Five had real drift, each corrected in its own row: #8's evidence cited the wrong file for the review queue; #9 is admin-only, not athlete self-service, despite the "athlete portal" claim; #113/#166 are one capability double-counted under two numbers; #119's audit write path is real but has no reachable read UI. #82/#198/#200 (this session's builds) were verified end-to-end with full test suites at build time and are not re-audited here.

**Phase-1 re-scope, 2026-08-07:** the remaining Phase-1 target list (#5, #11, #75, #76, #78, #83, #150, #152, #157) was re-audited against the current codebase before continuing the build. #11, #83, and #76 were found already fully built (stale map cells or an untraced call chain, not a code gap — rows corrected above); #78 and #150 were found genuinely blocked on capabilities that don't exist yet (#199 Parent Education, #149 Donor-Safe Reporting — both Phase 3/4), not fixable in place. #75 and #152 had real, buildable gaps and shipped as PR-238j/p in `docs/current/WORK_QUEUE.md` (plus five Phase-2 items pulled forward: #84, #151, #12, #173, #125/70/74). #5 had a real, small, buildable gap (surfacing active hold status on `coach/progression-intelligence`, visibility only) and shipped the same night as PR-238q. #157 remains genuinely open but is explicitly a design gap (curating specific high-risk-phrasing vs. benign-phrasing lists), not an implementation one — deliberately not attempted unsupervised; see the ticket note. **Doc sync, 2026-08-07 (later same night):** rows #5, #12, #70, #74, #75, #84, #125, #151, #152, #173 above were updated to reflect what actually shipped (PR-238j–q, s) — three (#75, #151, #152) moved 🟡→✅, three (#70, #74, #125) moved ⬜→🟡 (generic capture only, no invented taxonomy), and #84 moved ⬜→🟡. The aggregate scoreboard counts above (21/~54/~125) still have not been fully recomputed against any of this — treat them as directionally stale, not exact, until a full re-sweep happens.

The build so far has been **deep in four areas** — identity/governance, SHADOW
(AI layer), coach review/video, and board/compliance — and **thin in the
training-science engines** (physical, skill, mental, transfer) that make up the
numerical bulk of the 200. That is the right shape: the engines all consume
session/observation data that only the core loop can produce.

---

## 2. The map — all 200 items by group

Legend: ✅ built · 🟡 partial · ⬜ not started · **Phase** = where it lands in §3.
Evidence pointers are the primary module or route; tests live alongside.

### Group A — Core Athlete System (items 1–12) — mostly built

| # | Capability | Status | Evidence / gap | Phase |
|---|---|---|---|---|
| 1 | Athlete Profile System | ✅ | `entities.ts`, `api/pilot/athletes/*` | — |
| 2 | Raw Observation Intake | 🟡 | `shadow/formulas/observations`, feedback intake; no unified observation store | 1 |
| 3 | Safety Gate System | 🟡 | Generalized 2026-08-06: `pilot.safety_gates` + `pilot.safety_gate_evaluations`, `safetyGateMatrix.ts` evaluation/recording substrate, seeded per-org. `contactClearanceGate.ts` is its first row (a 'flag' gate — see #43). No gate exists yet for age or training-level; no admin UI to configure gate rows beyond the seeded defaults. (Note: `gateSession` in the original evidence was a misidentification — it's CI/deploy session tooling, unrelated to athlete safety.) | 1 |
| 4 | Performance Tracking | 🟡 | `shadowMetrics.ts`, formula engine; athlete-facing trends missing | 3 |
| 5 | Progression Decision System | 🟡 | `progression.ts`, coach reviews; decision rules thin. Updated 2026-08-07: `coach/progression-intelligence` now shows an active training-hold banner (scope + athlete-safe explanation) — visibility only, since `progression.ts` still has no codified "ready to advance" rule for a hold to actually gate. The decision-rules gap itself remains open. | 1 |
| 6 | Training Assignment System | 🟡 | `admin/track-assignments`, `progression/assignments` | 1 |
| 7 | Session Builder | 🟡 | sessions CRUD exists (`api/pilot/sessions/*`); no builder workflow | 3 |
| 8 | Coach Review System | ✅ | Drift-corrected 2026-08-06: submission is `api/pilot/coach-reviews/route.ts` (real, called by `CoachWorkspace.tsx`); the queue a coach actually sees is `api/pilot/shadow/review-projection`, not `coach-reviews/list` (real route, but never called — the evidence cell named the wrong file). | — |
| 9 | Athlete Update System | ✅ | Drift-corrected 2026-08-06: `athletes/update` is real but is an **admin-only correction tool** (`app/admin/athletes/page.tsx`, `allowedRoles={['admin','platform_owner']}`) — it is not called anywhere under `app/athlete/*`. "Athlete portal" self-service update does not exist; the capability as built is staff-side only. | — |
| 10 | Development Route System | 🟡 | routing pieces in progression; Route Factory not built | 3 |
| 11 | Goal Management System | ✅ | Drift-corrected 2026-08-07: the gap was closed by commit `5d750cc` (#202) — `pilot_slice_postgres_goal_category_progress_migration.sql` adds nullable `category`/`progress_percent` to `pilot.goals`, `validation.ts`/`entities.ts`/both goal write routes persist them for real, and `AthleteWorkspace.tsx` no longer fabricates `'Boxing'`/`0%` defaults. This doc's own map cell was stale, not the code. | — |
| 12 | Roster / Participation System | 🟡 | roster export exists; no attendance (see #122). Updated 2026-08-07: `/admin/athletes` now shows each athlete's live attendance rate (best-effort, non-blocking) and cross-links with `/admin/attendance`. The CSV export route still lacks the column — its test file's exact call-count/credential-leak assertions made merging a second data source under time pressure too risky; left as a documented follow-up. | 2 |

### Group B — Physical Training System (13–36) — the largest gap

| # | Capability | Status | Phase | | # | Capability | Status | Phase |
|---|---|---|---|---|---|---|---|---|
| 13 | Physical Capacity Engine | ⬜ | 3 | | 25 | Limiter Hierarchy Engine | ⬜ | 5 |
| 14 | Load Management Engine | ⬜ | 3 | | 26 | Intervention Tracking | ⬜ | 5 |
| 15 | Energy System Development | ⬜ | 5 | | 27 | Testing / Retest Engine | 🟡 formulas | 3 |
| 16 | Movement Quality Engine | ⬜ | 5 | | 28 | Deload / Taper Engine | ⬜ | 5 |
| 17 | Athleticism Engine | ⬜ | 5 | | 29 | Warm-Up / Prep Engine | ⬜ | 3 |
| 18 | Strength Development Engine | ⬜ | 5 | | 30 | Cooldown / Recovery Routine | ⬜ | 3 |
| 19 | Recovery Engine | ⬜ | 3 | | 31 | Mobility / ROM Engine | ⬜ | 5 |
| 20 | Physical Readiness Engine | 🟡 `shadowReadiness.ts` | 3 | | 32 | Asymmetry / Imbalance Monitor | ⬜ | 5 |
| 21 | Adaptation Engine | ⬜ | 5 | | 33 | Fatigue Decay Monitor | ⬜ | 3 |
| 22 | Injury-Risk Engine | ⬜ | 3 | | 34 | Return-to-Training Engine | ⬜ | 3 |
| 23 | Regression Library | ⬜ | 3 | | 35 | Conditioning Balance Engine | ⬜ | 5 |
| 24 | Session Outcome Engine | ⬜ | 3 | | 36 | Periodization / Block Planning | ⬜ | 5 |

### Group C — Combat / Boxing System (37–45)

| # | Capability | Status | Evidence / gap | Phase |
|---|---|---|---|---|
| 37 | Combat Athlete Engine | ⬜ | | 5 |
| 38 | Boxing Skill Tracking Engine | 🟡 | drills library (`drills.ts`), film study | 5 |
| 39 | Punch Quality / Volume Engine | 🟡 | SHADOW video-analysis / film-study diagnostic | 5 |
| 40 | Defense / Exit / Reset Engine | 🟡 | film-study proposals | 5 |
| 41 | Footwork / Ring Movement Engine | 🟡 | film-study scope | 5 |
| 42 | Round Performance Engine | ⬜ | | 5 |
| 43 | Contact / Sparring Restriction Engine | 🟡 | `contactClearanceGate.ts`, now registered in the Safety Gate Matrix (#3) as a 'flag'-enforcement gate — deliberately does not block, since it guards a post-action record (contact that already happened); refusing the write would destroy the only record it occurred. A pre-action 'block' gate (e.g. sparring registration) is unbuilt | 1 |
| 44 | Non-Contact Youth Program Engine | ⬜ | | 2 |
| 45 | Coach-Controlled Constraint Engine | ⬜ | | 5 |

### Group D — Transfer System (46–53) — not started

Validation layers over longitudinal data; building them before the data exists
would produce empty dashboards, which the truth-on-screen rule forbids.

| # | Capability | Status | Phase |
|---|---|---|---|
| 46 | Performance Transfer Validation Engine | ⬜ | 6 |
| 47 | Multi-Sport Transfer Engine | ⬜ | 6 |
| 48 | Tactical Athlete Transfer Engine | ⬜ | 6 |
| 49 | Wrestling Transfer Module | ⬜ | 6 |
| 50 | Military Readiness Transfer Module | ⬜ | 6 |
| 51 | Life-Skill Transfer Module | ⬜ | 6 |
| 52 | Transfer Evidence Engine | ⬜ | 6 |
| 53 | False Progress Detection Engine | ⬜ | 6 |

### Group E — Learning / Skill Acquisition (54–63)

| # | Capability | Status | Phase | | # | Capability | Status | Phase |
|---|---|---|---|---|---|---|---|---|
| 54 | Skill Acquisition Engine | ⬜ | 5 | | 59 | Attention Control Engine | ⬜ | 6 |
| 55 | Retention Tracking Engine | ⬜ | 5 | | 60 | Constraint Library Engine | 🟡 drills | 5 |
| 56 | Mastery Verification Engine | ⬜ | 5 | | 61 | Practice Design Engine | 🟡 drills | 5 |
| 57 | Decision-Making Engine | ⬜ | 6 | | 62 | Skill Regression Engine | ⬜ | 5 |
| 58 | Cue Recognition Engine | ⬜ | 6 | | 63 | Spaced Repetition Engine | ⬜ | 5 |

### Group F — Mental / Emotional / Behavioral (64–74) — not started

Nine are ⬜. Two (70, 74) have natural data-capture hooks in the Phase 2
class-management build (behavior standards, at-home habit engine); as of
2026-08-07 the capture half is real — `coach/decision-loop`'s "Behavior &
Habit Note" panel posts to `pilot.coach_observations` (`note_type:
'behavior_standard'`), which #70/#74/#125 all share (see #125's row below
for the full build note). Deliberately no invented taxonomy of specific
behavior/habit categories yet — that's a coaching-philosophy decision for
the gym's own staff. The inference layers (pattern detection, streaks,
consequences) still land in Phase 6, unbuilt.

| # | Capability | Status | Phase |
|---|---|---|---|
| 64 | Emotional Regulation Engine | ⬜ | 6 |
| 65 | Resilience Engine | ⬜ | 6 |
| 66 | Confidence Stability Engine | ⬜ | 6 |
| 67 | Frustration Response Monitor | ⬜ | 6 |
| 68 | Reset Ability Engine | ⬜ | 6 |
| 69 | Behavior Pattern Engine | ⬜ | 6 |
| 70 | Discipline / Accountability Engine | 🟡 | 2 (capture) → 6 |
| 71 | Motivation / Engagement Engine | ⬜ | 6 |
| 72 | Character Development Engine | ⬜ | 6 |
| 73 | Leadership Development Engine | ⬜ | 6 |
| 74 | Habit Formation Engine | 🟡 | 2 (capture) → 6 |

### Group G — Safety / Recovery / Health (75–84) — the safety spine

| # | Capability | Status | Evidence / gap | Phase |
|---|---|---|---|---|
| 75 | Safety Review Engine | ✅ | Updated 2026-08-07: `getOrganizationSafetyReview()` + `/admin/safety-review` now rolls up all four previously-siloed safety systems — active training holds, failing safety-gate evaluations, open escalations, and open compliance violations — into one admin console, closing the gap `escalationLadder.ts`'s own header had named as open. Pure read-side rollup (`Promise.all` over each system's own existing list function); the underlying schemas remain separate by design. | 1 |
| 76 | Pain / Symptom Flag Engine | ✅ | Drift-corrected 2026-08-07: `alertCoachToPainReport` (`formulas/painReportAlert.ts`) already classifies severity from the 1-10 self-report and calls `flagNearMiss` with `metadata.trigger = PAIN_REPORT_TRIGGER` on every pain report; high/critical severity auto-escalates via #194's ladder. Tracing the full call chain further: `detectRepeatedPatternEscalations` (`escalationLadder.ts`) already groups near-misses by exactly that `metadata->>'trigger'` key and files a `repeated_pattern` escalation once an athlete crosses the threshold within the lookback window -- reachable today via `POST /api/pilot/escalations` (`action: 'scan_patterns'`) and a live "Scan for repeated patterns" button on `/admin/escalations`. Repeated-pain-report pattern detection is not a gap; it was already fully wired, just not traced end-to-end before. | — |
| 77 | Recovery Status Engine | ⬜ | | 3 |
| 78 | Medical Uncertainty Routing | 🟡 | Drift-corrected 2026-08-07: `shadowMedicalStatus.ts` was a misidentification (that module is the recommendation-clearance gate, unrelated to chat refusals) — the real routing lives in `shadowChat.ts`/`shadowHandoff.ts`: a medical refusal already calls `queueHumanReview` and attaches a topic-specific `resolveHandoff()` lesson ("talk to your medical staff/coach/org admin"), so the human-routing half of the teaching-moment principle is done. What's genuinely missing is routing to educational *content* (Parent Education, #199) instead of only "ask a human" — and that is blocked on #199, which is an empty DRAFT stub with no data model or route. Not buildable until #199 exists. | 1 |
| 79 | Water Safety Gate | ⬜ | swim module | 7 |
| 80 | Breath-Hold Restriction Engine | ⬜ | swim module | 7 |
| 81 | Fatigue Breakdown Engine | ⬜ | | 3 |
| 82 | Stop / Hold / Regress Engine | ✅ 2026-08-06 — `pilot.training_holds` + `trainingHolds.ts`; all_training holds block class registration; scoped holds (regress = reduced permitted intensity, never a demotion) flag contact; escalation + audit wired | | 1 |
| 83 | Unsafe Behavior Flag Engine | ✅ | Drift-corrected 2026-08-07: `flagNearMiss()` is generic (any free-text description + severity, `detected_by: 'human'` or `'system'`), and `coach/decision-loop` already has a coach/admin-facing "Near-Misses" panel with unrestricted free-text — a coach can already flag observed unsafe behavior directly, not just wait on athlete self-report, and high/critical severity already auto-escalates through #194's ladder. No dedicated "unsafe behavior" label exists, but the capability is functionally covered end-to-end. | — |
| 84 | Guardian Safety Report Engine | 🟡 | Built 2026-08-07: `getGuardianGateSummary()` + `GET /api/pilot/parent/safety` + `/parent/safety` gives a guardian a read-only rollup of their own child's active training-hold and safety-gate status, reusing the exact athlete-safe projection already shipped for the athlete themselves. Deliberately excludes `pilot.safety_escalations` entirely (an `athlete_voice` escalation must never reach a guardian) and doesn't embed consent status (links to `/parent/consent` instead). Not yet: a full-fidelity guardian view of resolved/historical safety signal. | 2 |

### Group H — At-Home / Parent / Guardian (85–96)

| # | Capability | Status | Evidence / gap | Phase |
|---|---|---|---|---|
| 85 | At-Home Task System | ⬜ | | 2 |
| 86 | At-Home Movement Homework | ⬜ | | 2 |
| 87 | Guardian Observation Engine | ⬜ | | 2 |
| 88 | Home Compliance / Habit Engine | ⬜ | | 2 |
| 89 | Home Safety Boundary Engine | ⬜ | | 2 |
| 90 | Family Communication Engine | 🟡 | announcements exist; no two-way family channel | 2 |
| 91 | Recovery Homework Engine | ⬜ | | 3 |
| 92 | Life-Skill Homework Engine | ⬜ | | 6 |
| 93 | Parent / Guardian Dashboard | 🟡 | `app/parent/dashboard`, progression-visibility | 2 |
| 94 | Parent Confirmation System | ⬜ | Scoped 2026-08-07, deliberately not built: no general confirmation/RSVP concept exists to build against. A narrow analog does — `pilot.scheduler_classes` registrations already carry `parent_reviewed`/`parent_reviewed_at`/`parent_reviewer_account_id`, wired end-to-end (`schedulerDb.ts`, a "Mark Parent Reviewed" button on `app/schedule/page.tsx`) — but that's registration-confirmation only. Building "the" confirmation system generally means naming what gets confirmed (event RSVP? permission-slip sign-off? attendance-excuse confirmation? waiver acknowledgment is already `/parent/consent`) — an owner decision, not an implementation gap. The `parent_reviewed` pattern is a reusable template once a target is named. | 2 |
| 95 | Home Barrier Reporting | ⬜ | Scoped 2026-08-07, deliberately not built: `pilot.coach_observations.note_type` is unconstrained text (no taxonomy migration needed, same as #125's reuse), but the one route that writes it (`domain-upsert`, via `createCoachObservation`) `requireRole`s `['organization_admin','coach']` only — a parent role is explicitly excluded, and no parent-facing write route exists at all. Unlike #125 (added a `note_type` value to an existing route), this needs a genuinely new surface: a parent-facing POST route + role gate, plus a decision on whether guardian-reported barriers belong in `coach_observations` (a coach-authored-data table, semantically) or a dedicated field/table — an owner call, not pure wiring. | 2 |
| 96 | Transportation / Attendance Barrier Tracker | ⬜ | Same scoping and same blocker as #95 immediately above — no parent-facing write route exists, and the target table/taxonomy question is an owner decision. | 2 |

### Group I — Swim / Water Confidence (97–103) — not started

Self-contained specialty module; its hard safety gates (water panic,
breath-hold) must ship *with* it, not after.

| # | Capability | Status | Phase |
|---|---|---|---|
| 97 | Swim Screening Module | ⬜ | 7 |
| 98 | Water Confidence Tracker | ⬜ | 7 |
| 99 | Pool Safety Gate | ⬜ | 7 |
| 100 | Underwater Restriction Engine | ⬜ | 7 |
| 101 | Continuous Swim Progression Tracker | ⬜ | 7 |
| 102 | Water Panic / Unsafe Breath-Hold Flag | ⬜ | 7 |
| 103 | Lifeguard / Safety Support Requirement Tracker | ⬜ | 7 |

### Group J — Body Composition (104–109) — not started

Small, but sensitive: the safety router (#108) and growth/maturation context
(#109) are prerequisites for the trackers, not add-ons, and the whole group
sits behind the Privacy-Tier System (#200).

| # | Capability | Status | Phase |
|---|---|---|---|
| 104 | Bodyweight Tracking | ⬜ | 7 |
| 105 | Waist Tracking | ⬜ | 7 |
| 106 | Measurement Context Engine | ⬜ | 7 |
| 107 | Body-Composition Trend Monitor | ⬜ | 7 |
| 108 | Body-Composition Safety Router | ⬜ | 7 (first in group) |
| 109 | Growth / Maturation Context Layer | ⬜ | 7 (first in group) |

### Group K — Coach System (110–119)

| # | Capability | Status | Evidence / gap | Phase |
|---|---|---|---|---|
| 110 | Coaching Doctrine Engine | 🟡 | SHADOW doctrine filtering | 5 |
| 111 | Coach Intelligence Engine | 🟡 | `coach/progression-intelligence` page | 5 |
| 112 | Coach Training Module | ⬜ | | 5 |
| 113 | Coach Dashboard | ✅ | `app/coach/*` (8 workspaces). Drift note 2026-08-06: **duplicate of #166** — same title, same code, two different category framings in the master list (`expanded-200-index.json` ModuleId 113 vs 166). No root `app/coach/page.tsx` aggregates the 8 workspaces into an actual dashboard; the scoreboard's "~18 built" double-counts this pair by one. | — |
| 114 | Coach Cue Library | 🟡 | drills library adjacent | 5 |
| 115 | Coach Intervention Library | ⬜ | | 5 |
| 116 | Coach Compliance / Integrity Engine | ⬜ | | 4 |
| 117 | Coach Scenario Training | ⬜ | | 5 |
| 118 | Coach Review Queue | ✅ | `coach/review-queue` | — |
| 119 | Coach Decision Audit | ✅ | Drift-corrected 2026-08-06: writes are real (`writeShadowAuditEntry`, called from `shadowDecisions.ts`/`shadowRecommendations.ts`/`shadowNearMisses.ts`/`shadowMedicalStatus.ts`/`shadowDecisionOutcomes.ts`); `listShadowAuditEntries` has zero callers anywhere in `app/` — no route lets anyone read this trail back. The one reachable audit UI (`app/audit/page.tsx`) reads a different table (`pilot.audit_events`) that decision code never writes to. Recorded, unreadable. | — |

### Group L — Class / Program Management (120–129)

| # | Capability | Status | Evidence / gap | Phase |
|---|---|---|---|---|
| 120 | Class Control Engine | 🟡 | `schedulerDb.ts`, scheduler route | 2 |
| 121 | Group Assignment Engine | 🟡 | track-assignments | 2 |
| 122 | Attendance Engine | 🟡 | This entry was wrong: `pilot.scheduler_attendance` + `schedulerDb.ts` + the scheduler route's `attendance_checkin` action already existed and recorded real check-ins. The actual gaps closed 2026-08-06: no reporting/rollup layer (now `attendanceReporting.ts` + `/api/pilot/scheduler/attendance-summary` + `admin/attendance`), no bulk class check-in (now `bulk_attendance_checkin`), and a real bug where a parent's check-in was misattributed as `coach_override` (now its own `method: 'parent'`, migrated). Still open: `CoachWorkspace.tsx`'s roster view still hardcodes `attendance: 'Unknown'` instead of querying the new summary endpoint — deferred because that file was claimed by a concurrent session; a second legacy table, `pilot.attendance` (written by `intake.ts`'s manual-entry flow, read by `passbook.ts`), remains a second source of truth not unified with `scheduler_attendance` in this pass | 2 |
| 123 | Station Rotation Engine | 🟡 | floor-plans route | 2 |
| 124 | Capacity Management Engine | ✅ | Drift-corrected 2026-08-07: `pilot.scheduler_classes.capacity` (`check (capacity > 0 and capacity <= 200)`) already exists; `schedulerDb.ts` computes `registeredCount` vs. capacity with row-locking to prevent overbooking races and sets a registration's status to `waitlisted` once a class is full; `app/schedule/page.tsx` already renders `Seats: {registered_count}/{capacity}` on the shared class-management surface, and the create-class form collects capacity. The core mechanic (track + enforce + display) is built; nothing here needed a product decision. | — |
| 125 | Behavior Standard Engine | 🟡 | Built 2026-08-07 (capture only): `pilot.coach_observations.note_type` already accepted any free-text value with no taxonomy and the `domain-upsert` route already had the `coach_note` entity path — this was a pure UI wiring gap. `coach/decision-loop`'s "Behavior & Habit Note" panel posts a single generic `note_type: 'behavior_standard'`, shared with #70/#74. Deliberately does not invent specific behavior/habit category names ("respect," "effort," etc.) — a coaching-philosophy decision for the gym's own staff, left for the owner. Pattern detection, streaks, and consequences remain Phase 6, unbuilt. | 2 |
| 126 | Recognition / Achievement Engine | ⬜ | | 2 |
| 127 | 1% Club / Leadership Pathway | ⬜ | | 2 |
| 128 | Community Service Tracker | ⬜ | | 2 |
| 129 | Program Phase Engine | ⬜ | | 2 |

### Group M — Data Quality / Trust (130–139)

| # | Capability | Status | Evidence / gap | Phase |
|---|---|---|---|---|
| 130 | Evidence Quality Engine | 🟡 | `shadowEvidenceTier.ts` | 4 |
| 131 | Confidence Score Engine | 🟡 | evidence tiers, SHADOW read models | 4 |
| 132 | Missing Data Engine | ⬜ | | 4 |
| 133 | Source Reliability Engine | 🟡 | `shadowLibrary.ts` sources | 4 |
| 134 | Duplicate Detection Engine | ⬜ | | 4 |
| 135 | Uncertainty Tagging Engine | 🟡 | RESEARCH_NEEDED fallback, handoff | 4 |
| 136 | Version / Source Status Engine | 🟡 | publications lifecycle | 4 |
| 137 | Audit Trail / Decision History | ✅ | `audit.ts`, `auditEventVocabulary` | — |
| 138 | Review Due Engine | ⬜ | | 4 |
| 139 | Approval Gate Engine | 🟡 | publications/review-action, video release | 4 |

### Group N — Governance / Admin / Nonprofit (140–153) — the strongest group

| # | Capability | Status | Evidence / gap | Phase |
|---|---|---|---|---|
| 140 | App Governance Layer | ✅ | capability registry + console (fixed in #158) | — |
| 141 | Human Approval System | ✅ | `shadowAuthority.ts` — no autonomous approval | — |
| 142 | Role Permission System | ✅ | `access.ts`, `PilotRole`, role model docs | — |
| 143 | Source-Control Dashboard | 🟡 | `/source-control` is a **labeled placeholder** | 4 |
| 144 | Change Log System | 🟡 | audit events; no user-facing changelog | 4 |
| 145 | File Status / Promotion System | 🟡 | video scan promotion, publications | 4 |
| 146 | Grant / Nonprofit Impact Engine | ⬜ | | 4 |
| 147 | Board Reporting Engine | 🟡 | board seats built; **~30 tiles "Unavailable"** (WQ 4.4) | 4 |
| 148 | Program Outcome Reporting | ⬜ | | 4 |
| 149 | Donor-Safe Reporting Engine | ⬜ | | 4 |
| 150 | Privacy / Sensitive Data Boundary | 🟡 | Re-audited 2026-08-07 against the now-shipped #200 registry: org isolation, field-tier enforcement, and board k-anonymity (`boardSummary.ts`, `BOARD_MINIMUM_COHORT_SIZE = 5`) are all solid and independently verified. The one open item, "donor-safe rules," is genuinely blocked on Phase 4 — no donor-facing report/export route exists anywhere in the codebase (#149 Donor-Safe Reporting is ⬜), so there is nothing to make safe yet. At its practical Phase-1 ceiling. | 1 |
| 151 | Consent / Waiver Tracker | ✅ | Updated 2026-08-07: `getOrganizationWaiverStatus()` + `/admin/waiver-status` gives an org-wide roster × waiver-type status grid across all four tracked types (`general`, `medical_release`, `photo_media`, `travel` — the existing `admin/consent/page.tsx` vocabulary, not a new taxonomy). `pilot.waivers` has no expiry column, so "lifecycle" here means current-status visibility, not expiry tracking — a real schema gap left as-is, not worked around. | 2 |
| 152 | Incident Report Engine | ✅ | Updated 2026-08-07: `fileIncidentReport()` + `POST /api/pilot/incidents` + `coach/decision-loop`'s "Report Incident" panel — a post-hoc "this actually happened" report, distinct from `pilot.shadow_near_misses`' "this almost happened," filed as a new `source_type: 'incident'` on the existing escalation ladder rather than a new table (reusing near-misses would have corrupted the repeated-pattern detector's counts). Severity forced to `high`/`critical` only, always human-triggered, enforced at both the route and the function itself. Write-only by design; reads go through the existing `/admin/escalations` queue. | 1 |
| 153 | Compliance Checklist Engine | ✅ | compliance rules + default seeds (#159) | — |

### Group O — AI / Automation Support (154–164) — largely built via SHADOW

| # | Capability | Status | Evidence / gap | Phase |
|---|---|---|---|---|
| 154 | AI Assistant Layer | ✅ | SHADOW chat, role sets, rate limits | — |
| 155 | Routing Recommendation Engine | ✅ | `shadowRecommendations.ts` + decide | — |
| 156 | Session Drafting Assistant | 🟡 | chat can draft; not wired to session builder | 3 |
| 157 | Safety Flag Assistant | 🟡 | feedback safety scan, response validator (WQ 3.3 open) | 1 |
| 158 | Progression Review Assistant | 🟡 | review projections | 3 |
| 159 | Source-Audit Assistant | 🟡 | library review flags | 4 |
| 160 | Duplicate-Risk Assistant | ⬜ | | 4 |
| 161 | Report Drafting Assistant | ⬜ | | 4 |
| 162 | Coach Prep Assistant | 🟡 | coach chat + prep surfaces | 5 |
| 163 | Parent Message Drafting Assistant | ⬜ | | 2 |
| 164 | No-Autonomous-Approval Guardrail | ✅ | `shadowAuthority.ts`, authority model doc | — |

### Group P — Dashboards / Reporting (165–175)

| # | Capability | Status | Evidence / gap | Phase |
|---|---|---|---|---|
| 165 | Athlete Dashboard | ✅ | athlete portal | — |
| 166 | Coach Dashboard | ✅ | coach workspaces | — |
| 167 | Parent / Guardian Dashboard | 🟡 | exists; thin until Group H ships | 2 |
| 168 | Admin Dashboard | ✅ | admin console suite | — |
| 169 | Readiness Dashboard | ⬜ | needs Phase 3 engines | 3 |
| 170 | Safety Dashboard | 🟡 | board compliance-monitoring page | 1 |
| 171 | Progression Dashboard | 🟡 | progression pages; gaps route | 3 |
| 172 | Performance Trend Dashboard | ⬜ | needs Phase 3 engines | 3 |
| 173 | Attendance Dashboard | 🟡 | `admin/attendance` — org/coach-scoped rollup table; no trend charts or grant-facing view yet. Updated 2026-08-07: `getWeeklyAttendanceTrend()` adds a real week-over-week rate sparkline, bucketed by the class's own `start_at` (not mark time), gap-filled on render for omitted zero-mark weeks. A Round-9 review-confirmed off-by-one (the window silently included the current in-progress week) was fixed with a real-Postgres regression suite. Still missing: a grant-facing export/share view — needs branding and access-control decisions the owner should make. | 2 |
| 174 | Grant / Impact Dashboard | ⬜ | needs #146 | 4 |
| 175 | Source-Control Dashboard | 🟡 | placeholder (same as #143) | 4 |

### Group Q — Advanced / Future (176–192) — deliberately last

Prediction/automation layers that are only honest once 6–12 months of real
athlete data exists. Building them earlier recreates the fake-data problem the
owner has explicitly banned.

| # | Capability | Status | Phase | | # | Capability | Status | Phase |
|---|---|---|---|---|---|---|---|---|
| 176 | Physical Digital Twin | ⬜ | 8 | | 185 | Environment Engine | ⬜ | 8 |
| 177 | Athlete Operating System | ⬜ | 8 | | 186 | Competitive Readiness Engine | ⬜ | 8 |
| 178 | Development Forecasting Engine | ⬜ | 8 | | 187 | Tactical Readiness Engine | ⬜ | 8 |
| 179 | Plateau Detection Engine | ⬜ | 8 | | 188 | Selection Prep Engine | ⬜ | 8 |
| 180 | Best Next Action Engine | ⬜ | 8 | | 189 | Scenario Simulation Engine | ⬜ | 8 |
| 181 | Risk Forecasting Engine | ⬜ | 8 | | 190 | Adaptive Logic Engine | ⬜ | 8 |
| 182 | Long-Term Athlete Development Engine | ⬜ | 8 | | 191 | System-Driven Next Session Engine | ⬜ | 8 |
| 183 | Multi-Athlete Pattern Engine | ⬜ | 8 | | 192 | Closed-Loop Execution Engine | ⬜ | 8 |
| 184 | Program Effectiveness Engine | ⬜ | 8 | | | | | |

### Group R — Strongest Additions Now (193–200) — pulled forward, as named

| # | Capability | Status | Phase |
|---|---|---|---|
| 193 | Parent-Safe Exercise Library | ⬜ | 2 |
| 194 | Red Flag Escalation Protocol | 🟡 | Built 2026-08-06: `pilot.safety_escalations` + `escalationLadder.ts`, auto-files from `shadowNearMisses.ts`'s `flagNearMiss` (covers contactClearanceGate + pain reports) for high/critical severity, `/admin/escalations` (coach acknowledges own athletes, admin resolves), repeated-pattern detector, board-safe k-anonymity summary. Deliberately not unified with `compliance.ts`'s `escalateViolation` (separate, already-working system) — that merge is a real product question, left open | 1 |
| 195 | Minimum Effective Dose Engine | ⬜ | 3 |
| 196 | Session Quality Score | ⬜ | 3 |
| 197 | Readiness-to-Learn Score | ⬜ | 3 |
| 198 | Athlete Voice Module | ✅ 2026-08-06 — athlete safeguarding feedback files `athlete_voice` escalations (admin-only surface, non-disclosing, oracle-safe) | 1 |
| 199 | Parent Education Module | ⬜ | 2 |
| 200 | Privacy-Tier System | ✅ 2026-08-06 — `privacyTiers.ts` names the six enforced tiers + `FIELD_TIERS` registry; `guardianAccess.ts` consolidates viewer-scoped guardian joins; drift-tested, no schema | 1 |

---

## 3. The build sequence — layered, not one-at-a-time

**Recommendation: layer the build.** One-capability-at-a-time is how each PR
should land, but it is the wrong unit for *planning*, because the 200 items
cluster on shared substrates (an attendance engine and an attendance dashboard
are one schema; twenty-four physical engines share one observation/測 store).
Building substrate once per layer and then shipping capabilities as thin
vertical slices on top of it is the efficient path — and it is exactly how the
already-built parts of this platform were made (SHADOW is one substrate with
~30 capabilities on it).

Ordering principles, in priority order:

1. **Safety before scale** — the platform's charter. Safety-spine gaps close first.
2. **Data producers before data consumers** — engines and dashboards only after
   the loop that feeds them exists. This is why Group Q is last, not first.
3. **Pilot operations before science** — attendance, classes, parents: the things
   a real gym touches daily.
4. **Truth on screen** — nothing ships showing invented data; "Unavailable" is
   acceptable, fabrication is not (standing owner instruction, 2026-07-31).
5. **One capability = one branch = one PR**, per the collision rules already in
   the work queue.

### Phase 0 — Clear the deck *(≈1 week, mostly VS Code + owner)*

Not new work — finishing [WORK_QUEUE_2026-08-01.md](WORK_QUEUE_2026-08-01.md):
merge/deploy the open PRs, run the Band 4 runtime verifications, and get the two
stalled **owner decisions** made (3.2 Scout Reports build-or-retitle; 4.4 which
board-seat tiles to fill). Nothing below should start while those PRs sit,
because they touch the same files.

### Phase 1 — Safety spine + core-loop closure *(~12 items)*

Targets: **3, 5, 11** (goal category/progress columns — known schema gap), **43→generalized,
75, 76, 78, 82, 83, 152, 194, 198, 200, 150, 157**.

The unified piece of substrate: a **Safety Gate Matrix** table + evaluation
module that `contactClearanceGate` becomes one row of, an **escalation ladder**
(194) that pain reports, near-misses, unsafe-behavior flags, and incident
reports all feed, and the **Privacy-Tier System** (200) — which must exist
*before* Phase 2 puts family-facing data everywhere and long before body
composition (Group J) is even considered.

**Athlete Voice (198)** rides here because it is small, high-signal for a youth
nonprofit, and its reports flow into the same escalation ladder.

### Phase 2 — Run the gym: classes, attendance, families *(~24 items)*

Targets: Group L (120–129), Group H (85–90, 93–96), **12, 44, 84, 151, 163, 167,
173, 193, 199**, plus behavior-standard hooks for **70/74**.

Substrate: an **attendance/participation event store** (#122 — the single
biggest daily-ops gap; nothing records who showed up), a **class/session
scheduling model** promoted from the current thin scheduler, and an **at-home
task/confirmation loop** for guardians. This phase is what makes the platform
usable *as a gym tool* for the pilot families, and it feeds the attendance
dashboard, barrier trackers, and — later — grant reporting (attendance is the
number every grant asks for).

### Phase 3 — Training intelligence, minimum honest set *(~18 items)*

Targets: **4, 7, 10, 13, 14, 19, 20→complete, 22–24, 27→complete, 29, 30, 33,
34, 77, 81, 91, 156, 158, 169, 171–172, 195–197**.

Not all 24 physical engines — the **minimum set that is honest with pilot-scale
data**: readiness, load, recovery, testing/retest, session outcome, injury-risk
flags, plus the three Group R scores (MED, Session Quality, Readiness-to-Learn)
which are deliberately simple heuristics. Substrate: one **observation/measure
store** with typed measures, which every later engine (Phases 5, 6, 8) reads.
The Session Builder (7) and Development Route System (10) complete here because
they now have engines to draw on.

### Phase 4 — Trust, reporting, and the board *(~20 items)*

Targets: Group M remainder (130–136, 138, 139), **116, 143→real or removed, 144,
145, 146–149, 159–161, 174, 175**.

This is the nonprofit's outward face: grant/impact engine, donor-safe reporting,
program outcome reporting, and **filling the ~30 "Unavailable" board-seat tiles**
with the data Phases 1–3 created (the Treasurer's tiles stay empty until the
payment slot — that is correct and documented). The `/source-control` placeholder
gets either its backend or removed, per the product call flagged in the queue.

### Phase 5 — Skill & combat depth *(~22 items)*

Targets: Group E (54–56, 60–63), Group C remainder (37–42, 45), Group B skill-adjacent
engines (15–18, 21, 25, 26, 28, 31, 32, 35, 36), **110–112, 114, 115, 117, 162**.

Boxing-specific intelligence on top of the observation store: skill tracking,
mastery verification, spaced repetition, cue/intervention libraries, coach
scenario training, periodization. Film study and drills already give this phase
a running start.

### Phase 6 — Transfer & the inner game *(~21 items)*

Targets: Group D (46–53), Group F (64–69, 71–73), **57–59, 92**.

The mission-differentiating layer — SPECOPS/military transfer, life-skill
transfer, emotional regulation, resilience, false-progress detection. Sequenced
here because every one of these is a *longitudinal inference* over data that
Phases 1–3 start collecting; starting collection hooks early (Phase 2's behavior
standards) shortens the wait.

### Phase 7 — Specialty modules *(~14 items)*

Targets: Group I (97–103) swim/water as one self-contained module with its gates
(**79, 80** ship inside it); Group J (104–109) body composition behind the
privacy-tier system; **Payment Service slot** per
[PAYMENT_SERVICE_SLOT.md](PAYMENT_SERVICE_SLOT.md) — which finally gives the
Treasurer seat its data.

### Phase 8 — Advanced / closed-loop *(17 items)*

Group Q (176–192), only when the data has aged enough to make forecasting,
plateau detection, and system-driven sessions honest — and each one still lands
behind the No-Autonomous-Approval guardrail (164): the system proposes, humans
approve, always.

### Track S — SHADOW / ML hardening *(parallel, not a phase)*

The 2026-08-03 external ML audit's findings match this repo's own audits, and
its priorities touch SHADOW's substrate rather than new capabilities — so they
run **in parallel** with Phases 1–3 instead of queuing behind them. In the
audit's priority order:

| S# | Item | When | Notes |
|---|---|---|---|
| S1 | **Stream Quick Round responses** | with Phase 1 | Top UX risk: ~33 s unstreamed "quick" answers train coaches to stop opening the tool, which starves the learning loop. Full validation still runs on the assembled final text before persist. |
| S2 | **Rewrite ML spec §1** to match `shadowRouter.ts` | immediately | §3 was corrected in #154; §1 still describes the dead 3-tier / mini-small design and fictional <2 s SLAs. Pin a "verified against commit" SHA. |
| S3 | **Provision embeddings in staging** + backfill + measure vs keyword | with Phase 1–2 | Code is ready (`shadowEmbeddings.ts`); only the deployment is missing. Move claim confidence from count-based to similarity-weighted after measurement. |
| S4 | **Filter-rate measurement** (#178) + persist filter reasons queryably | with Phase 1 | Three over-filter defects in two days proved the withheld-answer rate was never watched. Alert if it stays above ~1%. |
| S5 | **Film Study E2E** — executor behind the proposals gate, cost-measured | with Phase 2–3 | Upload→scan→ready exists; prove enqueue→proposal→human-accept on a real clip, with per-frame cost caps. Human accept stays mandatory for youth video. Malware gate only after Defender is confirmed. |
| S6 | **Scout Reports decision** | Phase 0 | Already stalled owner decision (WQ 3.2): build or retitle. |
| S7 | **Learning-loop operations** | Phase 2 onward | Low-friction feedback UI, a staffed library-review queue so `human_reviewed` can actually happen, unlock metrics on the admin console. Fine-tuning pipeline stays disabled until governance exists — the code already refuses; keep it that way. |
| S8 | **Classifier labels** | log now, calibrate later | Record (query, tier, override, outcome) from Phase 1 on; do not replace the heuristic before there are labels. High-risk patterns keep forcing Heavy Bag regardless. |

---

## 4. The process — tried and true, per capability

This codifies what already works in this repo. Every capability, in every phase,
lands through the same pipeline:

1. **Queue it.** An entry in the current `WORK_QUEUE_*.md` with a band, an owner
   (Remote / VS Code / owner-decision), and an id. Claim before starting — the
   one-line `WIP` edit is the lock. One branch per item: `claude/wq-<id>-<slug>`.
2. **Register it.** The capability enters the org capability registry as `DRAFT`
   (feature-flag off). `PPBF_CAPABILITIES.json` remains the master list;
   promotion requires owner approval (`governance.promotionRequired: true`).
3. **Schema first, operator-applied only.** Migrations go through
   `npm run pilot:apply-*` / the manual `apply-migrations` workflow — never
   HTTP, never as a deploy side effect (standing repo rule, and
   `httpRoutesCarryNoDdl.test.ts` enforces it).
4. **Server module + contracts** under `apps/web/src/server/pilot/`, typed via
   `contracts.ts` patterns.
5. **Route** under `app/api/pilot/**` with explicit `requireRole` lists.
6. **Surface** per the design system — `design-system/ppbf.css` is the single
   source of truth; check `PAGE_MAP.md` for shape and ground.
7. **Tests at all three altitudes** the repo already uses: unit (`*.test.ts`),
   Postgres (`*.pg.test.ts`), and route tests. A change that alters behavior
   ships with a test that fails without it.
8. **Green, then draft PR.** `npm run typecheck` / `lint` / `test` locally;
   Remote opens drafts and reports green; **VS Code merges and deploys** — that
   asymmetry is by design and stays.
9. **Truth on screen.** No sample rows, no fabricated ids, no client-side
   invention (the #158 lesson). "Unavailable" is an acceptable state;
   placeholders must label themselves.
10. **Promote.** After runtime verification (VS Code, real sessions), the owner
    flips the capability `DRAFT → ACTIVE`. The plan document's map (§2) gets its
    status cell updated in the same PR — the map only stays useful if it moves
    with the code.

**Safety gates are not a phase — they are a lane.** Any capability touching
minors, medical inference, contact/sparring, water, or body data must ship its
refusal/gate logic *in the same PR* as the feature, reviewed against
[SHADOW_AUTHORITY_MODEL.md](SHADOW_AUTHORITY_MODEL.md) and the doctrine rules.

**A safety stop is a teaching moment, not just a wall** *(owner principle,
2026-08-03)*. Every gate, refusal, and filter built from Phase 1 onward carries
two outputs, not one: the **stop** (fail-closed, exactly as today) and the
**lesson** — an age- and role-appropriate explanation of *why* it stopped and
what the safe path is. Concretely:

- A blocked sparring clearance tells the athlete what gate is unmet and what
  earns it — not just "blocked."
- A SHADOW medical refusal routes to the relevant Parent Education (199) or
  athlete-facing safety content instead of ending the conversation.
- A red-flag escalation (194) generates the guardian-facing explanation
  alongside the internal alert.
- Repeated stops on the same gate surface as a coaching signal ("this athlete
  keeps asking about weight cutting"), feeding the escalation ladder — because a
  pattern of unsafe questions is itself information a human should see.

The stop itself never softens — fail-closed stays fail-closed. The education
rides alongside it. This turns the safety spine from pure enforcement into
curriculum, which is the mission.

### Cadence and sizing

Recent history (the 2026-08-01 queue: 4 green PRs in one Remote pass) suggests a
sustainable rhythm of **3–6 capability PRs per week** once a phase's substrate
migration has landed. At that pace:

| Phase | Items | Rough duration |
|---|---|---|
| 0 | queue closure | ~1 week |
| 1 | ~12 | 2–3 weeks |
| 2 | ~24 | 4–6 weeks |
| 3 | ~18 | 3–5 weeks |
| 4 | ~20 | 3–5 weeks |
| 5 | ~22 | 4–6 weeks |
| 6 | ~21 | 4–6 weeks |
| 7 | ~14 | 3–4 weeks |
| 8 | 17 | open-ended, data-gated |

These are planning shapes, not commitments — each phase should open with its own
dated work queue (the `WORK_QUEUE_YYYY-MM-DD.md` pattern), which is where real
estimates get made item by item, and where mis-filed assumptions get corrected
the way the 08-01 queue corrected three of its own.

### Owner decisions this plan needs (beyond the two already stalled)

1. **Phase order sign-off** — especially Phase 2 (gym operations) ahead of
   Phase 3 (training engines). The reverse order is defensible if the pilot's
   coaches want engine output before family features.
2. **Privacy-Tier design (200)** must be approved before Phase 2 starts putting
   more athlete data in front of guardians.
3. **Scope of "minimum honest set"** in Phase 3 — which engines are heuristics
   now vs. deferred to real ML later (see
   [SHADOW_ML_ARCHITECTURE_SPEC.md](SHADOW_ML_ARCHITECTURE_SPEC.md)).
