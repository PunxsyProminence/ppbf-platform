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
commit that added it (`dataDeletion.ts` et al.). T-004 has since been
built as PR-238g above (2026-08-07); see that row and the ticket's own
status header for the two deliberate deviations from its literal
wording.

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
