-- Video sessions (pilot.video_sessions) -- promoting a route-created table
-- into the migration path.
--
-- This table has no migration. Its ONLY definition anywhere in the repository
-- is inside apps/web/app/api/pilot/admin/migrate-multiorg/route.ts: a 938-line
-- HTTP handler carrying 125 DDL statements. So pilot.video_sessions exists in
-- an environment if and only if somebody once POSTed to that route there --
-- which makes the video feature's existence a property of deploy history
-- rather than of the schema, and leaves no way to tell from the repository
-- whether staging and production actually have it.
--
-- That route is bootstrap-key protected, so this is NOT the anonymous-DDL
-- exposure that pilot.announcements had (#111). It is the same ownership
-- problem one step less severe: a schema path running outside the
-- apply-migrations workflow, which guardrails section 7 makes the single way
-- schema changes reach an environment.
--
-- The shape below is copied from that runtime DDL -- with ONE deliberate
-- correction, described next -- so applying this where the table already
-- exists is a no-op apart from that correction. No data is read or dropped.
-- Both indexes are included because the runtime DDL created both: an
-- environment that got the table from the route but never the indexes would
-- otherwise pass a table-only readiness check while /api/pilot/video/list
-- stayed unindexed.
--
-- THE CORRECTION -- the status CHECK forbade the value the app writes, so
-- video upload failed 100% of the time. The route inserts
-- status = 'quarantined' (apps/web/app/api/pilot/video/upload/route.ts), and
-- the read path treats 'infected' as a non-servable state, but the route's
-- own CHECK allowed only ('uploaded','processing','ready','error',
-- 'archived'). Measured 2026-07-31 against embedded Postgres: that INSERT
-- fails with `new row for relation "video_sessions" violates check
-- constraint "video_sessions_status_check"`. Every upload, always -- the same
-- shape of defect as the volunteers feature (#113), which had also never
-- worked once in production.
--
-- The schema is what is stale here, not the code. Quarantine-on-upload is the
-- platform's deliberate safety posture for uploaded media -- the same stance
-- intake documents take by being born `pending_security_review` -- and video
-- of minors warrants at least that. So the allowed set gains 'quarantined'
-- and 'infected' rather than the route being downgraded to a state that
-- claims a file is safe before anything has checked it.
--
-- Codifying the old list would have cemented a total-failure bug into the
-- migration path, which is the opposite of what promoting a table into that
-- path is for.
--
-- Deliberately NOT changed here (the shape is copied, warts and all, because
-- a migration that "improves" a live table is a redefinition, not a no-op):
--   * organization_id has no foreign key to pilot.organizations, unlike every
--     other multi-org table.
--   * uploaded_by_account_id has no foreign key to pilot.accounts.
--   * athlete_id has no composite foreign key to pilot.athletes.
-- Adding those is a separate, data-dependent migration: it requires knowing
-- whether existing rows would violate them. The multiorg-orphans check
-- (check-database.yml) is the tool for finding that out first.
--
-- No `begin;`/`commit;` here on purpose: the runner
-- (apps/web/scripts/pilot-apply-video-sessions-migration.mjs) opens the
-- transaction itself, matching the announcements / public-interest /
-- scheduler-tables convention. The shadow-runtime runner takes the opposite
-- convention; putting boundaries in a file whose runner also opens one is what
-- took down every migration in that set (#107).

create table if not exists pilot.video_sessions (
  video_session_id text primary key,
  organization_id text not null,
  uploaded_by_account_id text not null,
  athlete_id text null,
  title text not null,
  notes text not null default '',
  blob_path text not null,
  file_name text not null,
  file_size_bytes bigint not null,
  mime_type text not null,
  status text not null default 'quarantined'
    check (status in ('uploaded', 'quarantined', 'infected', 'processing', 'ready', 'error', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_video_sessions_org_created
  on pilot.video_sessions(organization_id, created_at desc);

create index if not exists idx_video_sessions_athlete
  on pilot.video_sessions(organization_id, athlete_id, created_at desc);

-- Environments that already got the table from the route still carry the old
-- CHECK, and `create table if not exists` above is a no-op for them -- so the
-- constraint has to be replaced explicitly or uploads keep failing there.
--
-- PostgreSQL has no ADD CONSTRAINT IF NOT EXISTS (guardrails section 7), so
-- this is catalog-guarded, matching the DO-block pattern in
-- pilot_slice_postgres_multiorg_migration.sql. Both branches are idempotent:
-- re-running finds the constraint already correct and does nothing.
do $$
begin
  -- Drop only a STALE constraint -- one that does not already admit
  -- 'quarantined'. A correct constraint is left untouched, so this does not
  -- churn the table on every re-run.
  if exists (
    select 1
    from pg_constraint
    where conrelid = 'pilot.video_sessions'::regclass
      and conname = 'video_sessions_status_check'
      and pg_get_constraintdef(oid) not like '%quarantined%'
  ) then
    alter table pilot.video_sessions
      drop constraint video_sessions_status_check;
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'pilot.video_sessions'::regclass
      and conname = 'video_sessions_status_check'
  ) then
    alter table pilot.video_sessions
      add constraint video_sessions_status_check
      check (status in ('uploaded', 'quarantined', 'infected', 'processing', 'ready', 'error', 'archived'));
  end if;
end
$$;

-- The default follows the same reasoning: a row that arrives without an
-- explicit status is safest treated as awaiting scan, never as 'uploaded'
-- (which the read path is one step away from serving). Applied separately
-- because the create-table default above does not reach an existing table.
alter table pilot.video_sessions
  alter column status set default 'quarantined';
