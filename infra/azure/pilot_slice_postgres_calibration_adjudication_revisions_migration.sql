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
-- had settled a different one. The owner chose this reading on 2026-10-01.
--
-- EITHER SOURCE EVENT MAY BE NULL: an EVENT_MISSED decision has an event on one
-- side only. Two such decisions about the same lone event ARE the same
-- disagreement and must collide, which a plain unique constraint would not do
-- (NULLs are distinct there). The arbiter is therefore a unique INDEX in which
-- each mark contributes TWO key parts: whether it is null, and its value.
-- Nullness is its own key part so that "no mark" can never be the same key as
-- a mark whose id happens to be the empty string -- nothing in the events
-- table forbids '' as an id. That is exactly how `is not distinct from` (the
-- server's next-revision query, and the trigger below) and PARTITION BY (the
-- backfill) group, so all four agree on what one disagreement is. NULLS NOT
-- DISTINCT would say the same thing but needs PostgreSQL 15.
--
-- No unordered-pair rule is introduced. (A, B) and (B, A) remain distinct here,
-- exactly as the existing source_a/source_b FKs and the two_sets CHECK already
-- treat them -- A's event belongs to set A, and collapsing the orientation would
-- attribute an observation to the wrong annotator. The HTTP route always files
-- the two readings in the gate's own order, so this is a property of the table
-- and not something a caller of the route can choose.
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
-- and what retention applies to superseded revisions.
--
-- BOTH IMAGES CAN LIVE ON THIS SCHEMA. The application image that existed
-- before this migration inserts an adjudication WITHOUT naming a revision. A
-- NOT NULL column alone would refuse every one of those writes, so applying
-- this would break the running image until the next deploy landed, and a
-- failed deploy or a rollback would leave nobody able to record a decision.
-- The BEFORE INSERT trigger in step 5 closes that: an insert that names no
-- revision is given the disagreement's next one by the database, with the same
-- lock-free arithmetic the newer image performs itself. So:
--   * this schema + the PREVIOUS image: reads unchanged (it selects named
--     columns); writes succeed and are numbered by the trigger. It has no
--     stale-view check, and the loser of a race gets an untranslated error,
--     which is what that image would have done with any database error.
--   * this schema + the image that writes `revision`: the image names the
--     revision; the trigger does nothing.
--   * the PREVIOUS schema + the image that writes `revision` does not work
--     (the column is missing). Apply this before deploying that image.
-- Nothing here needs the two to change at the same instant, and rolling the
-- image back after applying this is safe.
--
-- The trigger can be removed once no image that omits the revision can be
-- deployed or rolled back to. Removing it is optional hardening (an insert
-- that forgets the revision would then be refused instead of numbered), not
-- something correctness waits on.
--
-- SAFE ON A TABLE THAT ALREADY HOLDS ROWS. The column is added nullable,
-- backfilled, and only then made NOT NULL and unique, all inside the runner's
-- one transaction, so a failure at any step leaves the table as it was. No
-- trigger existed on this table before this file (the gold migration's three
-- are all on pilot.calibration_gold_records), and the one added here fires on
-- INSERT only, so the backfill UPDATE is not refused or renumbered.
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
-- 2. REFUSE A HISTORY WHOSE ORDER CANNOT BE ESTABLISHED.
--
-- The backfill makes the LATEST existing answer to a disagreement the current
-- one. "Latest" is adjudicated_at. Where two un-numbered answers to one
-- disagreement carry the same adjudicated_at there is no recorded fact that
-- says which came second -- adjudication_id is a random UUID and created_at is
-- the same clock reading -- and choosing one would invent which decision
-- stands. So this stops, changes nothing (the runner rolls the whole file
-- back), and says how many disagreements are affected.
--
-- WHAT A TIE COSTS, stated plainly: this migration cannot be applied to that
-- database until the tie is gone, and in an `all` dispatch every migration
-- listed after this one is held back with it. The only way forward is for a
-- person to decide which of the tied answers stands and for the data to be
-- changed to say so. Nothing here makes that choice and no tool for it exists.
-- apps/web/scripts/pilot-preflight-calibration-adjudication-revisions.mjs
-- reports the count read-only, so it can be known before a dispatch.
--
-- Only rows with a null revision are examined, so once the migration has been
-- applied this finds nothing: every later row is numbered as it is written.
-- ---------------------------------------------------------------------------
do $$
declare
  tied_disagreements integer;
begin
  select count(*) into tied_disagreements
    from (
      select 1
        from pilot.calibration_adjudications
       where revision is null
       group by organization_id, calibration_clip_id,
                annotation_set_id_a, annotation_set_id_b,
                source_event_id_a, source_event_id_b,
                adjudicated_at
      having count(*) > 1
    ) tied;

  if tied_disagreements > 0 then
    raise exception
      'CALIBRATION_ADJUDICATION_BACKFILL_TIE: % disagreement(s) hold two or more existing adjudications with the same adjudicated_at, so which one is current cannot be established from the data. Nothing was changed.',
      tied_disagreements;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 3. Backfill, per disagreement in recorded order.
--
-- The table is NOT assumed to be empty.
--
-- PARTITION BY treats NULLs as equal, so two EVENT_MISSED decisions about the
-- same lone event land in one partition -- the grouping the index in step 6
-- enforces. Step 2 has already established that adjudicated_at is a total
-- order inside every partition, so nothing else is needed to break a tie.
--
-- Only rows with a null revision are touched, so re-running assigns nothing
-- twice and cannot renumber a row written since. That holds because this file
-- runs as ONE transaction (the runner's): a null revision can then only exist
-- before the first apply, when every row is null. Run statement by statement
-- outside a transaction, with the application writing in between, the
-- numbering would restart at 1 beside rows already numbered and step 6 would
-- refuse to build the index.
-- ---------------------------------------------------------------------------
with ordered as (
  select
    organization_id,
    adjudication_id,
    row_number() over (
      partition by organization_id, calibration_clip_id,
                   annotation_set_id_a, annotation_set_id_b,
                   source_event_id_a, source_event_id_b
      order by adjudicated_at asc
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
-- 4. Required, and positive.
--
-- No DEFAULT: a constant would be wrong for every disagreement that already
-- has an answer. The trigger in step 5 is what numbers an insert that names no
-- revision, and it fires BEFORE the NOT NULL is checked.
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
-- 5. An insert that names no revision gets the disagreement's next one.
--
-- This is what lets the image that predates the column keep recording
-- decisions on this schema (see the header). It takes no lock: two such
-- inserts for one disagreement can compute the same number, and the index in
-- step 6 refuses the second, exactly as it does for the newer image.
--
-- An insert that DOES name a revision is left alone.
-- ---------------------------------------------------------------------------
create or replace function pilot.calibration_adjudications_assign_revision()
returns trigger
language plpgsql
as $pilot_calibration_adjudications_assign_revision$
begin
  if new.revision is null then
    select coalesce(max(existing.revision), 0) + 1
      into new.revision
      from pilot.calibration_adjudications existing
     where existing.organization_id = new.organization_id
       and existing.calibration_clip_id = new.calibration_clip_id
       and existing.annotation_set_id_a = new.annotation_set_id_a
       and existing.annotation_set_id_b = new.annotation_set_id_b
       and existing.source_event_id_a is not distinct from new.source_event_id_a
       and existing.source_event_id_b is not distinct from new.source_event_id_b;
  end if;
  return new;
end;
$pilot_calibration_adjudications_assign_revision$;

drop trigger if exists pilot_calibration_adjudications_assign_revision
  on pilot.calibration_adjudications;
create trigger pilot_calibration_adjudications_assign_revision
  before insert on pilot.calibration_adjudications
  for each row
  execute function pilot.calibration_adjudications_assign_revision();

-- ---------------------------------------------------------------------------
-- 6. The arbiter. This is what makes the lock unnecessary.
--
-- An index rather than a table constraint because of the expressions (see the
-- header). `if not exists` goes by name; the runner's readiness query checks
-- the SHAPE, so a same-named index of another shape fails the dispatch instead
-- of passing as this one.
-- ---------------------------------------------------------------------------
create unique index if not exists pilot_calibration_adjudications_decision_revision_uq
  on pilot.calibration_adjudications (
    organization_id, calibration_clip_id,
    annotation_set_id_a, annotation_set_id_b,
    (source_event_id_a is null), coalesce(source_event_id_a, ''),
    (source_event_id_b is null), coalesce(source_event_id_b, ''),
    revision
  );
