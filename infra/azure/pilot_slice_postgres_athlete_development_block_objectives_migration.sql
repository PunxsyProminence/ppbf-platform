-- Full Spectrum block objectives (register module 036, slice 2 of the
-- Athlete Build foundation).
--
-- WHAT THIS IS: the child rows of pilot.athlete_development_blocks. A block
-- says what the next six weeks are for in the coach's own words; an
-- objective says what that means in ONE domain of the athlete's
-- development, still in the coach's own words. A block with four objectives
-- is four rows here, not four columns there.
--
-- WHY A CHILD TABLE AND NOT COLUMNS. The Full Spectrum domains are a list
-- that is expected to change, and a block table with a column per domain
-- would make every future domain an ALTER on the parent, make an unused
-- domain an empty column on every block ever written, and make "how many
-- objectives does this block have" unanswerable. The parent migration
-- refused that shape explicitly ("A block table with a column per domain is
-- exactly the shape this refuses to be"); this is the structure it was
-- refusing on behalf of.
--
-- STILL NO TRAINING SCIENCE. An objective is a sentence a coach wrote. There
-- is no progress percentage, no completion score, no attainment rating, no
-- difficulty, no weighting between domains, and no roll-up of objectives
-- into a block-level number. Whether an objective was met is a judgment,
-- and when this platform eventually records one it will record it the way
-- pilot.intervention_outcome_reviews does -- authored by a named human --
-- not computed from the count of rows that reached 'completed'.
--
-- THE ATHLETE IS NOT REPEATED HERE. An objective reaches its athlete
-- through its block, by composite FK. Copying athlete_id down would create
-- a second place for the answer to live and therefore a way for the two to
-- disagree; the block already cannot name an athlete outside its own
-- organization, so neither can its objectives.
--
-- ────────────────────────────────────────────────────────────────────────
-- THE DOMAIN VOCABULARY IS ALL TEN (owner decision, 2026-08-28)
--
-- Jason, verbatim: "admit nutrition_body_composition -- module 200 is done."
--
-- WHAT THIS RESOLVED. This table shipped with nine of the ten Full Spectrum
-- domains. The tenth was withheld, and the reasoning was not this
-- migration's: pilot_slice_postgres_goal_category_progress_migration.sql had
-- already withheld 'Weight Loss' and 'Weight Gain' from
-- pilot.goals.category because admitting them
--
--   "would create a stored, queryable record of a minor's weight-loss
--    intent ... ahead of the tier system whose entire job is to decide who
--    may see exactly that."
--
-- That was a wait on a named gate, not a permanent refusal, and the gate is
-- built: module 200 (the Privacy-Tier System,
-- apps/web/src/server/pilot/privacyTiers.ts) reads Status DONE and ships
-- FIELD_TIERS, the field-level registry whose own header names "a
-- body-composition tracker" as an anticipated consumer. The owner has now
-- made the explicit decision that FIELD_TIERS' goals.category note said the
-- registry "makes possible and deliberately does not make."
--
-- SO THE FIELD IS REGISTERED, NOT MERELY ADMITTED. Leaning on module 200 as
-- the ground for this change while not actually using module 200 would be a
-- hollow justification, so
-- FIELD_TIERS['athlete_development_block_objectives.objective'] now carries
-- this field's tier and names where it is enforced. Read that entry before
-- building anything that displays an objective: it records honestly that
-- what is enforced TODAY is organization scope, and that narrowing a
-- body-composition objective about a named minor to athlete_record is the
-- work item before any read surface ships.
--
-- WHAT THIS DECISION DOES NOT COVER, stated so a later reader does not
-- stretch it:
--   * pilot.goals.category is UNCHANGED. 'Weight Loss' and 'Weight Gain'
--     remain withheld there. That is a different surface -- athlete-filed,
--     athlete-readable -- and it was not what was decided. Deciding the two
--     together is worth doing; doing it here without being asked is not.
--   * shadowAuthority.ts still refuses 'weight_cut' in conversation, and
--     nothing here changes that. A coach may record their own plan; the
--     model still does not give weight-cutting guidance.
--   * No prescription, no automation, no computation. This admits a DOMAIN
--     LABEL on a sentence a coach wrote. It does not add a weight field, a
--     target, a target date, or anything that could be read as a
--     platform-issued body-composition instruction to a minor.
-- ────────────────────────────────────────────────────────────────────────
--
-- THE DOMAIN CHECK RECONCILES RATHER THAN GUARDS, for the reason the
-- rabbit-holes and goal-category migrations give: this vocabulary is
-- EXPECTED to grow -- by at least one value, on a decision already named
-- above -- and a catalog-guarded `if not exists` would leave an
-- already-migrated environment rejecting the new value forever. The DO
-- block drops and re-adds, making this file the single source of truth on
-- every run. Re-running is a no-op; if a row somewhere violated a narrowed
-- list the ADD fails, the runner's transaction rolls back, and the previous
-- constraint is restored intact.
--
-- Idempotent like every migration in this directory: create table/index if
-- not exists, no drops of anything holding data, safe to re-run wholesale.
-- No begin;/commit; here -- the runner
-- (apps/web/scripts/pilot-apply-athlete-development-block-objectives-migration.mjs)
-- opens the transaction itself.
--
-- DEPENDS ON pilot.organizations, pilot.accounts,
-- pilot.athlete_development_blocks (ordered after it in the `all` chain).

create table if not exists pilot.athlete_development_block_objectives (
  organization_id       text not null references pilot.organizations(organization_id) on delete cascade,
  objective_id          text not null,
  block_id              text not null,
  domain                text not null,
  -- The coach's own words for this domain, in this block. Blank means blank,
  -- including a tab: btrim/1 trims SPACES ONLY, which would let E'\t\n' pass
  -- a check that every JavaScript caller's .trim() calls empty. Same
  -- reasoning, same spelling, as the parent migration.
  objective             text not null
                        check (length(btrim(objective, E' \t\r\n\f\v')) > 0),
  status                text not null default 'draft',
  created_by_account_id text not null references pilot.accounts(account_id),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  primary key (organization_id, objective_id),
  -- The parent's exact vocabulary, not a second one. An objective can be
  -- dropped while its block runs on, which is why it carries its own state
  -- rather than inheriting the block's.
  constraint pilot_athlete_development_block_objectives_status_check
    check (status in ('draft', 'active', 'completed', 'cancelled')),
  -- Composite FK: an objective can only hang off a block in the SAME
  -- organization, and cannot outlive it. Tenancy and the athlete link both
  -- arrive through here.
  constraint pilot_athlete_development_block_objectives_block_fk
    foreign key (organization_id, block_id)
    references pilot.athlete_development_blocks(organization_id, block_id) on delete cascade
);

do $pilot_adb_objectives_domain$
begin
  -- All ten Full Spectrum domains. 'nutrition_body_composition' was withheld
  -- when this table shipped and was admitted by owner decision 2026-08-28;
  -- see the header for what that decision rests on and what it does not
  -- cover.
  alter table pilot.athlete_development_block_objectives
    drop constraint if exists pilot_athlete_development_block_objectives_domain_check;
  alter table pilot.athlete_development_block_objectives
    add constraint pilot_athlete_development_block_objectives_domain_check
    check (domain in (
      'technical',
      'physical',
      'conditioning',
      'mental',
      'recovery_load',
      'sparring_live_progression',
      'competition_preparation',
      'tactical_film_study',
      'lifestyle_athlete_identity',
      'nutrition_body_composition'
    ));
end
$pilot_adb_objectives_domain$;

-- The read every future surface starts from: this block's objectives,
-- grouped by domain. There is deliberately NO unique constraint on
-- (block, domain) -- a coach may hold two technical objectives in one block,
-- and deciding otherwise would be coaching doctrine.
create index if not exists idx_athlete_development_block_objectives_by_block
  on pilot.athlete_development_block_objectives(organization_id, block_id, domain);

comment on table pilot.athlete_development_block_objectives is
  'What one development block is trying to move, one row per domain per objective, in the coach''s own words. Records intent; computes nothing. No progress percentage, attainment score, domain weighting or block-level roll-up is stored or derived here.';

comment on column pilot.athlete_development_block_objectives.domain is
  'Which of the ten Full Spectrum domains this objective belongs to. nutrition_body_composition was withheld at first ship and admitted by owner decision 2026-08-28 once the Privacy-Tier System (module 200) was in place; the field''s tier is registered in FIELD_TIERS. pilot.goals.category is a separate surface and is unchanged.';

comment on column pilot.athlete_development_block_objectives.objective is
  'The coach''s own words. Stored verbatim, never parsed into a taxonomy, never scored.';

comment on column pilot.athlete_development_block_objectives.status is
  'draft / active / completed / cancelled -- the parent block''s vocabulary. Set by a human; reaching completed is a coach saying so, never the platform inferring it.';
