# Coach Intelligence / The Morning Read -- gates

Documentation on disk. Nothing imports this file, no page renders it, and it
does not live under `apps/web/public/`. It describes what the code does after
the change that added digest items 6 and 7 (open safety escalations, open
compliance violations), not what anyone intended it to do.

Capability home:

- route: `apps/web/app/api/pilot/coach/intelligence/route.ts`
- module: `apps/web/src/server/pilot/coachIntelligence.ts` (register module 111)
- page: `apps/web/app/coach/intelligence/page.tsx` (`/coach/intelligence`)

## What this capability is

A per-request, read-only digest of a coach's OWN athletes, assembled from
seven deterministic threshold reads of records other capabilities already
store. Every item is a stored fact plus a stated cut line. It stores nothing,
caches nothing, and computes no score, ranking, or prediction about a child.

The seven items:

| # | Item | Register read | Cut line |
|---|------|---------------|----------|
| 6 | `open_safety_escalations` | `pilot.safety_escalations` (#194) | `status = 'open'`, `athlete_voice` excluded |
| 7 | `open_compliance_violations` | `pilot.compliance_violations` | `status in ('new','acknowledged','escalated')` |
| 5 | `expiring_holds` | `pilot.training_holds` | active, expires within `HOLD_EXPIRY_DAYS` (14) |
| 2 | `readiness_concerns` | `pilot.readiness` | `READINESS_RED_DAYS` (3) RED days in `READINESS_RED_WINDOW_DAYS` (7) |
| 3 | `fading_attendance` | `getPerformanceRollup` | `TRAINING_DAYS_MIN_EARLY` (3) and a drop past `TRAINING_DAYS_DROP_RATIO` (0.5) |
| 1 | `stalled_gaps` | `pilot.progression_gaps` | identified `STALLED_GAP_DAYS` (14)+ ago, never assigned |
| 4 | `unreviewed_sessions` | `pilot.sessions` | completed, unreviewed `UNREVIEWED_SESSION_DAYS` (7)+ days |

Items 6 and 7 exist because the digest previously read none of the safety
registers. An athlete with an open escalation filed against them, or a filed
compliance violation, produced ZERO items -- and the page's empty state says
"Nothing needs your eyes". A blind digest is worse than no digest: it converts
"I have not looked" into "I looked and it was fine". That is the defect this
README's "Deliberately not gated" section exists to keep from recurring in a
new shape.

## What it may do

- Read, for the caller's own athletes only, records that already exist in
  other capabilities' tables, and return them in the digest's item shape.
- Name the athlete (`full_name`) and reproduce the stored reason, rule name,
  severity, status, and dates as written by the capability that owns them.
- Order items by each owning capability's own convention: severity-then-newest
  for escalations (inherited from `listEscalations`), oldest-first for
  violations, gaps, and sessions, soonest-expiry-first for holds.
- Return an empty list per item when nothing crosses the cut line.

## What it may NOT do

- Write anything. There is no INSERT, UPDATE, DELETE, or DDL anywhere in the
  capability; it cannot acknowledge, resolve, dismiss, escalate, clear, or
  restrict anything, and no item on it is actionable from this surface.
- Serve any role other than coach / organization_admin / admin.
- Read an athlete outside the caller's scope, or an organization other than
  the caller's own.
- Surface an `athlete_voice` escalation to anyone, including an admin.
- Decide for itself what "open" means for a compliance violation, or restate
  a threshold that another capability already owns.
- Clear, restrict, or prescribe training. An item is an observation; a
  restriction is a hold, and holds live in `trainingHolds.ts`. Reading this
  page is not clearance and is not a substitute for the clearance register.

## What must be true for an item to appear

This capability's gates are unusual: they do not refuse a request, they
*subtract rows*. So the honest version of "what does it take for this to be
active" is per item, not per request, and a reader debugging "why is this coach
seeing nothing" needs the list below rather than the gate descriptions.

**For the page to render at all:**

| Must be true | If it is not |
|---|---|
| Authenticated session | 401 |
| Role is `coach`, `organization_admin` or `admin` | 403 `Forbidden: role not allowed` |
| The caller has at least one athlete in scope | Page renders, digest is empty |

No feature flag, migration or environment variable is involved. The capability
is live wherever it is deployed, and it was **already live and already reporting
"nothing needs your eyes"** while blind to two safety registers — which is what
the change this README documents fixed.

**For each individual item to appear**, all of these must hold:

| Item | Appears when |
|---|---|
| 1. Stalled progression gap | Gap open ≥ 14 days with no drill assignment against it |
| 2. Readiness concern | ≥ 3 RED readiness days in the last 7 |
| 3. Fading attendance | Recent attendance below the athlete's own early-season baseline |
| 4. Unreviewed session | A completed session unreviewed for ≥ 7 days |
| 5. Hold expiring | An active training hold expiring within 14 days |
| 6. Open safety escalation | Escalation `status = 'open'`, **and** not `athlete_voice`, **and** not `source_type = 'compliance_violation'` (item 7 owns those — see below) |
| 7. Open compliance violation | Violation status in `COMPLIANCE_VIOLATION_OPEN_STATUSES` (`new`, `acknowledged`, `escalated`) |

**Items 6 and 7 do not double-report.** `compliance.ts` files an escalation
with `source_type = 'compliance_violation'` on the same transaction as the
violation insert, whenever the violated rule's `escalation_level` maps to a
supported target role — so most violations produce a row in *both* registers
this digest reads. Item 6 drops those; item 7 keeps them. Item 7 is the side
that survives because it reads the authoritative record (rule name, own status
lifecycle, days open) and because its coverage is strictly **wider**: a rule
whose `escalation_level` is `board` or `parent` produces no escalation at all,
so those violations exist only in item 7. Every other escalation source —
`near_miss`, `pain_report`, `safety_gate_evaluation`, `repeated_pattern`,
`training_hold`, `incident`, `video_scan` — still reaches item 6.

Every one is additionally scoped to the caller's own organization and to
athletes in the caller's own roster. Items 6 and 7 are the two this change
added; the other five predate it.

**Two silences are deliberate and are not bugs** — both are argued in
"Deliberately not gated" below, and both are the kind of thing that looks like
a defect to whoever finds it next:

- An escalation that is **acknowledged but never resolved** is still live and
  still leaves this digest, because item 6 matches `status = 'open'` only. Widen
  `ESCALATION_DIGEST_STATUS` to change that.
- A coach holding **active `coach_coverage`** over a child, rather than being
  their `coach_id` of record, sees nothing about that child here — this route
  derives its roster from `getAthletesForCoach`, while `/api/pilot/escalations`
  includes covering coaches. The two surfaces disagree today.

## Gates

**1. Authenticated session required**

- checks: a valid pilot session, and that the account is not still on a
  bootstrap PIN
- where: `src/server/pilot/http.ts:requirePrincipal`, called from
  `app/api/pilot/coach/intelligence/route.ts:GET`
- refuses with: `Unauthorized` -> 401; `Forbidden: PIN change required before
  using this account` -> 403 (`jsonError` maps the prefixes)
- why: the digest names children and reproduces safeguarding text. An
  unauthenticated read of it is a disclosure of a child's safety record.

**2. Staff-only role gate**

- checks: `principal.role` is one of `coach`, `organization_admin`, `admin`
- where: `route.ts:GET` -> `src/server/pilot/access.ts:requireRole`
- refuses with: `Forbidden: role not allowed` -> 403
- why: a parent or athlete reading this surface would read other children's
  escalations and violations. Since item 6 exists, the role gate is the
  difference between a staff lens and a safeguarding leak.

**3. The roster list is the access boundary, and the caller cannot influence it**

- checks: the athlete id list is derived from the session, never from the
  request -- `getAthletesForCoach(organizationId, accountId)` for a coach,
  `getAthletesByOrganization(organizationId)` for organization_admin/admin
- where: `route.ts:GET`; consumed as the only athlete input by
  `coachIntelligence.ts:getCoachIntelligence`
- refuses with: nothing, by construction -- the route reads no `athlete_id`,
  no `organization_id`, and no filter from the query string or body, so there
  is no request a caller can shape to widen the read. A coach asking about
  another coach's athlete has no way to ask.
- why: this is the only thing standing between a coach and another coach's
  athlete's safeguarding record. It is also why the organizationScope
  convention gate has nothing to flag here.

**4. Organization scoping on every read**

- checks: `organization_id = $1` (from `principal.organizationId`) on all six
  SQL reads, and `organizationId` passed to `listEscalations` for the seventh
- where: `coachIntelligence.ts:getCoachIntelligence`
- refuses with: nothing -- rows from another gym are not returned. Every gym's
  records share these tables, so the predicate IS the tenancy boundary.
- why: without it a coach at one gym reads escalations filed at another.

**5. Roster scoping on every read**

- checks: `athlete_id = any($2::text[])` on all six SQL reads, and
  `athleteIds: ids` passed to `listEscalations`
- where: `coachIntelligence.ts:getCoachIntelligence`
- refuses with: nothing -- non-roster rows are not returned.
- why: the coach's own athletes are the whole promise of the surface. An
  organization-wide safety list belongs to `/api/pilot/escalations` and the
  compliance centre, which gate on admin.

**6. `athlete_voice` escalations are excluded unconditionally**

- checks: `excludeAthleteVoice: true` is passed on every call, with no role
  branch and no way for a caller to turn it off
- where: `coachIntelligence.ts:getCoachIntelligence` ->
  `escalationLadder.ts:listEscalations` (the predicate lives in that module's
  SQL: `$4::boolean is not true or source_type <> 'athlete_voice'`)
- refuses with: nothing -- the rows are absent from the result.
- why: an `athlete_voice` escalation exists because a child typed something
  into the feedback box. Its mere presence on a coach's list tells that coach
  the child said something, and the coach may be exactly who the child is
  disclosing about. This function is handed ids and an organization but never
  a role, and one route serves coaches and admins through it, so there is
  nothing here to branch on safely: it fails closed for everyone. An admin
  reads those rows on `/api/pilot/escalations`, which does know the role.

**7. "Open" is imported from the capability that owns the lifecycle**

- checks: item 7 filters on `COMPLIANCE_VIOLATION_OPEN_STATUSES`
  (`new`, `acknowledged`, `escalated`) exported by `compliance.ts`, not on a
  local list; item 6 filters on the ladder's own `status` vocabulary via
  `ESCALATION_DIGEST_STATUS`
- where: `compliance.ts` (definition) ->
  `coachIntelligence.ts:getCoachIntelligence` (use)
- refuses with: nothing -- it is a filter. The gate is against drift: a
  private copy would eventually count a dismissed violation as live, or drop
  an escalated one out of a safety list, silently.
- why: two definitions of "open" in a safety surface means one of them is
  wrong and nobody finds out from the screen.

**8. A missing or cross-organization rule row cannot drop a violation**

- checks: `left join pilot.compliance_rules` with
  `coalesce(r.rule_name, v.rule_id)` as the label
- where: `coachIntelligence.ts:getCoachIntelligence`, item 7's query
- refuses with: nothing -- the violation is listed with its rule id in place
  of a name.
- why: `rule_id` is a global primary key while violations are org-scoped, so
  an inner join could silently remove a real violation from a safety list.
  Losing the label is acceptable; losing the row is not.

**9. An empty roster reads nothing at all**

- checks: `athleteIds.length === 0` returns the empty digest before any query
  or delegated call runs
- where: `coachIntelligence.ts:getCoachIntelligence`
- refuses with: nothing -- an all-empty digest.
- why: an unscoped `any('{}')` read is a query with no subject; short-circuit
  rather than let an empty scope reach the database.

## Deliberately not gated

Read this section as the exact size of the claim "Nothing needs your eyes"
makes. It means: no item crossed one of the seven cut lines above, for the
athletes assigned to you, at the moment you loaded the page. It does not mean
the floor is fine.

- **Acknowledged escalations are not surfaced.** Item 6 lists `status =
  'open'` only. A coach may acknowledge an escalation; only an admin may
  resolve one. So an escalation that was acknowledged and never resolved
  leaves this digest while remaining unresolved, and only `/admin/escalations`
  (status filter `acknowledged`) still shows it. This is a judgment call about
  a "needs your eyes" list, not an oversight -- but it is the one place where
  a still-live safety record deliberately stops appearing here.
- **Covering coaches are not included.** The route derives a coach's roster
  from `getAthletesForCoach`, i.e. `pilot.athletes.coach_id`. It does NOT union
  `pilot.coach_coverage` the way `/api/pilot/escalations` does (T-002). A
  coach actively covering someone else's athlete therefore sees that child's
  escalations on the escalation queue but NOT on their morning read. Changing
  it would change this route's audience derivation, which it shares with
  performance analytics and the readiness board -- an access decision, made
  where those routes are owned, not here.
- **`athlete_voice` escalations appear for nobody here, admin included.** See
  gate 6. An admin's morning read is therefore not a complete escalation list.
- **No severity floor and no age filter on items 6 and 7.** An escalation
  already crossed a line in the capability that filed it, so this module does
  not re-judge it; a `low` escalation and a `critical` one both appear.
  Equally, nothing ages out: an item stays until its own register closes it.
- **Registers this digest does NOT read.** It reads seven. It does not read
  `pilot.safety_flags`, the clearance register (`clearanceRegister.ts`), video
  scan review, waiver/consent compliance, intake review, near misses that did
  not escalate, or feedback triage. An athlete with an expired medical
  clearance, an unreviewed video, a missing waiver, or a `moderate` near miss
  and nothing else produces no item on this page. Those surfaces exist and are
  the authority for their own registers.
- **No notification, no push, no email.** This platform sends none, ever. The
  digest is pull-only: if the coach does not open the page, nothing about an
  open escalation reaches them from here. `/admin/escalations` is the
  designated pull surface for #194 for exactly this reason.
- **No k-anonymity floor, by design.** A coach reads named athletes on their
  own roster; suppression would defeat the surface. The k-gated paths are the
  board summaries (`getBoardEscalationSummary`,
  `getOrganizationViolationSummary` with `audience: 'board'`), which this
  capability does not use and must not be confused with.
- **No audit event is written for a read.** The digest writes nothing at all,
  including no read-audit row, matching the sibling read surfaces
  (performance analytics, readiness board).
- **No freshness or staleness gate.** Every item is queried at request time,
  so the digest is exactly as current as the request. There is no cache to
  invalidate and no stored copy to go stale -- and equally no guarantee that a
  record filed one second after the response exists in it.
- **The page's own failure mode is disclosed, not gated.** If the fetch fails,
  `/coach/intelligence` shows the error and says "Items may exist that are not
  shown here" rather than an empty digest. A load failure must never read as
  an all-clear.

## Verified by

- `apps/web/src/server/pilot/coachIntelligence.test.ts` -- the thresholds and
  their imported reuse; the empty-roster short-circuit (and that it consults
  neither safety register); the digest key order that puts the safety
  registers first; item 6's delegation to `listEscalations` with `status:
  'open'`, roster ids, and `excludeAthleteVoice: true`; item 6's item shape and
  name fallback; item 7's org/roster/open-status parameters, its
  `COMPLIANCE_VIOLATION_OPEN_STATUSES` reuse, and its LEFT-joined rule label;
  that no query in the digest is an INSERT or UPDATE; and, for each safety
  register, that an athlete whose ONLY signal is that register still produces
  a non-empty digest (the original defect, pinned).
- `apps/web/app/api/pilot/coach/intelligence/route.test.ts` -- the role gate
  (parent/athlete/platform_owner refused), the coach-vs-admin roster
  derivation, and that both safety lists reach the caller unfiltered.
- `apps/web/src/server/pilot/escalationLadder.test.ts` and
  `escalationLadder.pg.test.ts` -- the `excludeAthleteVoice` predicate itself,
  against real rows, in the module that owns it.
- `apps/web/src/server/pilot/organizationScope.convention.test.ts` -- that
  this route names no caller-supplied organization.
