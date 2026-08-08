-- Floor hours ledger -- public and admin views of time on the floor.
--
-- WHY NO ATTENDANCE BACKFILL. The app has not been on the floor. Any rows
-- presently in pilot.attendance or pilot.scheduler_attendance are test or
-- placeholder data, so there is no history to preserve and a migration
-- would import artificial numbers into the record that funders and the
-- public will read. The two legacy tables are left in place, read-only,
-- and excluded from every reporting query here. Real history starts at
-- go-live.
--
-- WHAT THIS FILE ADDS. pilot.activity_log already records duration_minutes
-- per person per occurrence across every activity domain. These views
-- aggregate it into the clock: all-time, year, and quarter. A public view
-- carries organization totals with NO personal data; an admin view carries
-- the per-person detail and the adjustment trail.
--
-- ADJUSTMENTS ARE APPENDED, NEVER OVERWRITTEN. A mistyped duration is
-- corrected by writing an adjustment row that references the original, not
-- by editing it. The clock a funder reads and the clock an auditor
-- reconstructs must be the same number, and that only holds if corrections
-- leave a trace.
--
-- DEPENDS ON pilot.organizations, pilot.accounts, pilot.activity_log (must
-- be applied first). No begin;/commit; here on purpose, matching this
-- repo's runner-opens-the-transaction convention (the runner is
-- apps/web/scripts/pilot-apply-floor-hours-ledger-migration.mjs).

create table if not exists pilot.activity_log_adjustments (
  organization_id     text not null references pilot.organizations(organization_id) on delete cascade,
  adjustment_id       text not null,
  activity_id         text not null,
  delta_minutes       integer not null check (delta_minutes <> 0),
  reason              text not null,
  adjusted_by_account_id text not null references pilot.accounts(account_id),
  adjusted_by_role    text not null,
  adjusted_at         timestamptz not null default now(),
  constraint pilot_activity_adj_pkey primary key (organization_id, adjustment_id),
  constraint pilot_activity_adj_activity_fk foreign key (organization_id, activity_id)
    references pilot.activity_log(organization_id, activity_id) on delete cascade,
  -- A correction without a stated reason is indistinguishable from
  -- tampering.
  constraint pilot_activity_adj_reason check (length(btrim(reason)) >= 10)
);

create index if not exists pilot_activity_adj_activity
  on pilot.activity_log_adjustments(organization_id, activity_id);

-- Effective minutes = recorded + net adjustments. Every downstream view
-- reads THIS, never activity_log.duration_minutes directly, so a
-- correction propagates everywhere at once. security_invoker=true so the
-- view runs with the querying role's own privileges, not the view owner's.
create or replace view pilot.v_activity_effective_minutes
  with (security_invoker = true) as
select
  a.organization_id,
  a.activity_id,
  a.person_account_id,
  a.athlete_id,
  a.activity_domain,
  a.activity_type,
  a.occurred_on,
  a.attendance_status,
  a.duration_minutes                                    as recorded_minutes,
  coalesce(sum(adj.delta_minutes), 0)::int               as adjustment_minutes,
  (a.duration_minutes + coalesce(sum(adj.delta_minutes), 0))::int as effective_minutes
from pilot.activity_log a
left join pilot.activity_log_adjustments adj
  on adj.organization_id = a.organization_id and adj.activity_id = a.activity_id
where a.attendance_status = 'present'
group by a.organization_id, a.activity_id, a.person_account_id, a.athlete_id,
         a.activity_domain, a.activity_type, a.occurred_on, a.attendance_status, a.duration_minutes;

-- PUBLIC CLOCK. Organization-level totals only. No person identifier, no
-- athlete identifier, no per-person figure -- this view is safe to render
-- on a public page for a youth program.
create or replace view pilot.v_floor_hours_public
  with (security_invoker = true) as
select
  organization_id,
  activity_domain,
  'all_time'                                  as period_kind,
  null::integer                               as period_year,
  null::integer                               as period_quarter,
  round(sum(effective_minutes) / 60.0, 1)     as hours,
  count(*)                                    as sessions_recorded,
  count(distinct person_account_id)           as distinct_participants,
  min(occurred_on)                            as first_recorded,
  max(occurred_on)                            as last_recorded
from pilot.v_activity_effective_minutes
group by organization_id, activity_domain
union all
select
  organization_id, activity_domain, 'year',
  extract(year from occurred_on)::integer, null,
  round(sum(effective_minutes) / 60.0, 1), count(*),
  count(distinct person_account_id), min(occurred_on), max(occurred_on)
from pilot.v_activity_effective_minutes
group by organization_id, activity_domain, extract(year from occurred_on)
union all
select
  organization_id, activity_domain, 'quarter',
  extract(year from occurred_on)::integer,
  extract(quarter from occurred_on)::integer,
  round(sum(effective_minutes) / 60.0, 1), count(*),
  count(distinct person_account_id), min(occurred_on), max(occurred_on)
from pilot.v_activity_effective_minutes
group by organization_id, activity_domain,
         extract(year from occurred_on), extract(quarter from occurred_on);

comment on view pilot.v_floor_hours_public is
  'Organization-level floor hours by domain, all-time / year / quarter. No personal identifiers. Safe for public display.';

-- ADMIN CLOCK. Per-person detail plus the adjustment trail. Read through
-- admin authorization only -- this view itself carries no access control,
-- the API route in front of it does.
create or replace view pilot.v_floor_hours_admin
  with (security_invoker = true) as
select
  e.organization_id,
  e.person_account_id,
  e.athlete_id,
  e.activity_domain,
  extract(year from e.occurred_on)::integer     as period_year,
  extract(quarter from e.occurred_on)::integer  as period_quarter,
  round(sum(e.effective_minutes) / 60.0, 2)     as hours,
  sum(e.recorded_minutes)                       as recorded_minutes,
  sum(e.adjustment_minutes)                     as adjustment_minutes,
  count(*)                                      as sessions_recorded,
  min(e.occurred_on)                            as first_recorded,
  max(e.occurred_on)                            as last_recorded
from pilot.v_activity_effective_minutes e
group by e.organization_id, e.person_account_id, e.athlete_id, e.activity_domain,
         extract(year from e.occurred_on), extract(quarter from e.occurred_on);

comment on view pilot.v_floor_hours_admin is
  'Per-person floor hours with recorded vs adjusted minutes exposed. Admin authorization required at the API layer.';
