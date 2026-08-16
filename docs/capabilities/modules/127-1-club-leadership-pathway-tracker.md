# Module 127 — 1% Club / Leadership Pathway Tracker

| Field | Value |
|-------|-------|
| Status | **DONE** (vertical slice — see Implementation notes) |
| Active | false |
| Promotion required | true |
| Category | Class / Program Management (`classProgramManagement`) |
| Source | `2.0.0-draft-merged` |
| Parent original-25 | _unmapped_ |

## Intent
A recognition-by-vote mechanism, not a ranking. Three real nomination paths (a
coach nominates directly, an athlete nominates themselves or a peer, or a real
earned milestone is cited as the reason) feed one confirmation mechanism: a
strict majority of the organization's currently-active coaches and admins have
to vote yes before anyone becomes a member. It must never compute a worthiness
number, rank athletes against each other, or let a milestone-surfaced
suggestion read as if a person put the name forward.

## Boundaries
- Does **not** auto-approve progression, medical, or board decisions.
- Does **not** expose athlete-level data to board / public aggregates without suppression rules.
- Does **not** invent metrics that are not stored by the platform.
- Does **not** compute a score, rank, or "worthiness" number anywhere — confirmation is a human majority vote, always.
- Does **not** let a milestone-surfaced nomination read as if a coach or peer put the name forward — the source is shown, always.
- Does **not** revoke or lapse a confirmed membership — owner decision 2026-08-16: permanent once confirmed.

## Dependencies
- Upstream: `pilot.accounts` (eligible-voter pool), `pilot.athletes`, `pilot.athlete_milestones` / the achievement-paths catalogue (milestone verification).
- Downstream: none yet — a future athlete-facing "you're a member" display is follow-up work, not built in this slice.
- Related original-25 capability: _unmapped_.

## Acceptance criteria
- [x] Data model / tables named — `pilot.one_percent_nominations`, `pilot.one_percent_votes`.
- [x] API surface listed — `/api/pilot/coach/one-percent-club` (GET list/detail, POST `nominate`/`vote`/`withdraw`).
- [x] Roles that may read / write — nominate: coach, organization_admin, admin, athlete (self/peer). Vote and withdraw: coach, organization_admin, admin only. Read (roster + tally + who-voted): coach, organization_admin, admin only.
- [x] Safety / refusal cases — duplicate/open/confirmed nomination refused; 30-day cooldown after a closed nomination; a vote cannot be changed once cast; a withdrawal requires a stated reason (enforced by a DB check constraint, not just the application); a confirmed nomination can never be withdrawn.
- [x] Audit events — `writePilotAuditEvent` on nominate, vote, and withdraw (`entity_type: 'one_percent_nomination'`).
- [x] UI surface — `/coach/one-percent-club` (coach/admin). An athlete-facing nomination entry point is follow-up work; the API already supports the self/peer path.

## Implementation notes

Built to the owner's design, verbatim (2026-08-16): "1,2,3 with the majority
of coach and admin on the list vote to confirm." Follow-up questions were
asked and answered the same day:

- **Eligible voters**: every account with role `coach`/`organization_admin`/`admin` that is currently `active_flag = true` in the organization. Computed live at vote time (`countEligibleVoters`), never cached.
- **Open-nomination expiry**: 30 days. An open nomination that never reaches majority is marked `expired` (lazily, on the next read/write that touches it) — the row is never deleted.
- **Re-nomination cooldown**: 30 days after a nomination closes as `withdrawn` or `expired`, reusing the same window rather than inventing a second constant.
- **Membership permanence**: permanent once confirmed. There is no code path anywhere in `onePercentClub.ts` that moves a row's status out of `'confirmed'`, and there is no revoke/un-vote action on the route or the page.

Design choices made without a direct owner answer, stated here rather than
buried:

- **Milestone-surfaced scope, kept narrow on purpose.** Rather than building a
  cross-athlete "candidate suggestions" feed (which risks reading as a
  leaderboard even without a score attached), the milestone path is a
  per-athlete, per-nomination verification: a nominator may cite a milestone
  key, and the server checks it against that athlete's real earned awards
  (`achievements.ts`'s `listMilestoneAwards` + `countCompletedSessions` +
  the achievement-paths catalogue) before trusting it. An unearned or
  fabricated key is silently dropped to an ordinary `coach_nomination` rather
  than rejected outright, since the nomination itself is still legitimate —
  only the "surfaced by a milestone" framing was not.
- **Withdrawal is staff-only.** An athlete may nominate (self or peer) but
  may not withdraw a nomination — reversing one is kept a coach/admin action
  so a peer nomination cannot be socially pressured back out by another
  athlete.
- **Full roster/tally visibility is staff-only.** An athlete who nominates
  gets a success response but not a view of the vote-in-progress tally —
  keeping "who voted no on my nomination" out of a minor's view was judged
  safer than exposing it, absent an explicit owner call either way.
- **No mathematically-dead early close.** If enough "no" votes make a
  majority arithmetically impossible before the 30-day window closes, this
  slice does not detect or early-close that state — it simply waits out the
  same 30 days as any other unresolved nomination, rather than adding an
  unrequested rule.

Vertical slice: migration + apply script + server module (`onePercentClub.ts`)
+ embedded-Postgres contract test + mocked unit test + API route + route test
+ coach-facing page + page test. Registered in `package.json`
(`pilot:apply-one-percent-club`, `test:migrations:one-percent-club`, and the
`test:migrations` chain) and in `.github/workflows/apply-migrations.yml` (the
matrix and both inline coverage loops). Door added to `buildingMap.ts`.

## Audit log
| Date | Actor | Note |
|------|-------|------|
| 2026-08-03 | scaffold-script | Stub created from PPBF_CAPABILITIES.json |
| 2026-08-16 | Claude | Vertical slice built to owner design (module 127): three nomination paths, majority-vote confirmation, permanent membership. Registered DONE / PENDING_SIGN_OFF. |
