-- Adult pathway (map item 17): where a coach has placed an athlete on the
-- four-stage adult pathway, which stage goals a coach has confirmed, and the
-- coach-set allowance that lets a minor be placed at all.
--
-- Owner decisions (Jason, 2026-10-03/04, asked in the adult-pathway lane):
--   stage is "Coach-set"; goals are "ticked only by a coach";
--   who may be placed = "C) Minors with a coach flag";
--   flag rules = "Reason required; unknown = minor".
-- The stage and goal vocabulary is apps/web/src/shared/adultPathwayStages.ts.
-- The CHECK lists below restate it so the database refuses a key the app does
-- not know; athletePathwayMigration.pg.test.ts fails if the app holds a pair
-- the database refuses, or the database accepts a goal under the wrong stage.
--
-- NOTHING HERE COMPUTES A STAGE. No column holds hours, levels, dates-to-reach
-- or thresholds. A stage is a coach's placement; a checkpoint is a coach's
-- confirmation. Nothing advances anyone.
--
-- APPEND-ONLY HISTORY. A placement is never overwritten: it stops being
-- current by a stamp (superseded_at, end_reason, ended_by_*), either because a
-- new placement replaced it, or because the minor allowance it depended on was
-- withdrawn -- owner decision (Jason, 2026-10-04): "A) Ends automatically",
-- stamped with who withdrew the allowance and when. A confirmation or an allowance is never
-- deleted: undoing one stamps it withdrawn, with who and when. Partial unique
-- indexes hold "at most one live row" for each.
--
-- WHO MAY BE PLACED. An adult (by pilot.athletes.dob), or a minor with a live
-- allowance. An athlete with no dob counts as a minor. That rule is enforced by
-- the module (adultPathway.ts, B1b) in the writing transaction, because age
-- is derived from dob on the gym day and is never stored as a band.
--
-- DELETION. Every row is tied to its athlete by the composite foreign key with
-- ON DELETE CASCADE, so the retention purge removes them with the athlete.
-- Account ids carry no foreign key, matching athlete_injuries: an account purge
-- must not be blocked by, or cascade into, a coach's record about an athlete.
--
-- No `begin;`/`commit;` here on purpose: the runner
-- (apps/web/scripts/pilot-apply-athlete-pathway-migration.mjs) opens the
-- transaction itself. Idempotent: create ... if not exists throughout, no
-- alters, no drops.

create table if not exists pilot.athlete_pathway_stages (
  organization_id     text not null references pilot.organizations(organization_id) on delete cascade,
  placement_id        uuid not null,
  athlete_id          text not null,
  stage_key           text not null
    constraint pilot_athlete_pathway_stages_stage_check
      check (stage_key in ('foundation', 'intermediate', 'advanced', 'elite')),
  coach_note          text not null default ''
    constraint pilot_athlete_pathway_stages_note_check check (length(coach_note) <= 2000),
  set_by_account_id   text not null,
  set_by_role         text not null
    constraint pilot_athlete_pathway_stages_role_check
      check (set_by_role in ('coach', 'organization_admin', 'admin')),
  set_at              timestamptz not null default now(),
  -- When this placement stopped being current, why, and who did it.
  superseded_at       timestamptz null,
  end_reason          text null
    constraint pilot_athlete_pathway_stages_end_reason_check
      check (end_reason is null or end_reason in ('replaced', 'allowance_withdrawn')),
  ended_by_account_id text null,
  ended_by_role       text null
    constraint pilot_athlete_pathway_stages_ended_role_check
      check (ended_by_role is null or ended_by_role in ('coach', 'organization_admin', 'admin')),
  superseded_by_placement_id uuid null,
  constraint pilot_athlete_pathway_stages_pkey primary key (organization_id, placement_id),
  constraint pilot_athlete_pathway_stages_athlete_fk foreign key (organization_id, athlete_id)
    references pilot.athletes(organization_id, athlete_id) on delete cascade,
  -- The history chain is real: a superseded placement names the SAME
  -- athlete's placement that replaced it. Deferred, because the writer stamps
  -- the old row before inserting the new one (the partial unique index on the
  -- current row is not deferrable, so the order is fixed).
  constraint pilot_athlete_pathway_stages_athlete_placement_key
    unique (organization_id, athlete_id, placement_id),
  constraint pilot_athlete_pathway_stages_superseded_by_fk
    foreign key (organization_id, athlete_id, superseded_by_placement_id)
    references pilot.athlete_pathway_stages(organization_id, athlete_id, placement_id)
    deferrable initially deferred,
  constraint pilot_athlete_pathway_stages_not_self_superseded check (
    superseded_by_placement_id is null or superseded_by_placement_id <> placement_id),
  -- The end stamp is all or none.
  constraint pilot_athlete_pathway_stages_end_all_or_none check (
    (superseded_at is null) = (end_reason is null)
    and (superseded_at is null) = (ended_by_account_id is null)
    and (superseded_at is null) = (ended_by_role is null)),
  -- A replacement is named exactly when the reason is 'replaced'.
  constraint pilot_athlete_pathway_stages_replacement_named check (
    coalesce(end_reason = 'replaced', false) = (superseded_by_placement_id is not null)),
  constraint pilot_athlete_pathway_stages_superseded_after_set check (
    superseded_at is null or superseded_at >= set_at),
  constraint pilot_athlete_pathway_stages_account_check check (
    length(btrim(set_by_account_id)) > 0
    and (ended_by_account_id is null or length(btrim(ended_by_account_id)) > 0))
);

-- One current placement per athlete; the rest are history.
create unique index if not exists idx_athlete_pathway_stages_current
  on pilot.athlete_pathway_stages(organization_id, athlete_id)
  where superseded_at is null;

create index if not exists idx_athlete_pathway_stages_history
  on pilot.athlete_pathway_stages(organization_id, athlete_id, set_at desc);

create table if not exists pilot.athlete_pathway_checkpoints (
  organization_id     text not null references pilot.organizations(organization_id) on delete cascade,
  confirmation_id     uuid not null,
  athlete_id          text not null,
  stage_key           text not null,
  goal_key            text not null,
  confirmed_by_account_id text not null,
  confirmed_by_role   text not null
    constraint pilot_athlete_pathway_checkpoints_role_check
      check (confirmed_by_role in ('coach', 'organization_admin', 'admin')),
  confirmed_at        timestamptz not null default now(),
  withdrawn_at        timestamptz null,
  withdrawn_by_account_id text null,
  withdrawn_by_role   text null
    constraint pilot_athlete_pathway_checkpoints_withdrawn_role_check
      check (withdrawn_by_role is null or withdrawn_by_role in ('coach', 'organization_admin', 'admin')),
  constraint pilot_athlete_pathway_checkpoints_pkey primary key (organization_id, confirmation_id),
  constraint pilot_athlete_pathway_checkpoints_athlete_fk foreign key (organization_id, athlete_id)
    references pilot.athletes(organization_id, athlete_id) on delete cascade,
  -- Every goal belongs to exactly one stage; the pair must be a real one.
  constraint pilot_athlete_pathway_checkpoints_goal_check check ((stage_key, goal_key) in (
    ('foundation', 'stance_guard'),
    ('foundation', 'footwork'),
    ('foundation', 'straight_punches'),
    ('foundation', 'basic_defence'),
    ('foundation', 'aerobic_base'),
    ('foundation', 'controlled_touch_sparring'),
    ('intermediate', 'hooks_uppercuts_combinations'),
    ('intermediate', 'distance_timing'),
    ('intermediate', 'strength_then_power'),
    ('intermediate', 'hard_sparring_weekly'),
    ('advanced', 'own_style'),
    ('advanced', 'film_study'),
    ('advanced', 'planned_strength_conditioning'),
    ('elite', 'elite_competition'))),
  constraint pilot_athlete_pathway_checkpoints_withdrawn_all_or_none check (
    (withdrawn_at is null) = (withdrawn_by_account_id is null)
    and (withdrawn_at is null) = (withdrawn_by_role is null)),
  constraint pilot_athlete_pathway_checkpoints_withdrawn_after_confirmed check (
    withdrawn_at is null or withdrawn_at >= confirmed_at),
  constraint pilot_athlete_pathway_checkpoints_account_check check (
    length(btrim(confirmed_by_account_id)) > 0
    and (withdrawn_by_account_id is null or length(btrim(withdrawn_by_account_id)) > 0))
);

-- One live confirmation per athlete per goal; withdrawn ones are history.
create unique index if not exists idx_athlete_pathway_checkpoints_live
  on pilot.athlete_pathway_checkpoints(organization_id, athlete_id, goal_key)
  where withdrawn_at is null;

create table if not exists pilot.athlete_pathway_minor_allowances (
  organization_id     text not null references pilot.organizations(organization_id) on delete cascade,
  allowance_id        uuid not null,
  athlete_id          text not null,
  -- Required: the coach says why a minor (or an athlete with no dob on file)
  -- is on the adult pathway. Kept on record.
  reason              text not null
    constraint pilot_athlete_pathway_minor_allowances_reason_check
      check (length(btrim(reason)) > 0 and length(reason) <= 2000),
  granted_by_account_id text not null,
  granted_by_role     text not null
    constraint pilot_athlete_pathway_minor_allowances_role_check
      check (granted_by_role in ('coach', 'organization_admin', 'admin')),
  granted_at          timestamptz not null default now(),
  withdrawn_at        timestamptz null,
  withdrawn_by_account_id text null,
  withdrawn_by_role   text null
    constraint pilot_athlete_pathway_minor_allowances_withdrawn_role_check
      check (withdrawn_by_role is null or withdrawn_by_role in ('coach', 'organization_admin', 'admin')),
  constraint pilot_athlete_pathway_minor_allowances_pkey primary key (organization_id, allowance_id),
  constraint pilot_athlete_pathway_minor_allowances_athlete_fk foreign key (organization_id, athlete_id)
    references pilot.athletes(organization_id, athlete_id) on delete cascade,
  constraint pilot_athlete_pathway_minor_allowances_withdrawn_all_or_none check (
    (withdrawn_at is null) = (withdrawn_by_account_id is null)
    and (withdrawn_at is null) = (withdrawn_by_role is null)),
  constraint pilot_athlete_pathway_minor_allowances_withdrawn_after_granted check (
    withdrawn_at is null or withdrawn_at >= granted_at),
  constraint pilot_athlete_pathway_minor_allowances_account_check check (
    length(btrim(granted_by_account_id)) > 0
    and (withdrawn_by_account_id is null or length(btrim(withdrawn_by_account_id)) > 0))
);

-- At most one live allowance per athlete.
create unique index if not exists idx_athlete_pathway_minor_allowances_live
  on pilot.athlete_pathway_minor_allowances(organization_id, athlete_id)
  where withdrawn_at is null;
