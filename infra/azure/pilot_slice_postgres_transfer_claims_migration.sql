-- Neuro and life-skill transfer claims attached to drills and script blocks
--
-- WHY A TABLE AND NOT TWO TEXT COLUMNS. Every PPBF session document attaches a neurological
-- rationale and a life-skill transfer statement to each drill. That is the engagement premise of
-- the whole programme and it should be first-class. But the two kinds of statement are not
-- equally supported, and storing them as prose would hide that.
--
-- Life-skill transfer statements ("control before reaction", "calm thinking produces better
-- outcomes than speed") are coaching intent. They describe what the coach is teaching and why the
-- session is framed that way. They do not assert a mechanism and they do not need one.
--
-- Neurological statements naming specific structures -- cerebellum coordination, basal ganglia
-- patterning, keeping the amygdala quiet -- are mechanism claims. They are plausible readings of
-- motor-learning and stress literature, but a claim that a particular gym drill engages a
-- particular brain structure has not been measured in boxing, in this population, or by PPBF.
-- Presenting them to a parent or funder as established neuroscience would not survive scrutiny.
--
-- So every row carries an evidence_class, and the app must render it. The intended default for
-- structure-naming claims is MECHANISM-THEORISED: useful for coach reasoning and athlete framing,
-- not a finding. A claim only becomes EVIDENCE-SUPPORTED when a registry claim_id is attached.
--
-- SHADOW MUST NOT SCORE THESE. Transfer claims are teaching content. They are not outcomes, they
-- are not measurable as written, and no engine may treat the presence of a life-skill tag as
-- evidence the life skill was acquired. Measuring transfer requires an instrument PPBF does not
-- yet have.
--
-- DEPENDS ON pilot.organizations, pilot.drill_library, pilot.session_script_blocks,
-- pilot.session_scripts (the last three via the "exactly one target" attachment columns -- each
-- FK is a composite (organization_id, <target>_id) FK, and Postgres's default MATCH SIMPLE means
-- a null <target>_id is never checked, so a row attaching to a drill never touches the block/script
-- FKs and vice versa). No begin;/commit; here on purpose, matching this repo's
-- runner-opens-the-transaction convention (the runner is
-- apps/web/scripts/pilot-apply-transfer-claims-migration.mjs).

create table if not exists pilot.transfer_claims (
  organization_id   text not null references pilot.organizations(organization_id) on delete cascade,
  transfer_id       text not null,

  -- Attaches to a drill, a script block, or a whole session. Exactly one.
  drill_id          text null,
  block_id          text null,
  script_id         text null,

  claim_kind        text not null check (claim_kind in
                      ('neuro_mechanism','life_skill_transfer','cognitive_demand','emotional_regulation')),
  statement         text not null,
  named_structure   text not null default '',   -- 'cerebellum', 'basal ganglia', '' when none named

  evidence_class    text not null default 'MECHANISM-THEORISED' check (evidence_class in
                      ('EVIDENCE-SUPPORTED','MECHANISM-THEORISED','COACHING INTENT','CONTESTED','INSUFFICIENT EVIDENCE')),
  registry_claim_id text not null default '',   -- e.g. 'A1-034'; required for EVIDENCE-SUPPORTED
  source_document   text not null default '',

  -- Display control. A claim shown to a parent or in a grant application should carry its
  -- qualification; one shown to a coach mid-session need not interrupt the flow.
  athlete_facing    boolean not null default true,
  public_facing     boolean not null default false,

  created_at        timestamptz not null default now(),

  constraint pilot_transfer_pkey primary key (organization_id, transfer_id),
  constraint pilot_transfer_drill_fk foreign key (organization_id, drill_id)
    references pilot.drill_library(organization_id, drill_id),
  constraint pilot_transfer_block_fk foreign key (organization_id, block_id)
    references pilot.session_script_blocks(organization_id, block_id),
  constraint pilot_transfer_script_fk foreign key (organization_id, script_id)
    references pilot.session_scripts(organization_id, script_id),
  -- Exactly one attachment point.
  constraint pilot_transfer_one_target check (
    (drill_id is not null)::int + (block_id is not null)::int + (script_id is not null)::int = 1
  ),
  -- An evidence-supported claim must name the claim it rests on.
  constraint pilot_transfer_evidence check (
    evidence_class <> 'EVIDENCE-SUPPORTED' or registry_claim_id <> ''
  ),
  -- A mechanism claim that names a brain structure may never be published outward unless it is
  -- evidence-supported. This is the constraint that stops a plausible sentence becoming a
  -- neuroscience claim in a grant application.
  constraint pilot_transfer_public_gate check (
    not (public_facing and named_structure <> '' and evidence_class <> 'EVIDENCE-SUPPORTED')
  )
);

create index if not exists pilot_transfer_drill on pilot.transfer_claims(organization_id, drill_id);
create index if not exists pilot_transfer_block on pilot.transfer_claims(organization_id, block_id);

comment on constraint pilot_transfer_public_gate on pilot.transfer_claims is
  'Structure-naming neuro claims cannot be published externally without a registry claim behind them. Prevents coaching rationale being read as neuroscience by funders or parents.';
