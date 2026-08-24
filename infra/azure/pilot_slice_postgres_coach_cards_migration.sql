-- Coach Cards: coach-issued work on the existing assignment spine.
--
-- WHAT A COACH CARD IS
--
-- A Coach Card is a pilot.drill_assignments row a coach issues directly --
-- to one athlete (an individual card) or to every active member of a
-- pilot.programs program (a group card) -- with NO detection gap behind it.
-- The athlete sees it, logs completions against it, and the coach verifies
-- or disputes those completions, all through the tables and routes that
-- already exist. Nothing new is invented here: a card IS an assignment.
--
-- WHY gap_id RELAXES (the one guarantee this migration loosens)
--
-- pilot.drill_assignments.gap_id was NOT NULL with an ON DELETE CASCADE
-- foreign key to pilot.progression_gaps: every assignment had to descend
-- from a detected gap. A Coach Card is exactly the assignment that does
-- not -- "shadowbox 3 rounds before Friday" needs no diagnosis. The
-- alternative to relaxing the column would be writing a synthetic gap per
-- card, and synthetic gaps would surface as fake entries on the athlete's
-- own gap list, which reads to the athlete as "my coach identified a
-- deficiency" when no such thing happened. The honest schema is a nullable
-- anchor: gap-driven assignments keep their gap, cards carry NULL.
--
-- This follows the documented-relaxation pattern of
-- pilot_slice_postgres_drill_versioning_migration.sql (its
-- pilot_drills_one_name_per_org index): name the guarantee being loosened,
-- loosen it no further than the feature requires, and leave everything the
-- old guarantee protected still protected for the rows it applies to. The
-- foreign key itself is untouched -- a non-null gap_id must still name a
-- real gap, and deleting a gap still cascades the assignments LINKED to
-- it. What changes is only that gap deletion no longer reaches cards it
-- was never linked to: a NULL gap_id participates in no foreign key, so a
-- Coach Card survives every gap deletion by construction.
--
-- WHY issuance_id EXISTS
--
-- One group card issued to a program becomes one row per authorized
-- member. issuance_id is the shared tag that ties those rows back together
-- as "the card I issued Tuesday", so the coach's view can group per-athlete
-- progress under the single act of issuing rather than presenting N
-- unrelated assignments. Individual cards and every pre-existing
-- assignment carry NULL. The index is partial for the same reason
-- idx_pilot_drill_assignments_drill is (drills migration): rows with NULL
-- are never an answer to "what did this issuance create".
--
-- Idempotent like every migration in this directory: ALTER ... DROP NOT
-- NULL is a no-op on an already-nullable column, the column add and index
-- are `if not exists`, safe to re-run wholesale. No begin;/commit; here --
-- the runner (apps/web/scripts/pilot-apply-coach-cards-migration.mjs)
-- opens the transaction itself, matching the programs runner.
--
-- DEPENDS ON pilot.drill_assignments
-- (pilot_slice_postgres_progression_migration.sql), so `coach-cards` is
-- ordered after `progression` in apply-migrations.yml's `all` loop.

alter table pilot.drill_assignments
  alter column gap_id drop not null;

alter table pilot.drill_assignments
  add column if not exists issuance_id text null;

create index if not exists idx_pilot_drill_assignments_issuance
  on pilot.drill_assignments(organization_id, issuance_id)
  where issuance_id is not null;

comment on column pilot.drill_assignments.gap_id is
  'Nullable since the coach-cards migration: a gap-driven assignment names its gap, a Coach Card carries NULL. Non-null values keep the FK to pilot.progression_gaps and its ON DELETE CASCADE.';

comment on column pilot.drill_assignments.issuance_id is
  'Shared tag across the rows one group Coach Card issuance created (one row per authorized program member). NULL on individual cards and on every gap-driven assignment.';
