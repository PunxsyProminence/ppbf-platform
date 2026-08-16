# Athlete check-in API contract (Phase 2 slice 1)

Stable contract for the athlete "Today" surface. The backend is merged and tested;
the migration ships with the next release wave (until then the route 404s in
deployed environments — treat that as an honest absent state).

## Route

`/api/pilot/athlete/check-in` — role `athlete` ONLY, self-scoped: the athlete id
comes from the session principal. There is no `athlete_id` parameter; a body
`athlete_id` is ignored. No other role has a path (coach/admin arrival views are a
later, separate read surface; parents have none).

### GET
Response `200`:
```json
{
  "today": { "check_in_id": "…", "checked_in_on": "2026-08-16", "energy": 4,
             "soreness": null, "focus": 3, "note": "", "created_at": "…" } | null,
  "recent": [ /* same shape, newest first, up to 14 days — the athlete's OWN history */ ]
}
```

### POST
Body (ALL fields optional — a bare `{}` is a valid check-in):
```json
{ "energy": 1-5, "soreness": 1-5, "focus": 1-5, "note": "string" }
```
- Wellness values must be whole numbers 1–5 when present; anything else is a `400`
  with the reason. **Omitted means omitted** — the UI must not default a skipped
  slider to a value, and must render stored `null` as "not reported", never as 0 or 3.
- Response `200`: `{ "item": <row>, "already_checked_in": boolean }`.
  One check-in per day is enforced by the database; a repeat POST returns the
  existing row with `already_checked_in: true` — render as friendly acknowledgment
  ("Already checked in today"), not an error.

## Semantics the UI must preserve

- **Check-in is not attendance.** The passbook/attendance register stays
  coach/terminal-owned; do not present check-in as official attendance.
- **Self-reports are not readiness scores.** Never display these values on any
  GREEN/YELLOW/RED scale or blend them with the readiness board.
- **Own record only.** `recent` is the athlete's own history — fine for streak-style
  display (no shame framing); never comparable across athletes.
- Streak/celebration mechanics built on this must follow the engagement addendum
  (real events only; no leaderboards; no pressure mechanics).
