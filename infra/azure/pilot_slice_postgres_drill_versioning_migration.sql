-- Drill versioning and change proposals -- closing the drill-refinement
-- traceability gap.
--
-- THE PROBLEM: pilot.drills (pilot_slice_postgres_drills_migration.sql) is
-- keyed (organization_id, drill_id) with no version. The intended workflow
-- is that a coach's notes refine a drill so it becomes more effective and
-- engaging. If a refinement edited the row in place, the pre-change state
-- would be gone -- "did the change help?" would be unanswerable, any
-- feedback row referencing that drill_id would point at content that no
-- longer exists, and there would be no way to compare v1 against v2 of the
-- same drill. Measuring whether coach-driven refinement works is the point
-- of the feature, so the before-state has to survive the edit.
--
-- THE APPROACH: a refinement never edits pilot.drills content in place. It
-- INSERTs a new row sharing lineage_id, with version = previous + 1 and
-- supersedes_drill_id pointing at the row it replaces, then stamps the old
-- row (superseded_at, superseded_by_drill_id, active = false). Both rows
-- survive. `active` keeps its existing meaning -- "offer this in the
-- library" -- and a lineage may legitimately have zero active rows
-- (retired).
--
-- WHY A TRIGGER SETS lineage_id, NOT A COLUMN DEFAULT: lineage_id has to
-- equal the row's OWN drill_id for a fresh v1 row, and a plain `default`
-- expression cannot reference another column of the same row being
-- inserted. A BEFORE INSERT trigger can. This means
-- apps/web/src/server/pilot/drills.ts#createDrill, which has always
-- inserted without naming lineage_id or version, needs NO changes -- every
-- drill it creates becomes its own lineage's v1 automatically, exactly as
-- it did before this migration existed. drillVersioning.ts's
-- adoptDrillChangeProposal explicitly sets lineage_id when it inserts a v2+
-- row, so the trigger's `if new.lineage_id is null` guard never overrides a
-- caller that already named it.
--
-- THE ONE PLACE THIS MIGRATION RELAXES AN EXISTING GUARANTEE:
-- pilot_drills_one_name_per_org was a TOTAL unique index on
-- (organization_id, name) -- exactly one row of that name per gym, ever.
-- Versioning breaks that outright: v2 of "Straight Jab Retraction Snap"
-- would collide with v1, and refining a drill would become impossible for
-- any coach who does not also rename it. The index is replaced with a
-- PARTIAL unique index on (organization_id, name) WHERE active -- one
-- *active* row of that name per gym, so the ambiguous-anchor problem the
-- original index existed to prevent is still prevented among the drills a
-- coach can actually select today, while superseded history keeps its
-- original name instead of being forced into a synthetic one. The
-- replacement KEEPS THE SAME INDEX NAME on purpose:
-- apps/web/src/server/pilot/drills.ts#isDrillNameCollision matches the
-- thrown error's `constraint` field against the literal string
-- 'pilot_drills_one_name_per_org'. Reusing the name means that
-- collision-to-DrillNameTakenError mapping keeps working with no
-- application code changes, even though what the index now enforces is
-- narrower (active-only) than what its name might suggest to a future
-- reader who does not check.
--
-- WHY drill_change_proposals EXISTS AND coach_observations/coach_reviews
-- ARE NOT TOUCHED: verified against the DDL, pilot.shadow_feedback,
-- pilot.shadow_learning_events and pilot.shadow_recommendation_effectiveness
-- all carry verification_state/human_review_required, but
-- pilot.coach_observations and pilot.coach_reviews carry neither -- and
-- should not gain them. Those two tables record what a human said, and a
-- human saying it IS the verification; a verification_state column on top
-- would be a state machine with no meaningful state other than "a human
-- said this," always true. The missing thing was never a review flag on
-- free-text notes -- it was a distinct record of a PROPOSED CHANGE TO
-- SHARED COACHING CONTENT, with its own review lifecycle, because a
-- proposal (unlike a note) can be adopted, declined, or superseded by a
-- later proposal, and only one outcome is true at a time.
--
-- WHY drill_version_outcomes HOLDS DESCRIPTIVE COUNTS ONLY: there is no
-- validated model for drill effectiveness in this domain. A composite
-- effectiveness score or a ranking would give a number authority it has not
-- earned -- exactly the "label with no authority behind it" the drills
-- migration's own header already refused once for a rank column. Comparing
-- v1 against v2 is a human reading two rows side by side, not a query
-- returning a verdict.
--
-- observation_note_ids is a plain uuid[], not an array of foreign keys:
-- pilot.coach_observations rows can be removed under retention policy, and
-- losing an observation must not delete the proposal that cited it, or cost
-- reviewers the rest of the rationale along with it.
--
-- DEPENDS ON pilot.drills, pilot.organizations, pilot.accounts
--
-- No `begin;`/`commit;` here on purpose, matching the drills migration this
-- one extends: the runner
-- (apps/web/scripts/pilot-apply-drill-versioning-migration.mjs) opens the
-- transaction itself.

-- A. VERSION pilot.drills.

alter table pilot.drills
  add column if not exists version integer not null default 1,
  add column if not exists supersedes_drill_id text null,
  add column if not exists superseded_at timestamptz null,
  add column if not exists superseded_by_drill_id text null,
  add column if not exists lineage_id text null;

-- Backfill before the column can be made NOT NULL. pilot.drills is empty in
-- every environment today, so this touches zero rows in practice -- written
-- to be correct if it ever is not. A row that already has a lineage_id
-- (impossible today, guarded against tomorrow) is left alone.
update pilot.drills
set lineage_id = drill_id
where lineage_id is null;

alter table pilot.drills
  alter column lineage_id set not null;

-- Sets lineage_id on INSERT when the caller did not name one, so a fresh v1
-- row becomes its own lineage without any change to
-- drills.ts#createDrill's existing INSERT. adoptDrillChangeProposal always
-- passes lineage_id explicitly for a v2+ row, so this never overrides a
-- caller that already knows which lineage it is extending.
create or replace function pilot.drills_default_lineage_id()
returns trigger
language plpgsql
as $pilot_drills_default_lineage$
begin
  if new.lineage_id is null then
    new.lineage_id := new.drill_id;
  end if;
  return new;
end;
$pilot_drills_default_lineage$;

drop trigger if exists pilot_drills_default_lineage_id on pilot.drills;
create trigger pilot_drills_default_lineage_id
  before insert on pilot.drills
  for each row
  execute function pilot.drills_default_lineage_id();

-- Composite self-reference, matching pilot_drill_assignments_fk_drill's own
-- reasoning: a scalar key on supersedes_drill_id alone would let one gym's
-- version chain point at another gym's drill. NULL satisfies the FK under
-- default MATCH SIMPLE, which is exactly what a v1 row (nothing to
-- supersede) needs.
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'pilot_drills_supersedes_fk'
      and conrelid = 'pilot.drills'::regclass
  ) then
    alter table pilot.drills
      add constraint pilot_drills_supersedes_fk
      foreign key (organization_id, supersedes_drill_id)
      references pilot.drills(organization_id, drill_id);
  end if;
end
$$;

-- The successor side of the same chain. Nullable for the same reason: an
-- active row (nothing has superseded it yet) carries NULL here.
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'pilot_drills_superseded_by_fk'
      and conrelid = 'pilot.drills'::regclass
  ) then
    alter table pilot.drills
      add constraint pilot_drills_superseded_by_fk
      foreign key (organization_id, superseded_by_drill_id)
      references pilot.drills(organization_id, drill_id);
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'pilot_drills_version_positive_check'
      and conrelid = 'pilot.drills'::regclass
  ) then
    alter table pilot.drills
      add constraint pilot_drills_version_positive_check
      check (version > 0);
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'pilot_drills_supersedes_not_self_check'
      and conrelid = 'pilot.drills'::regclass
  ) then
    alter table pilot.drills
      add constraint pilot_drills_supersedes_not_self_check
      check (supersedes_drill_id is null or supersedes_drill_id <> drill_id);
  end if;
end
$$;

-- One row per (lineage, version): the anchor a version chain is read by.
create unique index if not exists pilot_drills_lineage_version_uq
  on pilot.drills(organization_id, lineage_id, version);

-- The full read of a lineage, in order -- getDrillLineage's own index.
create index if not exists idx_pilot_drills_lineage
  on pilot.drills(organization_id, lineage_id, version);

-- THE RELAXATION. Drops the TOTAL unique index this migration's header
-- explains, and replaces it with a PARTIAL one over the same columns and
-- the SAME NAME, so drills.ts#isDrillNameCollision's string match against
-- the constraint name keeps working unchanged. "One active name per gym,"
-- not "one name per gym, ever."
drop index if exists pilot.pilot_drills_one_name_per_org;

create unique index if not exists pilot_drills_one_name_per_org
  on pilot.drills(organization_id, name)
  where active;

-- B. pilot.drill_change_proposals -- a coach's proposed adjustment to
-- shared drill content, with an explicit review lifecycle.

create table if not exists pilot.drill_change_proposals (
  proposal_id             text not null,
  organization_id         text not null references pilot.organizations(organization_id) on delete cascade,
  lineage_id              text not null,
  based_on_drill_id       text not null,
  proposed_by_account_id  text not null references pilot.accounts(account_id),
  proposed_by_role        text not null,
  rationale               text not null,
  proposed_change         jsonb not null default '{}'::jsonb,
  -- pilot.coach_observations.note_id references, NOT a foreign key array --
  -- see this file's header. A cited observation removed under retention
  -- policy must not take the proposal down with it.
  observation_note_ids    uuid[] not null default '{}'::uuid[],
  review_state            text not null default 'proposed',
  reviewed_by_account_id  text null references pilot.accounts(account_id) on delete set null,
  reviewed_at             timestamptz null,
  review_note             text null,
  resulting_drill_id      text null,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  constraint pilot_drill_change_proposals_pk primary key (organization_id, proposal_id),
  constraint pilot_drill_change_proposals_based_on_fk
    foreign key (organization_id, based_on_drill_id)
    references pilot.drills(organization_id, drill_id),
  -- Points at the version adopting this proposal actually produced. Added
  -- beyond the literal spec text for the same referential-integrity reason
  -- every other drill_id-shaped column in this file gets one: a
  -- resulting_drill_id that does not name a real row would be a citation to
  -- nothing, and the composite form keeps a proposal from ever pointing at
  -- another organization's drill.
  constraint pilot_drill_change_proposals_resulting_fk
    foreign key (organization_id, resulting_drill_id)
    references pilot.drills(organization_id, drill_id)
);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'pilot_drill_change_proposals_review_state_check'
      and conrelid = 'pilot.drill_change_proposals'::regclass
  ) then
    alter table pilot.drill_change_proposals
      add constraint pilot_drill_change_proposals_review_state_check
      check (review_state in ('proposed', 'under_review', 'adopted', 'declined', 'superseded'));
  end if;
end
$$;

-- Enforced in both directions: adopted always names what it produced, and
-- nothing else ever does. A resulting_drill_id on a merely-proposed row
-- would claim a version was minted before any reviewer acted; an adopted
-- row with none would be a decision with no record of what it decided.
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'pilot_drill_change_proposals_resulting_pairing_check'
      and conrelid = 'pilot.drill_change_proposals'::regclass
  ) then
    alter table pilot.drill_change_proposals
      add constraint pilot_drill_change_proposals_resulting_pairing_check
      check (
        (review_state = 'adopted' and resulting_drill_id is not null)
        or (review_state <> 'adopted' and resulting_drill_id is null)
      );
  end if;
end
$$;

-- The review queue read.
create index if not exists idx_pilot_drill_change_proposals_org_state
  on pilot.drill_change_proposals(organization_id, review_state);

-- Every proposal ever made about one lineage.
create index if not exists idx_pilot_drill_change_proposals_org_lineage
  on pilot.drill_change_proposals(organization_id, lineage_id);

-- C. pilot.drill_version_outcomes -- the measurement half. Without this,
-- versioning records THAT a drill changed but never whether the change
-- helped. NO EFFECTIVENESS SCORE, NO RANKING -- see this file's header.

create table if not exists pilot.drill_version_outcomes (
  outcome_id         text not null,
  organization_id    text not null references pilot.organizations(organization_id) on delete cascade,
  drill_id           text not null,
  lineage_id         text not null,
  window_start       date not null,
  window_end         date not null,
  assignments_count  integer not null default 0,
  completion_rate    numeric(5,4) null,
  coach_rating_mean  numeric(4,3) null,
  observation_count  integer not null default 0,
  computed_at        timestamptz not null default now(),
  computed_by        text not null,
  constraint pilot_drill_version_outcomes_pk primary key (organization_id, outcome_id),
  constraint pilot_drill_version_outcomes_drill_fk
    foreign key (organization_id, drill_id)
    references pilot.drills(organization_id, drill_id),
  constraint pilot_drill_version_outcomes_window_uq
    unique (organization_id, drill_id, window_start, window_end)
);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'pilot_drill_version_outcomes_completion_rate_check'
      and conrelid = 'pilot.drill_version_outcomes'::regclass
  ) then
    alter table pilot.drill_version_outcomes
      add constraint pilot_drill_version_outcomes_completion_rate_check
      check (completion_rate is null or completion_rate between 0 and 1);
  end if;
end
$$;

-- window_end before window_start would describe a measurement of negative
-- duration -- not in the literal spec text, but the same class of guard
-- every date range elsewhere in this schema gets, and cheap to hold here.
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'pilot_drill_version_outcomes_window_order_check'
      and conrelid = 'pilot.drill_version_outcomes'::regclass
  ) then
    alter table pilot.drill_version_outcomes
      add constraint pilot_drill_version_outcomes_window_order_check
      check (window_end >= window_start);
  end if;
end
$$;

-- computed_by's vocabulary is named in this table's own spec comment
-- ('scheduled_job' | 'manual'); closed the same way every other vocabulary
-- in this schema is closed, rather than left as unconstrained text.
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'pilot_drill_version_outcomes_computed_by_check'
      and conrelid = 'pilot.drill_version_outcomes'::regclass
  ) then
    alter table pilot.drill_version_outcomes
      add constraint pilot_drill_version_outcomes_computed_by_check
      check (computed_by in ('scheduled_job', 'manual'));
  end if;
end
$$;

-- Every measured window for one lineage, across every version -- the read a
-- human comparing v1 against v2 actually needs.
create index if not exists idx_pilot_drill_version_outcomes_org_lineage
  on pilot.drill_version_outcomes(organization_id, lineage_id, window_start desc);

comment on table pilot.drill_change_proposals is
  'A coach''s proposed adjustment to shared, organization-wide drill content, with an explicit review lifecycle distinct from pilot.coach_observations (free-text notes, no review state by design -- a human writing one IS the verification).';

comment on table pilot.drill_version_outcomes is
  'Descriptive counts only for one drill version over one date window. Deliberately holds no effectiveness score or ranking -- there is no validated model for drill effectiveness in this domain, and comparing versions is a human reading two rows.';

comment on column pilot.drills.lineage_id is
  'Stable across every version of a conceptually-same drill. Set to the row''s own drill_id on insert unless the caller names an existing lineage (see pilot_drills_default_lineage_id trigger).';
