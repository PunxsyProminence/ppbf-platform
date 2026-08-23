-- Session RPE semantics: let pilot.sessions.rpe mean session RPE, and make
-- every row state whether it does.
--
-- THE DEFECT. `rpe numeric not null` has one shipped writer: the athlete
-- check-in in apps/web/components/AthleteWorkspace.tsx, which sends
-- `rpe: readinessToTrain` -- the value of a pre-session "Readiness to Train"
-- slider that defaults to 8. Check-out then writes the same number back
-- unchanged; no post-session reading ever replaces it. So the column named for
-- session RPE holds, for every row the application has ever written, a
-- pre-session self-report of how ready somebody felt before training.
--
-- Session RPE is a different construct. It is perceived exertion across the
-- session that has finished, collected after it finishes. Two numbers on the
-- same 0-10 scale, measuring opposite ends of a session, are not
-- interchangeable, and nothing in the schema records which one a row holds.
--
-- WHY THIS MATTERS RATHER THAN BEING TIDINESS. The number is not inert.
-- performanceAnalytics.ts averages it into `avg_rpe` on
-- /coach/performance-analytics. TrainingCard.tsx renders it to the athlete as
-- "effort N of 10" and treats >= 8 as a hard session -- so a child who touched
-- nothing is told they trained at 8. It is one of the two inputs SHADOW's
-- Session Load formula multiplies (MVP-01, RPE x duration). A number that
-- looks like a measurement and is not is worse than an absent one, because
-- everything downstream is entitled to believe it.
--
-- WHAT THIS MIGRATION DOES. Two things, both additive.
--
-- 1. `rpe` becomes nullable, so "not collected yet" becomes expressible. It
--    was not, which is the whole reason a pre-session number was reached for:
--    the row had to carry SOME number at check-in, and readiness was the
--    number in hand. Nullability is what lets check-in write no RPE at all and
--    check-out write the real one. Without it the only alternatives are to
--    keep laundering readiness or to invent a placeholder, and
--    docs/AI_CONTRIBUTOR_GUARDRAILS.md section 3 forbids fabricated numbers.
--
-- 2. `rpe_method` records what produced the number, in the shape
--    pilot.readiness already uses. Without it the fix does not actually work:
--    a corrected post-session reading and a laundered pre-session readiness
--    are the same numeric on the same scale in the same column, so `avg(rpe)`
--    would go on averaging them together forever. The method column is what
--    lets a reader tell them apart.
--
-- HONEST BACKFILL. Existing rows record method 'UNKNOWN'. That is the true
-- answer and it is the same answer
-- pilot_slice_postgres_readiness_provenance_migration.sql gave for the same
-- reason: the write path never recorded provenance, so it cannot be recovered
-- now, and stamping a confident label during a migration would be the exact
-- fabrication this change exists to end. NO EXISTING VALUE IS ALTERED. Every
-- rpe reading that is in this table stays exactly as it is, including the
-- readiness values; this migration only adds a column that states, truthfully,
-- that nobody recorded where they came from. Deciding what to do about those
-- rows is a separate question and is not answered here.
--
-- THE VOCABULARY IS DELIBERATELY NARROW. 'UNKNOWN' and
-- 'athlete_post_session_self_report' are the only two honest values today: one
-- for every row that predates this column, one for the corrected check-out
-- path. A coach-entered RPE does not exist in the application -- CoachWorkspace
-- only reads the column -- so no value is minted for it here. A future writer
-- must widen this list in its own migration, which is the point: it forces the
-- decision to be recorded rather than absorbed silently.
--
-- NOT DONE HERE, DELIBERATELY:
--   * No readiness formula or threshold is invented, adjusted or retired.
--     LEGACY-READINESS stays unwired (docs/capabilities/GATES.md, "LIVE as an
--     absence -- and must stay that way").
--   * No new SHADOW observation kind is created for readiness. Adding one
--     would build the input stream for a capability the owner parked
--     (docs/capabilities/NETWORK_STATUS.md, "Parked by owner decision"), and
--     the handoff that requested this work conditions such a contract on
--     approval that does not exist.
--   * No 0-10 CHECK constraint is added to `rpe`, though pilot.activity_log
--     carries one on its own rpe column. Existing rows have never been
--     range-validated by any write path, so a CHECK could fail against real
--     data. That is a separate, measurable question.
--   * No historical row is corrected, deleted or backfilled with a real value.
--
-- Idempotent: nullability drop is a no-op when already nullable, add column if
-- not exists, catalog-guarded constraint, no drops of data, no destructive
-- alters.
-- No begin;/commit; here on purpose, matching this repo's
-- runner-opens-the-transaction convention (the runner is
-- apps/web/scripts/pilot-apply-session-rpe-semantics-migration.mjs).

-- "Not collected yet" becomes sayable. This is the load-bearing line: while
-- rpe was NOT NULL, check-in could not create a session row without producing
-- a number it did not have.
alter table pilot.sessions
  alter column rpe drop not null;

-- What produced this reading. 'UNKNOWN' is a real, permitted value and is what
-- every pre-existing row carries.
alter table pilot.sessions
  add column if not exists rpe_method text not null default 'UNKNOWN';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'pilot_sessions_rpe_method_check'
      and conrelid = to_regclass('pilot.sessions')
  ) then
    alter table pilot.sessions add constraint pilot_sessions_rpe_method_check
      check (rpe_method in ('UNKNOWN', 'athlete_post_session_self_report'));
  end if;
end
$$;

-- A row with no reading must not claim a method for one. This is what stops an
-- open check-in row -- rpe still NULL, because the session has not finished --
-- from asserting a provenance it has not earned. The converse is deliberately
-- NOT constrained: a row may carry a reading whose method is 'UNKNOWN',
-- because that is the honest description of every row already in the table and
-- of anything the CSV seeder writes.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'pilot_sessions_rpe_method_agrees_with_value'
      and conrelid = to_regclass('pilot.sessions')
  ) then
    alter table pilot.sessions add constraint pilot_sessions_rpe_method_agrees_with_value
      check (
        (rpe is null and rpe_method = 'UNKNOWN')
        or (rpe is not null)
      );
  end if;
end
$$;

-- The default exists ONLY so the column can be added to a table that already
-- has rows. Dropping it is what makes the not-null constraint bite: after
-- this, an insert that omits `rpe_method` fails rather than quietly claiming
-- 'UNKNOWN' on a row whose provenance the writer actually knew.
alter table pilot.sessions
  alter column rpe_method drop default;

comment on column pilot.sessions.rpe is
  'Session RPE: perceived exertion across the COMPLETED session, collected after it ends. NULL means not collected yet, which is the correct state between check-in and check-out. Read it only together with rpe_method -- rows predating that column hold a pre-session readiness value, not a session RPE.';

comment on column pilot.sessions.rpe_method is
  'What produced the rpe reading. UNKNOWN means provenance was never recorded, which is every row predating this column; those rows hold a pre-session "Readiness to Train" value that the check-in flow wrote into the rpe field. Not defaulted: an insert must state it.';
