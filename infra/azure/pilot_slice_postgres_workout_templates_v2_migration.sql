-- Workout templates (pilot.workout_templates, pilot.workout_template_items)
--
-- WHY THIS EXISTS. pilot.drill_library gives a drill identity. Nothing gives
-- a SESSION identity. The session-shaped tables that exist are both
-- athlete-scoped: pilot.sessions is a per-athlete log (date, rpe, notes)
-- and pilot.athlete_floor_plans is a per-athlete generated payload.
-- Neither can hold "Beginner Footwork - 45 minutes" as a reusable object,
-- so a coach who wants to run the same session twice rebuilds it by hand,
-- and two coaches running "the same" session produce two unrelated sets
-- of assignments that nothing can compare.
--
-- NO PRESCRIBED SPARRING VOLUME. A template may INCLUDE a sparring or
-- contact drill; it may not carry a round count, frequency or duration
-- for one. No validated safe sparring dose exists for any population this
-- platform serves, and a default here would appear authoritative in the
-- UI while resting on nothing. The check constraint below enforces that:
-- contact items above 'light_technical' carry no duration and no rep
-- count. A qualified human sets contact volume, in person, every time.
--
-- WHAT THIS TABLE DELIBERATELY DOES NOT HOLD: no athlete identifier, no
-- completion state, no effectiveness score. A template is gym-wide
-- coaching content read by every coach in the organization. Who ran it
-- and how it went belongs in the athlete-scoped tables that already
-- exist.
--
-- SCALE IS NOT PINNED BY DEFAULT. Template items reference a drill, not a
-- drill-at-a-level. The drill library carries difficulty (what the drill
-- requires) and scale_level A/B/C (how much demand is applied right now)
-- as INDEPENDENT axes; the second is chosen by the coach at delivery. A
-- template that hard-coded C would defeat the mixed-room case the scaling
-- model exists for.
--
-- VERSIONING MATCHES pilot.drill_library. Templates carry the same
-- lineage_id / version / supersedes convention for the same reason: a
-- template that is edited in place cannot be compared against what it
-- replaced.
--
-- DEPENDS ON pilot.organizations, pilot.drill_library (must be applied
-- first). No begin;/commit; here on purpose, matching this repo's
-- runner-opens-the-transaction convention (the runner is
-- apps/web/scripts/pilot-apply-workout-templates-v2-migration.mjs).

create table if not exists pilot.workout_templates (
  organization_id     text not null references pilot.organizations(organization_id) on delete cascade,
  template_id         text not null,
  lineage_id          text not null,
  version             integer not null default 1,
  supersedes_template_id text null,
  superseded_at       timestamptz null,
  name                text not null,
  session_type        text not null,
  difficulty          text not null default 'intermediate',
  age_band            text not null default 'any',
  duration_minutes    integer not null check (duration_minutes between 15 and 180),
  intent              text not null,
  coach_notes         text null,
  requires_coach_authorization boolean not null default false,
  active              boolean not null default true,
  created_by_account_id text null,
  created_by_role     text null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint pilot_workout_templates_pkey primary key (organization_id, template_id)
);

create table if not exists pilot.workout_template_items (
  organization_id     text not null references pilot.organizations(organization_id) on delete cascade,
  item_id             text not null,
  template_id         text not null,
  ordinal             integer not null check (ordinal > 0),
  block               text not null,
  drill_id            text null,
  free_text_drill     text null,
  scale_level         text null check (scale_level is null or scale_level in ('A','B','C')),
  -- Null means the coach picks the level at delivery. A template may
  -- PREFER a level (a first-week session reasonably starts at A) but must
  -- never force one: scale is a delivery-time decision made against the
  -- athlete in front of the coach.
  duration_minutes    integer null check (duration_minutes is null or duration_minutes between 1 and 90),
  rep_count           integer null check (rep_count is null or rep_count > 0),
  contact_level       text not null default 'none',
  coach_note          text null,
  created_at          timestamptz not null default now(),
  constraint pilot_workout_template_items_pkey primary key (organization_id, item_id),
  constraint pilot_wti_template_fk foreign key (organization_id, template_id)
    references pilot.workout_templates(organization_id, template_id) on delete cascade,
  constraint pilot_wti_drill_fk foreign key (organization_id, drill_id)
    references pilot.drill_library(organization_id, drill_id),
  -- An item names a catalogued drill or free text, not both and not
  -- neither.
  constraint pilot_wti_one_source check (
    (drill_id is not null and free_text_drill is null)
    or (drill_id is null and free_text_drill is not null)
  ),
  -- The rule the header describes, in the only place that can hold it.
  constraint pilot_wti_no_contact_volume check (
    contact_level in ('none','light_technical')
    or (duration_minutes is null and rep_count is null)
  )
);

do $$
begin
  if not exists (select 1 from pg_constraint
                 where conname='pilot_workout_templates_difficulty_check'
                   and conrelid='pilot.workout_templates'::regclass) then
    alter table pilot.workout_templates add constraint pilot_workout_templates_difficulty_check
      check (difficulty in ('beginner','intermediate','advanced','elite'));
  end if;
  if not exists (select 1 from pg_constraint
                 where conname='pilot_wti_contact_level_check'
                   and conrelid='pilot.workout_template_items'::regclass) then
    alter table pilot.workout_template_items add constraint pilot_wti_contact_level_check
      check (contact_level in ('none','light_technical','conditioned','controlled_sparring','open_sparring'));
  end if;
  if not exists (select 1 from pg_constraint
                 where conname='pilot_workout_templates_version_check'
                   and conrelid='pilot.workout_templates'::regclass) then
    alter table pilot.workout_templates add constraint pilot_workout_templates_version_check
      check (version > 0);
  end if;
end
$$;

-- One ACTIVE name per gym. Partial, for the same reason the drills index
-- must become partial: a superseded v1 and an active v2 legitimately
-- share a name.
create unique index if not exists pilot_workout_templates_one_active_name
  on pilot.workout_templates(organization_id, name) where active;

create unique index if not exists pilot_workout_templates_lineage_version
  on pilot.workout_templates(organization_id, lineage_id, version);

create unique index if not exists pilot_wti_template_ordinal
  on pilot.workout_template_items(organization_id, template_id, ordinal);

create index if not exists pilot_workout_templates_library
  on pilot.workout_templates(organization_id, session_type, difficulty) where active;

comment on table pilot.workout_templates is
  'Reusable, gym-wide coaching session templates. No athlete identifier, no completion state, no effectiveness score, no prescribed sparring volume.';

comment on table pilot.workout_template_items is
  'Ordered items within a template, each referencing a catalogued drill or free text. Scale level is a coach preference, never a forced value; contact items above light_technical carry no duration or rep count.';
