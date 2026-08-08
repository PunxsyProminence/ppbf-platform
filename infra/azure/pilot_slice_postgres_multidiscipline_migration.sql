-- Multi-discipline structure: wrestling, BJJ and combatives alongside boxing
--
-- THE STRUCTURAL FINDING THAT SHAPES THIS FILE. Boxing and grappling do not share a risk model.
-- Boxing's dominant exposure is repeated head impact; grappling's is cervical spine, joint and
-- submission exposure -- a NEISS analysis across 2014-2023 found injury patterns differ across
-- boxing, wrestling and martial arts (PMID 40778941), and cervical spine injury has its own
-- surveillance literature in high school sport (PMID 28919185). A single "contact level" ladder
-- built for striking cannot express "the neck is loaded" or "a submission is being applied", and
-- forcing grappling into it would silently drop the exposure that matters most.
--
-- SO: one drill library, one skill graph mechanism, one scaling model -- but DISCIPLINE-SPECIFIC
-- exposure vocabularies and stop rules. Sharing the container is right; sharing the risk model is
-- not.
--
-- WHAT THE EVIDENCE SUPPORTS AND WHAT IT DOES NOT. Combatives concussion incidence of 20.8 per 100
-- exposures has been reported in a MILITARY training environment (PMID 40818615). That population
-- is selected, mandated and training to a different standard than a civilian gym; the figure
-- establishes that combatives carries meaningful concussion exposure, and it is NOT a rate PPBF
-- may apply to itself or display as its own. No study was located evaluating any instructional
-- method, progression or rubric for combatives (CB-008) -- so combatives curriculum content is
-- coaching craft, labelled as such, and the schema must not imply otherwise.
--
-- YOUTH BJJ SITS UNDER STATE REGULATION. Competition eligibility for youth grappling follows
-- Pennsylvania rules, not PPBF policy and not SHADOW inference. Those constraints are recorded as
-- human-entered external rules, exactly as USA Boxing rest periods are.
--
-- DEPENDS ON pilot.organizations, pilot.athletes, pilot.accounts, pilot.activity_log,
-- pilot.drill_library. No begin;/commit; here on purpose, matching this repo's
-- runner-opens-the-transaction convention (the runner is
-- apps/web/scripts/pilot-apply-multidiscipline-migration.mjs).

-- ---------------------------------------------------------------------------
-- DISCIPLINE REGISTRY. Declares what each lane is, who governs it, and which exposure vocabulary
-- applies -- so nothing has to be inferred from a string comparison on `discipline`.
create table if not exists pilot.disciplines (
  organization_id     text not null references pilot.organizations(organization_id) on delete cascade,
  discipline          text not null,        -- boxing | wrestling | bjj | combatives | conditioning
  display_name        text not null,
  lane                text not null check (lane in ('striking','grappling','mixed','non_contact')),
  exposure_model      text not null check (exposure_model in
                        ('head_impact','positional_grappling','mixed_contact','none')),
  governing_body      text null,            -- USA Boxing, PA state athletic/BJJ rules, none
  age_policy_source   text null,            -- where youth eligibility actually comes from
  youth_permitted     boolean not null default true,
  adult_permitted     boolean not null default true,
  mixed_age_permitted boolean not null default false,   -- parent-and-child sessions
  evidence_note       text not null default '',
  active              boolean not null default true,
  constraint pilot_disciplines_pkey primary key (organization_id, discipline)
);

-- ---------------------------------------------------------------------------
-- GRAPPLING EXPOSURE. The counterpart to pilot.sparring_exposure, which records time under impact
-- for striking. Neither table can express the other's risk, which is why there are two.
--
-- WHAT THIS DELIBERATELY DOES NOT DO, for the same reason the striking table does not: no damage
-- score, no cumulative risk index, no recommended limit, no submission cap. Grappling injury
-- incidence is documented (9.2 per 1000 exposures in BJJ competition, PMID 26535299; training-phase
-- prevalence in PMID 40092168) but no validated safe dose exists for any population PPBF serves,
-- and a composite number would be invention.
create table if not exists pilot.grappling_exposure (
  organization_id     text not null references pilot.organizations(organization_id) on delete cascade,
  exposure_id         text not null,
  activity_id         text not null,
  athlete_id          text not null,
  discipline          text not null,
  segment_number      integer not null check (segment_number > 0),

  round_type          text not null check (round_type in
                        ('positional','flow','situational','competitive','technique_only','live_go')),
  duration_sec        integer not null check (duration_sec between 1 and 1800),
  partner_athlete_id  text null,
  -- Weight and experience mismatch is the grappling analogue of a size mismatch in sparring.
  partner_weight_delta_lb integer null,
  partner_rank_delta  text null,

  -- Exposure that only exists in grappling.
  submissions_applied integer not null default 0 check (submissions_applied >= 0),
  submissions_received integer not null default 0 check (submissions_received >= 0),
  neck_exposure       text not null default 'none' check (neck_exposure in
                        ('none','incidental','positional_pressure','choke_defended','choke_completed','unclear')),
  joint_exposure      text not null default 'none' check (joint_exposure in
                        ('none','incidental','joint_lock_defended','joint_lock_completed','unclear')),
  impact_to_head      text not null default 'none' check (impact_to_head in
                        ('none','incidental_mat_contact','incidental_clash','repeated','unclear')),
  takedowns_conceded  integer null check (takedowns_conceded is null or takedowns_conceded >= 0),

  coach_observed_intensity text not null
                      check (coach_observed_intensity in ('light','moderate','firm','unclear')),
  athlete_presentation text null check (athlete_presentation is null or athlete_presentation in
                        ('normal','slowed','unsteady','withdrawn','other_concern')),
  coach_note          text not null default '',
  supervising_coach_account_id text not null references pilot.accounts(account_id),
  stopped_early       boolean not null default false,
  stop_rule_id        text null,
  stop_reason         text null,
  created_at          timestamptz not null default now(),

  constraint pilot_grappling_exposure_pkey primary key (organization_id, exposure_id),
  constraint pilot_grappling_exposure_activity_fk foreign key (organization_id, activity_id)
    references pilot.activity_log(organization_id, activity_id) on delete cascade,
  constraint pilot_grappling_exposure_athlete_fk foreign key (organization_id, athlete_id)
    references pilot.athletes(organization_id, athlete_id) on delete cascade,
  constraint pilot_grappling_exposure_discipline_fk foreign key (organization_id, discipline)
    references pilot.disciplines(organization_id, discipline),
  constraint pilot_grappling_exposure_segment_uq unique (organization_id, activity_id, athlete_id, segment_number),
  constraint pilot_grappling_exposure_stop check (stopped_early = false or stop_reason is not null),
  -- A completed choke on a youth athlete is a coach-review event by construction, not a statistic.
  constraint pilot_grappling_exposure_choke_note check (
    neck_exposure <> 'choke_completed' or length(btrim(coach_note)) >= 10
  )
);

create index if not exists pilot_grappling_exposure_athlete
  on pilot.grappling_exposure(organization_id, athlete_id, created_at desc);

-- ---------------------------------------------------------------------------
-- CROSS-DISCIPLINE ELIGIBILITY. Which lanes a person may train in, and under whose authority.
-- Youth grappling competition eligibility comes from state rules; this table RECORDS a human's
-- determination and never computes one.
create table if not exists pilot.athlete_discipline_participation (
  organization_id     text not null references pilot.organizations(organization_id) on delete cascade,
  participation_id    text not null,
  athlete_id          text not null,
  discipline          text not null,
  participation_level text not null check (participation_level in
                        ('observing','technique_only','controlled_live','full_training','competing')),
  authority_source    text not null,   -- who decided: 'head coach', 'PA state rules', 'physician'
  determined_by_account_id text not null references pilot.accounts(account_id),
  determined_by_role  text not null,
  determined_at       timestamptz not null default now(),
  expires_on          date null,
  note                text not null default '',
  constraint pilot_adp_pkey primary key (organization_id, participation_id),
  constraint pilot_adp_athlete_fk foreign key (organization_id, athlete_id)
    references pilot.athletes(organization_id, athlete_id) on delete cascade,
  constraint pilot_adp_discipline_fk foreign key (organization_id, discipline)
    references pilot.disciplines(organization_id, discipline),
  constraint pilot_adp_uq unique (organization_id, athlete_id, discipline, determined_at)
);

create index if not exists pilot_adp_current
  on pilot.athlete_discipline_participation(organization_id, athlete_id, discipline, determined_at desc);

-- ---------------------------------------------------------------------------
-- MIXED-AGE SESSIONS. Parent-and-child training is a stated PPBF format and carries constraints
-- neither an adult nor a youth session has on its own: an adult partnered with a child is a size
-- and strength mismatch by definition, and safeguarding applies to adults who are not that child's
-- guardian. The table records the format so a session can be audited, not so the system can
-- approve one.
create table if not exists pilot.mixed_age_session_records (
  organization_id     text not null references pilot.organizations(organization_id) on delete cascade,
  record_id           text not null,
  activity_id         text not null,
  youth_athlete_id    text not null,
  adult_account_id    text not null references pilot.accounts(account_id),
  relationship        text not null check (relationship in
                        ('parent_guardian','sibling_adult','other_family','unrelated_adult')),
  pairing_permitted_by_account_id text not null references pilot.accounts(account_id),
  contact_permitted   text not null default 'technique_only' check (contact_permitted in
                        ('none','technique_only','controlled_light')),
  supervising_coach_account_id text not null references pilot.accounts(account_id),
  note                text not null default '',
  created_at          timestamptz not null default now(),
  constraint pilot_mixed_age_pkey primary key (organization_id, record_id),
  constraint pilot_mixed_age_activity_fk foreign key (organization_id, activity_id)
    references pilot.activity_log(organization_id, activity_id) on delete cascade,
  -- An unrelated adult paired with a youth athlete requires an explicit note. This is a
  -- safeguarding record, and silence is not acceptable in it.
  constraint pilot_mixed_age_unrelated check (
    relationship <> 'unrelated_adult' or length(btrim(note)) >= 15
  )
);

create index if not exists pilot_mixed_age_youth
  on pilot.mixed_age_session_records(organization_id, youth_athlete_id, created_at desc);

-- ---------------------------------------------------------------------------
-- The drill library already carries `discipline`. These add the grappling-specific fields that
-- have no striking equivalent, without disturbing the boxing rows.
alter table pilot.drill_library
  add column if not exists grappling_position text null,      -- guard, side control, standing, etc.
  add column if not exists neck_involvement text null
    check (neck_involvement is null or neck_involvement in ('none','positional','choke_taught')),
  add column if not exists joint_involvement text null
    check (joint_involvement is null or joint_involvement in ('none','positional','lock_taught')),
  add column if not exists youth_appropriate text null
    check (youth_appropriate is null or youth_appropriate in
           ('yes','yes_with_modification','adult_only','requires_external_authority'));

comment on column pilot.drill_library.youth_appropriate is
  'requires_external_authority means a governing body or state rule decides, not PPBF and never SHADOW.';
