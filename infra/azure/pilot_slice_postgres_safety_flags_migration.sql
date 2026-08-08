-- Safety flags with coach bypass -- the false-positive learning loop.
-- Return-to-training intensity progression.
--
-- THE DESIGN PREMISE, IN THE COACH'S WORDS: the system will by its nature
-- raise false flags, and a coach can bypass any of them with a note, so
-- the false flag can be identified. That inverts the usual failure mode.
-- A flag system tuned to never be wrong is tuned to never fire; a flag
-- system that fires and is corrected produces a labelled dataset of its
-- own errors. The bypass note is not an escape hatch bolted on for
-- convenience -- it is the training signal, and it is the only reason a
-- flag threshold can ever be improved rather than argued about.
--
-- TWO CLASSES OF FLAG, AND THEY BEHAVE DIFFERENTLY.
--
--   SYSTEM_GUIDANCE  -- SHADOW's own inference. Load looks high, technique
--                      degraded across consecutive sessions, an assessment
--                      is overdue, a drill's stop rule pattern keeps
--                      firing. Bypassable with a note. The note is what
--                      teaches it.
--
--   EXTERNAL_RULE    -- not SHADOW's opinion. USA Boxing post-knockout
--                      rest periods, a medical clearance a physician has
--                      not signed, a safeguarding clearance required under
--                      PA Act 153/Act 15, a sanctioning-body eligibility
--                      condition. The system did not decide these and
--                      cannot un-decide them.
--
-- An EXTERNAL_RULE flag is still ACKNOWLEDGED with a note by the coach --
-- the workflow is identical so nothing is learned by muscle memory -- but
-- the acknowledgement records that the coach SAW the constraint, not that
-- they overrode it. The distinction protects the coach: a logged "bypass"
-- of a statutory clearance would be documentation of a violation, whereas
-- a logged acknowledgement is documentation of due care. `resolution`
-- carries that difference explicitly.
--
-- CONFIRMED CONCUSSION IS NOT A FLAG STATE. A confirmed concussion follows
-- USA Boxing rules and the medical authority of a qualified clinician.
-- What this system may hold is an administrative record that such a
-- determination EXISTS and when its period expires, entered by a human --
-- plus, as an add-on, the week-by-week intensity progression a coach
-- plans on return. It must never compute, infer, shorten, or clear a rest
-- period, and no flag in this table may be created by SHADOW against a
-- medical condition.
--
-- DEPENDS ON pilot.organizations, pilot.accounts, pilot.athletes. No
-- begin;/commit; here on purpose, matching this repo's runner-opens-the-
-- transaction convention (the runner is
-- apps/web/scripts/pilot-apply-safety-flags-migration.mjs).

create table if not exists pilot.safety_flags (
  organization_id     text not null references pilot.organizations(organization_id) on delete cascade,
  flag_id             text not null,
  athlete_id          text null,
  person_account_id   text null references pilot.accounts(account_id) on delete set null,

  flag_class          text not null check (flag_class in ('system_guidance','external_rule')),
  flag_code           text not null,        -- stable code, e.g. 'load_spike', 'assessment_overdue',
                                            -- 'clearance_expired', 'usab_rest_period_active'
  severity            text not null default 'advisory'
                      check (severity in ('advisory','attention','blocking_display')),
  -- 'blocking_display' means the UI shows it prominently. It does NOT mean
  -- the system blocks an action; no value here prevents a human from
  -- proceeding.

  triggered_by        text not null check (triggered_by in ('shadow_inference','rule_evaluation','human_entry')),
  trigger_detail      text not null default '',
  evidence_basis      text not null default '',   -- what the flag rests on, in plain language
  confidence_note     text not null default '',   -- qualitative only; never a fake percentage
  source_activity_id  text null,
  source_reference    text null,            -- statute, rulebook clause, or registry claim id

  status              text not null default 'open'
                      check (status in ('open','acknowledged','bypassed','upheld','expired','withdrawn')),
  resolution          text null
                      check (resolution is null or resolution in
                             ('false_positive','true_but_not_actionable','acted_on',
                              'acknowledged_external_constraint','deferred')),
  resolved_by_account_id text null references pilot.accounts(account_id) on delete set null,
  resolved_by_role    text null,
  resolved_at         timestamptz null,
  coach_note          text null,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint pilot_safety_flags_pkey primary key (organization_id, flag_id),
  constraint pilot_safety_flags_athlete_fk foreign key (organization_id, athlete_id)
    references pilot.athletes(organization_id, athlete_id) on delete cascade,
  constraint pilot_safety_flags_subject check (athlete_id is not null or person_account_id is not null),

  -- A NOTE IS MANDATORY ON EVERY RESOLUTION. This is the whole mechanism:
  -- an unexplained dismissal teaches nothing and leaves no record of the
  -- coach's reasoning.
  constraint pilot_safety_flags_note_required check (
    status in ('open','expired')
    or (coach_note is not null and length(btrim(coach_note)) >= 10
        and resolved_by_account_id is not null and resolved_at is not null)
  ),
  -- An external rule can be acknowledged; it cannot be bypassed as if it
  -- were SHADOW's opinion.
  constraint pilot_safety_flags_external_not_bypassed check (
    flag_class <> 'external_rule' or status <> 'bypassed'
  ),
  constraint pilot_safety_flags_external_resolution check (
    flag_class <> 'external_rule' or resolution is null
    or resolution in ('acknowledged_external_constraint','acted_on','deferred')
  ),
  -- SHADOW may not raise a flag against a medical determination.
  constraint pilot_safety_flags_medical_human_only check (
    flag_code not in ('medical_clearance_missing','concussion_rest_period','rtp_not_cleared')
    or triggered_by = 'human_entry'
  )
);

create index if not exists pilot_safety_flags_open
  on pilot.safety_flags(organization_id, status, severity, created_at desc) where status = 'open';
create index if not exists pilot_safety_flags_athlete
  on pilot.safety_flags(organization_id, athlete_id, created_at desc);

-- ---------------------------------------------------------------------------
-- The learning loop this exists to serve: per flag_code, how often does a
-- coach say it was wrong. Descriptive only. It ranks nothing and retunes
-- nothing automatically -- a threshold change is a human decision informed
-- by this view, not an outcome of it.
create or replace view pilot.v_flag_calibration as
select
  organization_id,
  flag_code,
  flag_class,
  count(*)::int                                                       as total_raised,
  count(*) filter (where resolution = 'false_positive')::int          as called_false_positive,
  count(*) filter (where resolution = 'acted_on')::int                as acted_on,
  count(*) filter (where resolution = 'true_but_not_actionable')::int as true_not_actionable,
  count(*) filter (where status = 'open')::int                        as still_open,
  round(
    100.0 * count(*) filter (where resolution = 'false_positive')
    / nullif(count(*) filter (where resolution is not null), 0), 1)   as false_positive_pct,
  min(created_at) as first_raised,
  max(created_at) as last_raised
from pilot.safety_flags
group by organization_id, flag_code, flag_class;

comment on view pilot.v_flag_calibration is
  'Descriptive false-positive rate per flag code, from coach bypass notes. Informs human threshold review; retunes nothing automatically.';

-- ---------------------------------------------------------------------------
-- RETURN-TO-TRAINING INTENSITY PROGRESSION.
-- The add-on the coach asked for: after a confirmed concussion, the
-- week-by-week intensity plan. The medical determination and the rest
-- period come from USA Boxing rules and a qualified clinician -- both are
-- HUMAN-ENTERED here. This table holds the coaching plan that follows,
-- and each step's advancement is a human decision recorded, never a
-- computed clearance.

create table if not exists pilot.return_to_training_plans (
  organization_id     text not null references pilot.organizations(organization_id) on delete cascade,
  plan_id             text not null,
  athlete_id          text not null,
  triggering_event    text not null check (triggering_event in
                        ('confirmed_concussion','knockout','technical_knockout','injury','illness','other')),
  event_date          date not null,
  authority_source    text not null,      -- e.g. 'USA Boxing rulebook rest period', 'physician'
  rest_period_days    integer null,       -- HUMAN-ENTERED from the governing rule. Never computed.
  earliest_return_date date null,         -- HUMAN-ENTERED.
  medical_clearance_on_file boolean not null default false,
  entered_by_account_id text not null references pilot.accounts(account_id),
  entered_by_role     text not null,
  entered_at          timestamptz not null default now(),
  status              text not null default 'active' check (status in ('active','completed','cancelled')),
  note                text not null default '',
  constraint pilot_rtt_plans_pkey primary key (organization_id, plan_id),
  constraint pilot_rtt_plans_athlete_fk foreign key (organization_id, athlete_id)
    references pilot.athletes(organization_id, athlete_id) on delete cascade
);

create table if not exists pilot.return_to_training_steps (
  organization_id     text not null references pilot.organizations(organization_id) on delete cascade,
  step_id             text not null,
  plan_id             text not null,
  week_number         integer not null check (week_number > 0),
  intensity_label     text not null,      -- coach's own words for the week's ceiling
  permitted_contact   text not null default 'none'
                      check (permitted_contact in ('none','light_technical','conditioned','controlled_sparring','open_sparring')),
  permitted_scale_level text null check (permitted_scale_level is null or permitted_scale_level in ('A','B','C')),
  planned_note        text not null default '',
  advanced_by_account_id text null references pilot.accounts(account_id) on delete set null,
  advanced_at         timestamptz null,
  advancement_note    text null,
  constraint pilot_rtt_steps_pkey primary key (organization_id, step_id),
  constraint pilot_rtt_steps_plan_fk foreign key (organization_id, plan_id)
    references pilot.return_to_training_plans(organization_id, plan_id) on delete cascade,
  -- Named explicitly (the uploaded SQL left this anonymous), matching this
  -- session's own convention for every other multi-column unique here.
  constraint pilot_rtt_steps_week_uq unique (organization_id, plan_id, week_number),
  -- Advancing a step is a decision. It carries a name and a reason or it
  -- did not happen.
  constraint pilot_rtt_steps_advance check (
    advanced_at is null
    or (advanced_by_account_id is not null and advancement_note is not null
        and length(btrim(advancement_note)) >= 10)
  )
);

create index if not exists pilot_rtt_plans_active
  on pilot.return_to_training_plans(organization_id, athlete_id) where status = 'active';

comment on table pilot.safety_flags is
  'System-guidance and external-rule flags, each resolved with a mandatory note -- the note is the false-positive learning signal, not friction. No severity value blocks an action.';

comment on table pilot.return_to_training_plans is
  'Administrative record of a confirmed medical determination and its rest period -- both human-entered, never computed by this system.';

comment on table pilot.return_to_training_steps is
  'Week-by-week intensity progression a coach plans on return. Advancing a step is a recorded human decision, never an automated clearance.';
