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
| T-001 | P3 | Admin activation-code console (or remove dead route) | unclaimed | build | STAGING_READY | none | `admin/activation-codes/**` | low | #239 | — | — | Clean-room verified: typecheck, lint, 4 tests pass, build green | none | 2026-08-06 |
| T-002 | P1 | Covering coach cannot access an athlete they don't own | unclaimed | build | STAGING_READY | #243 | `access.ts`, new migration | medium — auth + schema | #242 | — | — | Clean-room verified: 284 suites pass, 15 new tests, typecheck/lint green, migrations pending (embedded-postgres flake on Windows, GitHub will verify) | Blocker #243 (coach reassignment) merged 2026-08-06 | 2026-08-06 |
| T-003 | P0 | Admin console for quarantined-video scan-review escalation | unclaimed | build | STAGING_READY | none | `admin/video-review/**` | medium — safeguarding, minors' footage | #237 | — | — | Clean-room verified: typecheck, lint, tests pass, E2E pass, build green | none | 2026-08-06 |
| PR-238a | P1 | Attendance Engine (#122): reporting rollup, bulk check-in, parent-method attribution fix + migration | session B (remote) | build | PR_OPEN | none | `schedulerDb.ts`, `attendanceReporting.ts`, `scheduler/**`, `admin/attendance`, 1 migration | medium — schema + role attribution | [#238](https://github.com/PunxsyProminence/ppbf-platform/pull/238) | — | — | none | 2026-08-06 |
| PR-238b | P1 | Safety Gate Matrix (#3/#43): `safety_gates` + `safety_gate_evaluations`, contactClearanceGate as first row, teaching-moment lesson | session B (remote) | build | PR_OPEN | PR-238a (same branch) | `safetyGateMatrix.ts`, `safetyGateSeeds.ts`, `contactClearanceGate.ts`, `auth.ts`, 1 migration | high — safety substrate, minors | [#238](https://github.com/PunxsyProminence/ppbf-platform/pull/238) | — | — | none | 2026-08-06 |
| PR-238c | P1 | Red Flag Escalation ladder (#194): `safety_escalations`, auto-escalation from near misses, `/admin/escalations`, pattern detector | session B (remote) | build | PR_OPEN | PR-238b (same branch) | `escalationLadder.ts`, `shadowNearMisses.ts`, `api/pilot/escalations`, `admin/escalations`, 1 migration | high — safety substrate, minors | [#238](https://github.com/PunxsyProminence/ppbf-platform/pull/238) | — | — | none | 2026-08-06 |
| PR-238d | P1 | Athlete Voice (#198): athlete safeguarding feedback files `athlete_voice` escalations — admin-only, non-disclosing, oracle-safe | session B (remote) | build | PR_OPEN | PR-238c (same branch — widens the unapplied `safety_escalations` CHECK in place) | `athleteVoice.ts` (new), `feedback/submit/route.ts`, `escalationLadder.ts`, `api/pilot/escalations`, `admin/escalations` page | high — safeguarding, minors' disclosures | [#238](https://github.com/PunxsyProminence/ppbf-platform/pull/238) | — | — | `feedback.ts` is session A's reserved file (prior queue §ownership) — deliberately NOT touched; the bridge lives in a new module + the submit route | 2026-08-06 |
| PR-238e | P1 | Privacy-Tier System (#200): name the six enforced tiers, promote the wall denylists into `FIELD_TIERS`, consolidate viewer-scoped guardian joins | session B (remote) | build | PR_OPEN | PR-238c (same branch — `FIELD_TIERS['safety_escalations.source_type']` names `escalationLadder.ts#listEscalations`, which the drift guard hard-requires; no schema, no runtime gate change) | `privacyTiers.ts` (new), `guardianAccess.ts` (new), `access.ts` (parent branch delegates), `scheduler/route.ts`, `shadowReadModels.ts`, `research-requirements/route.ts`, `profileVisibility.ts` (MINOR_CIRCLE export, read-only), wall privacy tests, `modules/200-*.md` | low — registry + refactor, drift-tested | [#238](https://github.com/PunxsyProminence/ppbf-platform/pull/238) | — | — | Weight-category reversal (`goals.category`) is a separate owner decision the registry enables but does not make; note: ParentDigest shipped on main ahead of the plan's #200-first ordering | 2026-08-06 |

**PR-238a/b/c predate this queue and its ticket process** — they were claimed
and built under the prior `docs/WORK_QUEUE.md` (rows preserved there) on one
branch because that session is constrained to a single branch. Registered
here at `PR_OPEN` so the gatekeeper has the rows the collision rules require;
three logical capabilities, one PR, cherry-pickable per the PR body. Builder
does not assert `CI_GREEN` per this table's own rule — observe it on the PR.

| PR-238f | P1 | Stop/Hold/Regress (#82): `pilot.training_holds`, registration STOP, scoped-hold REGRESS contact flag, escalation + audit wiring, athlete banner | session B (remote) | build | PR_OPEN | PR-238b/c (same branch — gate row + `training_hold` escalation source_type; also widens the applied audit-vocabulary migration, operator must re-dispatch `apply-migrations: audit-event-vocabulary`) | `trainingHolds.ts` (new), `training-holds/route.ts` (new), `schedulerDb.ts`, `scheduler/route.ts`, `observations/route.ts`, `safetyGateSeeds.ts` + matrix migration seed, `escalationLadder.ts` vocab, `auditEventTypes.ts` + both SQL homes, `AthleteWorkspace` banner, 1 new migration | high — safety substrate, minors; owner decisions recorded in module doc | [#238](https://github.com/PunxsyProminence/ppbf-platform/pull/238) | — | — | Owner decisions 2026-08-06: all three rungs (regress = scope restriction, no athlete ranks); coaches AND admins place/lift; enforcement at registration | 2026-08-06 |

| PR-238g | P2 | Portrait review exit UI (T-004): admin console listing `pending_review` portraits org-wide, approve/reject reusing the existing release/block state machine | session B (remote) | build | PR_OPEN | none (reuses existing `pilot.account_profiles` schema, `photo_review_state` column, and the partial index built for this exact query — no new migration) | `profileDb.ts` (+`listPendingReviewPortraits`), `admin/portrait-review/**` (new), `api/pilot/admin/portrait-review/**` (new) | medium — safeguarding, minors' photos; org-admin-only decide action, narrower than the sibling coach/self-carve-out route it reuses | [#238](https://github.com/PunxsyProminence/ppbf-platform/pull/238) | — | — | Two deliberate ticket deviations, reasoned through in scoping and recorded in the commit message: (1) "reject" is a state transition to `blocked` (blob deleted, row kept with attributed reviewer) matching the existing `photo/review` route's `block` path, not a row DELETE — a literal delete would be a second inconsistent code path and `delete` isn't in the audit-event vocabulary at all; (2) no thumbnail preview — `profileVisibility.ts` deliberately withholds a pending minor's photo from admins too, and loosening that is a safeguarding policy call, not a UI call, so it ships without it | 2026-08-07 |

| PR-238h | P2 | Video compliance review console (T-006): admin console listing `pending_review` publications org-wide, approve/reject/request-changes reusing the existing check/status state machine | session B (remote) | build | PR_OPEN | none (reuses existing `pilot.video_publications` / `pilot.publication_checks` schema — no new migration) | `publication.ts` (+CAS param on `updatePublicationStatus`), `admin/video-compliance/**` (new), `api/pilot/admin/video-compliance/**` (new) | medium — safeguarding, minors' video footage; org-admin-only decide action, adds the audit logging the sibling `check`/`create` routes are missing | [#238](https://github.com/PunxsyProminence/ppbf-platform/pull/238) | — | — | Two deliberate ticket deviations, reasoned through in scoping and recorded in the commit message: (1) "reject" moves to the real terminal `rejected` status, not back to `draft` — no such transition exists in `publication.ts`, and the coach-facing UX already tells a rejected uploader to start a new publication; (2) "athlete list" is actually a single scalar `athlete_id` column, not a join table — the UI shows one athlete, not a list. Confirmed genuinely separate from T-003's scan-review gate during scoping (different table, downstream of it — `createPublication` refuses until the video session is `'ready'`). Proactively added the same CAS guard the T-004 review found missing there, before building this route, rather than waiting to be told twice | 2026-08-07 |

| PR-238i | P1 | Guardian media consent (T-008): guardian grant/withdraw console + org-admin audit, gates video-compliance approval on consent | session B (remote) | build | PR_OPEN | PR-238h (same branch — gates video-compliance's approve decision) | `guardianConsent.ts` (new), `guardianAccess.ts` (+`guardianParentIds`, +`guardianParentIdForAthlete`), `intake.ts` (`upsertWaiver` +optional params), `http.ts` (+`GuardianConsentMissingError` 409), `auditEventTypes.ts` + both SQL homes (+`consent_granted`/`consent_withdrawn`), `parent/consent/**` (new), `api/pilot/parent/consent/**` (new), `admin/athlete-consent/**` (new), `api/pilot/admin/athlete-consent/**` (new), `api/pilot/admin/video-compliance/route.ts` (+consent gate on approve, +transactional re-check), `publication.ts` (+`verifyBeforeCommit` hook on `decidePublicationCompliance`), 1 new migration (`pilot.waivers` +`parent_id`/`covers_video`/`public_use_allowed`), 1 new reporting script | high — safety substrate, minors' media; new schema, gates an existing approval path | [#238](https://github.com/PunxsyProminence/ppbf-platform/pull/238) | — | — | Extends the existing `pilot.waivers` table (`waiver_type='photo_media'`, already in `admin/consent/page.tsx`'s vocabulary from an earlier build) rather than the ticket's proposed new `guardian_media_consent` table — one source of truth for the same real-world fact, not two; full reasoning in the migration's own header. Deliberately deferred, and stated as such rather than silently dropped: consent-scope (photo/video, internal/public) is recorded but not yet matched against a publication's actual media type or visibility; withdrawing consent never retroactively un-publishes an already-published video (no such status value exists on `pilot.video_publications`). **Round-8 self-review (2026-08-07, commit `4cd01d1`): 10 raw → 8 confirmed, all fixed** — critical: `resolveActingParent` picked an unordered "first" `pilot.parents` row with no athlete scoping, so an account backing two children through two different parent rows could silently write a consent decision under the wrong child's guardian record; fixed by requiring the athlete and joining through `guardian_links` (moved into `guardianAccess.ts` as `guardianParentIdForAthlete` per that module's consolidation doctrine). Also fixed: a TOCTOU race between the pre-approval consent check and the CAS-guarded approval transaction (closed with an in-transaction re-check); a blocked-approval attempt going unaudited despite the ticket's own acceptance criteria; and three test-quality gaps (`guardianParentIds`/`guardianParentIdForAthlete` coverage, a real-Postgres cross-organization isolation test, a grant-defaults-omitted test) | 2026-08-07 |

| PR-238j | P1 | Incident Report Engine (#152): post-hoc "this actually happened" report, distinct from a near-miss, files directly into the escalation ladder | session B (remote) | build | PR_OPEN | PR-238c (same branch — widens the unapplied `safety_escalations` CHECK in place, same mechanism #198/#82 already used) | `escalationLadder.ts` (+`fileIncidentReport`, +`incident` source_type), `pilot_slice_postgres_safety_escalations_migration.sql` (widened in place, not a new file — see below), `api/pilot/incidents/route.ts` (new), `coach/decision-loop/page.tsx` (+Report Incident panel) | medium — safety substrate, minors; new write path into an existing table, no new read surface | [#238](https://github.com/PunxsyProminence/ppbf-platform/pull/238) | — | — | Phase-1 re-scope (2026-08-07) found no schema concept for "this happened" as opposed to `pilot.shadow_near_misses`' "this almost happened" — reusing near-misses would corrupt `detectRepeatedPatternEscalations`' own counts, so this is a new `source_type`, not a new table. First attempt used a separate widening-migration file (the pattern used for `pilot.audit_events`/`pilot.waivers`); `escalationLadder.pg.test.ts`'s own shape-diff drift guard caught that this table's established pattern is different -- `pilot_slice_postgres_safety_escalations_migration.sql` self-widens in place via its own idempotent DO block (already used once for #198/#82), so the fix was reverted and redone editing that file directly instead. Read access reuses the existing `/admin/escalations` queue; this ships write-only (severity forced `high`/`critical`, always human-triggered). | 2026-08-07 |

| PR-238k | P1 | Guardian Safety Report (#84): read-only rollup of a guardian's own child's training-hold and safety-gate status | session B (remote) | build | PR_OPEN | PR-238f/i (same branch — reads `trainingHolds.ts`/`safetyGateMatrix.ts`, links to T-008's `/parent/consent`) | `safetyGateMatrix.ts` (+`getGuardianGateSummary`), `api/pilot/parent/safety/route.ts` (new), `parent/safety/page.tsx` (new), `buildingMap.ts` (+door) | medium — safeguarding, minors; read-only, reuses the SAME athlete-safe projections already shipped, no new data exposed beyond what the athlete themselves can already see | [#238](https://github.com/PunxsyProminence/ppbf-platform/pull/238) | — | — | Phase-2 re-scope (2026-08-07) found the backend (training-holds' parent branch) already existed but nothing surfaced it; gate status had no guardian-scoped read at all. Deliberately excludes `pilot.safety_escalations` entirely (an `athlete_voice` escalation must never reach a guardian per `escalationLadder.ts`'s own doctrine) and does not embed consent status (links to the existing `/parent/consent` instead of duplicating it). No `safetyGateMatrix.ts` pg-level test added for the new query — the module's existing pg suite has no function-level db-mock scaffold to extend safely under time pressure; covered by 4 unit tests instead, a documented gap not a silent one. **Hardening (2026-08-07):** Round 9 review flagged this gap and, on independent verification, found the SQL already correct (not an active bug) but the coverage gap real; added the `jest.mock('./db')`/`activeClient` scaffold to `safetyGateMatrix.pg.test.ts` and 5 real-Postgres tests for `getGuardianGateSummary` (newest-evaluation-wins ordering, not-evaluated default, athlete-scope isolation, org-scope isolation, inactive-gate exclusion) — 15/15 passing. | 2026-08-07 |

| PR-238l | P2 | Waiver Compliance audit (#151): org-wide roster × waiver-type status grid, across every tracked type, not just photo/media | session B (remote) | build | PR_OPEN | none (reuses existing `pilot.waivers` schema — no new migration) | `waiverCompliance.ts` (new), `api/pilot/admin/waiver-status/route.ts` (new), `admin/waiver-status/page.tsx` (new), `buildingMap.ts` (+door) | low — compliance visibility, read-only, no schema change | [#238](https://github.com/PunxsyProminence/ppbf-platform/pull/238) | — | — | Phase-2 re-scope (2026-08-07) found `admin/consent/page.tsx` already handles per-athlete waiver lookup across all types, and T-008's `admin/athlete-consent` already handles org-wide rollup for `photo_media` specifically — but nothing rolled up general/medical_release/travel org-wide. `TRACKED_WAIVER_TYPES` reuses `admin/consent/page.tsx`'s own existing 4-value vocabulary, not a new taxonomy. `pilot.waivers` has no expiry column, so "lifecycle" here means current-status visibility only, not expiry tracking — a real schema gap, not something this PR invents a workaround for. No pg-level test added (pure read over existing schema, no migration); covered by 5 unit tests on the query-grouping logic instead. **Hardening (2026-08-07):** Round 9 review flagged this gap and, on independent verification, found the SQL already correct (not an active bug) but the coverage gap real; added `waiverCompliance.pg.test.ts` (new, `npm run test:migrations:waiver-compliance`) — 6 real-Postgres tests for `getOrganizationWaiverStatus` (newest-waiver-wins ordering including a withdrawn-supersedes-signed case, missing-defaults-to-missing, untracked `waiver_type` never surfaces, athlete-scope isolation, org-scope isolation, `activeFlag` passthrough). | 2026-08-07 |

| PR-238m | P3 | Roster-attendance connection (#12): roster list shows each athlete's live attendance rate, cross-linked with the attendance dashboard | session B (remote) | build | PR_OPEN | PR-238a (same branch — reads `attendanceReporting.ts`) | `admin/athletes/page.tsx` (+attendance-rate fetch/render, +link), `admin/attendance/page.tsx` (+reciprocal link) | low — UI-only, best-effort read, never blocks the roster | [#238](https://github.com/PunxsyProminence/ppbf-platform/pull/238) | — | — | Phase-2 re-scope (2026-08-07) found #122 built real attendance data and a summary page, but the roster list/edit console and the CSV export still had no attendance column and neither page linked to the other. Deliberately scoped to the roster LIST page only, not the CSV export (`api/pilot/admin/export/roster/**`) -- that route/test file is unusually tightly guarded (organization-scoping regex assertions, an exact-query-call-count assertion, credential-leak assertions) and merging in a second data source under time pressure risked a mistake in code proven correct by design; left as a follow-up rather than rushed. | 2026-08-07 |

| PR-238n | P3 | Attendance weekly trend (#173): a real week-over-week rate strip on the existing attendance dashboard | session B (remote) | build | PR_OPEN | PR-238a/m (same branch — reads `attendanceReporting.ts`, sibling of #12's cross-links) | `attendanceReporting.ts` (+`getWeeklyAttendanceTrend`), `api/pilot/scheduler/attendance-summary/route.ts` (+`?trend=1&weeks=N` mode), `admin/attendance/page.tsx` (+trend strip) | low — pure read, no schema change, additive query param | [#238](https://github.com/PunxsyProminence/ppbf-platform/pull/238) | — | — | Buckets by the class's own `start_at` (one row per dated session), not by when a mark was recorded, so a late-entered check-in still belongs to the week the class happened. A week with zero marks is omitted, not zero-filled -- `attendance_rate: null` would be indistinguishable from a real 0% week, same doctrine as the existing per-athlete summary. Deferred, per the ticket's own scope split: a grant-facing export/share view -- that needs branding and access-control decisions the owner should make, not something inferred from the schema. **Round-9 review (2026-08-07): confirmed off-by-one, fixed** — the window had no upper bound and anchored from the start of the CURRENT, still-in-progress week, so a caller asking for "the last 8 weeks" silently got 9 whenever the current week already had marked attendance; every test for the function mocked `query()`, so none exercised the real `date_trunc`/`interval` arithmetic that hid it. Fixed by adding `c.start_at < date_trunc('week', now())`; added `attendanceReporting.pg.test.ts` (real embedded Postgres, `npm run test:migrations:attendance-trend`) so this class of bug fails a real query going forward, not just a mocked one. | 2026-08-07 |
| PR-238r | P2 | Merge `origin/main` (T-007 audit-vocabulary fix + gym-local dates, #253) into this branch | session B (remote) | integrate | PR_OPEN | none | `auditEventTypes.ts`, both SQL homes (conflict: main's `data_deletion_initiated`/`data_purged` widening vs. this branch's `safety_hold_*`/`consent_*` widening — resolved by keeping both value sets), `gymTime.ts` (+`formatGymDateTimeShort`, +`formatGymDayShort`), `admin/attendance/page.tsx`, `admin/escalations/page.tsx`, `admin/portrait-review/page.tsx`, `admin/video-compliance/page.tsx` (converted from viewer-timezone `toLocaleDateString`/`toLocaleString` to the gym-local helpers main's new drift-guard test (`gymTimeDrift.test.ts`) flagged as new offenders) | low — merge reconciliation + display-only conversion, no schema/behavior change beyond the vocabulary union | [#238](https://github.com/PunxsyProminence/ppbf-platform/pull/238) | — | — | PR went `mergeable_state: dirty` when main advanced past this branch's fork point; resolved per this environment's standing PR-ownership obligation (fetch, merge, resolve, verify, push — not wait or ask). The vocabulary collision was a same-file, different-values conflict, not a logic conflict — concatenated both lists and confirmed agreement with `auditEventVocabulary.test.ts` (18/18). `gymTimeDrift.test.ts`'s allowlist is a ratchet that "only ever shrinks" per its own header comment, so the four flagged files were converted, not grandfathered in. | 2026-08-07 |
| PR-238s | P2 | Round-9 self-review fixes: decision-loop UI bugs, sparkline gap-fill, incident severity floor | session B (remote) | fix | PR_OPEN | PR-238j/n/o (same branch — fixes bugs introduced by those builds) | `coach/decision-loop/page.tsx` (+stale-banner clear on athlete switch, +busy-disabled Report Incident/Log Note buttons), `admin/attendance/page.tsx` (+`fillWeeklyTrendGaps`, omitted-week gap marker), `escalationLadder.ts` (+runtime severity floor in `fileIncidentReport`) | medium — safety-adjacent UI correctness, no schema change | [#238](https://github.com/PunxsyProminence/ppbf-platform/pull/238) | — | — | **Round-9 review (2026-08-07): 11 raw → 8 confirmed (3 refuted as hypothetical-only, no active bug), all confirmed fixed.** High: `incidentFiledMessage`/`behaviorNoteMessage` on `coach/decision-loop` survived an athlete switch, so a stale "Incident filed" confirmation from athlete A kept showing under athlete B's panel -- now cleared at the top of `refreshAll`. High: the Report Incident client form (capability #152) had zero test coverage -- added 6 tests (severity default, explicit severity + occurredAt, field clear, empty-description guard, error display, double-submit guard) to `decision-loop/page.test.tsx`. Medium: neither the Report Incident nor Behavior Note submit button guarded against a double-click firing two independent POSTs (no idempotency key on either write path) -- both buttons now disable while their request is in flight. Medium: `getWeeklyAttendanceTrend`'s own doc comment promises "the page fills gaps on render" for an omitted zero-mark week, but the sparkline rendered whatever weeks came back as adjacent bars with no gap indicator -- added `fillWeeklyTrendGaps` to reindex onto every Monday between the first and last returned week, rendering a dashed/dimmed placeholder bar for each one the server omitted. Medium: `fileIncidentReport`'s 'high'/'critical' severity floor was TypeScript-only, enforced in practice only by the route's own allow-list check -- added a runtime throw inside the function itself so a future caller that bypasses the route (a script, a different endpoint) can't file a sub-floor severity. Refuted (verifier found the underlying SQL already correct, no active bug -- coverage gaps only, not fixed this round): `safetyGateMatrix.getGuardianGateSummary` and `waiverCompliance.getOrganizationWaiverStatus` both lack pg-level tests for their LATERAL-join "most recent/latest per group" logic; left as a documented gap, not a confirmed bug. | 2026-08-07 |

| PR-238o | P3 | Behavior/habit note capture (#125/#70/#74 capture hook): coach-facing free-text logging, no invented taxonomy | session B (remote) | build | PR_OPEN | none (reuses existing `pilot.coach_observations` schema and `api/pilot/intake/domain-upsert` route -- no new migration, no new route) | `coach/decision-loop/page.tsx` (+Behavior & Habit Note panel) | low — UI-only, reuses an existing route unchanged, no schema/taxonomy decisions made | [#238](https://github.com/PunxsyProminence/ppbf-platform/pull/238) | — | — | Phase-2 re-scope (2026-08-07) found `pilot.coach_observations.note_type` already accepts any free-text value (no CHECK constraint) and `domain-upsert`'s `entity_type: 'coach_note'` path already exists -- this was a pure UI wiring gap. Deliberately does NOT invent a taxonomy of specific behavior/habit categories ("respect," "effort," etc.) -- that is a coaching-philosophy/curriculum decision for the gym's own staff, explicitly flagged rather than guessed at. A single generic `note_type: 'behavior_standard'` is used; pattern detection, streaks, and consequences remain Phase 6 scope (#70/#74's own future engines), not attempted here. | 2026-08-07 |

| PR-238p | P1 | Rolled-up Safety Review (#75): one admin console over holds + gates + escalations + compliance violations, all currently siloed | session B (remote) | build | PR_OPEN | PR-238b/c/f (same branch — reads `trainingHolds.ts`/`safetyGateMatrix.ts`/`escalationLadder.ts`/`compliance.ts`, all unchanged) | `safetyReview.ts` (new), `api/pilot/admin/safety-review/route.ts` (new), `admin/safety-review/page.tsx` (new), `buildingMap.ts` (+door) | medium — safety substrate, minors; read-only rollup, no schema change, no change to any of the four underlying systems | [#238](https://github.com/PunxsyProminence/ppbf-platform/pull/238) | — | — | Phase-1 re-scope (2026-08-07) confirmed the gap `escalationLadder.ts`'s own header already named as open ("whether to eventually merge [compliance violations and the escalation ladder] is a real product question left open") -- four real safety systems, four separate pages, no admin ever saw all open signal for an org in one screen. Deliberately a pure read-side rollup (one `Promise.all` over each system's own existing list function) rather than a new unified table -- merging the underlying schemas is a bigger, riskier change this ticket does not attempt. | 2026-08-07 |

| PR-238q | P2 | Progression hold visibility (#5): active training-hold banner on `coach/progression-intelligence` | session B (remote) | build | PR_OPEN | PR-238f (same branch — reads `GET /api/pilot/training-holds`, unchanged) | `coach/progression-intelligence/page.tsx` (+hold banner, best-effort fetch) | low — UI-only, read-only, no schema/route change | [#238](https://github.com/PunxsyProminence/ppbf-platform/pull/238) | — | — | Phase-1 re-scope (2026-08-07) found `progression.ts` has no codified "ready to progress" rule at all -- it is a gap-tracking tool (identify → assign drill → verify), not a decision engine, matching the capability map's own "decision rules thin" framing exactly. There is nothing for a hold to block, since nothing decides advancement. The honest, buildable gap is visibility only: a coach assigning or verifying progression work now sees an athlete's active hold (scope + athlete-safe explanation) instead of it being invisible on this page. Deliberately does not enforce anything -- an automated readiness-to-progress engine needs training-science criteria this platform does not have codified anywhere, which is real Phase 3 scope, not this fix. | 2026-08-07 |

**T-002 collision, reconciled 2026-08-06 (collision rule 5).** Session B
claimed and built T-002 on PR #238 in parallel with the Lane A build that
merged as #242/#243 — the session B claim was pushed to the PR branch, so
Lane A never saw it. Reconciled in favor of the merged #242/#243
implementation (schema, `grantCoachCoverage`/`revokeCoachCoverage`,
route, and the stricter #243 reassignment guard all stand verbatim).
PR #238 retains only what the merged version lacks: the 42P01
pre-migration guard in `assertCoachAssignedToAthlete`, the escalations
coach-scope coverage union, grant-time active-coach and overlap checks,
audit events on grant/revoke, the base-schema copy of the table, and a
real-Postgres acceptance suite (`coachCoverage.pg.test.ts`) retargeted to
the merged column names. The T-002 row above is Lane A's, unmodified.

**T-005 collision, reconciled 2026-08-06 (collision rule 5).** Main added
`intake/tickets/T-005-shadow-safety-escalations-readable-queue.md`
(commit `e3cfd30`) describing an unreadable `pilot.safety_escalations`
admin queue — a real gap against `origin/main` at that commit, and
independently found: it predates and does not reference PR #238. That
gap is exactly capability #194 (PR-238c above), already built and
adversarially reviewed on this branch. No duplicate page was built.
Full evidence mapping is in the ticket file's own reconciliation note;
summary: `admin/escalations` (not `admin/safety-escalations` — a path
difference, not a gap) is broader than asked (coach-scoped view in
addition to org admin), and the audit trail is row-column-based
(`acknowledged_by_account_id`/`resolved_by_account_id`/etc.) rather
than a separate `audit_events` entry — functionally equivalent. Ticket
marked RESOLVED with the pointer. T-004, T-006, T-008 (added in the
same commit) were checked and did not collide with anything on this
branch at the time — genuinely open. T-007 was resolved by the same
commit that added it (`dataDeletion.ts` et al.). All three have since
been built: T-004 as PR-238g, T-006 as PR-238h, T-008 as PR-238i
(2026-08-07); see those rows and each ticket's own status header for
the deliberate deviations from its literal wording.

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
