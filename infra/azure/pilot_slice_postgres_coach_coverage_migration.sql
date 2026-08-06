-- Coach coverage grants (pilot.coach_coverage) -- ticket T-002.
--
-- THE VERIFIED PROBLEM
--
-- access.ts's assertCoachAssignedToAthlete is an exact match on
-- pilot.athletes.coach_id. A coach covering a session for the athlete's
-- regular coach -- out sick, on vacation -- gets 'Forbidden: coach not
-- assigned to athlete' on every athlete-scoped route, mid-session, with no
-- path to resolve it. The scheduler already understands CLASS-level cover
-- (scheduler_classes.covering_coach_account_id), but the athlete-scoped
-- access gate never learned the concept.
--
-- DESIGN DECISION (the ticket requires stating it): per-athlete,
-- time-bounded grants in this table -- the ticket's option 1. Option 2 (a
-- roster-wide coverage flag on the organization membership) was REJECTED
-- because: (a) real coverage is per-session -- a roster flag over-grants
-- the substitute access to EVERY athlete of the absent coach, including
-- ones nowhere near the covered class, and this gate fronts pain reports
-- and near misses about minors, where over-granting is a privacy cost, not
-- a convenience; (b) time-bounding and revocation are first-class columns
-- on a table and awkward, forgettable states on a membership flag; (c)
-- granted_by/reason give the safeguarding audit trail a membership flag
-- cannot; (d) the scheduler's covering_coach_account_id is already the
-- class-level mechanism -- a roster flag would be a third overlapping
-- coverage semantic, while a per-athlete grant composes with the existing
-- one.
--
-- WHAT A GRANT MEANS, EXACTLY
--
-- While `revoked_at is null and starts_at <= now() and expires_at > now()`,
-- the covering coach passes assertCoachAssignedToAthlete for that one
-- athlete -- nothing more. The athlete's coach_id of record never changes;
-- expiry needs no cron (the access check compares against now() at read
-- time); revocation is immediate.
--
-- granted_by_role admits 'coach' although the grant route is admin-only
-- today: the ticket's own design sketch names the athlete's regular coach
-- as a plausible future granter (handing their roster to a named sub), and
-- admitting the value now means that future is a route change, not a
-- migration. The AUTHORITY to grant lives in the route's role check; this
-- column records who actually did.
--
-- No `begin;`/`commit;` here on purpose: the runner
-- (apps/web/scripts/pilot-apply-coach-coverage-migration.mjs) opens the
-- transaction itself, matching the safety-escalations / goal-category
-- convention.

create table if not exists pilot.coach_coverage (
  organization_id            text not null references pilot.organizations(organization_id) on delete cascade,
  coverage_id                 text not null,
  athlete_id                  text not null,
  covering_coach_account_id   text not null,
  granted_by_account_id       text not null,
  granted_by_role             text not null check (granted_by_role in ('coach', 'organization_admin', 'admin')),
  reason                      text not null default '',
  starts_at                   timestamptz not null default now(),
  expires_at                  timestamptz not null,
  revoked_at                  timestamptz null,
  revoked_by_account_id       text null,
  created_at                  timestamptz not null default now(),
  primary key (organization_id, coverage_id),
  foreign key (organization_id, athlete_id)
    references pilot.athletes(organization_id, athlete_id)
    on delete cascade,
  constraint pilot_coach_coverage_window check (expires_at > starts_at)
);

create index if not exists idx_coach_coverage_lookup
  on pilot.coach_coverage(organization_id, covering_coach_account_id, athlete_id, expires_at desc);
