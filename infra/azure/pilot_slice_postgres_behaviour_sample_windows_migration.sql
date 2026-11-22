-- PATTERN-1d (lane PATTERN-1; PunxsyProminence/ppbf-platform#2082, Q2 A, Q3 A,
-- Q5 A, Q7 A, Q8 A): a SAMPLED WINDOW. In a live class (a session run) a coach
-- picks one athlete, one behaviour, the drill or context, the task constraint
-- and a number of chances, then taps shown / not shown per chance. The taps
-- are behaviour reports, written by the existing writer into
-- pilot.behaviour_observations; each chance's episode is fixed by window and
-- chance number (the writer's windowEpisodeId, PATTERN-1d-2), so a second coach
-- who joins the window codes the same attempts. This table holds the window
-- alone: no free text, and no tap. Named under pilot.behaviour_observations so
-- the public-surface denylist (privacyTiers.ts) covers it by prefix.
--
-- Applied only by Overwatch (Q2 A): `npm run pilot:apply-behaviour-sample-windows`.
-- Idempotent: every object is created if absent or replaced.

create table if not exists pilot.behaviour_observations_windows (
  organization_id text not null references pilot.organizations(organization_id) on delete cascade,
  window_id uuid not null default gen_random_uuid(),
  -- No foreign key, as for the reports: an anon_ token satisfies none. The guard checks the athlete.
  athlete_id text not null,
  behaviour_key text not null,
  run_id text not null,
  -- What the coach picked, as the writer takes it: a drill, a session block, or an attempt context.
  context_kind text not null,
  context_id text not null,
  task_constraint text not null,
  chances integer not null default 10,
  opened_by_account_id text null references pilot.accounts(account_id) on delete set null,
  opened_by_role text not null,
  opened_at timestamptz not null default now(),
  closed_at timestamptz null,
  deidentified_at timestamptz null,
  constraint pilot_behaviour_windows_pkey primary key (organization_id, window_id),
  constraint pilot_behaviour_windows_key_fk foreign key (organization_id, behaviour_key)
    references pilot.behaviour_keys(organization_id, behaviour_key),
  constraint pilot_behaviour_windows_run_fk foreign key (organization_id, run_id)
    references pilot.session_script_runs(organization_id, run_id),
  constraint pilot_behaviour_windows_context_check
    check (context_kind in ('drill', 'block', 'context') and context_id ~ '^[^[:space:]]{1,200}$'),
  constraint pilot_behaviour_windows_constraint_check
    check (task_constraint in ('controlled', 'constrained_live', 'live')),
  constraint pilot_behaviour_windows_chances_check check (chances between 1 and 50),
  constraint pilot_behaviour_windows_role_check check (opened_by_role in ('coach', 'organization_admin', 'admin')),
  constraint pilot_behaviour_windows_closed_check check (closed_at is null or closed_at >= opened_at),
  constraint pilot_behaviour_windows_deidentified_check
    check (deidentified_at is null or athlete_id ~ '^anon_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
);

create index if not exists idx_behaviour_windows_athlete
  on pilot.behaviour_observations_windows(organization_id, athlete_id);
create index if not exists idx_behaviour_windows_open_in_run
  on pilot.behaviour_observations_windows(organization_id, run_id) where closed_at is null;

create or replace function pilot.behaviour_observations_windows_guard()
returns trigger
language plpgsql
as $behaviour_windows_guard$
begin
  if tg_op = 'DELETE' then
    -- Only as a consequence: the athlete follow trigger or a gym cascade.
    if pg_trigger_depth() = 1 then
      raise exception 'BEHAVIOUR_WINDOW_IS_NOT_DELETED'
        using errcode = '23514', constraint = 'pilot_behaviour_windows_no_delete';
    end if;
    return old;
  end if;
  if tg_op = 'UPDATE' then
    -- Three updates only. (1) The opener's account going: the foreign key's
    -- own set-null action, which runs this deeper than 1; nothing else moves.
    if pg_trigger_depth() > 1 and new.opened_by_account_id is null
       and to_jsonb(new) - 'opened_by_account_id' = to_jsonb(old) - 'opened_by_account_id' then
      return new;
    end if;
    -- (2) Closing, once; nothing else moves.
    if old.closed_at is null and new.closed_at is not null
       and to_jsonb(new) - 'closed_at' = to_jsonb(old) - 'closed_at' then
      return new;
    end if;
    -- (3) The purge's de-identification of a DELETED athlete's window
    -- (scripts/pilot-cleanup-deleted-data.mjs), before it deletes the athlete:
    -- the athlete key becomes the purge's token, once; nothing else moves.
    if old.deidentified_at is null and new.deidentified_at is not null
       and new.athlete_id ~ '^anon_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       and not exists (
         select 1 from pilot.athletes a
          where a.organization_id = old.organization_id and a.athlete_id = old.athlete_id
            and a.deleted_at is null)
       and to_jsonb(new) - array['athlete_id', 'deidentified_at']
         = to_jsonb(old) - array['athlete_id', 'deidentified_at'] then
      return new;
    end if;
    raise exception 'BEHAVIOUR_WINDOW_IS_NOT_CHANGED'
      using errcode = '23514', constraint = 'pilot_behaviour_windows_append_only';
  end if;
  -- INSERT: an open window, for a live athlete of this gym, opened by active
  -- staff of this gym in the role it records, on an active behaviour name.
  if new.deidentified_at is not null or new.closed_at is not null or new.athlete_id like 'anon\_%'
     or not exists (
       select 1 from pilot.athletes a
        where a.organization_id = new.organization_id and a.athlete_id = new.athlete_id and a.deleted_at is null) then
    raise exception 'BEHAVIOUR_WINDOW_ATHLETE_OF_THIS_GYM'
      using errcode = '23514', constraint = 'pilot_behaviour_windows_live_athlete';
  end if;
  if new.opened_by_account_id is null or not exists (
    select 1 from pilot.organization_memberships om
      join pilot.accounts acc on acc.account_id = om.account_id
     where om.account_id = new.opened_by_account_id and om.organization_id = new.organization_id
       and om.active_flag and om.role = new.opened_by_role
       and acc.active_flag and acc.deleted_at is null
  ) then
    raise exception 'BEHAVIOUR_WINDOW_OPENER_OF_THIS_GYM'
      using errcode = '23514', constraint = 'pilot_behaviour_windows_opener_of_this_gym';
  end if;
  if not exists (
    select 1 from pilot.behaviour_keys k
     where k.organization_id = new.organization_id and k.behaviour_key = new.behaviour_key and k.status = 'active'
  ) then
    raise exception 'BEHAVIOUR_WINDOW_KEY_NOT_ACTIVE'
      using errcode = '23514', constraint = 'pilot_behaviour_windows_active_key';
  end if;
  return new;
end;
$behaviour_windows_guard$;

drop trigger if exists trg_behaviour_observations_windows_guard on pilot.behaviour_observations_windows;
create trigger trg_behaviour_observations_windows_guard
  before insert or update or delete on pilot.behaviour_observations_windows
  for each row execute function pilot.behaviour_observations_windows_guard();

-- A window still naming the athlete goes with the athlete row, as the reports do
-- (pilot_behaviour_observations_follow_athlete); the purge de-identifies first.
create or replace function pilot.behaviour_observations_windows_follow_athlete()
returns trigger
language plpgsql
as $behaviour_windows_follow_athlete$
begin
  delete from pilot.behaviour_observations_windows
   where organization_id = old.organization_id and athlete_id = old.athlete_id;
  return old;
end;
$behaviour_windows_follow_athlete$;

drop trigger if exists pilot_behaviour_observations_windows_follow_athlete on pilot.athletes;
create trigger pilot_behaviour_observations_windows_follow_athlete
  before delete on pilot.athletes
  for each row execute function pilot.behaviour_observations_windows_follow_athlete();
