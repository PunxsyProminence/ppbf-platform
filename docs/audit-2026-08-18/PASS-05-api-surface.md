# Pass 5 — API surface

Read-only audit of `origin/main` at `04dd116b`, working branch
`docs/full-spectrum-audit-2026-08-18`. No application code was changed; this
file is the only write. Nothing was executed — no server, no test, no request.
Per `AGENT_KERNEL.md` invariant 5 that is not runtime proof, and every severity
below should be reproduced against a live session before anyone acts on it.

**Scope.** Everything about the 228 `apps/web/app/api/**/route.ts` files
*except* authorization and role gating, which `PASS-02-authorization.md` owns.
Input validation, error-shape conformance, idempotency, rate limiting, response
leakage, HTTP semantics, `hiddenNotFound` integrity.

## Method

**Read before opening a route:** `AGENT_KERNEL.md`;
`PASS-02-authorization.md` in full (route table, all eight findings, its
*Checked and found sound* and *Could not establish* sections);
`docs/capabilities/NETWORK_STATUS.md` — which, as pass 2 already recorded, is
**not on this branch or on `origin/main`**; the only copy is on
`origin/docs/agent-handoff-briefs` and that is the copy I read. Also
`git log --oneline origin/main -40`, which matters here more than for other
passes because five of the last forty commits are in my exact scope: #433
(incident idempotency), #429 (rate-limit accounting), #424 (durable rate
limiting on two auth routes), #426 (three routes whose error handling did not do
what it looked like), #425 (external-call timeouts).

**A correction to the brief's premise, up front.** The brief states the
`jsonError` convention as `"Unsupported "`, `"Missing "`, `"Forbidden: "`. The
actual matcher is wider, and auditing against the narrow version would have
produced a large pile of false positives. The real prefix set, read from
`apps/web/src/server/pilot/http.ts:121-144`, is: `Unauthorized` → 401;
`Forbidden` → 403; `Missing`, `Request body`, `Unsupported`, `PIN` → 400;
`Not found`, `Athlete not found` → 404; and five 409 prefixes
(`Account already exists`, `Athlete is already linked`,
`Athlete record already exists`, `Coverage already exists`,
`Hold already exists`). Three error *types* are checked before any string
matching (`MedicalStatusBlockedError`, `GuardianConsentMissingError`,
`ShadowRuntimeUnavailableError`), and since some point before this commit a
fourth mechanism sits above all of them: `PilotError` and its four subclasses in
`apps/web/src/server/pilot/errors.ts`, whose header documents this exact defect
class and its history. I audited against the real matcher.

**Mechanical classification — all 228 routes.** I wrote scanners (Python, in the
scratchpad, not committed) over every `route.ts`:

| Measure | Count |
|---|---|
| Route files matching `apps/web/app/api/**/route.ts` | **228** |
| Routes calling `jsonError` | 223 |
| Routes calling `hiddenNotFound` | 47 |
| Routes importing any rate limiter | **14** |
| Routes using a schema validator (`zod` or equivalent) | **0** |
| Routes using `isUuid` | 11 |
| Routes using `parseSafeLimit` | 17 |
| Routes reading `request.formData()` | 5 |
| Routes exporting a `GET` | 139 |
| …of those, setting any `Cache-Control` header | 14 |
| Body-parse sites (`request.json()`) | 178 |
| …with a type assertion (`as`) on the parsed value | **155** |
| …without a `.catch()` on the parse | 102 |
| `insert into pilot.*` statements in routes + `src/server/pilot` | 175 |
| …carrying `on conflict` or `where not exists` | 58 |
| Literal-message `throw new Error('…')` in route files | 285 |
| …not matching any `jsonError` prefix | 10 |
| Literal-message throws in `apps/web/src/server` | 326 |
| …not matching any prefix | 197 (63 validation-shaped) |

**Verb distribution** (mechanical, from the exported function names):
`POST` only 86; `GET` only 63; `GET`+`POST` 41; `GET`+`PATCH`+`POST` 20;
`GET`+`PATCH` 7; `DELETE`+`GET`+`POST` 4; `DELETE`+`GET`+`PATCH`+`POST` 2; and
one each of `DELETE`, `DELETE`+`POST`, `PATCH`, `DELETE`+`GET`,
`DELETE`+`GET`+`PATCH`. No route exports `PUT`, `HEAD` or `OPTIONS`; no route
aliases one verb to another (`export const PUT = POST` — zero hits); there is no
`apps/web/middleware.ts`.

**How I chose the deep-read sample.** Not at random, and not by size. Five
mechanical signals each produced a candidate list, and I read the union:

1. **Every route whose body cast asserts membership of a closed set** — a union
   of string literals or a named type — because a presence check cannot
   substitute for a set-membership check. 30 such fields across 17 routes.
2. **Every route with a thrown literal message that fails the prefix matcher**
   (10 sites, 5 routes) plus the 63 validation-shaped non-conforming throws in
   `src/server`, traced to whichever route reaches them.
3. **The expensive / security-relevant routes with no rate limiter** —
   anything invoking an external service, an AI model, `ffmpeg`, a PDF parser,
   or exporting a whole roster.
4. **The two GET handlers my mutation scanner flagged** (`admin/export/roster`,
   `payments/connect/callback`) — a GET that writes.
5. **The one route mixing `hiddenNotFound()` with a distinguishable
   `throw new Error('Not found')`** for the same resource.

**What I read, exactly.** **14 route files end to end:**
`pilot/safety-flags`, `pilot/feedback/submit`, `document-ingest`,
`pilot/admin/export/roster`, `pilot/payments/connect/callback`,
`pilot/audit/get`, `pilot/shadow/unlocks`, `pilot/admin/data-deletion`,
`pilot/coach/chat`, `pilot/athlete/chat`, `pilot/individual/chat`,
`pilot/board/chat`, `pilot/intake/cases/get`, `pilot/shadow/video-analysis`.
**39 more at handler level** (I read the specific handler, the body-parse block,
the validation lines and the `catch`, not the whole file): `scheduler`,
`escalations`, `intake/domain-upsert`, `intake/review-action`,
`admin/floor-hours`, `admin/local-findings`, `admin/capabilities`,
`admin/staff`, `admin/memberships`, `admin/bootstrap`,
`admin/bootstrap/platform-owner-microsoft`, `admin/grant-obligations`,
`shadow/chat`, `shadow/metrics`, `shadow/decision-outcomes`, `shadow/events`,
`shadow/telemetry`, `shadow/authority`, `shadow/knowledge-projection`,
`shadow/observation-projection`, `shadow/research-projection`,
`shadow/review-projection`, `shadow/research-submissions`,
`shadow/film-study/diagnostic`, `publications/library`, `athletes/list`,
`athletes/get`, `parent/barrier-report`, `floor-plans`,
`platform/organizations/status`, `auth/login`, `achievements/milestones`,
`achievements/recognition`, `achievements/mentorships`, `goals/personal`,
`board/seats`, `drills`, `announcements/get`, `rabbit-holes/get`.
**The remaining 175 routes I classified mechanically and did not open.**

I also read five server modules in full or near-full because the route behaviour
is decided there: `http.ts` (203 lines), `errors.ts` (92), `env.ts` (57),
`rateLimit.ts` (~300), `shadowAuthority.ts` (99); plus the specific bodies of
`recordActivityAdjustment`, `updateGrantObligationStatus`,
`recordGrapplingExposure`, `fileAthleteVoiceEscalation`, `enqueueJob`,
`clampLimit` in `announcements.ts` and `shadowReadModels.ts`, `listAnnouncements`,
and `fileIncidentReport` (via the #433 diff).

**Any claim below about a route I did not open is a claim about what my scanners
measured in that file — which helper it imports, what it casts, which messages
it throws — and nothing more.**

## Route classification

The full 228-row helper table is in `PASS-02-authorization.md` and is not
reproduced. What follows is the classification *this* pass produced.

### Input validation posture

| Posture | Routes | Note |
|---|---|---|
| No schema validator anywhere in the API surface | 228 | `zod`: 0 hits. All validation is hand-rolled. |
| Body cast to `unknown` / `Record<string, unknown>` / all-`unknown` fields | 52 sites | The honest form: the cast forces a runtime narrow. |
| Body cast to a **concrete** shape | **103 sites, 89 routes** | The type system is told something the runtime never checked. |
| …of those, in a file containing **no** runtime narrowing at all (no `typeof body`, no `Array.isArray`, no `validate*` helper) | **73 sites, 61 routes** | The enumerated defect class. See next section. |
| Named shared validators (`validateAthletePayload`, `validateGoalPayload`, `validateSessionPayload`, `validateCoachReviewPayload`) | 6 routes | `athletes/update`, `goals`, `goals/update`, `sessions`, `sessions/update`, `coach-reviews`(+`/update`) — real validation, in a shared helper. |
| Body parsed with `.catch(() => …)` so a malformed body is a refusal, not a crash | 76 sites | The other 102 let `SyntaxError` reach `jsonError` → generic 500. |

### Rate limiting

**14 of 228 routes import a limiter.** They are exactly:
`admin/bootstrap`, `admin/bootstrap/platform-owner-microsoft`,
`public-interest`, `auth/login`, `auth/activate`, `auth/magic-link/consume`,
`auth/magic-link/request`, `auth/change-pin`, `profile/photo`,
`shadow/feedback`, `shadow/upload`, `shadow/chat`, `video/upload`, `wall`.

That is a well-chosen 14: every anonymous entry point, every credential path,
every blob upload, and the AI chat surface. Three modules back it —
`rateLimit.ts` (volatile + durable per-account/per-IP with exponential backoff),
`shadowRateLimit.ts` (six named per-endpoint policies, env-tunable, window
non-overridable), `wallRateLimit.ts` (IP budget on the public display). The
unprotected-but-expensive set is in the findings.

### The rows that matter

| Route | This pass's concern |
|---|---|
| `pilot/audit/get` | **Finding 1** — `select *` over `pilot.audit_events`, one-entry coach denylist |
| `pilot/scheduler` | **Finding 2** — 16 validator call sites whose refusals become 500s |
| `pilot/admin/floor-hours`, `admin/grant-obligations`, `admin/local-findings`, `admin/memberships`, `operations/*` | **Findings 2, 3** — module-level refusals scrubbed to 500 |
| `pilot/intake/domain-upsert`, `pilot/intake/review-action` | **Findings 4, 5** — authority audit written before authorization; caller picks the gate's mode |
| `pilot/shadow/video-analysis` | **Finding 6** — unbounded duplicate AI vision jobs on a minor's footage |
| `document-ingest` | **Finding 7** — three external writes, no idempotency, no rate limit |
| `pilot/feedback/submit` | **Finding 8** — safeguarding queue can be double-filed |
| `pilot/admin/data-deletion` | **Finding 9** — `.includes()` widens the 4xx match on the deletion route |
| `pilot/safety-flags`, `pilot/data-collection-requests` | **Finding 10** — enum cast lands on a DB CHECK, so a typo is a 500 |
| `pilot/shadow/unlocks` | **Finding 11** — silent no-op write on a misspelled feature key |
| `pilot/admin/export/roster`, 138 other GETs | **Finding 12** — 14 of 139 GET routes set `Cache-Control` |
| `src/server/pilot/env.ts` | **Finding 13** — the inverse case: internal misconfiguration leaks as a 400 naming the variable |

## Unchecked casts on request input

**73 unchecked casts on request bodies, across 61 of 228 routes.** "Unchecked"
here means: the parsed body is asserted into a concrete shape, and the file
contains no runtime narrowing of any kind — no `typeof body.x`, no
`Array.isArray`, no shared `validate*` helper. Presence and truthiness checks
(`if (!body.athlete_id)`, `body.x?.trim()`) are present in most of them and are
**not** counted as narrowing, because they cannot distinguish a string from a
number, an object or an array.

The recurring shape, verbatim:

> `apps/web/app/api/pilot/safety-flags/route.ts:47-58` —
> ```
>     const body = (await request.json()) as {
>       athlete_id?: string;
>       person_account_id?: string;
>       flag_class?: SafetyFlagClass;
>       flag_code?: string;
>       severity?: SafetyFlagSeverity;
> ```
> followed at `:59` by the only check there is —
> ```
>     if (!body.flag_class || !body.flag_code?.trim()) {
>       throw new Error('Missing flag_class or flag_code');
> ```

The 73 sites, by path:line:

```
apps/web/app/api/admin/volunteers/route.ts:33, :67
apps/web/app/api/pilot/admin/accounts/pin-reset/route.ts:21
apps/web/app/api/pilot/admin/accounts/repair-auth-provider/route.ts:29
apps/web/app/api/pilot/admin/accounts/revoke/route.ts:18
apps/web/app/api/pilot/admin/activation-codes/route.ts:69
apps/web/app/api/pilot/admin/athlete-accounts/route.ts:23
apps/web/app/api/pilot/admin/bootstrap/platform-owner-microsoft/route.ts:68
apps/web/app/api/pilot/admin/coach-coverage/route.ts:41, :104
apps/web/app/api/pilot/admin/data-deletion/route.ts:34
apps/web/app/api/pilot/admin/floor-hours/route.ts:37
apps/web/app/api/pilot/admin/grant-obligations/route.ts:48, :89
apps/web/app/api/pilot/admin/local-findings/route.ts:50, :105
apps/web/app/api/pilot/admin/memberships/route.ts:42, :90
apps/web/app/api/pilot/admin/staff/route.ts:77, :201
apps/web/app/api/pilot/announcements/get/route.ts:17
apps/web/app/api/pilot/announcements/post/route.ts:60
apps/web/app/api/pilot/athletes/get/route.ts:14
apps/web/app/api/pilot/audit/get/route.ts:26
apps/web/app/api/pilot/auth/activate/route.ts:75
apps/web/app/api/pilot/auth/change-pin/route.ts:55
apps/web/app/api/pilot/auth/login/route.ts:41
apps/web/app/api/pilot/auth/magic-link/consume/route.ts:61
apps/web/app/api/pilot/auth/magic-link/request/route.ts:35
apps/web/app/api/pilot/coach-reviews/get/route.ts:14
apps/web/app/api/pilot/compliance/escalate/route.ts:13
apps/web/app/api/pilot/data-collection-requests/route.ts:43, :100, :139
apps/web/app/api/pilot/goals/get/route.ts:14
apps/web/app/api/pilot/intake/cases/get/route.ts:14
apps/web/app/api/pilot/intake/domain-get/route.ts:14
apps/web/app/api/pilot/intake/review-action/route.ts:66
apps/web/app/api/pilot/operations/external-competition/competitions/route.ts:40, :76
apps/web/app/api/pilot/operations/external-competition/entries/route.ts:44, :86
apps/web/app/api/pilot/operations/wrestling-league/events/route.ts:40
apps/web/app/api/pilot/operations/wrestling-league/roster/route.ts:41, :77
apps/web/app/api/pilot/platform/athlete-shell/route.ts:28
apps/web/app/api/pilot/platform/organizations/assign-admin/route.ts:15
apps/web/app/api/pilot/platform/organizations/memberships/route.ts:22
apps/web/app/api/pilot/platform/organizations/route.ts:45
apps/web/app/api/pilot/platform/organizations/status/route.ts:15
apps/web/app/api/pilot/platform/organizations/transfer-admin/route.ts:22
apps/web/app/api/pilot/platform/staff/route.ts:52
apps/web/app/api/pilot/platform/users/create/route.ts:34
apps/web/app/api/pilot/progression/assignments/route.ts:37
apps/web/app/api/pilot/progression/completions/route.ts:54
apps/web/app/api/pilot/progression/gaps/route.ts:36
apps/web/app/api/pilot/publications/create/route.ts:45
apps/web/app/api/pilot/rabbit-holes/post/route.ts:22
apps/web/app/api/pilot/rabbit-holes/update/route.ts:27
apps/web/app/api/pilot/safety-flags/route.ts:47, :106
apps/web/app/api/pilot/sessions/get/route.ts:14
apps/web/app/api/pilot/shadow/decisions/route.ts:50
apps/web/app/api/pilot/shadow/events/route.ts:17
apps/web/app/api/pilot/shadow/evidence/review/route.ts:60
apps/web/app/api/pilot/shadow/knowledge-projection/route.ts:17
apps/web/app/api/pilot/shadow/observation-projection/route.ts:17
apps/web/app/api/pilot/shadow/recommendations/decide/route.ts:26
apps/web/app/api/pilot/shadow/research-projection/route.ts:17
apps/web/app/api/pilot/shadow/research-requirements/route.ts:59
apps/web/app/api/pilot/shadow/review-projection/route.ts:16
apps/web/app/api/pilot/shadow/telemetry/route.ts:17
apps/web/app/api/pilot/shadow/unlocks/route.ts:41
apps/web/app/api/pilot/training-attempts/route.ts:50
```

**Field-type breakdown across all 103 concrete cast sites** (measured, not
sampled): 289 fields typed `string`, 69 `unknown`, 35 `number`, 9 `boolean`,
**30 a union of string literals or a named type**, 5 `Record<…>`, 4 arrays.

The 30 closed-set fields are the sub-class where a presence check is provably
insufficient, and they are worth naming individually because each one asserts
set membership the runtime never verifies:

```
admin/accounts/pin-reset:21     mode: 'activate' | 'reset'
admin/local-findings:50         domain: LocalFindingDomain
admin/local-findings:50         originating_source: LocalFindingOriginatingSource
admin/local-findings:105        to_tier: LocalFindingTier
admin/local-findings:105        prediction_outcome: LocalFindingPredictionOutcome
data-collection-requests:43     request_kind: DataCollectionRequestKind
data-collection-requests:43     priority: 'low' | 'normal' | 'high'
escalations:96                  action: EscalationAction
floor-plans:96                  plan: FloorPlanPayload
intake/domain-upsert:33         entity_type: 'emergency_contact' | … | 'guardian_link'
intake/domain-upsert:33         automation_mode: ShadowAutomationMode
intake/review-action:66         action: 'approve' | 'reject' | 'promote'
intake/review-action:66         promotion: IntakePromotionPayload
intake/review-action:66         automation_mode: ShadowAutomationMode
platform/organizations/status:15 status: 'active' | 'inactive' | 'suspended' | 'pending'
safety-flags:47                 flag_class: SafetyFlagClass
safety-flags:47                 severity: SafetyFlagSeverity
safety-flags:106                status: 'acknowledged' | 'bypassed' | 'upheld' | 'withdrawn'
safety-flags:106                resolution: SafetyFlagResolution
scheduler:295                   action: SchedulerAction
scheduler:295                   status: 'present' | 'absent' | 'excused'  (×2)
shadow/research-requirements:59 action: 'create' | 'resolve'
shadow/research-requirements:59 source_confidence_tier: 'SUFFICIENT_FOR_LOW_RISK_ACTION' | …
shadow/research-requirements:59 source_verification_state: 'verified' | …
shadow/review-projection:16     status: 'pending_review' | 'approved' | 'rejected' | 'promoted'
shadow/unlocks:41               featureKey: ShadowFeatureKey
shadow/unlocks:41               metricKey: ShadowMetricKey
shadow/unlocks:41               activationMode: ActivationMode
```

**I chased each of those 30 for a downstream check, and most are caught
somewhere.** Recording the outcome, because the refutation is more useful than
the list:

- **Validated at the route, properly** — `escalations` action, `scheduler`
  action and attendance status, `intake/domain-upsert` entity_type,
  `intake/review-action` action, `platform/organizations/status` status,
  `floor-plans` plan (checked `typeof … === 'object'` and size-bounded),
  `admin/grant-obligations` status (`isGrantObligationStatus` — a real type
  guard). These are refuted outright.
- **Caught by a database CHECK constraint** — `safety-flags` flag_class,
  severity, status and resolution
  (`infra/azure/pilot_slice_postgres_safety_flags_migration.sql:56,59,72,74`);
  `data-collection-requests` request_kind and priority
  (`pilot_slice_postgres_assessment_protocols_migration.sql:119,130`);
  `local-findings` originating_source, local_tier, prediction_outcome
  (`pilot_slice_postgres_local_findings_migration.sql:50,54,69`). The data
  cannot be corrupted. What survives is an error-shape defect — see finding 10.
- **Not backed by anything, but fail-closed downstream** — `shadow/unlocks`
  activationMode (`shadowUnlocks.ts:263` — `const unlocked = activationMode ===
  'enabled' && satisfied`, so an unknown mode never unlocks) and featureKey
  (unknown keys are skipped by `buildFeatureStatuses`, which iterates the
  static config, not the rows). See finding 11 for what does happen.
- **Not backed by anything and it matters** — `local_findings.domain` is
  `text not null` with the vocabulary only in a SQL comment
  (`pilot_slice_postgres_local_findings_migration.sql:48` —
  `domain text not null, -- technical | physical | psychological | operational | safety`),
  and `admin/local-findings:63` checks only `!body.domain`. An arbitrary domain
  string is stored and becomes a phantom bucket in
  `pilot_local_findings(organization_id, domain, local_tier)`. Low.
- **`automation_mode`** — `pilot_slice_postgres.sql:156` is
  `automation_mode text not null`, no CHECK, and the value decides whether a
  safety gate can deny. Finding 5.

**Query-string casts, separately: 7 sites.** `admin/local-findings:35,36,37`,
`workout-templates:33`, `safety-flags:32,33`, `floor-hours/public:25`. All seven
are read filters bound as SQL parameters — an invalid value narrows a `WHERE`
clause to nothing and returns an empty list. Refuted as harmless.

## Findings

### [HIGH] `POST /api/pilot/audit/get` returns whole audit rows, and its coach denylist has one entry

`select *` over `pilot.audit_events` hands the caller the full row, `details`
JSONB included. The route knows this is dangerous — it carries a denylist and a
comment explaining the principle — and the denylist has exactly one member.

> `apps/web/app/api/pilot/audit/get/route.ts:19` —
> ```
> const COACH_EXCLUDED_ENTITY_TYPES = new Set(['training_hold']);
> ```
> `apps/web/app/api/pilot/audit/get/route.ts:40` — `` `select * ``

The route's own comment states the extension rule it then does not follow:
"Extend this list, don't weaken the dedicated route's gate, if another safety
entity type ever writes audit events a coach should not enumerate freely."

**56 distinct `entity_type` values are written across the codebase.** Three of
the excluded-by-rights kind are reachable by a coach:

> `apps/web/app/api/pilot/admin/staff/route.ts:151-161` —
> ```
>       details: {
>         action: 'organization_admin_provision_staff',
>         role: result.role,
>         login_email: result.loginEmail,
>         auth_provider: 'microsoft',
>         // Which minor an adult was given access to, and by whom, is the part
>         // of this write a safeguarding review would ask about.
>         ...(result.guardianLink
>           ? {
>               guardian_parent_id: result.guardianLink.parentId,
>               guardian_athlete_id: result.guardianLink.athleteId,
> ```

> `apps/web/app/api/pilot/intake/review-action/route.ts:138` —
> ```
>         details: { action: 'reject', notes: body.notes ?? '' },
> ```

> `apps/web/app/api/pilot/parent/barrier-report/route.ts:75` —
> ```
>       details: { athlete_id: body.athleteId, barrier_type: body.barrierType },
> ```

So a coach posting `{"entity_type":"account"}` enumerates every staff
provisioning row in the gym — login emails, and which adult was linked as
guardian to which child. `{"entity_type":"intake_case"}` returns reviewers'
free-text approval/rejection notes for every child's intake, gym-wide.
`{"entity_type":"parent_barrier_report"}` returns which named athlete's family
reported a barrier and of what category.

**Refutation attempted, four ways.** (1) Is the narrow gate elsewhere?
`intake/cases/get:31` calls `assertActorCanAccessAthlete(principal, athleteId)`
— a coach may read an intake case only for their own athlete. The audit route
reaches the same reviewer notes with no athlete scoping at all, so the narrow
gate exists and this route routes around it. (2) Is `details` sanitized at the
writer? Mostly yes and it is careful work — `note_written: liftNote.length > 0`,
`has_lesson: item.lesson_note.length > 0`, `athlete_row_count` rather than rows.
The three above are the exceptions. (3) Does pass 2 own this? Its route table
lists `pilot/audit/get` with `requirePrincipal, requireRole` and no finding
attached; `audit/get` is in the 175 it classified without opening. Not a
duplicate. (4) Is it in `NETWORK_STATUS.md` or the last 40 commits? No hits for
`audit/get` or `COACH_EXCLUDED` in either.

**Consequence.** Staff login emails, adult-to-minor guardian links, intake
reviewer prose about identified children, and family-hardship categories keyed
to a named athlete, all readable org-wide by any coach through one POST. **Not
CRITICAL**: it needs an authenticated coach in the same gym, cross-org is
blocked by the `organization_id = $1` predicate, and pass 2 already established
that a coach's read scope in this codebase is broad by design. It is HIGH
because the leak is of the *safeguarding record itself* — who was given access
to which child — and because the route already contains the mechanism that would
fix it.

Two smaller defects in the same handler:

> `apps/web/app/api/pilot/audit/get/route.ts:37` —
> ```
>     const limit = Math.max(1, Math.min(100, Number(body.limit ?? 20)));
> ```

`limit` is cast `number` and never checked. `{"limit":"abc"}` gives
`Number("abc")` → `NaN`, `Math.min(100, NaN)` → `NaN`, `Math.max(1, NaN)` →
`NaN`, which reaches Postgres as `limit $6` and errors. The codebase already
fixed exactly this, and wrote down why:

> `apps/web/app/api/pilot/publications/library/route.ts:14-19` —
> ```
>     // Math.min(parseInt(...) || 20, 100) never rejected a negative value --
>     // `-5 || 20` stays -5 since a negative number is truthy, and Math.min
>     // only clamps the upper bound, so it reached the database and crashed
>     // Postgres with an unhandled "LIMIT must not be negative", masked as a
>     // generic 500. parseSafeLimit rejects it outright instead, the same
>     // contract every other bounded list route in this codebase already uses.
> ```

`parseSafeLimit` takes `string | null`, so it does not fit a JSON-body limit —
which is why the seven body-driven `shadow/*` projection routes solved it a
third way, with `clampLimit`/`clampOffset` in `shadowReadModels.ts:107-118`
(refuted, they are safe), and `announcements.ts:91-92` and
`rabbitHoles.ts:424-425` a fourth way (also refuted, also safe). `audit/get` is
the one that clamps inline and gets it wrong.

### [MEDIUM] The scheduler has a real validation layer and every one of its refusals is scrubbed to a 500

`apps/web/app/api/pilot/scheduler/route.ts` is the largest route in the
codebase (770 lines, ten actions) and it is the only one with hand-rolled
typed-input helpers. Four of them, used at **16 call sites**, and all four throw
messages that match no `jsonError` prefix:

> `apps/web/app/api/pilot/scheduler/route.ts:76-99` —
> ```
> function toIso(value: unknown, field: string): string {
>   if (typeof value !== 'string' || !value.trim()) {
>     throw new Error(`${field} must be a non-empty string`);
>   }
>
>   const d = new Date(value);
>   if (Number.isNaN(d.getTime())) {
>     throw new Error(`${field} must be a valid date string`);
>   }
> …
> function requiredInt(value: unknown, field: string): number {
>   if (typeof value !== 'number' || Number.isNaN(value) || !Number.isInteger(value)) {
>     throw new Error(`${field} must be an integer`);
>   }
> ```

Plus two inline ones:

> `apps/web/app/api/pilot/scheduler/route.ts:333` — `throw new Error('capacity must be between 1 and 200');`

> `apps/web/app/api/pilot/scheduler/route.ts:633` — `throw new Error('status must be present, absent, or excused');`

All reach `return jsonError(error);` at `:766` with the default
`fallbackStatus = 500`, so the message is replaced with
`"Internal server error"`.

**Refutation attempted.** Is there a wrapper that catches these before
`jsonError`? No — `:765-767` is the sole `catch` in the POST and it calls
`jsonError(error)` unqualified. Is `PilotError`/`ValidationError` imported here?
No. Is a client-side validator doing the work? Irrelevant to the API contract,
and the class of caller that reaches these branches is precisely the one not
using that client. Is this #426's territory? #426 ("Fix three routes whose error
handling didn't do what it looked like") touches three routes; `scheduler` is
not among the files it changed.

**Consequence.** A coach scheduling a class with a bad date, a capacity of 0, or
an attendance status the UI did not send gets a blank "Internal server error"
and no way to know what to change. `errors.ts`'s own header calls this out as
the exact failure it was written to end — with `pinPolicy.ts` as the worked
example — and the scheduler is the largest un-migrated site.

### [MEDIUM] Four module-level state-machine refusals become 500s on routes that already import `ValidationError`

The same class as finding 2, but sharper, because in each case the *route* was
migrated to `ValidationError` and the *module behind it* was not.

> `apps/web/src/server/pilot/grantObligations.ts:126-128` —
> ```
>   if (current.status !== input.status && !ALLOWED_TRANSITIONS[current.status].includes(input.status)) {
>     throw new Error(`Invalid status transition: ${current.status} -> ${input.status}`);
>   }
> ```

Identical text and identical exposure at `externalCompetition.ts:131`,
`wrestlingLeague.ts:139`, `programMemberships.ts:134`. Each is reached by a
`PATCH` whose route body is:

> `apps/web/app/api/pilot/admin/grant-obligations/route.ts:95-96` —
> ```
>     if (!body.obligation_id) throw new ValidationError('Missing obligation_id.');
>     if (!isGrantObligationStatus(body.status)) throw new ValidationError('Unknown status.');
> ```

and ends `} catch (error) { return jsonError(error); }`. So a *malformed* status
gets a clean 400 and a *valid but disallowed* transition gets a 500.

Two more of the same shape, both route-reachable and confirmed:

> `apps/web/src/server/pilot/floorHours.ts:57-59` —
> ```
>   if (input.reason.trim().length < MIN_REASON_LENGTH) {
>     throw new Error(`ACTIVITY_ADJUSTMENT_REASON_TOO_SHORT: reason must be at least ${MIN_REASON_LENGTH} characters`);
>   }
> ```
reached from `apps/web/app/api/pilot/admin/floor-hours/route.ts:46` →
`jsonError` at `:68`; and `localFindings.ts:227`
(`LOCAL_FINDING_SECOND_REVIEWER_REQUIRED: …`) reached from
`admin/local-findings` PATCH → `jsonError` at `:154`.

**Refutation attempted, and it removed several candidates.** My scan found 63
validation-shaped non-conforming throws in `src/server`. I traced each. Five are
caught by message prefix at the route and correctly re-shaped —
`MEMBERSHIP_DUPLICATE_ACTIVE` (`admin/memberships:75`),
`LEAGUE_ROSTER_DUPLICATE_ENTRY` (`wrestling-league/roster:59`),
`COMPETITION_DUPLICATE_ENTRY` and `COMPETITION_LOSS_NEEDS_LESSON`
(`external-competition/entries:62,140`), `RESEARCH_SUBMISSION_DUPLICATE_LINK`
(`shadow/research-submissions:132`). Three more I initially flagged are
**unreachable from any route**: `sparringExposure.ts` and `drillVersioning.ts`
are imported by no `route.ts`, and `multidiscipline.ts`'s
`GRAPPLING_CHOKE_NOTE_REQUIRED` sits behind a write path the route deliberately
does not expose —
`apps/web/app/api/pilot/multidiscipline/route.ts:12-19` says so: "READ ONLY,
deliberately. … Recording that a child had a choke completed on them is a
safeguarding event". Withdrawn.

**Consequence.** Six confirmed refusals, each of which an admin or coach can
trigger by ordinary use, arrive as opaque 500s. Bounded and cosmetic per
instance; the pattern is that the `PilotError` migration reached route bodies and
stopped at the module boundary.

### [MEDIUM] `intake/domain-upsert` writes the SHADOW authority record before it checks whether the actor may touch the child

The authority check — and the compliance row it writes — runs first; the
athlete access check runs fifteen lines later.

> `apps/web/app/api/pilot/intake/domain-upsert/route.ts:47-62` —
> ```
>     await assertShadowAuthority({
>       actor: principal,
>       organizationId: principal.organizationId,
>       action: `intake.domain_upsert.${entityType}`,
>       automationMode,
>       confidenceTier: 'SUFFICIENT_FOR_REVIEW',
>       lowRisk: true,
>       reversible: true,
>       withinApprovedOptions: true,
>       restrictionConflict: false,
>       metadata: {
>         athlete_id: athleteId,
>       },
>     });
>
>     await assertActorCanAccessAthlete(principal, athleteId);
> ```

`assertShadowAuthority` inserts unconditionally before deciding
(`shadowAuthority.ts:76-93`). So a coach can name any `athlete_id` in the gym
and any `entity_type` string, and a row lands in
`pilot.shadow_authority_checks` with `allowed = true`,
`action = 'intake.domain_upsert.<caller text>'` and
`metadata.athlete_id = <that child>` — *then* the access check refuses, or the
`if`-chain falls through to `throw new Error('Unsupported entity_type')`.

**Refutation attempted.** Is the insert conditional? No — `shadowAuthority.ts:76`
runs before the `if (!decision.allowed)` at `:95`. Is `entityType` validated
before interpolation? No: `:42-45` checks only `!entityType`, and the
`'Unsupported entity_type'` throw is after the whole `if`-chain. Is this pass 2's
finding 4 (mentorship DELETE authorizing after the write)? Different route,
different direction — there the *business* write commits before the refusal; here
the *audit* write does. Is this pass 4's `assertShadowAuthority` finding? Pass 4
established the gate cannot deny; it did not report the ordering or the
attacker-authored `action` string. Not a duplicate, but adjacent — read them
together.

**Consequence.** The register the platform would consult to answer "was SHADOW
authorized to touch this child's medical record" accumulates `allowed: true`
rows for actions that were refused, naming children the actor had no standing
on, with a free-text `action` the actor chose. A safeguarding audit trail that
records attempts as authorizations is worse than one that records nothing,
because it reads as evidence.

### [MEDIUM] The caller supplies the input that decides whether the SHADOW authority gate is allowed to deny

`decideShadowAuthority` has six denial branches. Three of them are gated on
`automationMode === 'automatic'`:

> `apps/web/src/server/pilot/shadowAuthority.ts:46-63` —
> ```
>   if (input.automationMode === 'automatic' && isForbiddenAutomaticClearanceAction(input.action)) {
>     return { allowed: false, reason: 'Automatic clearance and medical authority actions are prohibited.' };
>   }
> …
>   if (input.automationMode === 'automatic' && !input.lowRisk) {
> …
>   if (input.automationMode === 'automatic' && !input.reversible) {
> ```

and `automationMode` comes from the request body, unchecked, defaulting away
from the only value that arms them:

> `apps/web/app/api/pilot/intake/domain-upsert/route.ts:42` —
> ```
>     const automationMode = body.automation_mode ?? 'assisted';
> ```

The same line is at `intake/review-action:76`. The other three branches are
hard-coded non-denying at both call sites (`restrictionConflict: false`,
`withinApprovedOptions: true`, `confidenceTier: 'SUFFICIENT_FOR_REVIEW'`).

And when it *does* deny, the refusal is unreadable:

> `apps/web/src/server/pilot/shadowAuthority.ts:95-97` —
> ```
>   if (!decision.allowed) {
>     throw new Error(`SHADOW authority denied: ${decision.reason}`);
> ```

`SHADOW authority denied:` matches no prefix → generic 500.

**Refutation attempted.** Is `automation_mode` constrained at the database?
`infra/azure/pilot_slice_postgres.sql:156` is `automation_mode text not null` —
no CHECK. Is it validated anywhere en route? No `isShadowAutomationMode` guard
exists. Is it derived from the session rather than the body on some third call
site? There are only two callers and both read it from the body. **Is this pass
4's finding?** Pass 4 reported that the gate "cannot deny at any of its three
call sites" because "every caller passes `restrictionConflict: false` and no
action string matches its forbidden list" — a correct conclusion by a different
route. The mechanism here is that the discriminating input is *caller-supplied*,
which is a different fix (validate and derive it) and a different consequence
(the audit row records the mode the caller claimed). Reported as a mechanism, not
a re-finding; do not count it twice in a severity tally.

**Consequence.** Two things. The compliance record's `automation_mode` column is
whatever the actor wrote, not what happened — so the register cannot be used to
answer "how much of this was automated". And if the gate is ever armed, its
refusal will be indistinguishable from a crash, which is the worst possible
first production behaviour for a safety control that has never fired.

### [MEDIUM] A Film Study vision job on a minor's footage can be enqueued without limit or dedup

`POST /api/pilot/shadow/video-analysis` is gated well — role, video-row-as-
authority, scan status, guardian consent — and then enqueues with no dedup:

> `apps/web/src/server/pilot/shadowJobQueue.ts:238-248` —
> ```
>   const row = await queryOne<{ job_id: string }>(
>     `INSERT INTO pilot.shadow_jobs (
>        job_type, organization_id, account_id, subject_id, role,
>        status, input_payload, priority, retry_count, max_retries,
>        safety_status, created_at, updated_at, expires_at
>      ) VALUES (
>        $1, $2, $3, $4, $5,
>        'pending', $6::jsonb, $7, 0, 3,
> ```

There is no unique constraint, no dedup window, no idempotency key on
`(job_type, organization_id, video_session_id)`, and the route imports no
limiter. Same request twice → two jobs → two real vision calls on the same
child's video → two proposals in the human review queue.

**Refutation attempted.** Does the route dedup? No — `video-analysis:108`
calls `enqueueJob` directly on every request. Does the worker dedup at claim
time? `enqueueJob` is the only insert path and the claim is `for update skip
locked` over pending rows; nothing compares payloads. Is there a partial unique
index? `grep` over `infra/azure/*.sql` for `shadow_jobs` unique indexes: the
only unique constraint is the primary key on `job_id`. Is `shadow/chat`'s
limiter inherited? No — `shadowRateLimit.ts`'s six policies are keyed
`chat`, `chat_daily`, `heavy_bag`, …; none covers `film_study`, and
`video-analysis` imports nothing from that module.

**Consequence.** Two orders of harm, and the smaller one is the money: an
external vision model runs twice on the same minor's footage, and two
observation proposals about one child enter the review queue as if they were two
observations. This is exactly the shape #433 fixed for incident reports, and
#433's own commit message names the general problem ("a client retry after a
dropped/timed-out response") while scoping the fix to one `source_type`.

### [MEDIUM] `POST /api/document-ingest` writes to three external systems with no idempotency and no rate limit

The route's input validation is the best in the codebase — `Content-Length`
required and integer-checked, 10 MB cap enforced twice, MIME check, `%PDF-`
magic-byte check, empty-file check, 15-second parse timeout, filename
sanitized. Then:

> `apps/web/app/api/document-ingest/route.ts:247-250` —
> ```
>       : await Promise.all([
>           uploadToSharePoint(getPipelineConfig().sharepoint, fileName, rawBuffer),
>           uploadToGoogleDrive(getPipelineConfig().googleDrive, fileName, rawBuffer),
>         ])
> ```
preceded at `:234` by `await writeDataverseRecord(…)`.

Three writes to three external systems, no transaction spanning them, no
compensation on partial failure, no idempotency key, and no rate limiter on a
route that parses a 10 MB PDF per request.

**Refutation attempted.** Is there a dedup on content hash? `grep` for
`sha`/`hash`/`digest` in `apps/web/src/server/document-intake/`: no content
hashing anywhere. Is the audit append idempotent? `appendIngestAudit` is
append-only by design. Is the route rate-limited upstream? No middleware exists
(`apps/web/middleware.ts` absent) and the route imports no limiter. Is #425's
timeout work sufficient? #425 bounded external calls that had no timeout, which
narrows the retry window — it does not make the retry safe.

**Consequence.** A dropped response or an impatient admin re-upload creates a
second Dataverse record, a second SharePoint item and a second Drive file for
one real document. A *partial* failure — Dataverse and SharePoint succeed, Drive
throws — returns 500 with the first two already written; the natural retry then
triples one of them. The corpus this pipeline ingests is gym paperwork
(`classifyPdfText` routes by destination), so the duplicated artefact may be a
child's medical form or waiver sitting twice in two external tenants. The
error handling itself is clean: `:288` returns a fixed
`'Document ingestion failed'` and never the raw message.

### [MEDIUM] The safeguarding queue can be double-filed by a double-click, and the route has no rate limit

`POST /api/pilot/feedback/submit` is the child-facing disclosure box. Its
validation is proper (`typeof payload.kind === 'string'`, length cap,
`isFeedbackKind`), its response is a deliberate constant to avoid being a
classifier oracle, and its escalation filing is fire-and-forget for the same
reason. What it has no defence against is a repeat.

> `apps/web/app/api/pilot/feedback/submit/route.ts:94-97` —
> ```
>       void fileAthleteVoiceEscalation({
>         organizationId: principal.organizationId,
>         accountId: principal.accountId,
>         submissionId: submission.submission_id,
>         body,
> ```

`fileAthleteVoiceEscalation` passes `sourceId: params.submissionId`
(`athleteVoice.ts:131`) into `fileEscalation`, whose insert
(`escalationLadder.ts:100`) carries no `on conflict` and no window predicate.
Each submission mints a fresh `submission_id`, so two identical submissions are
two submissions and two escalations.

**Refutation attempted.** Does `createFeedbackSubmission` dedup? Its insert into
`pilot.feedback_submissions` is one of the 117 unguarded ones my scan found; no
`on conflict`. Did #433 cover this? Explicitly not — its commit message names
the exclusion: "fileEscalation/insertEscalation and every other source_type that
goes through them (near_miss, pain_report, safety_gate_evaluation,
repeated_pattern, athlete_voice, training_hold): untouched." So `athlete_voice`
is a *documented* out-of-scope item, not an oversight — which is why this is
MEDIUM and not HIGH. Is the route rate-limited? No; and `shadow/feedback` (a
different route) is the one in the limited 14.

**Consequence.** The doubled-safety-review burden #433's commit message
describes, on the one queue where it matters most, plus an authenticated athlete
can enqueue safeguarding escalations without a ceiling. The oracle design makes
this genuinely awkward to fix — a dedup that returns a different response would
leak the classifier verdict — so this needs a design decision, not a patch.

### [LOW] `admin/data-deletion` matches its 4xx branches with `.includes()`, on the route that deletes a minor's record

This is the inverse case the brief asks for: a widened match that will hand an
internal message straight to the caller with a 4xx.

> `apps/web/app/api/pilot/admin/data-deletion/route.ts:76-81` —
> ```
>     if (message.includes('Forbidden')) {
>       return jsonError(new Error(message), 403);
>     }
>
>     if (message.includes('Not found')) {
> ```

Because the second argument is a non-500 `fallbackStatus`, `jsonError` skips its
scrubbing branch entirely (`http.ts:158-170` runs only when
`fallbackStatus === 500`) and returns `message` verbatim. Any error arising
anywhere under `deleteAthleteRecord` / `deleteGuardianAccount` whose text merely
*contains* `Forbidden` or `Not found` is disclosed in full.

**Refutation attempted.** Is the reachable set closed? `dataDeletion.ts` throws
exactly four literals (`:36`, `:48`, `:123`, `:135`), all four intentional and
all four prefix-conforming, so today the widened match changes nothing. That is
why this is LOW. But the two functions run inside `withTransaction` over eight
tables plus a blob-path enumeration, so the *reachable* error set is not closed
— it includes driver, constraint and Azure SDK messages this pass did not
enumerate. Does the comment cover it? The comment at `:73-75` explains the
`new Error(message)` re-wrap and reasons carefully about not logging the raw
error, so the disclosure direction was considered for the log and not for the
response. Note also that this route is the only place I found where the
generic-500 scrubbing is bypassed by design, and it is the right-to-be-forgotten
route.

**Consequence.** A latent disclosure channel on the highest-consequence
destructive endpoint. Changing `.includes(` to `.startsWith(` closes it without
altering any current behaviour.

### [LOW] An invalid enum on a safety-flag or data-collection write is a 500, not a refusal

The four `safety-flags` enum fields and the two `data-collection-requests` ones
are protected from corruption by database CHECK constraints (quoted in
*Unchecked casts* above), which is the good news and the reason this is LOW. The
bad news is the shape of the refusal: a Postgres check-constraint violation is a
plain `Error` whose message is `new row for relation "safety_flags" violates
check constraint "…"`, which matches no prefix, so `jsonError`'s final branch
replaces it with `Internal server error`.

> `apps/web/app/api/pilot/safety-flags/route.ts:60-62` —
> ```
>     if (!body.flag_class || !body.flag_code?.trim()) {
>       throw new Error('Missing flag_class or flag_code');
>     }
> ```
is the only check; `severity`, `status` and `resolution` are never checked at
all.

**Refutation attempted.** Are the constraints certainly present? Yes, quoted
from `pilot_slice_postgres_safety_flags_migration.sql:56,59,72,74`. Is there a
`isSafetyFlagSeverity` guard in `safetyFlags.ts`? No — `grep` returns type
aliases only (`:24`, `:25`, `:28`), no predicates. Would the constraint message
leak? No — it does not start with a prefix, so it is correctly scrubbed. The
defect is purely that a clean 400 is available and not taken.

**Consequence.** A coach resolving a flag with a value the UI did not send sees a
crash. Contained by the database; the constraint is doing the job the route
should.

### [LOW] A misspelled feature key on `shadow/unlocks` succeeds, changes nothing, and reports success

> `apps/web/app/api/pilot/shadow/unlocks/route.ts:41-53` —
> ```
>     const body = (await request.json().catch(() => ({}))) as {
>       featureKey?: ShadowFeatureKey;
>       metricKey?: ShadowMetricKey;
>       minValue?: number;
>       activationMode?: ActivationMode;
>       description?: string;
>     };
>
>     if (!body.featureKey || !body.metricKey || body.minValue == null || !body.activationMode) {
> ```

Three closed-set fields, presence-checked only, no CHECK constraint behind them
(`pilot_slice_postgres.sql:542,545` — `feature_key text not null`,
`activation_mode text not null default 'enabled'`). `updateShadowThreshold`
upserts, the audit event is written, the response returns `ok: true` and the
recomputed state — which does not contain the row just written, because
`buildFeatureStatuses` iterates the static `DEFAULT_THRESHOLD_CONFIG`.

**Refutation attempted, and it downgraded this from a gate defeat.** My first
read was that an arbitrary `activationMode` might unlock a capability. It cannot:
`shadowUnlocks.ts:263` is `const unlocked = activationMode === 'enabled' &&
satisfied;` — an unknown mode is fail-closed, matching every other gate pass 2
found. Nor can an unknown `featureKey` reach a reader.

**Consequence.** An admin adjusting the threshold on a capability — including
`fine_tuning_pipeline`, which the route's own comment says is "disabled pending
a governance process" — can typo the key, be told it worked, and have changed
nothing. Silent no-op on a governance control, plus junk rows.

### [LOW] 125 of 139 GET routes set no `Cache-Control`, including every one that returns athlete rows

`apps/web/app/api/pilot/admin/export/roster/route.ts:178-180` states the
standard and explains it:

> ```
>         // A roster of minors must not sit in a shared cache, and must not be
>         // re-served from a browser's back-forward cache after a logout.
>         'Cache-Control': 'no-store, no-cache, must-revalidate',
> ```

**14 of 139** GET-exporting routes carry any `Cache-Control` header
(`board/*` ×4, `wall-of-names`, `admin/export/roster`, `auth/microsoft/callback`,
`auth/session`, `profile/me`, `profile/roster`, `profile/card`,
`profile/photo/[accountId]`, `payments/setup-status`, `gym-photos/[slot]`, plus
`wall`). `athletes/list`, `coach/pain-reports`, `coach/barrier-reports`,
`training-holds` and the rest set none.

**Refutation attempted.** Does the framework do it? `next` is `16.3.1`
(`apps/web/package.json:248`); since Next 15 route handlers are uncached by
default, so there is no *server-side* full-route cache to worry about — the
concern is downstream, and Next emits no `Cache-Control` at all, which leaves
heuristic freshness available to browser disk cache and bfcache. Does a proxy
add it? No middleware, and I have no visibility into the Azure front door
configuration — see *Could not establish*. Does `export const dynamic =
'force-dynamic'` help? It is set on 10 routes and governs rendering, not response
headers.

**Consequence.** After a shared-device logout, a back-button navigation may
re-serve a roster or a pain-report list from disk cache. Low, and it is the
smallest-diff item in this document: the codebase already contains the exact
header string it needs, with the reasoning attached.

### [LOW] The inverse case, structurally: an unset environment variable is reported as a 400 naming the variable

> `apps/web/src/server/pilot/env.ts:4-7` —
> ```
>   if (!value?.trim()) {
>     throw new Error(`Missing required environment variable: ${name}`);
>   }
> ```

`Missing` matches, so `jsonError` returns **400 with that text**. `db.ts:11`
imports `getAzurePostgresConnectionString`, so on a deployment with the
connection string unset, every database-touching route — including the anonymous
login route — answers `400 {"error":"Missing required environment variable:
AZURE_POSTGRES_CONNECTION_STRING"}`. The same shape reaches anonymous callers
directly at `admin/bootstrap/route.ts:20` and
`admin/bootstrap/platform-owner-microsoft/route.ts:32`
(`throw new Error('Missing PPBF_PILOT_BOOTSTRAP_KEY')`), which lets an
unauthenticated caller distinguish "bootstrap key not configured" (400, names the
variable) from "invalid bootstrap key" (403).

`http.ts:90-94` states the rule this breaks, in the codebase's own words:

> ```
>   // Checked by type before any message matching. A missing migration or unset
>   // environment variable is a server-side availability problem, not a bad
>   // request, and must not be reported to the caller as one.
> ```

**Refutation attempted.** Is `ShadowRuntimeUnavailableError` used here? No —
`env.ts` imports nothing and throws a bare `Error`; the typed mechanism exists
for exactly this case and `env.ts` predates or bypasses it. Is the variable name
a secret? No, and I do not reproduce any value — the disclosure is *which*
variable and *that it is unset*, i.e. deployment state, to an anonymous caller.
Would a real deployment ever hit it? Unknown from source; a fresh or
mis-provisioned environment would.

**Consequence.** Configuration-state disclosure to anonymous callers, plus a
misleading 400 that will send an operator hunting a client bug during an outage.
No secret is exposed. The fix is one type, already written.

## Checked and found sound

Things I went looking for and did not find. Recorded so the next reader does not
repeat the search.

**HTTP method semantics are structurally clean.** No route exports `PUT`,
`HEAD` or `OPTIONS`; no route aliases one verb to another (`export const PUT =
POST`: zero hits); there is no `middleware.ts` to route around a verb. Next.js
App Router answers an unexported method with 405 by itself, so "missing method
guard" is not a defect that can exist in this codebase's shape. I found **no
mutation behind a GET** other than two deliberate ones. `GET
/api/pilot/admin/export/roster` writes an audit event before returning the CSV
and fails the export if the audit write fails — which is correct and its comment
says why ("A data export is exactly the act somebody asks about months later").
`GET /api/pilot/payments/connect/callback` calls `upsertConnectedAccount`, which
is what an OAuth landing leg does; it verifies a signed `state` and requires
`claims.organizationId === principal.organizationId` before storing anything
(`:71-73`), the store is an upsert so a replayed redirect is idempotent, and the
audit write is wrapped so a lost audit row cannot strand the admin on raw JSON.

**`hiddenNotFound` integrity holds everywhere I could test it.** 47 routes use
it. Exactly one route mixes it with a distinguishable `throw new Error('Not
found')` for the same resource, and that one is right:
`shadow/decision-outcomes` throws internally at `:30` and converts it at `:49`
and `:91` to `return hiddenNotFound()`. The `escalations` PATCH deserves
particular credit — it establishes membership through the coach's own scoped
list rather than a lookup by id, and says so: "so 'not mine' and 'not real' both
land on the same Missing error a coach cannot tell apart. … probing this path
with a guessed id yields the same Missing as a bogus id"
(`escalations/route.ts:110-115`). Pass 2 separately opened all seven
dynamic-segment routes and found the same. I found **no route that leaks
existence through a distinguishable status**. On timing I found nothing to
report and could not test it — see *Could not establish*.

**No bare `error.message` reaches a response.** 17 route sites return
`error.message` directly, and every one is guarded by an `instanceof` on a
purpose-built error class: `InvalidAchievementInput`
(`achievements/milestones:117`, `achievements/recognition:109`,
`goals/personal:97`, `achievements/mentorships:97`), `MentorshipAlreadyOpenError`,
`BoardSeatConflictError` (`board/seats:47`), `DrillNameTakenError`
(`drills:86`), `PilotError` (`session-scripts/runs`, `shadow/research-bridge/export`),
`VideoReviewLinkError`, and a regex-fenced SHADOW code at
`shadow/film-study/diagnostic:113`. I found no route returning a raw driver or
parser message, no stack trace in any response body, and no SQL text. `board/seats`
does return `current_holder_account_id` in its 409, which is a deliberate
disclosure the comment justifies ("A seat that is already held outright is a
conflict the caller can act on") and concerns adult governance, not a minor.

**The rate-limited 14 are the right 14, and the limiter degrades correctly.**
Every anonymous entry point, every credential path, both blob-upload routes, the
AI chat surface and the public wall. `rateLimit.ts` runs volatile and durable
limiters, either one refusing is enough, and a durable-store failure returns
"not limited" rather than throwing — with the reasoning written out at
`:36-49` ("Rate limiting is a guard, not the operation … the honest fallback is
the in-memory limiter, NOT locking every athlete out"). `getClientIp` resolves
`X-Forwarded-For` by trusted-hop count from the right, refuses to key a bucket
on a client-written header when `PPBF_TRUSTED_PROXY_COUNT` is 0, and its comment
records that the naive version "returned attacker-controlled chain data, letting
a client rotate a fabricated X-Forwarded-For to get a fresh per-IP bucket every
request." That is a fixed vulnerability, not an open one.

**The four chat adapter routes are not an unlimited AI surface.**
`coach/chat`, `athlete/chat`, `individual/chat` and `board/chat` each delegate to
`postShadowChat`, which carries `shadowRateLimit`. Each also deletes
`organizationId` from the forwarded body before forwarding, so a caller cannot
inject a gym. My initial read had these as four unlimited model endpoints;
refuted.

**`document-ingest` has the strongest input validation in the codebase.**
`Content-Length` required (411 if absent), digit-checked, `Number.isSafeInteger`
and positive, capped; `formData` file checked `instanceof File`; MIME checked;
size checked twice; `%PDF-` magic bytes checked against the buffer, not the
declared type; empty file rejected; filename through `safePdfFileName`; a
15-second parse timeout with `clearTimeout` and `parser.destroy()` in `finally`;
and every rejection writes an audit row. Its idempotency gap is finding 7; its
validation is a model the other 227 could copy.

**Body-limit clamping is safe on the routes I traced, three different ways.**
`shadowReadModels.ts:107-118` (`clampLimit`/`clampOffset`, `Number.isFinite`
guarded) covers the seven `shadow/*` projection routes;
`announcements.ts:91-92` and `rabbitHoles.ts:424-425` each guard with
`Number.isFinite` before `Math.min`, so a string, object or `Infinity` falls to
the default rather than reaching Postgres. Only `audit/get` gets this wrong.

**`parseSafeLimit` is a real, well-reasoned primitive and 17 routes use it.**
It rejects rather than coerces — empty, negative, zero, decimal, `NaN`,
`Infinity`, non-numeric — and `http.ts:184-187` explains that rejecting is the
point.

**`shadow/chat` and `shadow/metrics` handle their own non-conforming messages
locally.** My error-shape scanner flagged `invalid_body`
(`shadow/chat:509`) and `SHADOW_PROFILE_NOT_FOUND` (`shadow/metrics:350`). Both
are caught in the same file and converted to a proper response —
`shadow/chat:511-527` returns a 400 with a caller-readable body,
`shadow/metrics:124` matches the code exactly. Both withdrawn.
`achievements/milestones:102` (`'Milestone was not written'`) is an internal
fault and its opaque 500 is correct.

**An anonymous caller cannot flood the durable rate-limit table without bound.**
I chased this: `auth/login:41` takes `account_id` from the body with no length or
format validation and uses it to key both the in-memory `Map` and
`pilot.auth_rate_limit_buckets`, so on its face a rotating `account_id` writes an
unbounded number of rows. It is genuinely mitigated: the per-IP bucket is checked
*before* the login attempt (`:70-89`), so five failures from one IP stop the
sequence; `recordDurableFailedAttempt` deletes rows older than
`DURABLE_WINDOW_SECONDS` (15 minutes) on every call; and `cleanupExpiredEntries`
sweeps the `Map` on every `checkRateLimit`. Refuted, and worth not
rediscovering.

**Non-string values in credential fields fail closed, not open.**
`auth/login:42-43` uses `body.account_id?.trim()` on an unchecked cast. A number,
array or object has no `.trim`, so the request dies with a `TypeError` → generic
500 before any authentication work happens. Opaque, but there is no path where a
non-string is treated as a credential.

**Two `insert` guards that already exist and should not be re-fixed.** Five
duplicate-prevention paths are in place and correctly surfaced at the route:
`MEMBERSHIP_DUPLICATE_ACTIVE`, `LEAGUE_ROSTER_DUPLICATE_ENTRY`,
`COMPETITION_DUPLICATE_ENTRY`, `COMPETITION_LOSS_NEEDS_LESSON`,
`RESEARCH_SUBMISSION_DUPLICATE_LINK`. And 58 of 175 `insert into pilot.*`
statements carry `on conflict` or `where not exists`. The idempotency picture is
not "nothing is guarded"; it is "the guards are per-feature and there is no
platform-level idempotency key".

**No route uses a schema validator, and that is worth stating as a finding-shaped
absence rather than a defect.** Zero `zod` hits across 228 routes. Every check is
hand-rolled. The four shared `validate*Payload` helpers and the scheduler's four
typed helpers are the closest thing to a convention, and they cover 7 of 228
routes.

## Could not establish

**175 of 228 routes were classified but not opened.** I know, for every one of
them, which helpers it imports, what it casts the body to, which literal messages
it throws, whether it imports a limiter, and whether it sets `Cache-Control`. I
do not know whether a validation call sits on every path through the handler, nor
whether a second verb in the same file skips it. The 61 routes in the unchecked-
cast list are the population most likely to contain more instances of findings
2, 3 and 10, and I sampled them rather than enumerating their consequences.

**No runtime proof of anything.** I started nothing and issued no request. In
particular: finding 1's claim that a coach POSTing `{"entity_type":"account"}`
receives those rows depends on `pilot.audit_events` actually containing
`login_email` in `details` in a live database, which I inferred from the writer,
not observed. Finding 4's ordering claim depends on the authority insert
committing before the access check throws, which is what the code says and not
what I saw.

**I could not test timing side channels at all, so my `hiddenNotFound` verdict
covers status codes and response bodies only.** Several routes take a
caller-supplied record id and do measurably different work for "exists but
forbidden" than for "does not exist" — `escalations` acknowledge, for one, lists
the coach's whole scoped set before deciding. Whether that is measurable over the
network needs a running instance and a timing harness. `feedback/submit` is the
one place the codebase reasons about this itself
(`:73-81`: "response LATENCY is as much a classifier oracle as response shape"),
which suggests the concern is understood and not systematically applied.

**Whether any deployed proxy adds cache headers.** Finding 12's severity depends
on it. I read no Azure front door / CDN configuration and there is nothing in
`apps/web` that would tell me.

**Whether the 102 no-`.catch()` body parses matter in practice.** A malformed
JSON body on those routes produces a `SyntaxError` → generic 500 rather than a
400. I confirmed the mechanism and did not enumerate which of the 102 a real
client could trigger, nor whether any of them is reachable before
authentication. `publications/submit:44` carries a comment about exactly this
("jsonError maps status by message prefix; a bare request.json() throw…"), so
one route has thought about it.

**I did not audit the 5 `formData()` routes beyond `document-ingest`.**
`profile/photo`, `video/upload`, `shadow/upload` and `admin/gym-photos` all take
multipart input carrying minors' images or footage. Three of the four are in the
rate-limited 14, which is why I deprioritized them, but multipart validation is
its own surface and I did not read it.

**The `parent_id` / guardian-link questions are pass 2's and pass 3's, and are
parked by owner decision.** I touched `intake/domain-upsert` only for its
authority-check ordering and its `automation_mode` cast. Nothing in findings 4
or 5 should be read as reopening the parked linking decision.

**`docs/capabilities/NETWORK_STATUS.md` is not on this branch.** I read the copy
on `origin/docs/agent-handoff-briefs` (PR #437, draft). If a newer copy exists,
my de-duplication is only as current as that branch. Open-PR state I took from
`git log origin/main` and not from GitHub, so a fix already in flight for any
finding here would be invisible to me — check `gh pr list --state open` before
acting.
