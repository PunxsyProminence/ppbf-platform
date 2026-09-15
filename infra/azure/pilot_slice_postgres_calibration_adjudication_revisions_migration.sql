-- Calibration adjudication revisions (OD-2026-08-29-005) -- superseding one
-- adjudication with a later one, without a lock.
--
-- STACKED ON the calibration adjudication migration. That file is NOT touched:
-- it is already applied wherever this schema exists, and rewriting an applied
-- migration is how two environments end up believing different things about the
-- same table.
--
-- WHAT WAS MISSING. A pair could be adjudicated twice and nothing said which
-- answer stood. Ordering by adjudicated_at is not the same guarantee: two
-- adjudications can share a timestamp, and a timestamp is a clock reading rather
-- than a declaration that one decision replaces another. `revision` makes the
-- supersession explicit -- highest revision for a pair IS the current answer,
-- and every earlier revision is retained as the record of what was thought
-- before.
--
-- THE PAIR IS THE ONE THE ROUTE ALREADY USES:
--   (organization_id, calibration_clip_id, annotation_set_id_a, annotation_set_id_b)
-- No unordered-pair rule is introduced. (A, B) and (B, A) remain distinct here,
-- exactly as the existing source_a/source_b FKs and the two_sets CHECK already
-- treat them -- A's event belongs to set A, and collapsing the orientation would
-- attribute an observation to the wrong annotator.
--
-- NO ROW LOCK, BY DECISION. Two administrators may compute the same next
-- revision concurrently. Neither waits on the other, and the unique constraint
-- below is the arbiter: the second writer's insert fails with 23505 naming
-- pilot_calibration_adjudications_pair_revision_uq, and the route translates
-- exactly that into a 409 telling them to read the answer that landed while they
-- were deciding. A lock would serialise administrators behind each other for a
-- decision that takes minutes of human thought, and would still not tell the
-- loser that somebody else had answered.
--
-- THE CONSTRAINT NAME IS LOAD-BEARING. The route matches SQLSTATE 23505 AND
-- this exact name, so an unrelated duplicate-key error is never reported as a
-- concurrent-correction conflict. Renaming it silently turns that translation
-- back into a raw duplicate-key dump.
--
-- NOT DECIDED HERE, and deliberately not implied: whether a surface shows only
-- the current revision or the full history, who may supersede an adjudication,
-- and what retention applies to superseded revisions. This migration only makes
-- supersession expressible and the race detectable.

-- ---------------------------------------------------------------------------
-- 1. The column, nullable first so existing rows can be backfilled.
-- ---------------------------------------------------------------------------
alter table pilot.calibration_adjudications
  add column if not exists revision integer;

-- ---------------------------------------------------------------------------
-- 2. Backfill, deterministically, per canonical pair in historical order.
--
-- The table is NOT assumed to be empty. Whether this schema has been applied to
-- a populated database is not knowable from here, and a backfill that only
-- works on an empty table is not a backfill.
--
-- The order is (adjudicated_at, adjudication_id) -- the same order
-- listAdjudicationsForClip already reads adjudications in, so the revision a
-- row receives matches the sequence the application has always displayed.
-- adjudication_id breaks ties because adjudicated_at can repeat; without it two
-- rows could receive the same revision and step 4 would then refuse to build
-- the constraint, which is the correct direction but a worse diagnosis.
--
-- Only rows with a null revision are touched, so re-running assigns nothing
-- twice and cannot renumber a row the server has since written.
-- ---------------------------------------------------------------------------
with ordered as (
  select
    organization_id,
    adjudication_id,
    row_number() over (
      partition by organization_id, calibration_clip_id,
                   annotation_set_id_a, annotation_set_id_b
      order by adjudicated_at asc, adjudication_id asc
    ) as computed_revision
  from pilot.calibration_adjudications
  where revision is null
)
update pilot.calibration_adjudications as target
   set revision = ordered.computed_revision
  from ordered
 where target.organization_id = ordered.organization_id
   and target.adjudication_id = ordered.adjudication_id
   and target.revision is null;

-- ---------------------------------------------------------------------------
-- 3. Required, and positive.
--
-- No DEFAULT on purpose. The server computes the next revision for the pair it
-- is writing; a default would let an insert that forgot to supply one land a
-- plausible-looking row instead of failing, and the value it landed would be
-- wrong for every pair that already had revisions.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'pilot'
      and table_name = 'calibration_adjudications'
      and column_name = 'revision'
      and is_nullable = 'YES'
  )
  then
    alter table pilot.calibration_adjudications
      alter column revision set not null;
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = to_regclass('pilot.calibration_adjudications')
      and conname = 'pilot_calibration_adjudications_revision_positive'
  )
  then
    alter table pilot.calibration_adjudications
      add constraint pilot_calibration_adjudications_revision_positive
      check (revision >= 1);
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 4. The arbiter. This is what makes the lock unnecessary.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = to_regclass('pilot.calibration_adjudications')
      and conname = 'pilot_calibration_adjudications_pair_revision_uq'
  )
  then
    alter table pilot.calibration_adjudications
      add constraint pilot_calibration_adjudications_pair_revision_uq
      unique (organization_id, calibration_clip_id,
              annotation_set_id_a, annotation_set_id_b, revision);
  end if;
end
$$;

-- Reading the current answer for a pair is a max(revision) lookup, and the
-- unique constraint's own index serves it: its leading columns are exactly the
-- pair. No second index is added for that.
