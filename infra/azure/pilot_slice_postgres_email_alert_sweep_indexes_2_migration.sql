-- Indexes for the email alert sweep's reads by time, second part (lane W4-1,
-- EM-IX-2).
--
-- WHAT WAS MISSING. EM-IX (pilot_slice_postgres_email_alert_sweep_indexes_migration.sql)
-- indexed the two tables EM-4a's sources read. EM-4b's and EM-4c's sources
-- read two more tables the same way, for the rows created since the source's
-- checkpoint less the sweep's ten-minute overlap: `created_at > <from> and
-- created_at <= <to>` (the predicate is in emailAlertEvents.ts, lines 191,
-- 219 and 395, on main since EM-4b, #2193, and EM-4c, #2217; emailAlertQueue.ts
-- computes the window):
--   - EM-4b's coach_message source (a coach's message to an athlete) and its
--     family_note source (a coach's message to a family) read
--     pilot.coach_observations;
--   - EM-4c's guardian_message source (a guardian's post in a family thread)
--     reads pilot.family_thread_posts.
-- Neither table has an index that starts with created_at:
--   - pilot.coach_observations has its primary key (organization_id,
--     note_id) and idx_pilot_coach_observations_org_athlete (organization_id,
--     athlete_id, created_at desc) (pilot_slice_postgres.sql), and
--     uq_pilot_coach_observations_org_note_athlete (organization_id, note_id,
--     athlete_id) (the family-message-replies and family-message-reads
--     migrations);
--   - pilot.family_thread_posts has its primary key (organization_id,
--     post_id), its unique key (organization_id, post_id, athlete_id), and
--     idx_family_thread_posts_thread (organization_id, thread_id, created_at),
--     idx_family_thread_posts_athlete (organization_id, athlete_id,
--     created_at) and idx_family_thread_posts_author (author_account_id,
--     organization_id) (pilot_slice_postgres_family_threads_migration.sql).
-- That is the shape EM-IX fixed on the other two tables (its header records
-- what EM-4a's reviewer measured there). These two reads have not been
-- measured at any real size; this file claims no numbers for them.
--
-- family_thread_posts.created_at is not left to its column default: the
-- table's guard trigger sets it to clock_timestamp() on every insert, whatever
-- the caller sends, so a post's time is the database clock at the moment of
-- the write, which is what the window compares. The index is on the column as
-- stored; the trigger is not touched.
--
-- WHAT THIS DOES. One b-tree on created_at for each table, so the sweep reads
-- only the rows in its window. Additive only: no table altered, no column
-- added, no row touched, nothing dropped. App Overwatch on #2159, comment
-- 7182891878: "Add the third index in its own index-only migration
-- ("EM-IX-2"), on the same pattern as EM-IX: runner, registration lines, a pg
-- test, no data change. It serves coach_message now and family_note later."
-- Comment 7187050078: "EM-IX-2 also indexes pilot.family_thread_posts
-- (created_at). That makes two indexes in the one index-only migration, with
-- one runner and one pg test." and "An index on W4-4's table adds no column
-- and changes no data."
--
-- FORM. Plain `create index`, not CONCURRENTLY, as EM-IX: this runner, like
-- EM-IX's, applies the file inside one BEGIN/COMMIT, and PostgreSQL refuses
-- CREATE INDEX CONCURRENTLY inside a transaction block. Each build takes a
-- SHARE lock on its table, and both locks are held until the one COMMIT:
-- reads continue, writes wait. `if not exists` does not avoid the lock, so a
-- re-run under `all` takes it too. The runner sets lock_timeout to 10
-- seconds, which limits each lock wait on its own. Behind a long write
-- already open on a table, the runner waits for that table's lock, and new
-- writes to that table queue behind the runner for as long as it waits. So:
--   - the family thread posts index is built first. New family thread posts
--     (a guardian's message, familyThreads.ts startFamilyThread and
--     writeAgainInFamilyThread; a staff reply, replyInFamilyThread) are held
--     from the moment the runner starts waiting for that table until COMMIT:
--     through that wait and build, and then through the wait for
--     pilot.coach_observations and its build;
--   - new coach notes (createCoachObservation, intake.ts) are held only from
--     the moment the runner starts waiting for pilot.coach_observations until
--     COMMIT: that wait and that build;
--   - a wait that reaches 10 seconds fails the runner with 55P03 and rolls
--     everything back, and the operator re-runs in a quieter moment.
-- The worst case for a new family thread post is therefore about 20 seconds
-- of waiting plus both builds. The tables' production row counts are not
-- known from the repository, so neither are the build times.
--
-- Idempotent: `if not exists` makes a re-run under `all` a no-op for the
-- schema, though it still takes the locks, as FORM says. The release
-- workflow re-runs every migration in `all` (release-one-approval.yml). A
-- re-run that times out behind a long write rolls back and leaves the
-- indexes as they were; the runner exits 1, which fails that release run at
-- this slug, after every migration before it in `all` has committed. A retry
-- is safe: the re-run changed nothing. Depends on the base schema
-- (pilot.coach_observations) and the family-threads migration
-- (pilot.family_thread_posts); the guard below names a missing table rather
-- than failing inside the create. No begin;/commit; here, matching the
-- runner-opens-the-transaction convention; the runner is
-- apps/web/scripts/pilot-apply-email-alert-sweep-indexes-2-migration.mjs.

do $pilot_email_alert_sweep_indexes_2$
begin
  if to_regclass('pilot.coach_observations') is null then
    -- No "--" inside the strings: pilot-verify-schema.mjs strips comments
    -- without regard to quotes and would eat the closing quote.
    raise exception 'EMAIL_ALERT_SWEEP_INDEXES_2_NOT_READY: pilot.coach_observations does not exist; apply the base schema first';
  end if;
  if to_regclass('pilot.family_thread_posts') is null then
    raise exception 'EMAIL_ALERT_SWEEP_INDEXES_2_NOT_READY: pilot.family_thread_posts does not exist; apply the family-threads migration first';
  end if;
end
$pilot_email_alert_sweep_indexes_2$;

-- Family thread posts first: see FORM above.
create index if not exists idx_pilot_family_thread_posts_created_at
  on pilot.family_thread_posts (created_at);

create index if not exists idx_pilot_coach_observations_created_at
  on pilot.coach_observations (created_at);
