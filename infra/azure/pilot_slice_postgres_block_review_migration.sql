-- The coach's review of a development block: what they say happened against
-- what they planned (register module 036).
--
-- WHAT THIS IS: one table holding a HUMAN'S judgement about a block, and
-- nothing else. The "actual" half of plan-versus-actual is not stored here at
-- all -- it is read from records that already exist, at read time, and this
-- migration adds no copy of them.
--
-- THE ORDER SETTLES THE HARDEST QUESTION, AND IT SETTLES IT AGAINST A NUMBER.
-- The build order's PR G says, in its own words: "Do not invent an adherence
-- percentage. If adherence needs a judgment, use a human-selected state such
-- as the existing intervention vocabulary if appropriate: delivered_as_planned
-- / delivered_with_deviations / under_delivered / not_delivered / unknown."
-- That is exactly the vocabulary pilot.intervention_executions already
-- carries, so it is REUSED rather than restated: the same five values, in the
-- same spelling, checked the same way. A block review and an intervention
-- execution are both a human saying how far a plan survived contact with a
-- gym, and two vocabularies for that would be two answers to one question.
--
-- 'unknown' IS A REAL ANSWER AND IS THE DEFAULT. A coach who has not decided
-- has not decided, and the honest state for that is not 'not_delivered' and
-- not an absent row. It is the same refusal the intervention ledger makes,
-- and it is why the vocabulary has five values instead of four.
--
-- SAYING "WITH DEVIATIONS" MEANS SAYING WHAT THEY WERE. Copied from
-- pilot_intervention_executions_deviations_check, because the rule is right
-- and the reason survives the move: an adherence state that names a departure
-- without recording it is a judgement nobody can review. The spelling here
-- uses the explicit whitespace set rather than btrim/1 -- btrim's default
-- trims SPACES ONLY, so E'\t\n' would satisfy the one-argument form while
-- every JavaScript caller's .trim() calls it empty, and the database would be
-- the looser of the two layers. Same fix, same reason, as the rest of this
-- module's tables.
--
-- MANY REVIEWS PER BLOCK, NOT ONE. A six-week block reviewed only at its end
-- is reviewed too late to change anything, and a coach who writes a mid-block
-- note should not have to overwrite it to write another. Each review is its
-- own dated row; the block's current reading is the most recent one, and the
-- earlier ones stay exactly as they were written. Nothing here amends a
-- review in place, because a judgement someone recorded at the time is a fact
-- about that time.
--
-- NOTHING IS COMPUTED, AND THIS IS THE TABLE THE WHOLE LANE HAS BEEN HOLDING
-- THE DOOR OPEN FOR. Every surface built before this one -- the session link,
-- the objective link, the coach's own development record -- refused to count
-- anything, so that when the plan-versus-actual question finally arrived it
-- would arrive undecided. It has arrived, and the order answers it: a human
-- picks a state. There is no adherence percentage column here, no coverage
-- figure, no completion ratio, no score, and none may be added. A number in
-- this table would be a machine's verdict on a coach's work with a child,
-- and it would be believed precisely because it looked measured.
--
-- WHAT THE EVIDENCE READ MUST NEVER DO, recorded here because this table is
-- what that read hangs off: an absence of records is not a finding. A block
-- window with no training attempts in it means nobody logged any -- not that
-- the athlete did not train. Any surface over this must say "recorded", and
-- must not turn a zero into a judgement. That is the same honesty rule the
-- rest of this platform runs on, at the one surface where breaking it would
-- look most like insight.
--
-- SHADOW IS NOT WIRED IN. The order permits it: "SHADOW may summarize
-- evidence, but must not silently become the final evaluator." Permitted is
-- not required, and an automated summary of a child's training record needs
-- its own evidence and safety contract rather than arriving as a side effect
-- of a review table. Nothing here calls SHADOW, and the review is authored by
-- the account named in reviewed_by_account_id. If a summary is added later it
-- is an input a human reads before choosing a state -- never the state.
--
-- TENANCY IS A DATABASE FACT. The composite FK into
-- pilot.athlete_development_blocks means a review cannot name a block in
-- another organization, and cascades so a review cannot outlive the block it
-- is about -- which is also what keeps dataDeletion.ts's retention purge
-- whole, since that purge is a bare delete from pilot.athletes relying
-- entirely on cascades.
--
-- Idempotent like every migration in this directory: create table/index if
-- not exists, no alters, no drops, safe to re-run wholesale. No begin;/
-- commit; here -- the runner
-- (apps/web/scripts/pilot-apply-block-review-migration.mjs) opens the
-- transaction itself.
--
-- DEPENDS ON pilot.organizations, pilot.accounts,
-- pilot.athlete_development_blocks.

create table if not exists pilot.athlete_development_block_reviews (
  organization_id       text not null references pilot.organizations(organization_id) on delete cascade,
  review_id             text not null,
  block_id              text not null,
  -- The five human-selected states, exactly as pilot.intervention_executions
  -- spells them. 'unknown' is the default because a coach who has not decided
  -- has not decided.
  adherence_state       text not null default 'unknown',
  -- What departed from the plan. Required when the state says there were
  -- deviations; free text otherwise, in the coach's own words.
  deviations            text not null default '',
  -- Why. Deliberately separate from the deviations themselves: what changed
  -- and why it changed are different claims, and collapsing them loses the
  -- half a later reader needs.
  reason                text not null default '',
  what_worked           text not null default '',
  what_did_not          text not null default '',
  -- The only forward-looking field, and it is a sentence rather than a
  -- structure: what the coach intends to do differently. No suggested
  -- adjustment is generated, ranked or pre-filled.
  next_adjustment       text not null default '',
  reviewed_by_account_id text not null references pilot.accounts(account_id),
  created_at            timestamptz not null default now(),
  primary key (organization_id, review_id),
  constraint pilot_adb_reviews_adherence_check
    check (adherence_state in ('delivered_as_planned', 'delivered_with_deviations',
                               'under_delivered', 'not_delivered', 'unknown')),
  -- Say it was delivered with deviations, and say what they were. Copied from
  -- pilot_intervention_executions_deviations_check; see the header.
  constraint pilot_adb_reviews_deviations_check
    check (adherence_state <> 'delivered_with_deviations'
           or length(btrim(deviations, E' \t\r\n\f\v')) > 0),
  constraint pilot_adb_reviews_block_fk
    foreign key (organization_id, block_id)
    references pilot.athlete_development_blocks(organization_id, block_id) on delete cascade
);

-- A block's reviews, newest first: the read every surface starts from, and
-- the one that answers "where did this block get to".
create index if not exists idx_adb_reviews_by_block
  on pilot.athlete_development_block_reviews(organization_id, block_id, created_at desc);

comment on table pilot.athlete_development_block_reviews is
  'A coach''s dated judgement about how a development block went: a human-selected adherence state from the intervention vocabulary, what departed from the plan and why, what worked, what did not, and what they intend to adjust. Records a judgement; computes nothing. There is no adherence percentage, coverage figure or completion ratio here and none may be added -- the build order refuses one explicitly.';

comment on column pilot.athlete_development_block_reviews.adherence_state is
  'delivered_as_planned / delivered_with_deviations / under_delivered / not_delivered / unknown. The same five values pilot.intervention_executions uses, chosen by a human. ''unknown'' is the default and is a real answer: a coach who has not decided has not decided.';

comment on column pilot.athlete_development_block_reviews.next_adjustment is
  'What the coach intends to do differently, in their own words. Never generated, ranked or suggested by this platform.';
