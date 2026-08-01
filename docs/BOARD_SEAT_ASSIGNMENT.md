# Board seat assignment

The governing board has eight seats: President, Chair, Vice Chair, Treasurer,
Secretary, Program & Safety Director, Community & Development Director,
Director-at-Large. They are stored in `pilot.board_seats`
([migration](../infra/azure/pilot_slice_postgres_board_seats_migration.sql)) and
their slugs come from
[boardWorkspaceConfig.ts](../apps/web/app/board/boardWorkspaceConfig.ts), which
is also what the `/board/[seat]` pages route on and what the migration's
`pilot_board_seats_seat_check` constraint admits.

## What a seat row may hold

An adult board member's own appointment, and nothing else. No athlete
identifier, no `entity_id`, no payload, no event reference. The board role is
aggregate-only — see [Board](../ORGANIZATION_ROLE_MODEL.md#board) — and a
governance table carrying an `entity_id` would be the shortest path from a seat
assignment to a youth record. The roster read carries no `login_email` and no
auth provider either: a governance roster is not a directory of personal data.

## The rules the surface has to respect

- **One primary per seat, enforced by the database.** The partial unique index
  `pilot_board_seats_one_primary_per_seat` over `(organization_id, seat) where
  is_primary` is the only thing that holds under concurrency: two simultaneous
  assignments each read no existing primary and both write, so a check in
  application code loses that race by construction. A UI that only checks
  client-side is a convenience, never the guarantee.
- **Additional holders are legal and unlimited.** Co-chairs, a successor
  shadowing an outgoing officer, and someone covering an absence are rows with
  `is_primary = false`.
- **Promotion does not seat someone new.** `PATCH` changes who holds a seat
  outright among the people already on it, so bringing in an outside successor
  is a `POST` as an additional holder followed by a `PATCH`.
- **A handover is a demote and a promote in one transaction.** Between the two
  statements the seat has no holder, so split across two requests a failure in
  between leaves the seat vacant. `setPrimarySeatHolder` keeps both halves in
  one transaction.
- **One person may hold more than one seat**, and holds any one seat once — the
  primary key is `(organization_id, seat, account_id)`. Small boards double up.
- **A seat is held by an active board member of this gym.** The table's foreign
  key only proves the account exists somewhere on the platform, so
  `assertEligibleHolder` checks the organization and the board role as well.

## Who may assign

An organization admin, or the board member holding the President seat outright.
`assertCanManageBoardSeats` in
[boardSeats.ts](../apps/web/src/server/pilot/boardSeats.ts) is the authority, and
it reads the President from the database rather than from the caller's session
payload. Writes additionally require a Microsoft-authenticated session.

## Surface

`/admin/board-seats` — [page](../apps/web/app/admin/board-seats/page.tsx),
reachable from the People console.

Shows every seat including unfilled ones, the holder of record, and any
additional holders; assigns, promotes, and removes. Assigning a second holder of
record to an occupied seat is refused before the request is sent, with a message
naming the current holder and offering the two things the person actually meant:
hand the seat over, or join it as an additional holder. The console mirrors
`assertCanManageBoardSeats` to decide what is worth showing — hiding a control is
never what stops a write.

The console works from account ids because the roster read carries nothing else.
When the caller is an organization admin it also reads
`/api/pilot/admin/staff`, which is what turns an account id back into a person an
admin recognises; the President cannot read that route, so their picker is a
typed account id and they can still seat anyone.

## API — `/api/pilot/board/seats`

Failures follow the platform convention: a non-2xx status with
`{ "error": "..." }`. Success is `{ "ok": true }` plus the affected rows.

### `GET`

Readable by `board`, `organization_admin`, `admin`. The organization is always
the caller's own session organization and is never read from the request.
Optional `?seat=<slug>` narrows to one seat.

```json
{
  "ok": true,
  "organization_id": "org-ppbf",
  "seats": ["president", "chair", "vice-chair", "treasurer", "secretary", "safety-director", "community-director", "at-large"],
  "holders": [
    { "seat": "chair", "account_id": "dana", "is_primary": true, "assigned_at": "2026-07-01T00:00:00.000Z" }
  ]
}
```

### `POST`

```json
{ "seat": "chair", "account_id": "dana", "is_primary": false }
```

Records one appointment. `is_primary` must be asked for: an assignment that says
nothing about it joins the seat rather than taking it from whoever holds it.
Answers 409 with `{ error, seat, current_holder_account_id }` when the seat is
already held outright.

### `PATCH`

```json
{ "seat": "chair", "account_id": "rosa" }
```

The handover: `account_id` takes the seat outright and whoever held it steps back
to an additional holder, both halves committing together. 404 when that person
does not already hold the seat.

### `DELETE`

`/api/pilot/board/seats?seat=chair&account_id=dana`

Ends one appointment. 404 rather than a silent success when this organization has
no such assignment. Removing the holder of record leaves the seat unfilled rather
than promoting an additional holder — succession is a decision, not a side
effect.
