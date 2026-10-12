-- Round timers (pilot.round_timers): the boxing round clock for a live session
-- run, shown on the gym TV and driven from any staff screen allowed to run that
-- session (WO-N1-03, issue #1460; build plan OD-2026-10-08-012).
--
-- WHY THIS EXISTS. pilot.session_script_runs already owns the SESSION clock
-- (started_at, paused_at, paused_seconds; session_run_state migration). A round
-- clock is a second, independent clock inside that session: rounds of work and
-- rest, started, paused and ended by the coach while the session runs on. It
-- cannot live in the browser, because a TV that reloads and a second coach's
-- phone must read the same round, so it is stored here.
--
-- ONE TIMER PER RUN. The primary key is the run. Every TV showing a run shows
-- that run's timer, and two TVs in one session cannot disagree.
--
-- THE SERVER OWNS THE CLOCK. Only the configuration and the start, pause and
-- end instants are stored. The current round, work or rest, and the seconds
-- left are derived from started_at, paused_seconds and the configuration at
-- read time, never written by a client, exactly as the run's own elapsed time
-- is.
--
-- A TIMER STARTS ONLY ON A COACH'S START (N1-03-Q1 default A). A row is
-- written as 'ready' with no start time; nothing here starts it.
--
-- THE STATE AND ITS TIMES AGREE. ready has no start, no pause and no end;
-- running has a start and no pause or end; paused has a start and a pause;
-- ended has an end and no pause. A crashed writer cannot leave a row that
-- reads as two of these.
--
-- IT LEAVES WITH ITS RUN. The run foreign key cascades; nothing else deletes a
-- timer. Taking a run off a TV clears the TV's pointer only (gymTvs.ts) and
-- leaves the run and its timer as they were.
--
-- DEPENDS ON pilot.session_script_runs (session-scripts, session-run-state) and
-- pilot.accounts, both earlier in apply-migrations.yml's `all` list.
-- No `begin;`/`commit;` here on purpose: the runner
-- (apps/web/scripts/pilot-apply-round-timers-migration.mjs) opens the
-- transaction itself. Idempotent: create ... if not exists.

create table if not exists pilot.round_timers (
  organization_id           text not null references pilot.organizations(organization_id) on delete cascade,
  run_id                    text not null,
  round_seconds             integer not null
    constraint pilot_round_timers_round_seconds_check check (round_seconds between 1 and 3600),
  rest_seconds              integer not null
    constraint pilot_round_timers_rest_seconds_check check (rest_seconds between 0 and 3600),
  rounds_total              integer not null
    constraint pilot_round_timers_rounds_total_check check (rounds_total between 1 and 100),
  state                     text not null
    constraint pilot_round_timers_state_check check (state in ('ready', 'running', 'paused', 'ended')),
  started_at                timestamptz null,
  paused_at                 timestamptz null,
  paused_seconds            integer not null default 0
    constraint pilot_round_timers_paused_seconds_check check (paused_seconds >= 0),
  ended_at                  timestamptz null,
  configured_by_account_id  text not null references pilot.accounts(account_id),
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  constraint pilot_round_timers_pkey primary key (organization_id, run_id),
  constraint pilot_round_timers_run_fk
    foreign key (organization_id, run_id)
    references pilot.session_script_runs(organization_id, run_id)
    on delete cascade,
  constraint pilot_round_timers_state_times_check check (
    (state = 'ready' and started_at is null and paused_at is null and ended_at is null)
    or (state = 'running' and started_at is not null and paused_at is null and ended_at is null)
    or (state = 'paused' and started_at is not null and paused_at is not null and ended_at is null)
    or (state = 'ended' and paused_at is null and ended_at is not null)
  ),
  constraint pilot_round_timers_end_after_start_check check (
    ended_at is null or started_at is null or ended_at >= started_at
  )
);

comment on table pilot.round_timers is
  'One round clock per live session run (WO-N1-03): configuration plus start, pause and end instants. Current round, phase and seconds left are derived on the server at read time. Leaves only with its run.';
