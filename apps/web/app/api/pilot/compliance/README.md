# Safety Compliance Center -- gates

Documentation on disk. Nothing imports this file, it is not under `public/`, and
no page renders it.

Written from what the code does on `origin/main` at `04dd116b`.

## What this capability is

The record that a gym safety rule was broken for a named child, and the workflow
that closes it.

- `pilot.compliance_rules` -- the gym's own rule set, per organization, with a
  `severity` and an `escalation_level`. Seeded by
  `src/server/pilot/complianceRuleSeeds.ts`.
- `pilot.compliance_violations` -- one filed violation: a rule, an athlete,
  optionally a video session, evidence, a `status` and an `escalation_status`.
- `pilot.violation_escalations` -- the manual "Escalate" action's own history.

Routes:

- `app/api/pilot/compliance/violations/route.ts` -- `GET` list, `POST` file,
  `PATCH` move through the lifecycle (`acknowledge` / `resolve` / `dismiss`).
- `app/api/pilot/compliance/escalate/route.ts` -- `POST` escalate one violation.
- `app/api/pilot/board/compliance-summary/route.ts` and
  `board/compliance-rules/route.ts` -- the board's k-anonymity-gated view.

Server module: `src/server/pilot/compliance.ts`.

**Adjacent, deliberately separate system:** `src/server/pilot/escalationLadder.ts`
and `pilot.safety_escalations` are the platform's *pull-based notification*
surface (there is no email in this platform, ever). `compliance.ts` files onto
that ladder as well as into its own history table. `escalationLadder.ts`'s header
records that unifying the two **tables** "remains the real, still-open product
question" -- so this file documents two escalation paths because there are two.

## What it may do

- Let a coach or an admin file a violation against an athlete they may act on.
- Auto-file a matching safety escalation, in the same transaction, when the
  violated rule's `escalation_level` maps to a supported target role.
- Move a violation through exactly the transitions the vocabulary declares, once
  each, with a stated reason on the closing ones.
- Close a violation's escalation track when the violation resolves.
- Give the board counts, with each severity and status bucket independently
  k-anonymity-gated.

## What it may NOT do

- It may not file a violation against a child the actor has no standing with
  (gate 2).
- It may not file against another organization's rule or video (gate 3).
- It may not accept a severity outside the four buckets (gate 4).
- It may not re-open or overwrite a decided violation (gate 6).
- It may not close a violation about a minor with no stated reason (gate 7).
- It may not put an individually identifiable violation in front of the board
  (gate 9), or in front of a parent at all.
- It may not clear an athlete medically, lift a hold, or erase evidence. See
  "What resolution does not mean".

## What must be true before a violation is filed against a child

| # | Must be true | If it is not | Who can make it true |
|---|---|---|---|
| 1 | A live, non-bootstrap session | 401 `Unauthorized` / 403 `Forbidden: PIN change required...` | Sign in |
| 2 | Role is `coach`, `admin` or `organization_admin` | 403 `Forbidden` | -- |
| 3 | `rule_id` and `athlete_id` are both present | 400 `Missing rule_id or athlete_id` | Fix the request |
| 4 | The actor may act on this specific athlete | 403 `Forbidden: coach not assigned to athlete` (or the other `access.ts` messages) | Be the coach of record, hold active coverage, or have an admin file it |
| 5 | The `rule_id` resolves **inside this organization** | 404 `Not found` | -- |
| 6 | A supplied `video_session_id` is in this organization **and** is not attributed to a different athlete | 404 `Not found` | Correct the video, or file without one |
| 7 | `severity` is one of `critical`, `high`, `medium`, `low` | 400 `Unsupported severity: must be one of critical, high, medium, low` | Use a real bucket |

On success: **201** with the violation row.

## What must be true to move a violation through its lifecycle

The transitions, exactly as `compliance.ts:TRANSITION_CONTRACT` declares them:

| Transition | From | To | Route |
|---|---|---|---|
| `acknowledge` | `new` | `acknowledged` | `PATCH violations` |
| `escalate` | `new`, `acknowledged` | `escalated` | `POST escalate` |
| `resolve` | `acknowledged`, `escalated` | `resolved` | `PATCH violations` |
| `dismiss` | `new`, `acknowledged` | `dismissed` | `PATCH violations` |

`resolved` and `dismissed` are terminal. An escalated violation "comes back down
by being resolved, never by being dismissed". Everything else is a refusal.

`PATCH` and `POST escalate` are both **admin-only** (`admin`,
`organization_admin`) -- "coaches read violations, admins move them" -- while
`GET` and `POST` (filing) admit `coach` as well.

## Gates

### Gate 1 -- roles: coaches file and read, admins move

- **What it checks:** `requireRole` on each verb.
  `GET`: `['organization_admin', 'admin', 'coach']`.
  `POST`: `['coach', 'admin', 'organization_admin']`.
  `PATCH`: `['admin', 'organization_admin']`.
  `POST /escalate`: `['admin', 'organization_admin']`.
- **Where it runs:** `app/api/pilot/compliance/violations/route.ts` and
  `escalate/route.ts`, via `http.ts:requirePrincipal` + `http.ts:requireRole`.
- **What it refuses with:** 401 `Unauthorized`; 403
  `Forbidden: PIN change required before using this account`; 403 `Forbidden`.
- **Why the `PATCH` set is narrower:** stated in the route -- the lifecycle
  levers are "gated to the same role set as the escalate route -- the only
  pre-existing violation lifecycle mutation -- because that is the authority
  current source establishes."
- **`board`, `parent`, `athlete`, `volunteer`, `staff` and `platform_owner` are
  absent from all four.** A violation names one child.

### Gate 2 -- the actor must have standing with this child

- **What it checks:** `access.ts:assertActorCanAccessAthlete(principal, athleteId)`.
  An organization admin over any athlete in their own organization; a coach only
  over athletes they are `coach_id` of record for or hold an active
  `pilot.coach_coverage` grant on; `platform_owner` and `board` refused
  outright.
- **Where it runs:** `POST` calls it **before** the rule lookup;
  `GET` calls it whenever an `athlete_id` filter is supplied.
- **What it refuses with:** 403 with the `access.ts` messages unchanged --
  `Forbidden: coach not assigned to athlete`,
  `Forbidden: athlete does not belong to organization`,
  `Forbidden: platform owner cannot access organization-private athlete records by default`,
  `Forbidden: board role is restricted to organization-level aggregates`.
- **The unfiltered coach read is narrowed too.** With no `athlete_id`, the route
  passes `coachAccountId: principal.accountId` and
  `compliance.ts:getOrganizationViolations` adds
  `athlete_id in (select athlete_id from pilot.athletes where coach_id = $n and organization_id = $1)`.
  **Honest limit:** that subquery matches assignment only -- it does **not**
  union in `pilot.coach_coverage`, unlike `app/api/pilot/escalations/route.ts:coachAthleteIds`,
  which does. So a covering coach who can file a violation about a covered child
  (via gate 2) will not see it in their own unfiltered list; they have to ask for
  it by `athlete_id`. Not a disclosure hole -- a coverage gap in the read.
- **Why it exists:** without it, a role check alone would let any coach in the
  gym file a safety violation, with evidence, against any child.

### Gate 3 -- cross-organization ids are refused without confirming they exist

- **What it checks:** three org-scoped lookups.
  - `compliance.ts:getComplianceRuleById(organizationId, ruleId)` on `POST`.
  - `videoSessions.ts:getVideoSessionById(organizationId, videoSessionId)` on
    `POST`, **and** that `videoSession.athlete_id`, when set, equals the
    `athlete_id` the violation is being filed against.
  - `compliance.ts:getComplianceViolationById(organizationId, violationId)` on
    `PATCH` and on `POST /escalate`.
- **Where it runs:** all in the route handlers, before any write.
- **What it refuses with:** 404 `Not found` (`http.ts:hiddenNotFound`) in every
  case -- "rejecting a cross-organization `violation_id` without revealing
  whether it exists."
- **Why the video/athlete cross-check matters:** without it a violation could
  cite footage of a *different* child as its evidence, which is both a false
  record about the accused athlete and a disclosure of the other one.

### Gate 4 -- severity is validated in code because the table does not

- **What it checks:** `params.severity` against
  `COMPLIANCE_SEVERITIES = ['critical', 'high', 'medium', 'low']`.
- **Where it runs:** `compliance.ts:createComplianceViolation`, first statement,
  before the transaction opens.
- **What it refuses with:** 400
  `Unsupported severity: must be one of critical, high, medium, low`.
- **Why it exists:** stated in the module -- "`pilot.compliance_violations.severity`
  carries no check constraint, unlike the rules table it is filed against. Free
  text written here is invisible to `getOrganizationViolationSummary`, which
  counts only these four buckets, and sorts last everywhere severity is ranked."
  A violation nobody's dashboard counts is a violation nobody acts on.
- **Note the route's default:** `POST` sends `body.severity || 'medium'`, so an
  omitted severity is filed as `medium`, not refused.

### Gate 5 -- a violation and its escalation commit together, or neither does

- **What it checks:** nothing conditional; it is a transaction boundary.
- **Where it runs:** `compliance.ts:createComplianceViolation` runs the insert and
  `:fileComplianceEscalationIfConfigured` on the **same** transaction client
  (`escalationLadder.ts:fileEscalation` accepts one for exactly this reason).
  `:escalateViolation` does the same for the guarded `UPDATE` and the
  `violation_escalations` insert.
- **Why it exists:** "a violation severe enough for its rule to demand escalation
  must never commit without that escalation, or vice versa" -- matching
  `trainingHolds.ts:placeTrainingHold`'s own pairing. And on the escalate path:
  "an escalation row whose violation is still sitting at status 'new' reads as an
  unescalated violation everywhere the compliance centre looks."
- **The `escalate` UPDATE runs FIRST and is a compare-and-set.** The module
  records the two failure shapes this fixed: "an escalation row could be filed
  against a violation the org-scoped update never matched (foreign or missing
  id), and a violation already resolved or dismissed could be silently yanked
  back to 'escalated' by a stale click."
- **What it refuses with:** 400
  `Unsupported: violation is not in an escalatable state` -- thrown inside the
  transaction, which rolls back before the escalation row exists.

### Gate 6 -- every transition is a compare-and-set on named source states

- **What it checks:** `status = any($4::text[])` on the `UPDATE`, where the array
  is the transition's own `allowedSources` from
  `compliance.ts:TRANSITION_CONTRACT`, together with
  `organization_id = $1` in the same predicate.
- **Where it runs:** `compliance.ts:transitionComplianceViolation`.
- **What it refuses with:** the function returns `false` and writes nothing; the
  route answers **409**
  `This violation cannot be <acknowledged|resolved|dismissed> from its current state.`
  with the current `status` in the body so the refusal is actionable.
- **Why it exists:** "'resolved' and 'dismissed' are terminal and a stale click
  can never re-open or overwrite a decided violation." Returning `false` for both
  "a foreign or missing `violation_id`" and "a stale state" is deliberate: "two
  operators cannot silently overwrite one another", and the two cases arrive
  identically.
- **Resolving also closes the escalation track, in the same transaction.**
  `escalation_status` moves to `'resolved'` when the violation was `escalated`
  (whichever leg -- `in_progress` or `escalated_to_board`), and every
  `violation_escalations` row with a null `resolved_at` is stamped.
  "`status = 'resolved'` with an escalation still reading `in_progress` is
  exactly the contradictory state the transaction exists to make
  unrepresentable." The escalation rows themselves "are history and are never
  deleted."

### Gate 7 -- a closing verdict about a minor needs a stated reason

- **What it checks:** a non-empty trimmed `note` on `resolve` and `dismiss`.
  `acknowledge` is exempt.
- **Where it runs:** `app/api/pilot/compliance/violations/route.ts:PATCH`, before
  the org-scoped lookup.
- **What it refuses with:** 400
  `Missing note: a resolution needs a stated reason` /
  `Missing note: a dismissal needs a stated reason`.
- **Why it exists:** "closing a violation about a minor without a stated reason
  is unauditable -- same rule the escalation ladder and the video console apply to
  their own closing verdicts. Acknowledgement is receipt, not closure, and
  carries no such requirement." The note lands in the audit event, not on the
  violation row.

### Gate 8 -- auto-escalation refuses to invent a safe target

- **What it checks:** whether the violated rule's `escalation_level` has an entry
  in `compliance.ts:RULE_ESCALATION_LEVEL_TO_TARGET_ROLE`
  (`coach -> 'coach'`, `admin -> 'organization_admin'`). `'board'` and
  `'parent'` are **absent**.
- **Where it runs:** `compliance.ts:fileComplianceEscalationIfConfigured`. A rule
  whose level is `board` or `parent`, or whose `rule_id` does not resolve in this
  organization, is a deliberate no-op.
- **What it refuses with:** nothing reaches the caller. The violation is filed;
  no ladder escalation is.
- **Why it exists:** `escalationLadder.ts:SafetyEscalationTargetRole`'s own doc
  gives both reasons. `'board'` "would put an individually-identifiable athlete
  record in front of board", which `ORGANIZATION_ROLE_MODEL.md` and
  `boardRoleBoundaries.test.ts` both hold to aggregate-only reads. `'parent'`
  "would let a guardian learn an escalation exists at all, which
  `parent/safety/route.ts`'s own doc explicitly refuses for the same
  disclosure-safety reason `athlete_voice` rows are hidden from a coach."
- **This is reported as a known gap, not silently widened.** A rule seeded or
  authored with `escalation_level` `board` or `parent` files a violation that
  raises **no** ladder notification. The right fix is a safe board- or
  parent-facing surface for individual safety records, which does not exist.
  The two severity vocabularies are likewise unreconciled -- the migration's own
  doc calls them out -- and `medium` is mapped to the ladder's `moderate` by
  `COMPLIANCE_SEVERITY_TO_ESCALATION_SEVERITY`.

### Gate 9 -- the board sees counts, gated bucket by bucket

- **What it checks:** for `audience: 'board'`, each figure passes through
  `boardSummary.ts:boardCountMetric(recordCount, participantCount)` against
  `BOARD_MINIMUM_COHORT_SIZE`. Only aggregates leave the query;
  `count(distinct athlete_id)` sizes each cohort and `athlete_id` itself "is
  never selected".
- **Where it runs:** `compliance.ts:getOrganizationViolationSummary` ->
  `:violationMetric`. For `audience: 'organization_admin'` the exact count is
  returned -- "an organization admin runs the gym and legitimately reads exact
  violation counts."
- **What it refuses with:** a **withheld** bucket rather than a small number.
- **Why every bucket is gated independently, not just the total:** "a single
  critical violation is an identification even when the ledger as a whole is
  large, because the severity and the date narrow it to one athlete." And: "an
  empty ledger stays distinguishable from a suppressed one so neither can be read
  as a measured zero."
- **A related correctness gate:** `severity` is a text column, so
  `order by severity desc` sorts alphabetically and puts `medium` above
  `critical`. `compliance.ts:SEVERITY_RANK_SQL` ranks the vocabulary explicitly,
  and anything outside it sorts last "rather than silently displacing a real
  severity."

## What resolution does not mean

Quoted from `compliance.ts:TRANSITION_CONTRACT`, because it is the sentence most
likely to be misread by whoever builds the next surface on this data:

> Resolution and dismissal close the WORKFLOW only. They do not clear an athlete
> medically, disprove a safeguarding concern, lift any restriction or hold, or
> erase the violation, its rule, its evidence, or its history.

Symmetrically, `compliance.ts`'s escalation reason text tells the reader of the
*escalation*: "resolving this escalation does not resolve the violation." And
`trainingHolds.ts` says the same about holds: "resolving that escalation does NOT
lift the hold." Three records, three clocks, and closing one closes exactly one.

## Deliberately not gated

- **`escalated_to_role` on the manual escalate route is unvalidated free text.**
  `compliance.ts:escalateViolation` takes `escalatedToRole: string`, the route
  requires only that it be non-empty, and
  `pilot.violation_escalations.escalated_to_role` is `text not null` with **no
  check constraint** -- unlike `pilot.safety_escalations.escalated_to_role`,
  which is `check (escalated_to_role in ('coach', 'organization_admin', 'admin'))`
  and whose migration comment explicitly notes the difference. So an admin can
  escalate a violation "to parent" or "to board" through this route -- the two
  targets gate 8 refuses to auto-file for, for stated non-disclosure reasons.
  Nothing then *shows* it to a parent or the board, so this is a data-integrity
  and audit-honesty gap rather than a live disclosure; it is recorded as a
  finding in `docs/capabilities/GATES.md` and **is not fixed here**.
- **`escalation_reason` defaults instead of being required.** The route
  substitutes `'Policy violation requires escalation'` when none is sent, so an
  escalation can carry no human reasoning at all -- the opposite of gate 7's rule
  for closing verdicts.
- **Evidence is a path, and nothing checks it.** `createComplianceViolation`
  accepts `evidencePath` and writes it verbatim. The route does not currently
  pass one, so no caller can set it today; when one does, there is no gate that
  the path names a blob in this organization.
- **`details` is arbitrary JSON.** Whatever the caller sends is stored. No shape,
  no size bound beyond the request limit, no redaction.
- **No `athlete_id` gate on the escalate or `PATCH` routes.** Both resolve the
  violation org-scoped and act on it; neither re-runs
  `assertActorCanAccessAthlete` against the violation's athlete. That is
  consistent -- both routes are admin-only, and an organization admin may reach
  any athlete in their organization -- but it means the per-child check exists
  only on the filing and reading paths, not the closing ones.
- **Rules themselves have no write route here.** `pilot.compliance_rules` is
  seeded (`complianceRuleSeeds.ts`, ownership-pinned by
  `complianceRuleSeedsOwnership.test.ts`) and read by
  `app/api/pilot/board/compliance-rules/route.ts`. There is no route that
  creates, edits or deactivates a rule, so there is no gate to document -- and no
  way for a gym to add one without a migration.
- **`GET` has no `severity` filter exposed.** `getOrganizationViolations` supports
  one; the route reads only `athlete_id`, `status` and `limit`. Not a gate, noted
  so nobody assumes the filter is being ignored.
- **The Morning Read surfacing of open violations is added by open PR #450**
  (`coach-intelligence`), not merged and not present in this branch. Nothing here
  describes it as existing.

## Verified by

- `src/server/pilot/compliance.test.ts` --
  `escalateViolation` (the compare-and-set out of `new`/`acknowledged`, the
  rollback when zero rows match, the org scoping),
  `transitionComplianceViolation` (every allowed transition, every refused one,
  terminality of `resolved`/`dismissed`, and that resolving closes the escalation
  track and stamps `resolved_at`),
  `createComplianceViolation` including its
  `auto-escalation on rule escalation_level` block (gate 8: `coach` and `admin`
  map and file; `board` and `parent` are a no-op; an unresolvable `rule_id` is a
  no-op; the escalation shares the violation's transaction),
  `getOrganizationViolationSummary` (gate 9: the per-bucket k-anonymity gate,
  exact counts for an org admin, empty vs suppressed),
  `getComplianceRulesByCategory` (the explicit severity ranking).
- `app/api/pilot/compliance/violations/route.test.ts` -- `GET` (role gate,
  athlete gate, `limit validation`), `POST` (the `Missing rule_id or athlete_id`
  400, the athlete gate running before the rule lookup, the `hiddenNotFound` for
  a foreign rule and for a video attributed to another athlete, the 201), and
  `PATCH` (the admin-only gate, the transition validation, the required note, the
  409 naming the current status, and the audit row).
- `app/api/pilot/compliance/escalate/route.test.ts` -- the admin-only gate, the
  `hiddenNotFound` for a cross-organization `violation_id`, and the
  not-escalatable refusal.
- `src/server/pilot/escalationLadder.test.ts` -- `fileEscalation` on a supplied
  client, the target-role constraint, and `getBoardEscalationSummary`'s
  k-anonymity gate.
- `src/server/pilot/boardRoleBoundaries.test.ts` -- that the board cannot reach
  individually identifiable safety data, which is the invariant gate 8 defers to.
- `src/server/pilot/complianceRuleSeedsOwnership.test.ts` and
  `complianceMigration.pg.test.ts` / `complianceRuleSeeds.pg.test.ts` -- seed
  ownership and schema. The two `*.pg.test.ts` files are **not run by this lane**
  (excluded here); named so the next reader knows.
