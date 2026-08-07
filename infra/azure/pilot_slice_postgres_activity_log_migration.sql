-- Activity logging, sparring exposure -- P-01 / P-03.
--
-- SCOPE NOTE. This is deliberately NOT a boxing-only log. PPBF tracks hours
-- across activity domains that share one structure and one door: boxing
-- training, schoolwork and tutoring, gym service, community service
-- (including court-ordered), and college work-study. They differ in what
-- counts as a unit and who verifies it, not in shape. A single table with
-- a domain discriminator keeps one authoritative hours figure per person
-- per occurrence; separate tables per domain would recreate the exact
-- ambiguity this table exists to remove.
--
-- WHY THIS REPLACES TWO TABLES, WITHOUT TOUCHING EITHER OF THEM HERE.
-- pilot.attendance has no unique constraint of any kind -- unlimited
-- duplicate rows per athlete per day -- and pilot.scheduler_attendance is
-- class-scoped and properly constrained, but nothing declares which of the
-- two is authoritative. This migration does not drop or alter either: a
-- human has to decide which source wins on conflict before any backfill
-- runs, and that decision is not this migration's to make. The check-in
-- audit shape from scheduler_attendance (capture_method, recorded_by_role)
-- is carried forward here because who put a person on the floor is
-- safeguarding evidence, not metadata.
--
-- DURATION IS LOAD-BEARING. pilot.sessions holds rpe but no duration, so
-- session load (sRPE x duration) could not be computed at all before this.
-- duration_minutes here is what makes the RPE already being collected
-- usable.
--
-- DEPENDS ON pilot.organizations, pilot.accounts, pilot.athletes. No
-- begin;/commit; here on purpose, matching this repo's runner-opens-the-
-- transaction convention (the runner is
-- apps/web/scripts/pilot-apply-activity-log-migration.mjs).

create table if not exists pilot.activity_log (
  organization_id       text not null references pilot.organizations(organization_id) on delete cascade,
  activity_id           text not null,
  person_account_id     text not null references pilot.accounts(account_id),
  athlete_id            text null,               -- null when the person is not an athlete
  activity_domain       text not null,           -- boxing_training | schoolwork | gym_service |
                                                 -- community_service | work_study | other
  activity_type         text not null,           -- domain-specific: 'technical_session',
                                                 -- 'tutoring', 'equipment_maintenance', ...
  occurred_on           date not null,
  started_at            timestamptz null,
  duration_minutes      integer not null check (duration_minutes between 1 and 720),
  what_was_worked_on    text not null default '',-- free text; the coach/supervisor's own words
  class_id              text null,               -- null for open gym and non-class activity
  attendance_status     text not null default 'present'
                        check (attendance_status in ('present','absent','excused')),
  capture_method        text not null
                        check (capture_method in ('door_terminal','self','coach_override',
                                                  'admin_override','supervisor_entry','import')),
  recorded_by_role      text not null,
  recorded_by_account_id text not null references pilot.accounts(account_id),
  verified_by_account_id text null references pilot.accounts(account_id) on delete set null,
  verified_at           timestamptz null,
  rpe                   numeric null check (rpe is null or rpe between 0 and 10),
  notes                 text not null default '',
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint pilot_activity_log_pkey primary key (organization_id, activity_id),
  constraint pilot_activity_log_athlete_fk foreign key (organization_id, athlete_id)
    references pilot.athletes(organization_id, athlete_id) on delete cascade
);

-- The constraint pilot.attendance never had. One record per person per
-- activity occurrence. Open gym has no class_id, so the key uses coalesce
-- to a sentinel rather than allowing unlimited nulls to defeat uniqueness.
create unique index if not exists pilot_activity_log_one_per_occurrence
  on pilot.activity_log(organization_id, person_account_id, occurred_on,
                        activity_domain, coalesce(class_id, '__none__'), coalesce(started_at, 'epoch'));

create index if not exists pilot_activity_log_person_window
  on pilot.activity_log(organization_id, person_account_id, occurred_on desc);
create index if not exists pilot_activity_log_domain
  on pilot.activity_log(organization_id, activity_domain, occurred_on desc);

-- VERIFICATION IS NOT UNIFORM ACROSS DOMAINS. Court-ordered community
-- service and college work-study hours are reported to an external
-- authority and need a named human verifier; a boxing session does not.
-- Enforced rather than left to application code.
do $$
begin
  if not exists (select 1 from pg_constraint where conname='pilot_activity_log_domain_check'
                 and conrelid='pilot.activity_log'::regclass) then
    alter table pilot.activity_log add constraint pilot_activity_log_domain_check
      check (activity_domain in ('boxing_training','schoolwork','gym_service',
                                 'community_service','work_study','other'));
  end if;
  if not exists (select 1 from pg_constraint where conname='pilot_activity_log_verified_check'
                 and conrelid='pilot.activity_log'::regclass) then
    alter table pilot.activity_log add constraint pilot_activity_log_verified_check
      check (activity_domain not in ('community_service','work_study')
             or (verified_by_account_id is not null and verified_at is not null));
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- SPARRING EXPOSURE -- per round, not per session.
--
-- Session-level hours cannot answer "how many rounds did this athlete take
-- this month", which is the head-impact exposure proxy reviewed at every
-- coach review.
--
-- INTENSITY TYPES ARE NOT INTERCHANGEABLE. Verified evidence (A1-062)
-- found amateur boxing produces greater acute physiological, endocrine and
-- biochemical alterations in competitive bouts than in sparring, and
-- greater in sparring than in boxing-specific simulation -- a GRADED
-- response across intensity conditions, which is why the type is recorded
-- per round rather than assumed constant.
--
-- WHAT THIS TABLE DOES NOT DO: it does not compute a damage score, a
-- cumulative risk index, or a recommended limit. No validated safe
-- sparring dose exists for any population PPBF serves, and no validated
-- model converts round counts into individual injury risk. This table
-- COUNTS exposure so a qualified human can read it. It must never gate,
-- clear, or recommend.

create table if not exists pilot.sparring_rounds (
  organization_id     text not null references pilot.organizations(organization_id) on delete cascade,
  round_id            text not null,
  activity_id         text not null,
  athlete_id          text not null,
  round_number        integer not null check (round_number > 0),
  duration_sec        integer not null check (duration_sec between 1 and 900),
  sparring_type       text not null,   -- hard | play | technical | game | conditioned
  partner_athlete_id  text null,
  headgear_worn       boolean null,
  glove_oz            integer null check (glove_oz is null or glove_oz between 8 and 20),
  supervising_coach_account_id text not null references pilot.accounts(account_id),
  stopped_early       boolean not null default false,
  stop_reason         text null,
  coach_note          text not null default '',
  created_at          timestamptz not null default now(),
  constraint pilot_sparring_rounds_pkey primary key (organization_id, round_id),
  constraint pilot_sparring_rounds_activity_fk foreign key (organization_id, activity_id)
    references pilot.activity_log(organization_id, activity_id) on delete cascade,
  constraint pilot_sparring_rounds_athlete_fk foreign key (organization_id, athlete_id)
    references pilot.athletes(organization_id, athlete_id) on delete cascade,
  constraint pilot_sparring_rounds_round_number_uq unique (organization_id, activity_id, athlete_id, round_number)
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname='pilot_sparring_rounds_type_check'
                 and conrelid='pilot.sparring_rounds'::regclass) then
    alter table pilot.sparring_rounds add constraint pilot_sparring_rounds_type_check
      check (sparring_type in ('hard','play','technical','game','conditioned'));
  end if;
end
$$;

create index if not exists pilot_sparring_rounds_athlete_window
  on pilot.sparring_rounds(organization_id, athlete_id, created_at desc);

comment on table pilot.activity_log is
  'Cross-domain hours record (boxing_training, schoolwork, gym_service, community_service, work_study, other). Supersedes pilot.attendance and pilot.scheduler_attendance in intent -- neither is dropped or altered by this migration; a human-reviewed backfill decides which source wins on conflict.';

comment on table pilot.sparring_rounds is
  'Per-round sparring exposure counts only. No damage score, cumulative risk index, or recommended limit -- no validated safe sparring dose exists for any population this platform serves.';
