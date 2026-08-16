-- Floor groups and circuit stations (register modules 121 + 123, owner
-- answer 2026-08-16: "depends on who shows up ... some groups work in
-- small groups and we do do circuits").
--
-- BUILT AROUND WHO IS ACTUALLY HERE. The gym does not run fixed rosters:
-- a floor plan is made on the day, for the athletes present. So a group
-- belongs to a DAY (and optionally a scheduled class), not to a
-- permanent roster, and an athlete's membership in it is a fact about
-- that session only. Nothing here assigns anyone to anything in advance,
-- and no group membership carries forward or implies a level, a rank, or
-- a judgment.
--
-- STATIONS ARE OPTIONAL. A plan with groups and no stations is a
-- small-group day; a plan with stations is a circuit. Neither is the
-- default, because the gym runs both.
--
-- Idempotent: create table/index if not exists, no alters, no drops.

create table if not exists pilot.floor_plans_daily (
  organization_id       text not null references pilot.organizations(organization_id) on delete cascade,
  plan_id               text not null,
  plan_on               date not null,
  class_id              text null,
  title                 text not null default '',
  rotation_minutes      integer null check (rotation_minutes is null or rotation_minutes between 1 and 120),
  notes                 text not null default '',
  created_by_account_id text not null references pilot.accounts(account_id),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  primary key (organization_id, plan_id)
);

create index if not exists idx_floor_plans_daily_by_day
  on pilot.floor_plans_daily(organization_id, plan_on desc);

-- A group on the floor for one plan. station_name null = a small group
-- with no station (not a circuit); rotation_order null = the group does
-- not rotate.
create table if not exists pilot.floor_plan_groups (
  organization_id  text not null references pilot.organizations(organization_id) on delete cascade,
  group_id         text not null,
  plan_id          text not null,
  group_name       text not null check (length(btrim(group_name)) > 0),
  station_name     text null,
  focus            text not null default '',
  rotation_order   integer null check (rotation_order is null or rotation_order >= 1),
  coach_account_id text null references pilot.accounts(account_id),
  created_at       timestamptz not null default now(),
  primary key (organization_id, group_id),
  constraint pilot_floor_plan_groups_plan_fk
    foreign key (organization_id, plan_id)
    references pilot.floor_plans_daily(organization_id, plan_id) on delete cascade
);

create index if not exists idx_floor_plan_groups_by_plan
  on pilot.floor_plan_groups(organization_id, plan_id, rotation_order nulls last);

-- Who stood in which group today. One group per athlete per plan: a
-- person cannot be in two places on the same floor at the same time.
create table if not exists pilot.floor_plan_members (
  organization_id text not null references pilot.organizations(organization_id) on delete cascade,
  plan_id         text not null,
  group_id        text not null,
  athlete_id      text not null,
  created_at      timestamptz not null default now(),
  primary key (organization_id, plan_id, athlete_id),
  constraint pilot_floor_plan_members_group_fk
    foreign key (organization_id, group_id)
    references pilot.floor_plan_groups(organization_id, group_id) on delete cascade,
  constraint pilot_floor_plan_members_athlete_fk
    foreign key (organization_id, athlete_id)
    references pilot.athletes(organization_id, athlete_id) on delete cascade
);

create index if not exists idx_floor_plan_members_by_group
  on pilot.floor_plan_members(organization_id, group_id);
