-- Athlete self-report measures, pass 2 (lane L58).
--
-- WHAT JASON RULED (2026-10-18 question cards, after the research draft
-- BASELINE-METRICS-2026-10-18.md): add "Mood + stress (Rec.)", "Sleep hours
-- (Rec.)", "Session effort (Rec.)" with a session-type tag, a "Sparring
-- symptom flag (Rec.)" that is a FLAG only, and cycle tracking "C: Now".
-- Recipient of the flag: "A: Their coach (Rec.)"; the gym's written protocol:
-- "A: Not yet, leave blank (Rec.)".
--
-- WHAT WAS ALREADY THERE, SO IS NOT ADDED. Sleep hours is
-- pilot.athlete_check_ins.sleep_hours and stress is .stress (both
-- pilot_slice_postgres_athlete_check_in_measures_migration.sql). Session
-- effort is pilot.sessions.rpe + rpe_method + duration_minutes, written at
-- check-out. Nothing here touches those columns or any stored value.
--
-- WHAT THIS ADDS. Additive only: no drop of data, no altered value.
--   1. pilot.athlete_check_ins.mood -- 1-5 self-report, higher is better.
--   2. pilot.sessions.session_type -- the athlete's tag on their own session.
--   3. pilot.organization_symptom_flag_settings -- the gym's own protocol
--      words shown under the fixed message. No row means none (Jason: "Not
--      yet, leave blank"). Who receives a flag is not a setting: Jason ruled
--      "Their coach", so the filing code sends it to the athlete's coach.
--   4. pilot.sparring_symptom_reports -- what an athlete ticked after
--      sparring. A FLAG, not a score: there is no total, no severity and no
--      column that could hold one. A tick is never taken back off a report.
--   5. 'sparring_symptom' as a pilot.safety_escalations source_type, so a
--      ticked report reaches staff on the existing escalation ladder.
--   6. pilot.athlete_cycle_tracking + pilot.athlete_cycle_entries -- opt-in,
--      athlete-only period start dates (section 6 below).
--
-- Every athlete row here cascades with pilot.athletes, so the retention purge
-- (scripts/pilot-cleanup-deleted-data.mjs) deletes it with the athlete.
-- Nothing here is de-identified or kept after the athlete is purged.
--
-- Idempotent: create/add if not exists, catalog-guarded constraints.
-- No begin;/commit; here on purpose: the runner
-- (apps/web/scripts/pilot-apply-athlete-self-report-measures-migration.mjs)
-- opens the transaction itself.

-- ---------------------------------------------------------------------------
-- 1. MOOD. Same 1-5 scale as the other check-in self-reports; what each
-- number means lives in apps/web/src/shared/wellnessScales.ts. NULL is "not
-- reported", never a default.

alter table pilot.athlete_check_ins
  add column if not exists mood integer null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'pilot_athlete_check_ins_mood_check'
      and conrelid = to_regclass('pilot.athlete_check_ins')
  ) then
    alter table pilot.athlete_check_ins
      add constraint pilot_athlete_check_ins_mood_check
      check (mood is null or mood between 1 and 5);
  end if;
end
$$;

comment on column pilot.athlete_check_ins.mood is
  'Athlete self-report, 1-5, higher is better. Anchors in apps/web/src/shared/wellnessScales.ts. NULL means not reported: never 0, never a default.';

-- ---------------------------------------------------------------------------
-- 2. SESSION TYPE. What kind of session the athlete says it was, picked at
-- check-out beside the effort answer, so a hard sparring night and a
-- technique night are not read as the same load. Optional: NULL is "not
-- said". Existing rows stay NULL; nothing is inferred for them.

alter table pilot.sessions
  add column if not exists session_type text null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'pilot_sessions_session_type_check'
      and conrelid = to_regclass('pilot.sessions')
  ) then
    alter table pilot.sessions
      add constraint pilot_sessions_session_type_check
      check (session_type is null or session_type in
        ('technique', 'bag_pads', 'conditioning', 'sparring', 'mixed', 'other'));
  end if;
end
$$;

comment on column pilot.sessions.session_type is
  'The athlete''s own tag for the session, set at check-out: technique, bag_pads, conditioning, sparring, mixed or other. NULL means not said.';

-- ---------------------------------------------------------------------------
-- 3. SYMPTOM FLAG SETTINGS, one row per gym: the gym's own protocol words,
-- shown to the athlete under the fixed message; '' means the gym has not
-- written one (Jason: "Not yet, leave blank"). Kept out of
-- pilot.organization_profiles on purpose: that table is the gym's public
-- identity, and this is safety guidance. There is deliberately no recipient
-- column: Jason ruled the flag goes to "Their coach", and a setting would let
-- a gym route it away from the coach.

create table if not exists pilot.organization_symptom_flag_settings (
  organization_id text not null,
  protocol_text   text not null default '',
  updated_at      timestamptz not null default now(),
  constraint pilot_org_symptom_flag_settings_pkey primary key (organization_id),
  constraint pilot_org_symptom_flag_settings_org_fk foreign key (organization_id)
    references pilot.organizations (organization_id) on delete cascade,
  constraint pilot_org_symptom_flag_settings_not_platform_check
    check (organization_id <> '__platform__'),
  constraint pilot_org_symptom_flag_settings_protocol_check
    check (char_length(protocol_text) <= 1000)
);

comment on table pilot.organization_symptom_flag_settings is
  'The gym''s own protocol words for a sparring symptom flag, shown under the fixed message. No row or blank = none written.';

-- ---------------------------------------------------------------------------
-- 4. SPARRING SYMPTOM REPORTS. What an athlete ticked after sparring
-- (context 'after_sparring', at check-out) or the next day ('next_day', on
-- "How I feel today"). An empty list is a real answer ("None of these").
--
-- A FLAG, NOT A SCORE. The list is stored as the athlete ticked it and is
-- never totalled: no count column, no severity, no derived field. A report
-- with anything ticked files a pilot.safety_escalations row whose source_id
-- is this report_id; that is how the two are joined, so there is no
-- escalation column here to fall out of step. (That table requires a
-- severity; the filing code uses one fixed value, never one derived from
-- what was ticked.)
--
-- One report per athlete, per gym day, per context: a second submission the
-- same day adds to the same report. WHAT A CHILD TICKED IS KEPT: the guard
-- below refuses any update that takes a tick back off, or that changes whose
-- report it is, which day, or which context. Deletes are not guarded, so the
-- report still goes with the athlete.

create table if not exists pilot.sparring_symptom_reports (
  organization_id text not null,
  report_id       text not null,
  athlete_id      text not null,
  reported_on     date not null,
  context         text not null,
  symptoms        text[] not null default '{}',
  created_at      timestamptz not null default now(),
  constraint pilot_sparring_symptom_reports_pkey primary key (organization_id, report_id),
  constraint pilot_sparring_symptom_reports_athlete_fk foreign key (organization_id, athlete_id)
    references pilot.athletes (organization_id, athlete_id) on delete cascade,
  constraint pilot_sparring_symptom_reports_context_check
    check (context in ('after_sparring', 'next_day')),
  constraint pilot_sparring_symptom_reports_symptoms_check
    check (
      array_position(symptoms, null) is null
      and symptoms <@ array['headache', 'dizzy', 'nausea', 'foggy', 'vision', 'ringing', 'hard_head_shot']::text[]
    ),
  constraint pilot_sparring_symptom_reports_one_per_day
    unique (organization_id, athlete_id, reported_on, context)
);

create or replace function pilot.sparring_symptom_reports_guard()
returns trigger
language plpgsql
as $$
begin
  if new.organization_id is distinct from old.organization_id
     or new.report_id is distinct from old.report_id
     or new.athlete_id is distinct from old.athlete_id
     or new.reported_on is distinct from old.reported_on
     or new.context is distinct from old.context
     or new.created_at is distinct from old.created_at then
    raise exception 'A sparring symptom report keeps whose it is, its day and its context.'
      using errcode = '23514', constraint = 'pilot_sparring_symptom_reports_identity_kept';
  end if;
  if not (new.symptoms @> old.symptoms) then
    raise exception 'A ticked symptom is never taken back off a report.'
      using errcode = '23514', constraint = 'pilot_sparring_symptom_reports_ticks_kept';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_sparring_symptom_reports_guard on pilot.sparring_symptom_reports;
create trigger trg_sparring_symptom_reports_guard
  before update on pilot.sparring_symptom_reports
  for each row execute function pilot.sparring_symptom_reports_guard();

comment on table pilot.sparring_symptom_reports is
  'What an athlete ticked after sparring. A flag, never a score: no total, no severity. A report with anything ticked has one pilot.safety_escalations row with source_type sparring_symptom and source_id = report_id.';

-- ---------------------------------------------------------------------------
-- 5. 'sparring_symptom' ON THE ESCALATION LADDER. The same catalog-guarded
-- widening pilot_slice_postgres_safety_escalations_migration.sql performs,
-- carried here so this one file is the one run that makes the flag work. That
-- file and the base schema carry the same list, so re-running either keeps
-- 'sparring_symptom' rather than narrowing it back.

-- EVERY stale vocabulary check is replaced, not just the first one found: a
-- second narrower check left in place would refuse every symptom escalation,
-- and the filing code's failure would be the only trace.
do $$
declare
  stale record;
begin
  for stale in
    select conname
    from pg_constraint
    where conrelid = to_regclass('pilot.safety_escalations')
      and contype = 'c'
      and pg_get_constraintdef(oid) like '%source_type%'
      and pg_get_constraintdef(oid) like '%''near_miss''%'
      and pg_get_constraintdef(oid) not like '%''sparring_symptom''%'
  loop
    execute format('alter table pilot.safety_escalations drop constraint %I', stale.conname);
  end loop;

  if to_regclass('pilot.safety_escalations') is not null and not exists (
    select 1 from pg_constraint
    where conrelid = to_regclass('pilot.safety_escalations')
      and conname = 'safety_escalations_source_type_check'
  ) then
    alter table pilot.safety_escalations
      add constraint safety_escalations_source_type_check
      check (source_type in ('near_miss', 'pain_report', 'safety_gate_evaluation', 'repeated_pattern', 'athlete_voice', 'training_hold', 'incident', 'video_scan', 'compliance_violation', 'shadow_disclosure', 'sparring_symptom'));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 6. CYCLE TRACKING -- MINORS' HEALTH DATA, ATHLETE-ONLY.
--
-- Jason chose "C: Now". Because this is a child's health data, the rule this
-- schema is built to hold: opt-in by the athlete; readable ONLY by that
-- athlete; never shown to coaches, parents, staff or the gym TV; never used to
-- change training; never sent to SHADOW; deleted with the athlete. Any wider
-- sharing needs a separate ruling from Jason.
--
-- NO ENTRY WITHOUT AN OPT-IN ROW. An entry's foreign key points at the
-- athlete's tracking row, not at the athlete, so no entry can exist without
-- one, and turning tracking off (deleting that row) deletes every entry with
-- it. That the athlete is the one who made the row is the application's job:
-- only the athlete's own route writes either table. The tracking row cascades
-- with pilot.athletes, so the purge removes both.
--
-- Nothing here is derived: no cycle length, no phase, no prediction column.

create table if not exists pilot.athlete_cycle_tracking (
  organization_id text not null,
  athlete_id      text not null,
  opted_in_at     timestamptz not null default now(),
  constraint pilot_athlete_cycle_tracking_pkey primary key (organization_id, athlete_id),
  constraint pilot_athlete_cycle_tracking_athlete_fk foreign key (organization_id, athlete_id)
    references pilot.athletes (organization_id, athlete_id) on delete cascade
);

create table if not exists pilot.athlete_cycle_entries (
  organization_id   text not null,
  entry_id          text not null,
  athlete_id        text not null,
  period_started_on date not null,
  created_at        timestamptz not null default now(),
  constraint pilot_athlete_cycle_entries_pkey primary key (organization_id, entry_id),
  constraint pilot_athlete_cycle_entries_tracking_fk foreign key (organization_id, athlete_id)
    references pilot.athlete_cycle_tracking (organization_id, athlete_id) on delete cascade,
  constraint pilot_athlete_cycle_entries_one_per_day
    unique (organization_id, athlete_id, period_started_on)
);

comment on table pilot.athlete_cycle_tracking is
  'Athlete opt-in to cycle tracking. Minors'' health data: readable only by the athlete; never coaches, parents, staff, the gym TV or SHADOW; never changes training. Deleting this row deletes every entry.';

comment on table pilot.athlete_cycle_entries is
  'Days an athlete logged their period starting. Athlete-only (see pilot.athlete_cycle_tracking). Requires the opt-in row; deleted with it and with the athlete.';
