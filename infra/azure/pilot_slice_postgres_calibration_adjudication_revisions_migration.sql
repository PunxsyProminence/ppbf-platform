-- Calibration adjudication revisions (OD-2026-08-29-005) -- superseding one
-- adjudication with a later one, without a lock.
--
-- STACKED ON the calibration adjudication migration. That file is NOT touched:
-- it is already applied wherever this schema exists, and rewriting an applied
-- migration is how two environments end up believing different things about the
-- same table.
--
-- WHAT WAS MISSING. One disagreement could be adjudicated twice and nothing
-- said which answer stood. Ordering by adjudicated_at is not the same guarantee:
-- two adjudications can share a timestamp, and a timestamp is a clock reading
-- rather than a declaration that one decision replaces another. `revision`
-- makes the supersession explicit -- the highest revision for a disagreement IS
-- the current answer, and every earlier revision is retained as the record of
-- what was thought before.
--
-- THE PAIR IS THE PAIR OF MARKS A DECISION IS ABOUT:
--   (organization_id, calibration_clip_id,
--    annotation_set_id_a, annotation_set_id_b,
--    source_event_id_a, source_event_id_b)
-- A row of this table is ONE decision about ONE disagreement -- the two source
-- events it names -- and a clip carries as many rows as it has disagreements,
-- all sharing one clip and one pair of annotation sets. Scoping the revision to
-- the two sets alone would number unrelated decisions 1..N on a clip, make the
-- latest of them read as superseding the others, and tell an administrator
-- settling one disagreement that somebody had corrected it when a colleague
-- had settled a different one. (Owner, 2026-10-01, on being shown both
-- readings of "pair": "go with recomendations" -- this one.)
--
-- EITHER SOURCE EVENT MAY BE NULL: an EVENT_MISSED decision has an event on one
-- side only. Two such decisions about the same lone event ARE the same
-- disagreement and must collide, which a plain unique constraint would not do
-- (NULLs are distinct there). The arbiter is therefore a unique INDEX over
-- coalesce(source_event_id, ''). '' cannot be a real event id on the route's
-- path: it normalises '' to "no event on this side" before the write. NULLS
-- NOT DISTINCT would say the same thing but needs PostgreSQL 15.
--
-- No unordered-pair rule is introduced. (A, B) and (B, A) remain distinct here,
-- exactly as the existing source_a/source_b FKs and the two_sets CHECK already
-- treat them -- A's event belongs to set A, and collapsing the orientation would
-- attribute an observation to the wrong annotator.
--
-- NO ROW LOCK, BY DECISION. Two administrators may compute the same next
-- revision concurrently. Neither waits on the other, and the unique index
-- below is the arbiter: the second writer's insert fails with 23505 naming
-- pilot_calibration_adjudications_decision_revision_uq, and the route
-- translates exactly that into a 409 telling them to read the answer that
-- landed while they were deciding. A lock would serialise administrators behind
-- each other for a decision that takes minutes of human thought, and would
-- still not tell the loser that somebody else had answered.
--
-- THE INDEX NAME IS LOAD-BEARING. The route matches SQLSTATE 23505 AND this
-- exact name, so an unrelated duplicate-key error is never reported as a
-- concurrent-correction conflict. Renaming it silently turns that translation
-- back into a raw duplicate-key dump.
--
-- NOT DECIDED HERE, and deliberately not implied: whether a surface shows only
-- the current revision or the full history, who may supersede an adjudication,
-- and what retention applies to superseded revisions. This migration only makes
-- supersession expressible and the race detectable.
--
-- NOT CAUGHT BY THIS INDEX: a decision made on a view that went stale. A
-- second adjudication recorded after the first has committed is simply the
-- next revision. The index refuses two inserts that overlap, nothing more.
--
-- SAFE ON A TABLE THAT ALREADY HOLDS ROWS. The column is added nullable,
-- backfilled, and only then made NOT NULL and unique, all inside the runner's
-- one transaction, so a failure at any step leaves the table as it was. No
-- trigger exists on this table (the gold migration's three are all on
-- pilot.calibration_gold_records), so the backfill UPDATE is not refused.
--
-- RELEASE WINDOW. The column is NOT NULL with no default, so this migration
-- and the application image that writes `revision` have to go out together:
--   * this schema + the PREVIOUS image: every adjudication write fails on the
--     NOT NULL (reads still work);
--   * the new image + the PREVIOUS schema: reads and writes of adjudications
--     fail on the missing column.
-- Apply this, then deploy, close together, and do not roll the image back
-- past this change once it is applied.
--
-- Additive and idempotent. No `begin;`/`commit;` here on purpose: the runner
-- (apps/web/scripts/pilot-apply-calibration-adjudication-revisions-migration.mjs)
-- opens the transaction itself.

-- ---------------------------------------------------------------------------
-- 1. The column, nullable first so existing rows can be backfilled.
-- ---------------------------------------------------------------------------
alter table pilot.calibration_adjudications
  add column if not exists revision integer;

-- ---------------------------------------------------------------------------
-- 2. Backfill, deterministically, per disagreement in historical order.
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
-- the index, which is the correct direction but a worse diagnosis.
--
-- PARTITION BY treats NULLs as equal, so two EVENT_MISSED decisions about the
-- same lone event land in one partition -- the same grouping the index in
-- step 4 enforces through coalesce.
--
-- Only rows with a null revision are touched, so re-running assigns nothing
-- twice and cannot renumber a row the server has since written. That holds
-- because this file runs as ONE transaction (the runner's): a null revision
-- can then only exist before the first apply, when every row is null. Run
-- statement by statement outside a transaction, with the application writing
-- in between, the numbering would restart at 1 beside rows already numbered
-- and step 4 would refuse to build the index.
-- ---------------------------------------------------------------------------
with ordered as (
  select
    organization_id,
    adjudication_id,
    row_number() over (
      partition by organization_id, calibration_clip_id,
                   annotation_set_id_a, annotation_set_id_b,
                   source_event_id_a, source_event_id_b
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
-- No DEFAULT on purpose. The server computes the next revision for the
-- disagreement it is writing; a default would let an insert that forgot to
-- supply one land a plausible-looking row instead of failing, and the value it
-- landed would be wrong for every disagreement that already had an answer.
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
--
-- An index rather than a table constraint because of the coalesce (see the
-- header). `if not exists` goes by name; the runner's readiness query checks
-- the SHAPE, so a same-named index of another shape fails the dispatch instead
-- of passing as this one.
-- ---------------------------------------------------------------------------
create unique index if not exists pilot_calibration_adjudications_decision_revision_uq
  on pilot.calibration_adjudications (
    organization_id, calibration_clip_id,
    annotation_set_id_a, annotation_set_id_b,
    coalesce(source_event_id_a, ''), coalesce(source_event_id_b, ''),
    revision
  );
