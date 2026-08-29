-- What a purged guardian leaves behind, and what goes with them.
--
-- Owner decision, 2026-08-29 (D-9). Two tables hold rows a GUARDIAN wrote, and
-- both refused to let that guardian's account be deleted. The retention purge
-- names them in its nightly report; this is the answer to what it found.
--
-- THE CASE THIS IS ABOUT IS NARROWER THAN IT LOOKS. pilot.coach_observations
-- already cascades from pilot.athletes, so a family that fully withdrew loses
-- these rows anyway when the athlete is purged at two years. The only state
-- this decision touches is a guardian purged at ONE year while their child is
-- STILL ENROLLED under a remaining guardian -- so the record in question is
-- about a child who is still training here.
--
-- ── pilot.coach_observations: the record stays, its author does not ─────────
--
-- POST /api/pilot/parent/barrier-report writes coach_observations with the
-- PARENT's own account id in coach_account_id. A barrier report is a
-- safeguarding note about a child ("no ride on Thursdays", and worse things
-- than that). Owner decision, verbatim: "Keep it, detached from the author."
--
-- Deleting it was the alternative and was rejected for the right reason: a
-- note about a currently enrolled child would be destroyed because the person
-- who reported it aged out of the system, and nobody would know it had ever
-- existed.
--
-- coach_account_id therefore becomes NULLABLE and its foreign key becomes ON
-- DELETE SET NULL. THE NULLABILITY IS A REAL COST AND IS NOT PRETENDED
-- OTHERWISE: the schema stops guaranteeing that any observation has an author,
-- coaches' included, to fix a case that only arises for guardians. The owner
-- was told that and chose it. Nothing in the application writes NULL -- every
-- writer supplies an author -- and a test pins that, so the only way this
-- column goes NULL is the referential action below.
--
-- WHAT SURVIVES, PRECISELY. author_role carries 'parent' on every row this
-- path writes, because the route passes principal.role. So after the purge the
-- record still says a GUARDIAN filed it, which is what makes "detached from
-- the author" different from "anonymous". That is a statement about rows this
-- decision touches, not about the column in general: author_role is nullable
-- and was never backfilled, so observations written before that migration may
-- have none. This migration does not backfill it -- inventing a role nobody
-- recorded is the one thing worse than an absent one.
--
-- ── pilot.parent_task_state: the row goes ──────────────────────────────────
--
-- The owner first chose one rule for both tables. It cannot be had. This table
-- carries pilot_parent_task_state_completion_paired, which forbids exactly the
-- shape "keep it, forget who":
--
--   check ((completed_at is null and completed_by_account_id is null)
--       or (completed_at is not null and completed_by_account_id is not null))
--
-- and its own comment gives the reason -- "a completed_at with nobody against
-- it is an unattributable claim that a family did something". SET NULL on the
-- completer alone raises 23514 against that constraint.
--
-- Put back to the owner with that constraint quoted, the decision was to
-- CASCADE: the task-state row is deleted with the guardian. A task completion
-- is bookkeeping; the message it hangs off is a coach_observation and survives
-- under the rule above. The CHECK is left exactly as it is -- weakening a
-- constraint added on purpose, for every row and every future writer, was
-- offered and declined.
--
-- created_by_account_id IS DELIBERATELY UNTOUCHED. canSetParentTask admits
-- only coach and organization_admin, so a guardian can never be the creator,
-- and the retention purge deletes role = 'parent' only. Changing a foreign key
-- no reachable state exercises would be churn dressed as safety.
--
-- Idempotent: shape-guarded, no drops of anything but the two foreign keys it
-- replaces, no backfill. No begin;/commit; here on purpose, matching this
-- repo's runner-opens-the-transaction convention (the runner is
-- apps/web/scripts/pilot-apply-parent-authored-purge-migration.mjs).

-- ── coach_observations.coach_account_id ────────────────────────────────────
alter table pilot.coach_observations
  alter column coach_account_id drop not null;

do $pilot_coach_observations_author_fk$
declare
  fk_name text;
begin
  -- The constraint was created inline by the base schema, so its name is
  -- whatever Postgres generated. Found by shape rather than assumed, and only
  -- replaced when it is not already SET NULL.
  select c.conname into fk_name
    from pg_constraint c
   where c.conrelid = to_regclass('pilot.coach_observations')
     and c.confrelid = to_regclass('pilot.accounts')
     and c.contype = 'f'
     and c.conkey = array[(
           select a.attnum from pg_attribute a
            where a.attrelid = to_regclass('pilot.coach_observations')
              and a.attname = 'coach_account_id'
         )]::int2[]
     and c.confdeltype <> 'n';

  if fk_name is not null then
    execute format(
      'alter table pilot.coach_observations drop constraint %I', fk_name);
  end if;

  if not exists (
    select 1 from pg_constraint
     where conname = 'pilot_coach_observations_author_fk'
       and conrelid = to_regclass('pilot.coach_observations')
  ) then
    alter table pilot.coach_observations
      add constraint pilot_coach_observations_author_fk
      foreign key (coach_account_id) references pilot.accounts(account_id)
      on delete set null;
  end if;
end
$pilot_coach_observations_author_fk$;

comment on column pilot.coach_observations.coach_account_id is
  'The account that filed this observation, NULL once that account has been purged by data retention. Nullable only for that reason -- every writer supplies an author. author_role still says what kind of person filed it, which is what keeps a detached record from being an anonymous one.';

-- ── parent_task_state.completed_by_account_id ──────────────────────────────
do $pilot_parent_task_state_completed_by_fk$
declare
  fk_name text;
begin
  select c.conname into fk_name
    from pg_constraint c
   where c.conrelid = to_regclass('pilot.parent_task_state')
     and c.confrelid = to_regclass('pilot.accounts')
     and c.contype = 'f'
     and c.conkey = array[(
           select a.attnum from pg_attribute a
            where a.attrelid = to_regclass('pilot.parent_task_state')
              and a.attname = 'completed_by_account_id'
         )]::int2[]
     and c.confdeltype <> 'c';

  if fk_name is not null then
    execute format(
      'alter table pilot.parent_task_state drop constraint %I', fk_name);
  end if;

  if not exists (
    select 1 from pg_constraint
     where conname = 'pilot_parent_task_state_completed_by_fk'
       and conrelid = to_regclass('pilot.parent_task_state')
  ) then
    alter table pilot.parent_task_state
      add constraint pilot_parent_task_state_completed_by_fk
      foreign key (completed_by_account_id) references pilot.accounts(account_id)
      on delete cascade;
  end if;
end
$pilot_parent_task_state_completed_by_fk$;

comment on constraint pilot_parent_task_state_completed_by_fk on pilot.parent_task_state is
  'ON DELETE CASCADE: the task-state row goes with the guardian who completed it. SET NULL is impossible here -- pilot_parent_task_state_completion_paired forbids a completed_at with no completer, deliberately, because that would be an unattributable claim that a family did something.';
