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

-- ─── Scan bookkeeping (#49) ──────────────────────────────────────────────────
--
-- The correction above made quarantine-on-upload WORK. It did not give the
-- state an exit: no `update pilot.video_sessions` existed anywhere in the
-- repository -- verified across app/, src/, scripts/ and infra/*.sql -- so a
-- video that uploaded successfully entered a state nothing could leave, and
-- the Film Study chain (#126 acceptance gate, #128 executor) had no reachable
-- input. Measured 2026-08-01, immediately after the owner proved upload works.
--
-- These columns are what the scan sweep claims, records into, and settles.
-- They live on this migration rather than a new one because they describe the
-- same table and this file is already registered in apply-migrations.yml and
-- npm scripts; a separate migration would have added a third registration
-- surface for one ALTER.
--
-- `add column if not exists` is real PostgreSQL (unlike ADD CONSTRAINT IF NOT
-- EXISTS -- guardrails section 7), so these are plainly idempotent. Existing
-- rows land on scan_state 'pending' with scan_next_attempt_at now(), which is
-- exactly right: every video quarantined before this migration becomes
-- eligible for its first scan the next time the sweep runs.
alter table pilot.video_sessions
  add column if not exists scan_state text not null default 'pending';

-- Verdicts and gate names only. The content screen's prose about the footage
-- is never written here (videoScanSweep.ts), so this column cannot become a
-- description of a minor's video sitting in the database.
alter table pilot.video_sessions
  add column if not exists scan_detail jsonb not null default '{}'::jsonb;

alter table pilot.video_sessions
  add column if not exists scan_attempts integer not null default 0;

-- Set at claim, cleared at settle. A claim older than the sweep's staleness
-- window is taken over, so a worker that dies mid-scan cannot strand a video
-- in 'scanning' forever -- the failure mode the job queue's lease tokens
-- already guard against for jobs.
alter table pilot.video_sessions
  add column if not exists scan_claimed_at timestamptz null;

-- Retry backoff. Defender for Storage writes its verdict asynchronously and
-- takes its time; without this the attempt budget would be spent at worker
-- cadence within minutes and every upload would reach human review before the
-- scanner had answered.
alter table pilot.video_sessions
  add column if not exists scan_next_attempt_at timestamptz not null default now();

-- Set once, when a verdict is reached. Distinct from updated_at, which moves
-- on every retry.
alter table pilot.video_sessions
  add column if not exists scanned_at timestamptz null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'pilot.video_sessions'::regclass
      and conname = 'video_sessions_scan_state_check'
  ) then
    alter table pilot.video_sessions
      add constraint video_sessions_scan_state_check
      check (scan_state in (
        -- Eligible for a scan attempt (also where a retry returns to).
        'pending',
        -- Claimed by a worker.
        'scanning',
        -- Every enabled gate passed; status is 'ready'.
        'passed',
        -- A real scanner returned a malware hit; status is 'infected'.
        'infected',
        -- The content screen refused; status stays 'quarantined'.
        'blocked',
        -- Uncertain, or no verdict ever arrived; status stays 'quarantined'.
        'needs_human_review',
        -- No gate is configured in this environment, so no verdict is
        -- possible. Recorded rather than retried, so an unconfigured
        -- environment does not spin attempts against a scan that cannot run.
        'unconfigured'
      ));
  end if;
end
$$;

-- The sweep's claim query, and nothing else, drives this index: due rows
-- among the quarantined. Partial on status so it stays small -- promoted and
-- archived videos are the overwhelming majority once the platform has been
-- running, and none of them are ever scan candidates.
create index if not exists idx_video_sessions_scan_queue
  on pilot.video_sessions(scan_state, scan_next_attempt_at)
  where status = 'quarantined';
