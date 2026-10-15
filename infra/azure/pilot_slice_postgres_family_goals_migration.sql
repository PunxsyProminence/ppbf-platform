-- Family goals: what a family and the gym agree the family will do to support
-- one child (PH-05, issue #1593; the storage half of PH-06).
--
-- WHAT THIS SOLVES. The parent hub's Family Goals tab has a goal shape (a
-- title, the family's support action, a target date) and nothing behind it.
-- An athlete's own goals (pilot.goals, written by achievements.ts) belong
-- to the athlete and say what the child wants to work on; a family goal says
-- what the household will do ("Arrange transportation twice each week"). They
-- have different owners, so they are separate records (PH-05 Q1 default B).
--
-- PROGRESS IS A RECORDED EVENT, NOT A PERCENTAGE. A goal is 'active' or
-- 'completed', and completed_at is when it was marked done. The database holds
-- the two together: completed exactly when completed_at is set (PH-05 Q-A
-- default A). Nothing here stores a number a person did not record.
--
-- NOTHING IS HARD-DELETED. A goal taken down is retired (retired_at) and the
-- application stops showing it (PH-05 Q-B default A). A direct DELETE is
-- refused; one that arrives as a cascade (its athlete or gym going) runs from
-- inside another trigger, so pg_trigger_depth() is above 1 and it goes through.
--
-- WHO WROTE IT IS KEPT, and who reads what is the application's (PH-06): by
-- OD-2026-10-12-024's principle a guardian reads the goals they created and
-- those staff created for the child, never another guardian's; staff read all
-- of a child's goals. created_by_account_id and created_by_role are what make
-- that enforceable, so they never change by hand. When the writer's account is
-- removed the goal stays, about the child, with no writer (set null), as a
-- family reply does (D-9).
--
-- THE GOAL'S CHILD AND GYM NEVER MOVE. The athlete reference is (gym, athlete)
-- over pilot.athletes' own key, so a goal cannot name another gym's child, and
-- the guard refuses an UPDATE that would move it.
--
-- EACH REFUSAL NAMES ITSELF (23514 with its own constraint name).
--
-- DEPENDS ON pilot.organizations, pilot.accounts, pilot.athletes.
-- Idempotent: if-not-exists throughout, the trigger function is create-or-
-- replace, and the trigger is dropped-and-created by name. No drops of any
-- table or data, no backfill. No begin;/commit; here on purpose, matching this
-- repo's runner-opens-the-transaction convention (the runner is
-- apps/web/scripts/pilot-apply-family-goals-migration.mjs).

create table if not exists pilot.family_goals (
  organization_id text not null references pilot.organizations(organization_id) on delete cascade,
  goal_id uuid not null default gen_random_uuid(),
  athlete_id text not null,

  title text not null,
  -- What the family will do to support the child.
  support_action text not null,
  target_date date,

  state text not null default 'active',
  completed_at timestamptz,
  retired_at timestamptz,

  created_by_account_id text references pilot.accounts(account_id) on delete set null,
  created_by_role text not null,
  updated_by_account_id text references pilot.accounts(account_id) on delete set null,
  updated_by_role text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint pilot_family_goals_pkey primary key (organization_id, goal_id),

  -- Dies with its athlete; athletes are retired, not deleted, in this app.
  constraint pilot_family_goals_athlete_fk
    foreign key (organization_id, athlete_id)
    references pilot.athletes(organization_id, athlete_id) on delete cascade,

  constraint pilot_family_goals_title_check
    check (char_length(btrim(title)) between 1 and 200),
  constraint pilot_family_goals_support_action_check
    check (char_length(btrim(support_action)) between 1 and 500),
  constraint pilot_family_goals_state_check
    check (state in ('active', 'completed')),
  -- Completed exactly when it was marked done at a recorded time.
  constraint pilot_family_goals_completed_check
    check ((state = 'completed') = (completed_at is not null)),
  constraint pilot_family_goals_created_by_role_check
    check (created_by_role in ('parent', 'coach', 'organization_admin', 'admin')),
  constraint pilot_family_goals_updated_by_role_check
    check (updated_by_role is null or updated_by_role in ('parent', 'coach', 'organization_admin', 'admin'))
);

-- One child's goals, newest first.
create index if not exists idx_family_goals_athlete
  on pilot.family_goals(organization_id, athlete_id, created_at desc);

create or replace function pilot.family_goals_guard()
returns trigger
language plpgsql
as $family_goals_guard$
begin
  if tg_op = 'DELETE' then
    if pg_trigger_depth() = 1 then
      raise exception 'FAMILY_GOAL_IS_NOT_DELETED'
        using errcode = '23514', constraint = 'pilot_family_goals_no_delete';
    end if;
    return old;
  end if;

  -- UPDATE. A cascade (an account going sets its writer columns to null) runs
  -- from inside the foreign key's own trigger, so it is let through as is.
  if pg_trigger_depth() > 1 then
    return new;
  end if;

  if new.organization_id is distinct from old.organization_id
     or new.goal_id is distinct from old.goal_id
     or new.athlete_id is distinct from old.athlete_id then
    raise exception 'FAMILY_GOAL_DOES_NOT_MOVE'
      using errcode = '23514', constraint = 'pilot_family_goals_fixed_child';
  end if;

  if new.created_by_account_id is distinct from old.created_by_account_id
     or new.created_by_role is distinct from old.created_by_role
     or new.created_at is distinct from old.created_at then
    raise exception 'FAMILY_GOAL_WRITER_IS_KEPT'
      using errcode = '23514', constraint = 'pilot_family_goals_fixed_writer';
  end if;

  new.updated_at := now();
  return new;
end;
$family_goals_guard$;

drop trigger if exists trg_family_goals_guard on pilot.family_goals;
create trigger trg_family_goals_guard
  before update or delete on pilot.family_goals
  for each row execute function pilot.family_goals_guard();
