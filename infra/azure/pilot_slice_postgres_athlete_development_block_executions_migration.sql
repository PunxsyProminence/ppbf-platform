-- Plan versus actual: what a coach concluded about how a block went
-- (register module 036, slice 3 of the Athlete Build foundation).
--
-- WHAT THIS IS: the row that lets a finished development block carry a
-- HUMAN's verdict. pilot.athlete_development_blocks records what a coach
-- planned; pilot.athlete_development_block_objectives records what that meant
-- per Full Spectrum domain. Neither records whether any of it happened. This
-- does -- and it records it as a judgment a named person made, never as
-- something the platform worked out.
--
-- ────────────────────────────────────────────────────────────────────────
-- THE ONE DECISION THAT DETERMINES WHETHER THIS SURFACE CAN LIE
--
-- STORED: the human judgment only. An adherence state, the deviations and
-- the reason in the coach's own words, who recorded it and when. That is a
-- fact about what a person concluded, and facts about the past are stored.
--
-- NEVER STORED: every count. How many training_attempts fell in the block's
-- window, how many activity_log minutes by domain, which assessments were
-- administered. Those are derived from rows that keep changing -- a
-- late-logged session, a corrected attempt, a retracted assessment -- and a
-- stored count silently stops matching its own sources the moment one of them
-- moves. A count that disagrees with the rows beneath it, on a record about a
-- child, is worse than no count at all.
--
-- So the counts are computed at read time, every time, and cost a query per
-- view. That is the right trade. The alternative is a materialised number
-- that goes stale and that nobody notices until a coach acts on it.
--
-- IF A LATER CHANGE ADDS attempt_count, minutes_total, adherence_score,
-- completion_pct OR ANY OTHER TALLY TO THIS TABLE, that is precisely the
-- defect this migration exists to prevent. The pg suite asserts the column
-- list and will fail rather than let one in quietly.
--
-- This mirrors what the platform already does one table over:
-- pilot.intervention_executions stores the human's `adherence` and links
-- evidence, and stores no tally.
--
-- ────────────────────────────────────────────────────────────────────────
-- OWNER DECISIONS, 2026-08-28 (recorded in
-- docs/capabilities/proposals/engine-unlock/036a-plan-vs-actual-execution-design.md)
--
--   D1 (a) -- THE JUDGMENT SITS ON THE BLOCK, not on each objective. One
--     verdict per block, which is why (organization_id, block_id) is UNIQUE
--     below. The cost was named when the decision was made and is not hidden
--     here: a block that went well technically and badly on conditioning gets
--     one word for both. The alternative -- five judgments per block -- is
--     the kind of friction that gets skipped, and skipped judgments default
--     to 'unknown', which would turn an honest default into an empty screen.
--
--   D2 (a) -- RECORDED BY DEVELOPMENT_BLOCK_WRITE_ROLES: coach,
--     organization_admin, admin. The same list that authors the block. That
--     is enforced in the data layer, not here; this table records WHO by
--     account id so the answer cannot be lost.
--
--   D4 (a) -- NO EVIDENCE LINKS IN THIS SLICE. When a coach may point at the
--     specific rows behind their judgment, it reuses
--     pilot.intervention_evidence_links' shape rather than getting a parallel
--     table here.
--
--   D5 -- RESTATED, so a later slice cannot drift into it: no count shown on
--     this surface may be combined into a single figure, percentage, grade or
--     index, and no cross-athlete comparison, cohort average or "on plan"
--     leaderboard may exist at any tier.
--
-- ────────────────────────────────────────────────────────────────────────
-- THE ATHLETE IS NOT REPEATED HERE, for the third time in this capability.
-- An execution reaches its athlete through its block, by composite FK,
-- exactly as an objective does. Copying athlete_id down would create a second
-- place for the answer to live and therefore a way for the two to disagree.
--
-- 'unknown' IS THE DEFAULT AND IT IS HONEST. A block with no judgment
-- recorded is unknown -- never inferred from the counts sitting next to it.
-- That inference is the entire thing this table refuses to make. Matching
-- pilot.intervention_executions' own default, and its exact vocabulary,
-- rather than inventing a second adherence language for the same concept.
--
-- deviations AND deviation_reason DEFAULT TO EMPTY, not null, so that "the
-- coach wrote nothing" and "the coach wrote an empty string" are not two
-- states a reader has to tell apart.
--
-- IDEMPOTENT AND TRANSACTIONAL. create table if not exists, and the
-- vocabulary constraint is dropped and re-added inside a DO block so a
-- migrated environment can receive a widened vocabulary later without a
-- hand-written ALTER. No BEGIN/COMMIT here: the runner opens the transaction.
--
-- DEPENDS ON pilot.organizations, pilot.accounts,
-- pilot.athlete_development_blocks (ordered after it in the `all` chain).

create table if not exists pilot.athlete_development_block_executions (
  organization_id        text not null references pilot.organizations(organization_id) on delete cascade,
  execution_id           text not null,
  block_id               text not null,
  -- The human's verdict. Defaults to the honest answer, not a flattering one.
  adherence              text not null default 'unknown',
  -- What actually differed from the plan, and why, in the coach's own words.
  -- Stored verbatim; never parsed into a taxonomy, never scored, never used
  -- to derive the adherence state above.
  deviations             text not null default '',
  deviation_reason       text not null default '',
  recorded_by_account_id text not null references pilot.accounts(account_id),
  recorded_at            timestamptz not null default now(),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  primary key (organization_id, execution_id),
  -- D1(a): ONE judgment per block. Not a revision log -- a coach who changes
  -- their mind corrects the row rather than filing a second verdict, because
  -- two live verdicts on one block is a discrepancy someone would want
  -- resolved by arithmetic, which is the thing this capability refuses.
  constraint pilot_adb_executions_one_per_block
    unique (organization_id, block_id),
  -- Composite FK: an execution can only hang off a block in the SAME
  -- organization, and cannot outlive it. Tenancy and the athlete link both
  -- arrive through here.
  constraint pilot_adb_executions_block_fk
    foreign key (organization_id, block_id)
    references pilot.athlete_development_blocks(organization_id, block_id) on delete cascade
);

do $pilot_adb_executions_adherence$
begin
  -- pilot.intervention_executions' vocabulary, copied verbatim rather than
  -- paraphrased. Two tables describing "how far did the plan survive contact"
  -- in two different languages would be two things for a reader to reconcile,
  -- and the reconciliation would be guesswork.
  --
  -- Dropped and re-added rather than declared inline so that widening this
  -- list later is a migration a deployed environment can actually receive.
  alter table pilot.athlete_development_block_executions
    drop constraint if exists pilot_adb_executions_adherence_check;
  alter table pilot.athlete_development_block_executions
    add constraint pilot_adb_executions_adherence_check
    check (adherence in (
      'delivered_as_planned',
      'delivered_with_deviations',
      'under_delivered',
      'not_delivered',
      'unknown'
    ));

  -- CLAIMED DEVIATIONS MUST BE NAMED.
  --
  -- pilot_intervention_executions_deviations_check ships BESIDE the vocabulary
  -- this table copied, and the first version of this migration took the five
  -- words without it. That is half a copy: it accepts
  -- 'delivered_with_deviations' with the deviations field empty, which is the
  -- one combination the vocabulary exists to rule out -- a coach saying the
  -- plan bent and not saying how. Found by reading
  -- pilot.athlete_development_block_reviews (#804), which copied both halves.
  --
  -- btrim with an explicit character set rather than btrim/1, which trims
  -- SPACES ONLY: a lone tab would pass a check that every JavaScript caller's
  -- .trim() calls empty. Same reasoning and same spelling as the parent block
  -- and objectives migrations. Stricter than the constraint it copies, on
  -- purpose.
  alter table pilot.athlete_development_block_executions
    drop constraint if exists pilot_adb_executions_deviations_check;
  alter table pilot.athlete_development_block_executions
    add constraint pilot_adb_executions_deviations_check
    check (adherence <> 'delivered_with_deviations'
           or length(btrim(deviations, E' \t\r\n\f\v')) > 0);
end
$pilot_adb_executions_adherence$;

-- The read every future surface starts from: this block's verdict. The unique
-- constraint above already provides the (organization_id, block_id) index, so
-- there is deliberately no second one here.

comment on table pilot.athlete_development_block_executions is
  'A coach''s judgment of how one development block actually went. Stores the human verdict and their words; stores no count, no percentage, no score and no index. Every count on this capability''s surfaces is computed at read time from its own sources, because a stored count stops matching them the moment a session is logged late.';

comment on column pilot.athlete_development_block_executions.adherence is
  'pilot.intervention_executions'' vocabulary, verbatim: delivered_as_planned / delivered_with_deviations / under_delivered / not_delivered / unknown. Defaults to unknown and is only ever moved by a named human -- never inferred from the training rows in the block''s window.';

comment on column pilot.athlete_development_block_executions.deviations is
  'What differed from the plan, in the coach''s own words. Verbatim; never parsed, never scored, never used to derive the adherence state.';

comment on column pilot.athlete_development_block_executions.deviation_reason is
  'Why it differed, in the coach''s own words. Empty means the coach wrote nothing -- not null, so that is one state rather than two.';

comment on column pilot.athlete_development_block_executions.recorded_by_account_id is
  'Who made the judgment. Owner decision 2026-08-28 D2(a): the DEVELOPMENT_BLOCK_WRITE_ROLES set may record one -- coach, organization_admin, admin -- enforced in the data layer, recorded here so the answer cannot be lost.';
