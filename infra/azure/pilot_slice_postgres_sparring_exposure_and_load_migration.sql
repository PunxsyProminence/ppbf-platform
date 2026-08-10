-- Sparring exposure v2 -- time under impact, coach-observed, with a
-- bypassable flag model. Split session load -- P-03a (v2) / P-04.
--
-- SUPERSEDES the pilot.sparring_rounds block that previously lived in
-- pilot_slice_postgres_activity_log_migration.sql. Round count is a weak
-- proxy for what an individual actually absorbed. In collegiate boxers,
-- 27.63 +/- 17.87 impacts above 9.6 g were recorded per boxer across two
-- 2-minute sparring rounds -- the standard deviation is roughly two thirds
-- of the mean, so two athletes who did "the same two rounds" did not have
-- the same exposure. Time under impact, typed by intensity and annotated
-- by the coach who watched it, is the closest honest instrument available
-- without hardware. pilot.sparring_rounds was removed before it was ever
-- applied to any database, so this is a clean replacement, not a migration
-- of existing data.
--
-- WHY NOT SENSORS (YET). Against 5,168 video-verified contact events
-- across 115 boxing sparring rounds, an instrumented mouthguard recorded
-- 695, a skin patch 1,579 and a headgear patch 1,690 -- sensitivities of
-- 35%, 86% and 78%. A sensor feed today would add precision the device
-- cannot deliver. device_type/device_event_count below exist so a
-- validated device can be added later WITHOUT a migration, and are null
-- until one is funded and validated.
--
-- WHAT pilot.sparring_exposure REFUSES TO DO. No damage score. No
-- cumulative risk index. No recommended limit. No clearance. The acute
-- dose-response relationship between head impact exposure and concussion
-- remains unresolved, so any number this system produced would be
-- invention wearing a decimal point. It counts and it displays. A
-- qualified human reads it.
--
-- SPLIT LOAD -- pilot.session_load rates physical and cognitive load
-- SEPARATELY. Session-RPE (sRPE x duration) is verified evidence across 36
-- studies, but validated in other sports -- boxing sRPE has never been
-- validated, and it measures EFFORT: a hard conditioning round and a hard
-- sparring round can return the same number with entirely different
-- recovery demands. Splitting them is what makes live work distinguishable
-- from conditioning in the data. Derived load (sRPE x duration) is
-- DELIBERATELY NOT a stored column -- it is arithmetic on two fields that
-- are both present, and storing it would freeze a formula that has not
-- been validated in boxing. Compute it in the query that needs it, and
-- label it unvalidated where it is displayed.
--
-- DEPENDS ON pilot.organizations, pilot.accounts, pilot.athletes,
-- pilot.activity_log (must be applied first). No begin;/commit; here on
-- purpose, matching this repo's runner-opens-the-transaction convention
-- (the runner is
-- apps/web/scripts/pilot-apply-sparring-exposure-migration.mjs).

create table if not exists pilot.sparring_exposure (
  organization_id     text not null references pilot.organizations(organization_id) on delete cascade,
  exposure_id         text not null,
  activity_id         text not null,
  athlete_id          text not null,
  segment_number      integer not null check (segment_number > 0),

  sparring_type       text not null,   -- hard | play | technical | game | conditioned
  time_under_impact_sec integer not null check (time_under_impact_sec between 1 and 1800),
  -- Time the athlete was actually in an exchange where contact to the head
  -- was possible. NOT round length: a 3-minute round with 40 seconds of
  -- live exchange is 40 seconds here.
  round_equivalent    numeric(4,2) null,   -- optional bookkeeping, never a risk input

  partner_athlete_id  text null,
  headgear_worn       boolean null,
  glove_oz            integer null check (glove_oz is null or glove_oz between 8 and 20),

  -- Coach observation is the primary instrument, not a footnote on a number.
  coach_observed_intensity text not null
                      check (coach_observed_intensity in ('light','moderate','firm','unclear')),
  coach_observed_head_contact text not null
                      check (coach_observed_head_contact in ('none','incidental','regular','frequent','unclear')),
  athlete_presentation text null
                      check (athlete_presentation is null or athlete_presentation in
                             ('normal','slowed','unsteady','withdrawn','other_concern')),
  coach_note          text not null default '',

  supervising_coach_account_id text not null references pilot.accounts(account_id),
  stopped_early       boolean not null default false,
  stop_rule_id        text null,          -- which stop rule fired, when one did
  stop_reason         text null,

  -- Reserved for a validated device. Null until then; see header.
  device_type         text null,
  device_event_count  integer null,
  device_note         text null,

  created_at          timestamptz not null default now(),
  constraint pilot_sparring_exposure_pkey primary key (organization_id, exposure_id),
  constraint pilot_sparring_exposure_activity_fk foreign key (organization_id, activity_id)
    references pilot.activity_log(organization_id, activity_id) on delete cascade,
  constraint pilot_sparring_exposure_athlete_fk foreign key (organization_id, athlete_id)
    references pilot.athletes(organization_id, athlete_id) on delete cascade,
  -- Named explicitly (the uploaded SQL left this anonymous) so application
  -- code can catch a violation by name rather than pattern-matching an
  -- auto-generated, possibly-truncated Postgres identifier.
  constraint pilot_sparring_exposure_segment_uq unique (organization_id, activity_id, athlete_id, segment_number),
  -- An early stop records what ended it. Silence is not a record.
  constraint pilot_sparring_exposure_stop check (stopped_early = false or stop_reason is not null)
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname='pilot_sparring_exposure_type_check'
                 and conrelid='pilot.sparring_exposure'::regclass) then
    alter table pilot.sparring_exposure add constraint pilot_sparring_exposure_type_check
      check (sparring_type in ('hard','play','technical','game','conditioned'));
  end if;
end
$$;

create index if not exists pilot_sparring_exposure_athlete_window
  on pilot.sparring_exposure(organization_id, athlete_id, created_at desc);

-- ---------------------------------------------------------------------------
-- SPLIT LOAD -- physical and cognitive rated separately. See header.

create table if not exists pilot.session_load (
  organization_id     text not null references pilot.organizations(organization_id) on delete cascade,
  load_id             text not null,
  activity_id         text not null,
  athlete_id          text not null,

  rpe_physical        numeric(3,1) null check (rpe_physical is null or rpe_physical between 0 and 10),
  rpe_cognitive       numeric(3,1) null check (rpe_cognitive is null or rpe_cognitive between 0 and 10),
  rpe_scale           text not null default 'CR10',
  rated_by            text not null check (rated_by in ('athlete','coach_proxy')),
  rated_at            timestamptz not null default now(),
  minutes_at_rating   integer null,     -- duration used, if it differs from activity_log

  -- Carryover: the lagged signal. Did quality drop in the session AFTER
  -- live work.
  next_session_quality text null
                      check (next_session_quality is null or next_session_quality in
                             ('better','same','slightly_down','clearly_down','not_assessed')),
  next_session_activity_id text null,

  note                text not null default '',
  created_at          timestamptz not null default now(),
  constraint pilot_session_load_pkey primary key (organization_id, load_id),
  constraint pilot_session_load_activity_fk foreign key (organization_id, activity_id)
    references pilot.activity_log(organization_id, activity_id) on delete cascade,
  constraint pilot_session_load_athlete_fk foreign key (organization_id, athlete_id)
    references pilot.athletes(organization_id, athlete_id) on delete cascade,
  -- Named for the same reason as pilot_sparring_exposure_segment_uq above.
  constraint pilot_session_load_rated_by_uq unique (organization_id, activity_id, athlete_id, rated_by)
);

-- Derived load is INTENTIONALLY NOT A STORED COLUMN. See header.
create index if not exists pilot_session_load_athlete_window
  on pilot.session_load(organization_id, athlete_id, rated_at desc);

comment on table pilot.sparring_exposure is
  'Per-segment sparring exposure by time under impact, not round count. No damage score, cumulative risk index, or recommended limit -- no validated safe sparring dose exists for any population this platform serves.';

comment on table pilot.session_load is
  'Physical and cognitive RPE rated separately, never merged. Derived load (sRPE x duration) is computed in the query, never stored -- the formula is unvalidated in boxing.';
