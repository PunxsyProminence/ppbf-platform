-- Drill identity (pilot.drills) -- a drill as a record of the gym, not a string.
--
-- A drill has no identity on this platform. pilot.drill_assignments stores
-- drill_name and drill_description as free text with no foreign key, so two
-- coaches who assign the same drill produce two unrelated strings and nothing
-- can attach to "the jab retraction drill" across assignments -- not a cue
-- change, not a category, not a count of how often it was given. The athlete
-- drill library is three drills hardcoded in a useState initializer in
-- apps/web/components/AthleteWorkspace.tsx, identical in every gym, editable
-- only by a deploy.
--
-- This table makes a drill a fact about the organization.
--
-- NO RANK COLUMN. The hardcoded library carries minRank values ('TIRO',
-- 'DISCIPULUS') that exist nowhere else in the codebase -- there is no rank
-- table, no rank column on pilot.athletes, and nothing that can answer whether
-- a given athlete has reached one. A column here would be a label with no
-- authority behind it. difficulty is the vocabulary the database already
-- carries: it matches pilot.drill_assignments.drill_difficulty exactly
-- ('beginner', 'intermediate', 'advanced', 'elite'), so the difficulty of a
-- drill and the difficulty recorded on an assignment of it are one vocabulary.
--
-- WHAT THIS TABLE DELIBERATELY DOES NOT HOLD: no athlete identifier, no
-- assignment reference, no completion state. A drill is gym-wide coaching
-- content -- the same row is read by every athlete in the organization -- so a
-- column naming one minor here would be visible to all of them. Who was
-- assigned what stays in pilot.drill_assignments, which is athlete-scoped and
-- read through the athlete's own authorization.
--
-- ONE NAME PER GYM, ENFORCED BY THE DATABASE: a unique index over
-- (organization_id, name). Two rows named "Straight Jab Retraction Snap" in one
-- gym is an ambiguous anchor, which is the exact failure the free-text columns
-- already have. Application code cannot enforce it -- two concurrent creates
-- each read no existing row and both write -- so only the index holds. The
-- index is organization-scoped, so a different gym naming its drill the same
-- thing is unaffected; every gym names its own drills.
--
-- cues is text[] rather than a child table. A cue is an ordered line of
-- coaching copy with no identity of its own, nothing references one, and the
-- only read is "every cue for this drill". Its default is the empty array, not
-- NULL: a drill whose cues nobody has written yet has no cues, and a reader
-- that renders zero cues renders nothing rather than an empty list shell.
--
-- active retires a drill without deleting it. A gym stops teaching a drill far
-- more often than it decides the drill never existed, and the assignments that
-- reference it are history.
--
-- THE COLUMN ADDED TO pilot.drill_assignments IS NULLABLE AND ADDITIVE
--
-- drill_id is nullable on purpose. Every assignment written before this
-- migration carries only free text, and all of them must keep working
-- untouched -- reads, updates and completion tracking alike. A NOT NULL column
-- would refuse every one of them, and a backfill that guessed which drill a
-- string meant would be inventing a fact.
--
-- drill_name and drill_description are NOT dropped and NOT rewritten. A
-- historical assignment's typed name is the only record of what was actually
-- assigned on that day; a drill can be renamed afterwards, and the assignment
-- must still say what the coach wrote. The two coexist: drill_id is the anchor,
-- drill_name is the record.
--
-- The foreign key is composite over (organization_id, drill_id), so an
-- assignment can only reference a drill belonging to the same organization --
-- a scalar key on drill_id alone would let one gym's assignment point at
-- another gym's drill. Under the default MATCH SIMPLE, a row with drill_id NULL
-- satisfies the constraint regardless of organization_id, which is what keeps
-- the legacy path writable.
--
-- ON DELETE RESTRICT, not SET NULL. Deleting a drill that assignments reference
-- is refused outright, so no assignment ever silently loses its anchor and
-- degrades back to the free text this migration exists to move past. Retiring a
-- drill is what `active = false` is for, and it leaves history intact. SET NULL
-- would also have to name a column list to avoid nulling the NOT NULL
-- organization_id half of the composite key, which is a PostgreSQL 15+ syntax
-- this file has no reason to depend on. A drill no assignment references still
-- deletes cleanly.
--
-- DEPENDS ON pilot.drill_assignments
--
-- pilot_slice_postgres_progression_migration.sql creates that table, and the
-- `all` loop orders it ahead of this one; dispatching `drills` alone against a
-- fresh environment requires `progression` first.
--
-- No `begin;`/`commit;` here on purpose: the runner
-- (apps/web/scripts/pilot-apply-drills-migration.mjs) opens the transaction
-- itself, matching the announcements / volunteer-program / board-seats
-- convention. The shadow-runtime runner takes the opposite one.

create table if not exists pilot.drills (
  organization_id text not null references pilot.organizations(organization_id),
  drill_id text not null,
  name text not null,
  category text not null,
  focus text not null,
  cues text[] not null default '{}'::text[],
  difficulty text not null default 'intermediate',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pilot_drills_pkey primary key (organization_id, drill_id)
);

-- PostgreSQL has no `add constraint if not exists`, so the vocabulary
-- constraint is catalog-guarded. Declaring it here rather than inline in the
-- create-table keeps exactly one copy of the four levels in this file and
-- reaches a table that was created before this migration existed.
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'pilot_drills_difficulty_check'
      and conrelid = 'pilot.drills'::regclass
  ) then
    alter table pilot.drills
      add constraint pilot_drills_difficulty_check
      check (difficulty in ('beginner', 'intermediate', 'advanced', 'elite'));
  end if;
end
$$;

-- The rule the anchor depends on, in the only place that can hold it.
create unique index if not exists pilot_drills_one_name_per_org
  on pilot.drills(organization_id, name);

-- The library read: one gym's drills that are still taught, grouped the way the
-- workspace lists them. The primary key serves the by-id read.
create index if not exists idx_pilot_drills_org_active
  on pilot.drills(organization_id, active, category, name);

alter table pilot.drill_assignments
  add column if not exists drill_id text null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'pilot_drill_assignments_fk_drill'
      and conrelid = 'pilot.drill_assignments'::regclass
  ) then
    alter table pilot.drill_assignments
      add constraint pilot_drill_assignments_fk_drill
      foreign key (organization_id, drill_id)
      references pilot.drills(organization_id, drill_id)
      on delete restrict;
  end if;
end
$$;

-- Every assignment of one drill -- the read that free text could never serve.
-- Partial, because every assignment that predates this migration carries NULL
-- and none of them is ever an answer to that question.
create index if not exists idx_pilot_drill_assignments_drill
  on pilot.drill_assignments(organization_id, drill_id)
  where drill_id is not null;

comment on table pilot.drills is
  'Organization-scoped drill identity. pilot.drill_assignments.drill_id anchors an assignment to a drill; drill_name on that assignment remains the record of what was typed when it was assigned.';
