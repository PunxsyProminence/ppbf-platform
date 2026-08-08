-- Assessment protocols, scheduling, dual retest triggers, and the coach-
-- facing capture prompt queue -- P-03.
--
-- WHAT pilot.assessments HELD BEFORE THIS: (organization_id, assessment_id,
-- athlete_id, assessor_account_id, assessment_type, result, created_at,
-- updated_at). A result with no protocol, no version, no schedule, and no
-- link to the administration it should be compared against.
--
-- INTERVALS ARE DERIVED FROM SENSITIVITY TO CHANGE, NOT FROM A CALENDAR.
-- Re-testing CMJ every two weeks produces measurement error that reads as
-- improvement. The battery's intervals are per-test for that reason and
-- the scheduler inherits them rather than imposing its own.
--
-- TWO TRIGGERS, DELIBERATELY. A test may be due by ELAPSED TIME or by
-- ACCUMULATED TRAINING HOURS, and the two can disagree -- an athlete
-- training six days a week reaches a training-hours threshold long before
-- a calendar one, and an athlete who stopped attending reaches neither.
-- Both are recorded so the disagreement is visible rather than resolved
-- silently: one may show improvement while the other shows regression, and
-- that divergence is information.
--
-- pilot.assessments is EXTENDED, not replaced. Every column added is
-- nullable or has a safe default; nothing existing changes meaning.
--
-- DEPENDS ON pilot.organizations, pilot.accounts, pilot.athletes,
-- pilot.assessments (existing). No begin;/commit; here on purpose, matching
-- this repo's runner-opens-the-transaction convention (the runner is
-- apps/web/scripts/pilot-apply-assessment-protocols-migration.mjs).

create table if not exists pilot.assessment_protocols (
  organization_id        text not null references pilot.organizations(organization_id) on delete cascade,
  protocol_id            text not null,
  protocol_version       integer not null default 1,
  name                   text not null,
  measure_kind           text not null check (measure_kind in ('physical_test','skill_rubric',
                                                               'wellness','questionnaire','other')),
  source_ref             text null,          -- e.g. 'A5-T01' or 'rubric_id'
  quality_measured       text not null,
  protocol_summary       text not null,
  equipment_needed       text not null default '',
  time_to_administer_min integer null,
  -- Retest guidance, both forms. NULL means the research gave no
  -- defensible interval.
  retest_interval_days        integer null check (retest_interval_days is null or retest_interval_days > 0),
  retest_after_training_hours numeric null check (retest_after_training_hours is null or retest_after_training_hours > 0),
  retest_interval_basis  text not null default 'TBD - no defensible basis',
  -- Measurement properties, carried so a result is never read without
  -- them.
  reliability_status     text not null default 'UNVALIDATED - PPBF MUST ESTABLISH',
  validity_status        text not null default 'UNKNOWN',
  evidence_class         text not null default 'INSUFFICIENT EVIDENCE',
  boxing_specific        text not null default 'NO - transferred',
  minimal_detectable_change numeric null,     -- null until the reliability study supplies it
  human_authority_required boolean not null default true,
  active                 boolean not null default true,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint pilot_assessment_protocols_pkey primary key (organization_id, protocol_id, protocol_version)
);

create unique index if not exists pilot_assessment_protocols_one_active_name
  on pilot.assessment_protocols(organization_id, name) where active;

-- Extend the existing results table. Additive only; nothing existing
-- changes meaning.
alter table pilot.assessments add column if not exists protocol_id text null;
alter table pilot.assessments add column if not exists protocol_version integer null;
alter table pilot.assessments add column if not exists administration_kind text null;
alter table pilot.assessments add column if not exists due_on date null;
alter table pilot.assessments add column if not exists administered_on date null;
alter table pilot.assessments add column if not exists retest_of_assessment_id text null;
alter table pilot.assessments add column if not exists training_hours_at_administration numeric null;
alter table pilot.assessments add column if not exists assessor_role text null;
alter table pilot.assessments add column if not exists second_rater_account_id text null;
alter table pilot.assessments add column if not exists second_rater_result text null;
alter table pilot.assessments add column if not exists conditions_note text not null default '';

do $$
begin
  if not exists (select 1 from pg_constraint where conname='pilot_assessments_admin_kind_check'
                 and conrelid='pilot.assessments'::regclass) then
    alter table pilot.assessments add constraint pilot_assessments_admin_kind_check
      check (administration_kind is null or administration_kind in
             ('scheduled_interval','scheduled_training_hours','ad_hoc','baseline',
              'retention_test','transfer_test','reliability_study'));
  end if;
  if not exists (select 1 from pg_constraint where conname='pilot_assessments_protocol_fk'
                 and conrelid='pilot.assessments'::regclass) then
    alter table pilot.assessments add constraint pilot_assessments_protocol_fk
      foreign key (organization_id, protocol_id, protocol_version)
      references pilot.assessment_protocols(organization_id, protocol_id, protocol_version);
  end if;
end
$$;

-- second_rater_* exist to make the reliability study collect itself from
-- live use rather than requiring a separate research exercise. Two raters
-- scoring the same administration is the raw material for weighted kappa
-- and ICC. Populated opportunistically, not required.

create index if not exists pilot_assessments_due
  on pilot.assessments(organization_id, due_on) where administered_on is null;

-- ---------------------------------------------------------------------------
-- DATA COLLECTION REQUESTS -- the coach-facing prompt.
--
-- A due assessment that nobody is told about does not get done. This table
-- is what the app surfaces: a specific person, a specific thing to
-- capture, and the capture mode. The camera path matters because a coach
-- holding pads cannot type -- video and photo capture in one tap is the
-- difference between an observation recorded now and one reconstructed
-- hours later.

create table if not exists pilot.data_collection_requests (
  organization_id     text not null references pilot.organizations(organization_id) on delete cascade,
  request_id          text not null,
  athlete_id          text null,
  person_account_id   text null references pilot.accounts(account_id),
  request_kind        text not null check (request_kind in
                        ('observation','video','photo','physical_test','skill_rubric',
                         'wellness_check','document')),
  protocol_id         text null,
  protocol_version    integer null,
  prompt_text         text not null,
  reason_code         text not null,   -- why it is being asked: 'interval_due',
                                       -- 'training_hours_due', 'baseline_missing',
                                       -- 'coach_requested', 'reliability_second_rater'
  capture_hint        text not null default '',  -- what good capture looks like
  due_on              date null,
  priority            text not null default 'normal' check (priority in ('low','normal','high')),
  status              text not null default 'open'
                      check (status in ('open','captured','declined','expired')),
  captured_at         timestamptz null,
  captured_by_account_id text null references pilot.accounts(account_id) on delete set null,
  media_ref           text null,       -- blob path or video_session reference
  resulting_assessment_id text null,
  declined_reason     text null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint pilot_dcr_pkey primary key (organization_id, request_id),
  constraint pilot_dcr_athlete_fk foreign key (organization_id, athlete_id)
    references pilot.athletes(organization_id, athlete_id) on delete cascade,
  -- A request names a person one way or the other.
  constraint pilot_dcr_subject check (athlete_id is not null or person_account_id is not null),
  -- Captured means captured: a status change without evidence is not a
  -- capture.
  constraint pilot_dcr_captured check (status <> 'captured'
    or (captured_at is not null and captured_by_account_id is not null))
);

create index if not exists pilot_dcr_open_queue
  on pilot.data_collection_requests(organization_id, status, priority, due_on) where status = 'open';

comment on table pilot.assessment_protocols is
  'Assessment protocol catalog with dual retest triggers (elapsed time and accumulated training hours). Every reliability/validity field defaults to an explicit unvalidated state -- this platform does not fabricate measurement properties it has not established.';

comment on table pilot.data_collection_requests is
  'The coach-facing capture prompt queue. status=captured requires BOTH captured_at and captured_by_account_id -- a status change without evidence is not a capture.';
