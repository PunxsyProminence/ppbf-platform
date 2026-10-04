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
  "sleep_hours": 0-24, "note": "string",
  "body_mass": number, "body_mass_unit": "lb" | "kg" }
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
- `body_mass` (elite-boxing item 5, Jason 2026-10-04) is optional and needs
  `body_mass_unit`; 20–250 kg (or the same range in lb), else `400` before
  anything is written. It is **not a check-in column**: it is stored as the
  athlete's `body_weight` formula observation, in kilograms, keyed to the
  check-in (`check-in:<check_in_id>:body_weight`) -- the same record the
  sparring form writes, feeding MVP-12 (Seven-Day Weight Change). One weigh-in
  per check-in: a repeat POST may add a missing one but never replaces a stored
  one. The response carries `body_mass_saved: boolean`.

### Who reads body mass, and the flag
- Staff: `GET /api/pilot/coach/athlete-body-mass?athlete_id=` -- a sibling of
  the check-in read, because its gate is narrower. Adult: any coach or
  organization admin in the gym. Youth, or no date of birth on file: only the
  assigned or covering coach and the organization admin
  (`assertActorCanAccessAthlete`). Anyone else gets `body_mass: null`, the same
  as "no weigh-in".
- Parent: `GET /api/pilot/parent/body-mass?athlete_id=` -- linked children only.
- The flag (Jason 2026-10-04: ">5% in 7 days"; "B: any >5% within 7 days"):
  raised when, by more than 5% of the earlier weight, up or down, either the
  latest weigh-in differs from the one closest to 7 days earlier (±24 h, MVP-12:
  `change`), or any two weigh-ins in the 7 days up to the latest differ
  (`largest_change_in_window`). `flag_text` names the larger, e.g. "Weight down
  6.0% in 7 days (132.3 lb → 124.3 lb). Check in with the athlete." The
  parent route answers only for a youth (an adult has no parent surface).
  Weigh-ins outside 20–250 kg are left out. Nothing acts on
  the flag.

### Correcting a mistyped weight
Jason 2026-10-04: "Athlete or their coach".
- Athlete: `GET /api/pilot/athlete/check-in/body-mass` returns their own latest
  weigh-in (`observation_id`, `pounds`, `observed_at`, `correctable`). It does
  not include the flag. `POST` with `{ observation_id, body_mass, body_mass_unit }`
  corrects one of their own entries.
- Coach: `POST /api/pilot/coach/athlete-body-mass` with `{ athlete_id,
  observation_id, body_mass, body_mass_unit }`. Only the assigned or covering
  coach may correct, for adults too. The GET answers `can_correct`.
- Refused with `403`: everyone else, including a coach who only shares the gym,
  the organization admin, a parent and the platform owner.
- Only entries observed in the last 7 days can be corrected, which is the
  flag's window; anything older answers `409 BODY_MASS_CORRECTION_WINDOW`.
- A correction writes a new `body_weight` observation that supersedes the old
  one, at the old one's `observed_at`. The old entry is never edited or
  deleted; it stays on record. Reads and the flag use only entries that
  nothing supersedes.
- Each entry can be corrected once (`409 BODY_MASS_ALREADY_CORRECTED`). To fix
  it again, correct the newer entry.
- The audit row names both entries and holds no weights.

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
