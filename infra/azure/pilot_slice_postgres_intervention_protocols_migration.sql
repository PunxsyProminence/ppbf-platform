-- Intervention protocols (register module 026, slice 1 of the keystone --
-- owner-directed spec 2026-08-16, capability name
-- InterventionExecutionLedger_TheWork).
--
-- WHAT THIS IS: the durable record of what PPBF INTENDED to do about a
-- problem -- the hypothesis being tested, the intervention as designed, the
-- intended exposure, and how it would be evaluated. A protocol is NOT an
-- execution: what actually happened lands in slice 2's execution records,
-- and the gap between the two is where half the learning lives.
--
-- STRUCTURED EXPOSURE, NEVER A DOSE SCALAR. Different interventions live in
-- incomparable units (rounds, cue exposures, constrained opportunities...).
-- intended_exposure is a jsonb map of DIMENSION -> numeric amount, with the
-- dimension vocabulary validated by the writing module; forcing these onto
-- one number would be an invented metric, which this platform refuses.
--
-- Versioning mirrors the drill-lineage pattern: editing a protocol INSERTS
-- a new version sharing lineage_id with supersedes pointing at the old row,
-- which is stamped superseded. Nothing is silently overwritten -- an
-- execution recorded against v1 keeps meaning v1 forever.
--
-- Athlete applicability: athlete_id null means an org-general protocol; set
-- means designed for one athlete. Athlete-specific learning must never
-- auto-generalize (standing rule) -- and neither do protocols.
--
-- Idempotent like every migration in this directory: create table/index
-- if not exists, no alters, no drops, safe to re-run wholesale.

create table if not exists pilot.intervention_protocols (
  organization_id        text not null references pilot.organizations(organization_id) on delete cascade,
  protocol_id            text not null,
  lineage_id             text not null,
  version                integer not null default 1 check (version >= 1),
  supersedes_protocol_id text null,
  athlete_id             text null,
  title                  text not null check (length(btrim(title)) > 0),
  target_problem         text not null check (length(btrim(target_problem)) > 0),
  hypothesis             text not null check (length(btrim(hypothesis)) > 0),
  intervention_description text not null check (length(btrim(intervention_description)) > 0),
  intended_task_context  text not null default '',
  intended_exposure      jsonb not null default '{}'::jsonb,
  expected_outcome       text not null check (length(btrim(expected_outcome)) > 0),
  -- Hypothesis before hindsight (spec): what would CONTRADICT the belief,
  -- and what else could explain a change. Optional -- ordinary coaching is
  -- not an elaborate scientific form -- but recorded BEFORE execution when
  -- present, which is what makes them bias-resistant.
  contradicting_evidence text not null default '',
  alternative_explanations text not null default '',
  evaluation_plan        text not null default '',
  status                 text not null default 'active' check (status in ('active', 'retired', 'superseded')),
  created_by_account_id  text not null references pilot.accounts(account_id),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  primary key (organization_id, protocol_id),
  constraint pilot_intervention_protocols_supersedes_fk
    foreign key (organization_id, supersedes_protocol_id)
    references pilot.intervention_protocols(organization_id, protocol_id),
  constraint pilot_intervention_protocols_athlete_fk
    foreign key (organization_id, athlete_id)
    references pilot.athletes(organization_id, athlete_id) on delete cascade,
  -- v1 rows head their lineage; v2+ rows must say what they replace.
  constraint pilot_intervention_protocols_lineage_check
    check ((version = 1) = (supersedes_protocol_id is null))
);

-- One ACTIVE head per lineage: the current version of a protocol is a fact,
-- not a query heuristic.
create unique index if not exists idx_intervention_protocols_one_active
  on pilot.intervention_protocols(organization_id, lineage_id)
  where status = 'active';

create index if not exists idx_intervention_protocols_by_org
  on pilot.intervention_protocols(organization_id, status, created_at desc);
