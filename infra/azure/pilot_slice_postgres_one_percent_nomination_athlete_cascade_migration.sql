-- A One Percent Club nomination is deleted with the athlete it names.
--
-- Owner decision OD-2026-08-29-007, the option he selected, verbatim:
--   "Delete it with the athlete (Recommended)"
-- The alternative offered, and declined, was to keep the nomination and detach
-- it from the athlete.
--
-- WHAT WAS WRONG. pilot_one_percent_nominations_athlete_fk was created with no
-- delete action (one_percent_club_migration.sql:61-62), so it restricts. The
-- retention purge hard-deletes an athlete two years after withdrawal
-- (apps/web/scripts/pilot-cleanup-deleted-data.mjs), and a nominated athlete
-- could therefore never be purged: the job reported the constraint by name as
-- a blocker, every night, and the child's record stayed.
--
-- WHAT THIS DOES. The same constraint, same name, same key, now ON DELETE
-- CASCADE. pilot.one_percent_votes already cascades from the nomination
-- (one_percent_club_migration.sql:89-91), so a nomination's votes go with it.
-- No row is written, changed or removed by this file.
--
-- WHAT THIS DOES NOT DO (the decision's own limits). It changes no other One
-- Percent Club table and no other foreign key, and it changes nothing for a
-- nomination whose athlete is still enrolled: the cascade fires only when the
-- pilot.athletes row itself is deleted. In this repository's code the only
-- statements that do that are the two retention purges (dataDeletion.ts and
-- pilot-cleanup-deleted-data.mjs), both limited to athletes withdrawn more
-- than two years ago. Withdrawing or expiring a nomination still keeps the row.
--
-- SAME NAME, DROPPED AND RE-ADDED, guarded on the constraint's own delete
-- action -- the pattern parent_authored_purge_migration.sql:117-150 used. The
-- one-percent-club migration re-runs on every `all` dispatch and its `create
-- table if not exists` is then a no-op, so it cannot put the old shape back.
-- pilot-verify-schema.mjs compares names only, so it cannot see this change;
-- the runner's readiness query checks the delete action.
--
-- DEPENDS ON one-percent-club, earlier in the workflow's `all` list; the block
-- below refuses to run without its table. Idempotent: a second run finds the
-- constraint already cascading and does nothing. No begin;/commit; here,
-- matching this repo's runner-opens-the-transaction convention; the runner is
-- apps/web/scripts/pilot-apply-one-percent-nomination-athlete-cascade-migration.mjs.

do $pilot_one_percent_nominations_athlete_fk$
declare
  fk record;
begin
  if to_regclass('pilot.one_percent_nominations') is null then
    raise exception 'ONE_PERCENT_NOMINATION_ATHLETE_CASCADE_NOT_READY: pilot.one_percent_nominations does not exist -- apply the one percent club migration first';
  end if;

  -- Found by what it points at rather than by name alone: any foreign key from
  -- this table onto pilot.athletes that does not already cascade is the one
  -- that blocks the purge, whatever it is called.
  for fk in
    select c.conname
      from pg_constraint c
     where c.conrelid = to_regclass('pilot.one_percent_nominations')
       and c.confrelid = to_regclass('pilot.athletes')
       and c.contype = 'f'
       and c.confdeltype <> 'c'
  loop
    execute format(
      'alter table pilot.one_percent_nominations drop constraint %I', fk.conname);
  end loop;

  if not exists (
    select 1 from pg_constraint
     where conname = 'pilot_one_percent_nominations_athlete_fk'
       and conrelid = to_regclass('pilot.one_percent_nominations')
  ) then
    alter table pilot.one_percent_nominations
      add constraint pilot_one_percent_nominations_athlete_fk
      foreign key (organization_id, athlete_id)
      references pilot.athletes(organization_id, athlete_id)
      on delete cascade;
  end if;
end
$pilot_one_percent_nominations_athlete_fk$;

comment on constraint pilot_one_percent_nominations_athlete_fk on pilot.one_percent_nominations is
  'ON DELETE CASCADE: a nomination is deleted with the athlete it names (owner decision OD-2026-08-29-007). It fires only when the pilot.athletes row itself is deleted, which the two-year retention purge does; a nomination whose athlete is still enrolled is untouched.';
