-- Intervention executions (register module 026, slice 2 of the keystone --
-- owner-directed spec 2026-08-16, capability name
-- InterventionExecutionLedger_TheWork).
--
-- WHAT THIS IS: the durable record of what ACTUALLY HAPPENED when a
-- protocol was run -- planned vs actual, adherence, deviations and their
-- reasons, and why work stopped or changed. A human decision is NOT
-- evidence an intervention was executed; a decision can exist with zero
-- executions, and one protocol/decision can span many executions. The gap
-- between slice 1's stated intent and these rows is where half the
-- learning lives.
--
-- PLANNED IS A SNAPSHOT, NEVER OVERWRITTEN. planned_* columns are copied
-- from the protocol version at start time and no write path touches them
-- again; actual_* columns are the only ones execution updates. Deviations
-- are recorded beside the plan, not painted over it.
--
-- ADHERENCE IS AN EXPLICIT STATE, NOT A FAKE PERCENTAGE. The vocabulary
-- separates "delivered as planned" from "delivered with deviations",
-- "under-delivered", "not delivered", and the honest default "unknown" --
-- because "intervention looked ineffective" and "intervention was never
-- really delivered" must stay distinguishable forever.
--
-- CORRECTIONS ARE SUPERSESSION. Fixing an erroneous execution record
-- INSERTS a new version in the same lineage with a stated reason; the
-- original row keeps its values and is stamped superseded. History is
-- never rewritten.
--
-- CONTEXT IS FACTS, NOT SCORES: trained context is a small vocabulary
-- (controlled / constrained_live / live / unknown); there is no difficulty
-- or challenge score anywhere in this table.
--
-- Idempotent like every migration in this directory: create table/index
-- if not exists, no alters, no drops, safe to re-run wholesale.

-- Lets executions bind to a decision IN THE SAME ORGANIZATION as a
-- database fact (composite FK below): additive unique index over the
-- existing PK column plus its org column.
create unique index if not exists idx_shadow_decisions_org_decision
  on pilot.shadow_decisions(organization_id, decision_id);

create table if not exists pilot.intervention_executions (
  organization_id        text not null references pilot.organizations(organization_id) on delete cascade,
  execution_id           text not null,
  lineage_id             text not null,
  version                integer not null default 1 check (version >= 1),
  supersedes_execution_id text null,
  athlete_id             text not null,
  decision_id            uuid null,
  protocol_id            text not null,
  protocol_version       integer not null check (protocol_version >= 1),
  session_run_id         text null,
  recorded_by_account_id text not null references pilot.accounts(account_id),
  planned_start          timestamptz null,
  actual_start           timestamptz null,
  actual_end             timestamptz null,
  status                 text not null default 'in_progress'
    check (status in ('in_progress', 'completed', 'stopped', 'superseded')),
  -- Snapshots of intent at start time. No update path touches these.
  planned_exposure       jsonb not null default '{}'::jsonb,
  planned_task_context   text not null default '',
  -- What actually happened, in the same structured dimension vocabulary.
  actual_exposure        jsonb not null default '{}'::jsonb,
  trained_context        text not null default 'unknown'
    check (trained_context in ('unknown', 'controlled', 'constrained_live', 'live')),
  task_constraint        text not null default '',
  partner_context        text not null default '',
  adherence              text not null default 'unknown'
    check (adherence in ('delivered_as_planned', 'delivered_with_deviations',
                         'under_delivered', 'not_delivered', 'unknown')),
  deviations             text not null default '',
  deviation_reason       text not null default '',
  stop_change_reason     text not null default '',
  notes                  text not null default '',
  correction_reason      text not null default '',
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  primary key (organization_id, execution_id),
  constraint pilot_intervention_executions_supersedes_fk
    foreign key (organization_id, supersedes_execution_id)
    references pilot.intervention_executions(organization_id, execution_id),
  constraint pilot_intervention_executions_athlete_fk
    foreign key (organization_id, athlete_id)
    references pilot.athletes(organization_id, athlete_id) on delete cascade,
  constraint pilot_intervention_executions_protocol_fk
    foreign key (organization_id, protocol_id)
    references pilot.intervention_protocols(organization_id, protocol_id),
  -- Org-bound decision link: an execution cannot claim another org's
  -- decision, structurally.
  constraint pilot_intervention_executions_decision_fk
    foreign key (organization_id, decision_id)
    references pilot.shadow_decisions(organization_id, decision_id) on delete set null,
  constraint pilot_intervention_executions_session_run_fk
    foreign key (organization_id, session_run_id)
    references pilot.session_script_runs(organization_id, run_id) on delete set null,
  -- v1 rows head their lineage; corrections must say what they correct.
  constraint pilot_intervention_executions_lineage_check
    check ((version = 1) = (supersedes_execution_id is null)),
  -- A correction without a stated reason is a rewrite, not a correction.
  constraint pilot_intervention_executions_correction_reason_check
    check (version = 1 or length(btrim(correction_reason)) > 0),
  -- Claimed deviations must be named, and a stop must say why.
  constraint pilot_intervention_executions_deviations_check
    check (adherence <> 'delivered_with_deviations' or length(btrim(deviations)) > 0),
  constraint pilot_intervention_executions_stop_reason_check
    check (status <> 'stopped' or length(btrim(stop_change_reason)) > 0),
  constraint pilot_intervention_executions_interval_check
    check (actual_end is null or actual_start is null or actual_end >= actual_start)
);

-- One CURRENT record per execution lineage: corrections replace, they do
-- not coexist.
create unique index if not exists idx_intervention_executions_one_current
  on pilot.intervention_executions(organization_id, lineage_id)
  where status <> 'superseded';

create index if not exists idx_intervention_executions_by_athlete
  on pilot.intervention_executions(organization_id, athlete_id, created_at desc);

create index if not exists idx_intervention_executions_by_protocol
  on pilot.intervention_executions(organization_id, protocol_id, created_at desc);
