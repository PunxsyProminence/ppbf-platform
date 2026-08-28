# Athlete check-in API contract (Phase 2 slice 1)

Stable contract for the athlete "Today" surface.

**Deployment state (verified 2026-08-28).** The table and all nine wellness
columns are dispatchable through the normal `all` chain. `pilot.athlete_check_ins`
itself is applied to **production**: apply-migrations run `33089360578`
(`MIGRATION: all`, `TARGET: production`, commit `4545969b`) completed green on
2026-08-27, and `athlete-check-ins` sits ahead of `calibration-gold` in that
chain, which applied and passed in the same run. The `athlete-check-in-measures`
migration adding the six extended columns is newer than that run and its applied
state in any environment is **not verified here** — dispatch `all` (idempotent by
design) rather than assuming either way.

> An earlier revision of this file said "the migration ships with the next
> release wave (until then the route 404s in deployed environments)". That was
> true when written and is now stale for the base table; it is corrected rather
> than deleted so a reader who remembers the old claim can see it was retired
> deliberately.

## Route

`/api/pilot/athlete/check-in` — role `athlete` ONLY, self-scoped: the athlete id
comes from the session principal. There is no `athlete_id` parameter; a body
`athlete_id` is ignored. No other role has a path (coach/admin arrival views are a
later, separate read surface; parents have none).

### GET
Response `200`:
```json
{
  "today": { "check_in_id": "…", "checked_in_on": "2026-08-16",
             "energy": 4, "soreness": null, "focus": 3,
             "sleep_hours": 7.5, "hydration": 4, "motivation": null,
             "mental_clarity": 3, "stress": 2, "nutrition_compliance": 4,
             "note": "", "created_at": "…" } | null,
  "recent": [ /* same shape, newest first, up to 14 days — the athlete's OWN history */ ]
}
```

### POST
Body (ALL fields optional — a bare `{}` is a valid check-in):
```json
{ "energy": 1-5, "soreness": 1-5, "focus": 1-5,
  "hydration": 1-5, "motivation": 1-5, "mental_clarity": 1-5,
  "stress": 1-5, "nutrition_compliance": 1-5,
  "sleep_hours": 0-24, "note": "string" }
```
- The eight wellness values must be whole numbers 1–5 when present; anything else
  is a `400` with the reason. **Omitted means omitted** — the UI must not default a
  skipped slider to a value, and must render stored `null` as "not reported",
  never as 0 or 3.
- `sleep_hours` is a **quantity, not a rating**: any number 0–24, fractional
  allowed (the control steps in half hours). It does not take the 1–5 rule.
- Response `200`: `{ "item": <row>, "already_checked_in": boolean }`.
  One check-in per day is enforced by the database; a repeat POST returns the
  existing row with `already_checked_in: true` — render as friendly acknowledgment
  ("Already checked in today"), not an error.

## What each number means

Every 1–5 scale is anchored — a bare number that nobody described is exactly what
this platform has been burned by before. The anchors, the question text and the
scale **direction** live in `apps/web/src/shared/wellnessScales.ts`, which the
server validates against and the athlete's screen labels from, so the wording a
child reads and the value in the column cannot drift apart.

**Direction is recorded, not assumed.** Most scales are `higher_is_better`;
`soreness` and `stress` are `higher_is_worse` — a 5 there is a bad day. Nothing
aggregates these today, and the field exists so the first thing that does has to
look rather than guess.

## Deliberately NOT collected here

Three measures the athlete panel once advertised are owned elsewhere. A second
home would be a second answer:

- **RPE** — `pilot.sessions.rpe` + `rpe_method`, and it is a POST-session
  construct. Check-in writing a pre-session number into it is the exact defect
  `pilot_slice_postgres_session_rpe_semantics_migration.sql` exists to end.
- **Training load** — `pilot.session_load`, which splits physical/cognitive and
  states that derived load "is computed in the query, never stored — the formula
  is unvalidated in boxing".
- **Soreness by location** — the pain card, which posts to
  `/api/pilot/shadow/formulas/observations` as `kind: 'pain_report'` and
  **escalates**: the UI tells the child a coach has been told. A duplicate
  wellness column would take the same report and tell nobody.

Resting heart rate, HRV and blood pressure are **deferred, not dropped** (owner
decision 2026-08-28): they are biometric readings on minors, a different class
from "how sore are you", and they get their own slice once consent and retention
are settled.

## Semantics the UI must preserve

- **Check-in is not attendance.** The passbook/attendance register stays
  coach/terminal-owned; do not present check-in as official attendance.
- **Self-reports are not readiness scores.** Never display these values on any
  GREEN/YELLOW/RED scale or blend them with the readiness board. In particular
  nothing here may feed `getReadinessLevel` in `AthleteWorkspace.tsx`.
- **Own record only.** `recent` is the athlete's own history — fine for streak-style
  display (no shame framing); never comparable across athletes.
- Streak/celebration mechanics built on this must follow the engagement addendum
  (real events only; no leaderboards; no pressure mechanics).

## Growing the table

Owner decision 2026-08-28: **named columns, one migration per measure decided** —
not a jsonb blob. Each new measure therefore needs its own migration plus the
registration surfaces, and `migrationDispatchCoverage.test.ts` asserts it is
ordered after `athlete-check-ins` in the `all` chain. Add the column to
`WELLNESS_COLUMNS` and a scale to `wellnessScales.ts` in the same change: the
route's validation sweep and the athlete's labels both derive from those, and
`athleteCheckInMeasures.pg.test.ts` checks the constant against the constraints
on the table so code agreeing with code cannot pass for schema agreement.
