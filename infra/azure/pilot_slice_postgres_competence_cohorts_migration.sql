-- Cohort model: competence and time-in-programme, not age
--
-- THE DECISION THIS ENCODES. PPBF's own source files carried three incompatible age schemes
-- (5-7/8-11/12-15/16-18; 8-12/12-15; 8-10/11-12), and a twelve-year-old landed in three bands at
-- once while a six-year-old existed in only one. Rather than pick a winner, the decision was to
-- stop using age as the grouping axis at all.
--
-- Athletes are grouped by what they can do and how long they have been training. Those are the two
-- facts a coach actually uses on the floor, they are observable, and they do not force a nine-year-old
-- who has trained for two years into the same room as a nine-year-old on day one.
--
-- AGE DOES NOT DISAPPEAR -- IT IS DEMOTED. Age remains legally binding for round structure, contact
-- eligibility, and governing-body rules. It moves from "how we form groups" to "a constraint the
-- grouping must not violate". pilot.athletes.dob already exists, so age is always derivable; no new
-- age column is added anywhere, because duplicating it would create a second source of truth.
--
-- WHY TENURE IS MEASURED, NOT ENTERED. Time-in-programme is derived from the activity log, not typed
-- in by an admin. A typed value drifts the moment someone forgets to update it. A derived value is
-- always current and always auditable back to the sessions that produced it.
--
-- DEPENDS ON pilot.organizations, pilot.athletes, pilot.accounts, pilot.activity_log. No
-- begin;/commit; here on purpose, matching this repo's runner-opens-the-transaction convention
-- (the runner is apps/web/scripts/pilot-apply-competence-cohorts-migration.mjs).

-- ---------------------------------------------------------------------------
-- Competence vocabulary. Deliberately small. These are levels a coach can assign from the floor
-- without an instrument, which is the only kind of level that will actually get recorded.
create table if not exists pilot.competence_levels (
  organization_id   text not null references pilot.organizations(organization_id) on delete cascade,
  level_key         text not null,
  ordinal           smallint not null,
  display_name      text not null,
  observable_test   text not null,        -- what the coach must SEE to assign this level
  typical_scale     text null check (typical_scale is null or typical_scale in ('A','B','C')),
  constraint pilot_complevel_pkey primary key (organization_id, level_key),
  constraint pilot_complevel_ordinal_uq unique (organization_id, ordinal)
);

-- ---------------------------------------------------------------------------
-- Per-athlete competence, per domain. An athlete is not one number -- footwork and composure move
-- at different rates, and a single overall level would hide exactly the gap a coach wants to work on.
create table if not exists pilot.athlete_competence (
  organization_id     text not null references pilot.organizations(organization_id) on delete cascade,
  competence_id       text not null,
  athlete_id          text not null,
  domain              text not null check (domain in
                        ('stance_base','footwork','offense','defense','distance_timing',
                         'decision_making','composure','conditioning','ring_craft','partner_control')),
  level_key           text not null,

  -- Provenance. A level is a coach judgment until an assessment backs it, and the schema says which.
  basis               text not null check (basis in
                        ('coach_observation','assessment_result','both','carried_forward')),
  assessment_id       text null,
  assessed_by_account_id text not null references pilot.accounts(account_id),
  assessed_on         date not null,
  evidence_note       text not null default '',
  superseded_by       text null,          -- history is kept; levels are never overwritten

  constraint pilot_athcomp_pkey primary key (organization_id, competence_id),
  constraint pilot_athcomp_athlete_fk foreign key (organization_id, athlete_id)
    references pilot.athletes(organization_id, athlete_id) on delete cascade,
  constraint pilot_athcomp_level_fk foreign key (organization_id, level_key)
    references pilot.competence_levels(organization_id, level_key),
  constraint pilot_athcomp_assessment_basis check (
    basis not in ('assessment_result','both') or assessment_id is not null
  )
);

-- One current level per athlete per domain; the rest are history.
create unique index if not exists pilot_athcomp_current
  on pilot.athlete_competence(organization_id, athlete_id, domain)
  where superseded_by is null;

-- ---------------------------------------------------------------------------
-- Time in programme, derived. Never typed.
create or replace view pilot.v_athlete_tenure as
select
  a.organization_id,
  a.athlete_id,
  min(l.occurred_on)                                    as first_session_on,
  max(l.occurred_on)                                    as last_session_on,
  count(*)                                              as sessions_logged,
  coalesce(sum(l.duration_minutes), 0) / 60.0           as hours_logged,
  (current_date - min(l.occurred_on))                   as days_enrolled,
  -- Elapsed time and actual training are different facts. Someone enrolled 18 months who attended
  -- twice is not an 18-month athlete, and grouping on calendar alone would put them in the wrong room.
  case
    when count(*) < 6                                   then 'insufficient_history'
    when coalesce(sum(l.duration_minutes),0) < 900      then 'introduction'
    when coalesce(sum(l.duration_minutes),0) < 3600     then 'fundamentals'
    when coalesce(sum(l.duration_minutes),0) < 9000     then 'development'
    else                                                     'established'
  end                                                    as tenure_band
from pilot.athletes a
join pilot.activity_log l
  on l.organization_id = a.organization_id
 and l.athlete_id      = a.athlete_id
group by a.organization_id, a.athlete_id;

comment on view pilot.v_athlete_tenure is
  'Time-in-programme derived from logged activity, never entered. tenure_band uses training hours rather than calendar months so an enrolled-but-absent athlete is not banded as experienced. Thresholds are PROPOSED PPBF PARAMETERS pending floor data.';

-- ---------------------------------------------------------------------------
-- Cohorts. A cohort is a rule, not a list -- membership is recomputed, so an athlete moves rooms
-- when their competence moves rather than when someone remembers to move them.
create table if not exists pilot.cohort_definitions (
  organization_id     text not null references pilot.organizations(organization_id) on delete cascade,
  cohort_id           text not null,
  cohort_name         text not null,
  discipline          text not null default 'boxing',

  min_level_ordinal   smallint null,
  max_level_ordinal   smallint null,
  required_domains    text not null default '',   -- comma-separated; blank = any domain qualifies
  tenure_bands        text not null default '',   -- comma-separated; blank = any

  -- Regulatory constraints. NOT grouping criteria -- these are the lines a cohort must not cross.
  -- Populated from governing-body rules, never invented.
  min_age_regulatory  smallint null,
  max_age_regulatory  smallint null,
  regulatory_basis    text not null default '',   -- which rulebook and clause imposes it
  contact_permitted   text not null default 'none' check (contact_permitted in
                        ('none','light_technical','controlled_sparring','open_sparring')),

  requires_coach_approval boolean not null default true,
  notes               text not null default '',
  active_flag         boolean not null default true,
  constraint pilot_cohortdef_pkey primary key (organization_id, cohort_id),
  constraint pilot_cohortdef_level_order check (
    min_level_ordinal is null or max_level_ordinal is null or max_level_ordinal >= min_level_ordinal
  ),
  -- Any age bound must say which rule imposes it. This is what stops an invented band being
  -- reintroduced through the back door.
  constraint pilot_cohortdef_reg_basis check (
    (min_age_regulatory is null and max_age_regulatory is null) or regulatory_basis <> ''
  ),
  -- Contact above technical requires named human approval, always.
  constraint pilot_cohortdef_contact_gate check (
    contact_permitted in ('none','light_technical') or requires_coach_approval
  )
);

comment on constraint pilot_cohortdef_reg_basis on pilot.cohort_definitions is
  'An age bound must cite the rulebook imposing it. Age is a regulatory constraint here, not a development category -- a bound with no cited source is an invented age band and is rejected.';
