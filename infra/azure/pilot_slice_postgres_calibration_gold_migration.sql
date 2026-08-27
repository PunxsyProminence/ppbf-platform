-- Calibration gold / reference-dataset governance
-- (pilot.calibration_gold_records) -- the deliberate act by which an
-- adjudicated reading becomes part of a governed reference dataset, and the
-- one-way ratchet that keeps a held-out test set held out.
--
-- STACKED ON the calibration adjudication migration. It needs
-- pilot.calibration_adjudications, pilot.calibration_annotation_sets and
-- pilot.calibration_clips to exist.
--
-- WHY THIS TABLE EXISTS AT ALL. The four slices beneath it produce readings
-- and decisions. None of them produces a DATASET. The gap between "a reviewer
-- settled this disagreement" and "this is reference data we build against" is
-- exactly where a research corpus quietly assembles itself out of everything
-- that happened to be adjudicated -- and a corpus nobody chose is a corpus
-- nobody can defend. This table makes that gap an explicit, attributed,
-- per-record act.
--
-- NOTHING IS PROMOTED AUTOMATICALLY, AND NOTHING ARRIVES PROMOTED. A row
-- enters as 'candidate'. Becoming 'gold' requires a separate UPDATE that names
-- a human and a time, tied to the state by a CHECK in both directions -- the
-- same shape pilot_film_study_proposals_attested_v2 uses to tie a review
-- verdict to its reviewer. A trigger additionally refuses any INSERT that
-- tries to arrive as 'gold', because the CHECK alone would happily accept a
-- row born promoted so long as it carried a name, and "deliberate" has to mean
-- a second act rather than a well-filled first one.
--
-- THE LOAD-BEARING RULE, AND THE WHOLE REASON THIS SLICE EXISTS.
--
--   A LOCKED_TEST record may never become TRAINING_ELIGIBLE.
--
-- It is enforced by a trigger, in the database, and it could not honestly live
-- anywhere else. The doctrine is already written down in this repository, on
-- pilot.feedback_submissions_freeze_disclosure:
--
--   "Application code cannot hold it: any process with write access -- a
--    migration of detection rules, a backfill, a well-meant cleanup -- can
--    issue the UPDATE that reclassifies a disclosure, and only the database
--    sees all of them."
--
-- It applies here exactly, and the consequence is worse than a mislabelled
-- disclosure. A held-out test set silently reclassified as training data does
-- not fail loudly; it produces an evaluation number that looks fine and means
-- nothing, and every decision taken on the strength of that number is taken on
-- no evidence at all. The failure direction is silence. That is why the rule
-- is a trigger and not a code path in calibration/gold.ts: the module is the
-- narrow door, and the trigger is the floor under every other door.
--
-- THE THREE TRANSITION DECISIONS, MADE DELIBERATELY AND RECORDED HERE.
--
--   1. LOCKED_TEST -> TRAINING_ELIGIBLE: REFUSED. The rule above.
--
--   2. LOCKED_TEST -> VALIDATION_ONLY: ALSO REFUSED, so LOCKED_TEST is
--      terminal rather than merely one-directional. Two reasons, and the
--      second is decisive.
--
--      The first is that any loosening of a held-out set is the thing this
--      guards. Validation data is read repeatedly during development; a test
--      set that has been read during development is no longer held out, and
--      the row would still be sitting there claiming otherwise.
--
--      The second is that refusing only the direct move leaves a two-step
--      launder wide open. LOCKED_TEST -> VALIDATION_ONLY -> TRAINING_ELIGIBLE
--      reaches the forbidden state through two individually-legal updates, and
--      a backfill can issue two statements as easily as one. A rule that can
--      be walked around in two hops is not a rule. Making LOCKED_TEST terminal
--      is what makes the rule un-launderable rather than merely stated.
--
--   3. TRAINING_ELIGIBLE -> LOCKED_TEST, TRAINING_ELIGIBLE -> VALIDATION_ONLY,
--      VALIDATION_ONLY -> LOCKED_TEST: ALL ALLOWED. Tightening is safe in a
--      way loosening is not. Moving a record OUT of the training pool can only
--      shrink what a model was trained on; it can never contaminate an
--      evaluation, and it is the correct response to discovering that a clip
--      belongs in the held-out set after all. The ratchet turns one way, and
--      that way is toward less training data, never more.
--
--   The cost, stated plainly rather than left to be discovered: an eligibility
--   set too tight by mistake cannot be loosened. The remedy is to delete the
--   row and nominate again. That is deliberate. A DELETE is total and visible;
--   an UPDATE wearing the same primary key is the thing that hides. And a
--   residual hole is admitted rather than papered over -- a process with write
--   access can still DELETE a LOCKED_TEST record and INSERT a TRAINING_ELIGIBLE
--   one for the same reading. It is not closed here because the only way to
--   close it would be to refuse DELETE, and this table must never be able to
--   refuse a deletion made on behalf of a minor (see DELETION below).
--
-- ONE GOVERNANCE RECORD PER ADJUDICATION, enforced by a unique constraint, and
-- this is not tidiness. Without it the ratchet has a flanking route that needs
-- no UPDATE at all: leave the LOCKED_TEST row alone and simply INSERT a
-- second, TRAINING_ELIGIBLE record for the same adjudicated reading. Two rows
-- disagreeing about whether one reading is held out is precisely the state the
-- ratchet exists to prevent, so the schema refuses the second row as well as
-- the transition.
--
-- PROVENANCE IS COLUMNS AND FOREIGN KEYS, NOT A jsonb BLOB. Every gold record
-- names its source project, its source clip, the source video that clip was
-- cut from, the ontology version, the adjudication and adjudicator it came
-- from, and BOTH annotators' set ids. A gold record that cannot say which two
-- people produced the reading it came from is not governed data; it is an
-- assertion with a nice column name. Each of those is carried as a real column
-- inside a composite foreign key, so it cannot merely be PRESENT -- it has to
-- be TRUE. The project and the video are checked against the clip itself, and
-- the two annotator sets and the adjudicator are checked against the
-- adjudication itself, so a gold record physically cannot name a plausible
-- provenance that is not its own.
--
-- PROVENANCE IS ALSO FROZEN. The foreign keys stop a record pointing at an
-- INCONSISTENT provenance; they do nothing to stop it being repointed at
-- another perfectly consistent one, which would let a promoted record keep its
-- attribution while quietly changing what it is a record OF. A trigger refuses
-- every update to those columns, for the reason the freeze-disclosure comment
-- gives: only the database sees all the writers.
--
-- WHAT IS DELIBERATELY NOT HERE.
--
--   * No accuracy, confidence, quality or agreement score. Not omitted for
--     later -- refused. A number attached to a gold record would be read as a
--     property of the reading rather than of the process that produced it, and
--     nothing in this subsystem has earned the right to publish one.
--   * No athlete_id. Deletion already reaches these rows through the clip, so
--     the column would buy nothing operational and would attach a named minor
--     to a research artifact. Calibration data is not athlete truth.
--   * No training, no export, no feeder, no model, no HTTP route, no UI. This
--     migration governs what MAY be used. It uses nothing.
--   * No attribution on exclusion. An 'excluded' record names nobody -- a
--     known gap, recorded rather than half-built. The columns for it would
--     need their own CHECK tying them to the state, and that is a decision for
--     whoever needs the exclusion audit, not a guess made now.
--
-- DELETION STILL WORKS, AND MUST. Every table in this subsystem cascades from
-- footage and athlete deletion so that a research dataset can never block a
-- data-deletion request made on behalf of a minor, and a governed dataset is
-- the most tempting place in the schema to make an exception. No exception is
-- made. The provenance foreign keys cascade, the triggers here fire only on
-- INSERT and UPDATE, and calibrationGold.pg.test.ts asserts directly that a
-- 'gold' + LOCKED_TEST record -- the single hardest row here to delete on
-- purpose -- disappears when its source video is deleted. The naive form of
-- the annotations freeze trigger would have broken exactly this class of
-- cascade while looking correct; nothing here reintroduces it.
--
-- Additive and idempotent. No `begin;`/`commit;` here on purpose: the runner
-- (apps/web/scripts/pilot-apply-calibration-gold-migration.mjs) opens the
-- transaction itself.

-- ---------------------------------------------------------------------------
-- PREREQUISITE on the clips table: a key carrying the clip's project and video.
--
-- Lets a gold record's copy of "which project" and "which video" be foreign-
-- keyed back to the clip it names, which is what turns those two pieces of
-- provenance from a claim into a database guarantee. Without it a gold record
-- could name clip C, project P and video V where C belongs to neither.
--
-- Cannot fail on existing data: (organization_id, calibration_clip_id) is
-- already the primary key, so any superset is unique by construction. There is
-- no row, in any environment, that this constraint can reject.
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('pilot.calibration_clips') is not null
    and not exists (
      select 1 from pg_constraint
      where conrelid = to_regclass('pilot.calibration_clips')
        and conname = 'pilot_calibration_clips_provenance_key'
    )
  then
    alter table pilot.calibration_clips
      add constraint pilot_calibration_clips_provenance_key
      unique (organization_id, calibration_clip_id, calibration_project_id, video_session_id);
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- PREREQUISITE on the adjudications table: a key carrying the decision's clip,
-- its two annotator sets, and its adjudicator.
--
-- This is the key that makes "original annotator provenance" real. A gold
-- record names two annotation sets; hanging them off THIS key means they are
-- not two ids someone typed, they are the two readings that specific
-- adjudication was actually made between -- and the adjudicator named is the
-- one who made it.
--
-- Cannot fail on existing data: (organization_id, adjudication_id) is already
-- the primary key, so any superset is unique by construction.
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('pilot.calibration_adjudications') is not null
    and not exists (
      select 1 from pg_constraint
      where conrelid = to_regclass('pilot.calibration_adjudications')
        and conname = 'pilot_calibration_adjudications_provenance_key'
    )
  then
    alter table pilot.calibration_adjudications
      add constraint pilot_calibration_adjudications_provenance_key
      unique (organization_id, adjudication_id, calibration_clip_id,
              annotation_set_id_a, annotation_set_id_b, adjudicator_account_id);
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- The governance record.
-- ---------------------------------------------------------------------------
create table if not exists pilot.calibration_gold_records (
  organization_id text not null
    references pilot.organizations(organization_id) on delete cascade,
  gold_record_id text not null,

  -- WHERE THIS READING CAME FROM. All six of the following are provenance the
  -- owner's order requires every gold record to retain, and every one of them
  -- sits inside a composite foreign key below rather than merely being stored.
  calibration_project_id text not null,
  calibration_clip_id text not null,
  video_session_id text not null,
  ontology_version text not null check (length(btrim(ontology_version)) > 0),
  adjudication_id text not null,
  adjudicator_account_id text not null,

  -- ORIGINAL ANNOTATOR PROVENANCE. Both sets, never one. The reading a gold
  -- record carries exists because two people labelled the same clip
  -- independently and a third settled where they differed; a record naming
  -- only the "winning" annotator would describe a process that never happened
  -- and would make the disagreement -- the actual measurement -- unrecoverable.
  annotation_set_id_a text not null,
  annotation_set_id_b text not null,

  -- WHERE THIS RECORD IS IN ITS GOVERNANCE LIFE.
  --
  -- candidate: adjudicated and nominated, NOT part of the reference dataset.
  -- gold: deliberately promoted, by the named human, at the named time.
  -- excluded: deliberately kept out.
  --
  -- 'candidate' is the default so that the lazy write is the safe one. A
  -- caller that forgets to say produces a row that is not in the dataset,
  -- rather than one that is.
  governance_state text not null default 'candidate'
    check (governance_state in ('candidate', 'gold', 'excluded')),

  -- WHAT THIS RECORD MAY BE USED FOR. Uppercase verbatim, as the owner's order
  -- writes them, and unlike every other vocabulary in this subsystem -- which
  -- is lower-case -- because these are not observations. They are policy
  -- labels, and the case difference is a standing reminder of which kind of
  -- value a reader is looking at.
  --
  -- NO DEFAULT, deliberately. Every other column here can be defaulted safely;
  -- this one cannot. A default would mean a caller that never thought about
  -- held-out data still gets an answer, and the answer would be whichever
  -- value this file guessed. A record whose eligibility nobody chose has no
  -- business existing, so the database refuses to invent one.
  eligibility text not null
    check (eligibility in ('TRAINING_ELIGIBLE', 'VALIDATION_ONLY', 'LOCKED_TEST')),

  -- PROMOTION ATTRIBUTION. Null until a human promotes this record, then both
  -- non-null forever after, tied to the state by the CHECK below.
  promoted_by_account_id text null references pilot.accounts(account_id),
  promoted_at timestamptz null,

  -- Why this record was nominated, promoted or set aside, in a human's words.
  -- Free text on purpose and scoreless on purpose: a governance decision is
  -- explained, not rated.
  notes text null,

  created_at timestamptz not null default now(),

  constraint pilot_calibration_gold_records_pkey
    primary key (organization_id, gold_record_id),

  -- ONE GOVERNANCE RECORD PER ADJUDICATED READING. See the header: without
  -- this, the eligibility ratchet has a flanking route that needs no UPDATE at
  -- all -- just a second row saying something else about the same reading.
  constraint pilot_calibration_gold_one_per_adjudication
    unique (organization_id, adjudication_id),

  -- THE PROMOTION ATTESTATION, in both directions, the same stance
  -- pilot_film_study_proposals_attested_v2 takes on a review verdict.
  --
  -- Forwards: a 'gold' record cannot exist without naming who promoted it and
  -- when. Backwards -- and this half is the one that is easy to leave out and
  -- does real work -- a record that is NOT gold cannot carry promotion
  -- attribution either. Without it a candidate could sit there naming a
  -- promoter who promoted nothing, and a later reader counting "records with a
  -- promoter" would count it.
  constraint pilot_calibration_gold_promotion_attested check (
    (governance_state = 'gold'
      and promoted_by_account_id is not null
      and promoted_at is not null)
    or (governance_state in ('candidate', 'excluded')
      and promoted_by_account_id is null
      and promoted_at is null)
  ),

  -- TENANCY AND PROVENANCE IN ONE KEY, twice over.
  --
  -- The composite-foreign-key pattern every calibration table already uses:
  -- organization_id is part of the referencing key, so a gold record in
  -- organization A pointing at organization B's clip or adjudication is not a
  -- bug to be caught in review, it is a row the database refuses to store.
  --
  -- Both of these cascade. If the clip, the project, the source video, the
  -- athlete or the adjudication goes, this record goes with it -- see DELETION
  -- in the header.
  constraint pilot_calibration_gold_clip_fk
    foreign key (organization_id, calibration_clip_id, calibration_project_id, video_session_id)
    references pilot.calibration_clips(
      organization_id, calibration_clip_id, calibration_project_id, video_session_id)
    on delete cascade,

  constraint pilot_calibration_gold_adjudication_fk
    foreign key (organization_id, adjudication_id, calibration_clip_id,
                 annotation_set_id_a, annotation_set_id_b, adjudicator_account_id)
    references pilot.calibration_adjudications(
      organization_id, adjudication_id, calibration_clip_id,
      annotation_set_id_a, annotation_set_id_b, adjudicator_account_id)
    on delete cascade,

  -- The two annotator sets are not free text: each must be a real set, about
  -- the clip this record names. The adjudication key above ties them to the
  -- decision; these tie them to the clip, so a gold record cannot outlive the
  -- readings it claims to summarise.
  constraint pilot_calibration_gold_set_a_fk
    foreign key (organization_id, annotation_set_id_a, calibration_clip_id)
    references pilot.calibration_annotation_sets(
      organization_id, annotation_set_id, calibration_clip_id)
    on delete cascade,
  constraint pilot_calibration_gold_set_b_fk
    foreign key (organization_id, annotation_set_id_b, calibration_clip_id)
    references pilot.calibration_annotation_sets(
      organization_id, annotation_set_id, calibration_clip_id)
    on delete cascade,

  -- One reading is not two annotators.
  constraint pilot_calibration_gold_two_annotators
    check (annotation_set_id_a <> annotation_set_id_b)
);

-- "What is in the reference dataset for this study, and what may it be used
-- for" -- the governance read-out.
create index if not exists idx_calibration_gold_project
  on pilot.calibration_gold_records(
    organization_id, calibration_project_id, governance_state, eligibility);

-- "What is currently held out" -- the read a person checking whether an
-- evaluation is still honest needs, across every study at once.
create index if not exists idx_calibration_gold_eligibility
  on pilot.calibration_gold_records(organization_id, eligibility, governance_state);

-- "Which gold records came from this clip" -- the read a deletion or retention
-- review needs.
create index if not exists idx_calibration_gold_clip
  on pilot.calibration_gold_records(organization_id, calibration_clip_id);

-- ---------------------------------------------------------------------------
-- NOTHING ARRIVES AS GOLD.
--
-- The attestation CHECK above cannot hold this on its own: it is satisfied by
-- an INSERT that arrives as 'gold' carrying a promoter and a timestamp, which
-- is exactly the shape a bulk import or a well-meant backfill produces. The
-- order is explicit that promotion must be a deliberate, separate act, and a
-- separate act means a second statement.
--
-- 'excluded' IS permitted at insert, and the asymmetry is the point. Arriving
-- excluded adds nothing to the reference dataset -- it records a decision to
-- keep something out, which is the safe direction and needs no ceremony.
-- Arriving gold adds something, and everything added must be chosen.
-- ---------------------------------------------------------------------------
create or replace function pilot.calibration_gold_records_born_candidate()
returns trigger
language plpgsql
as $pilot_calibration_gold_born_candidate$
begin
  if new.governance_state = 'gold' then
    raise exception 'CALIBRATION_GOLD_PROMOTION_MUST_BE_A_SEPARATE_ACT'
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$pilot_calibration_gold_born_candidate$;

drop trigger if exists pilot_calibration_gold_born_candidate
  on pilot.calibration_gold_records;
create trigger pilot_calibration_gold_born_candidate
  before insert on pilot.calibration_gold_records
  for each row
  execute function pilot.calibration_gold_records_born_candidate();

-- ---------------------------------------------------------------------------
-- THE ELIGIBILITY RATCHET. The reason this slice exists.
--
-- Turns one way only: toward less training data, never toward more. See the
-- header for the three transition decisions and why each was made. The two
-- refusals below are written as the doctrine reads rather than encoded as an
-- ordering, so that a reviewer diffing this file sees the words LOCKED_TEST
-- and TRAINING_ELIGIBLE in the enforcement itself.
--
-- This is a trigger and not application code because a backfill, a cleanup, a
-- migration for some future feeder, or a psql session at 2am all have write
-- access and none of them go through calibration/gold.ts. Only the database
-- sees all of them.
-- ---------------------------------------------------------------------------
create or replace function pilot.calibration_gold_records_eligibility_ratchet()
returns trigger
language plpgsql
as $pilot_calibration_gold_ratchet$
begin
  -- LOCKED_TEST IS TERMINAL -- not merely barred from becoming
  -- TRAINING_ELIGIBLE, barred from becoming anything else at all. Refusing
  -- only the direct move would leave LOCKED_TEST -> VALIDATION_ONLY ->
  -- TRAINING_ELIGIBLE open, and two individually-legal updates are no harder
  -- for a backfill to issue than one.
  if old.eligibility = 'LOCKED_TEST'
     and new.eligibility is distinct from 'LOCKED_TEST'
  then
    raise exception 'CALIBRATION_GOLD_LOCKED_TEST_IS_TERMINAL'
      using errcode = 'restrict_violation';
  end if;

  -- The same rule one notch down. Validation data that becomes training data
  -- contaminates the measurement in the same way, and closing this is what
  -- makes the ratchet a ratchet rather than a single locked door.
  if old.eligibility = 'VALIDATION_ONLY'
     and new.eligibility = 'TRAINING_ELIGIBLE'
  then
    raise exception 'CALIBRATION_GOLD_ELIGIBILITY_LOOSENED'
      using errcode = 'restrict_violation';
  end if;

  return new;
end;
$pilot_calibration_gold_ratchet$;

drop trigger if exists pilot_calibration_gold_eligibility_ratchet
  on pilot.calibration_gold_records;
create trigger pilot_calibration_gold_eligibility_ratchet
  before update on pilot.calibration_gold_records
  for each row
  execute function pilot.calibration_gold_records_eligibility_ratchet();

-- ---------------------------------------------------------------------------
-- PROVENANCE IS FROZEN.
--
-- The composite foreign keys stop a gold record naming an INCONSISTENT
-- provenance. They do nothing about repointing it at a different, perfectly
-- consistent one -- and a promoted record that keeps its promotion attribution
-- while quietly changing which reading it is a record OF retains nothing at
-- all. "Every gold record must retain its provenance" is a claim about time,
-- not about the moment of insert.
--
-- None of these columns is ever the target of an ON DELETE SET NULL, so no
-- legitimate cascade arrives here as an update. Deletion cascades remove the
-- row instead, which this trigger does not see and must not.
-- ---------------------------------------------------------------------------
create or replace function pilot.calibration_gold_records_freeze_provenance()
returns trigger
language plpgsql
as $pilot_calibration_gold_freeze$
begin
  if new.calibration_project_id is distinct from old.calibration_project_id
     or new.calibration_clip_id is distinct from old.calibration_clip_id
     or new.video_session_id is distinct from old.video_session_id
     or new.ontology_version is distinct from old.ontology_version
     or new.adjudication_id is distinct from old.adjudication_id
     or new.adjudicator_account_id is distinct from old.adjudicator_account_id
     or new.annotation_set_id_a is distinct from old.annotation_set_id_a
     or new.annotation_set_id_b is distinct from old.annotation_set_id_b
  then
    raise exception 'CALIBRATION_GOLD_PROVENANCE_IMMUTABLE'
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$pilot_calibration_gold_freeze$;

drop trigger if exists pilot_calibration_gold_freeze_provenance
  on pilot.calibration_gold_records;
create trigger pilot_calibration_gold_freeze_provenance
  before update on pilot.calibration_gold_records
  for each row
  execute function pilot.calibration_gold_records_freeze_provenance();
