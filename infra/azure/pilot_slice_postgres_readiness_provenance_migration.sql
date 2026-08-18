-- Readiness provenance: make pilot.readiness state where its number came from.
--
-- THE DEFECT. pilot.readiness stores a bare `score numeric` and `category
-- text` with no formula, no provenance, and no validation columns. Nothing
-- records what produced the score or whether that method was ever
-- established. Three engine proposals (modules 021, 029 and 033 in
-- docs/capabilities/proposals/engine-unlock/) each INDEPENDENTLY recommended
-- excluding readiness as an engine input rather than inheriting a number they
-- cannot audit. The full fact-finding is in
-- docs/capabilities/READINESS_PROVENANCE_FACTS.md.
--
-- WHAT THE NUMBER ACTUALLY IS TODAY. One production write path
-- (intake.ts#createReadiness) which computes nothing and stores whatever its
-- caller hands it, driven by two staff-facing intake routes. The formula that
-- looks like it backs this table (readinessMath.ts#calculateReadinessL14, with
-- uncited coefficients 125/45/30) is DEAD CODE -- its only caller is its own
-- unit test, and it never writes here. Two source comments currently claim
-- otherwise and are corrected alongside this migration.
--
-- WHY THIS MATTERS RATHER THAN BEING TIDINESS. The score drives a GREEN/
-- YELLOW/RED dot on the coach floor that coaches are told to use to "adjust
-- coaching intensity", it flags athletes by RED-day count, and it is an
-- admissible EVIDENCE SOURCE for intervention outcome review. A number nobody
-- can audit is worse than no number, because it looks usable.
--
-- THE VOCABULARY IS BORROWED, NOT INVENTED. reliability_status,
-- validity_status and evidence_class are the same three columns, with the same
-- three default values, that pilot.assessment_protocols already carries
-- (pilot_slice_postgres_assessment_protocols_migration.sql). That table's own
-- comment states the principle this migration is applying here: "this platform
-- does not fabricate measurement properties it has not established." Readiness
-- was simply exempt from it.
--
-- These three describe the METHOD that produced a reading, not the reading
-- itself, and they are stamped onto the row at write time rather than joined
-- from a catalog. That is deliberate: the audit question is "how much did we
-- know about this number when somebody acted on it", and a stamped answer
-- survives a method later being validated. A one-row catalog table would also
-- be more machinery than one method justifies today.
--
-- HONEST BACKFILL. Existing rows record method 'UNKNOWN'. That is the true
-- answer -- the write path never recorded provenance, so it cannot be
-- recovered now, and guessing a confident label during a migration would be
-- the exact fabrication this change exists to end. The column is added WITH a
-- default so existing rows can take it, then the default is DROPPED, so from
-- here on an insert that does not state a method fails on the not-null
-- constraint rather than silently inheriting 'UNKNOWN'.
--
-- NOT DONE HERE, DELIBERATELY: no formula is invented to justify existing
-- scores, no new readiness score is computed, and calculateReadinessL14 stays
-- dead. Wiring it would first require establishing its coefficients, which is
-- a research and owner decision, not a migration.
--
-- APPLIED TO BOTH DEFINITIONS. pilot.readiness is created in
-- pilot_slice_postgres.sql AND in pilot_slice_postgres_multiorg_migration.sql.
-- This migration alters the live table, so it covers an environment built from
-- either -- but the two base definitions are left untouched on purpose, in
-- keeping with this repo's additive-increment convention.
--
-- Idempotent: add column if not exists, guarded backfill, catalog-guarded
-- constraint, no drops of data, no destructive alters.
-- No begin;/commit; here on purpose, matching this repo's
-- runner-opens-the-transaction convention (the runner is
-- apps/web/scripts/pilot-apply-readiness-provenance-migration.mjs).

-- What produced this score. 'UNKNOWN' is a real, permitted value and is what
-- every pre-existing row carries.
alter table pilot.readiness
  add column if not exists method text not null default 'UNKNOWN';

-- The method's measurement properties, in assessment_protocols' vocabulary.
alter table pilot.readiness
  add column if not exists reliability_status text not null default 'UNVALIDATED - PPBF MUST ESTABLISH';

alter table pilot.readiness
  add column if not exists validity_status text not null default 'UNKNOWN';

alter table pilot.readiness
  add column if not exists evidence_class text not null default 'INSUFFICIENT EVIDENCE';

-- Who entered it, when a human did. Nullable because a future computed method
-- has no human author, and because the pre-existing rows genuinely have no
-- recorded one -- a fabricated attribution would be its own dishonesty.
alter table pilot.readiness
  add column if not exists recorded_by_account_id text null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'pilot_readiness_recorded_by_fk'
      and conrelid = to_regclass('pilot.readiness')
  ) then
    alter table pilot.readiness add constraint pilot_readiness_recorded_by_fk
      foreign key (recorded_by_account_id) references pilot.accounts(account_id);
  end if;
end
$$;

-- The method vocabulary, deliberately narrow: these are the only two honest
-- values today. 'staff_entered_intake' is what both live write paths actually
-- do -- a person typed the number during intake review. A future computed
-- method must widen this list in its own migration, which is the point: it
-- forces the decision to be recorded rather than absorbed silently.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'pilot_readiness_method_check'
      and conrelid = to_regclass('pilot.readiness')
  ) then
    alter table pilot.readiness add constraint pilot_readiness_method_check
      check (method in ('UNKNOWN', 'staff_entered_intake'));
  end if;
end
$$;

-- The default exists ONLY so the columns can be added to a table that already
-- has rows. Dropping it is what makes the not-null constraint bite: after
-- this, an insert that omits `method` fails rather than quietly claiming
-- 'UNKNOWN' on a row whose provenance the writer actually knew.
--
-- The three measurement-property columns KEEP their defaults, matching
-- assessment_protocols, where an unstated property correctly reads as
-- unvalidated. Defaulting those toward "not established" is safe in a way
-- defaulting provenance toward 'UNKNOWN' is not.
alter table pilot.readiness
  alter column method drop default;

comment on column pilot.readiness.method is
  'What produced this score. UNKNOWN means provenance was never recorded (every row predating this column). Not defaulted: an insert must state it.';

comment on column pilot.readiness.reliability_status is
  'Reliability of the METHOD that produced this score, not of this reading. Same vocabulary as pilot.assessment_protocols.';

comment on column pilot.readiness.validity_status is
  'Validity of the METHOD that produced this score, not of this reading. Same vocabulary as pilot.assessment_protocols.';

comment on column pilot.readiness.evidence_class is
  'Evidence class of the METHOD that produced this score. Same vocabulary as pilot.assessment_protocols.';

comment on table pilot.readiness is
  'Readiness readings. Every row states what method produced it and that method''s measurement properties -- a score whose provenance is UNKNOWN must not be presented as a measurement. Scores are staff-entered during intake review; no validated formula writes here.';
