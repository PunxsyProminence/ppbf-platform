-- Intervention evidence links + outcome reviews (register module 026,
-- slice 3 of 3 -- owner-directed spec 2026-08-16, capability name
-- InterventionExecutionLedger_TheWork). This slice closes the loop:
-- DECISION -> PLANNED -> ACTUAL -> WHAT HAPPENED -> WHAT WE LEARNED.
--
-- TYPED EVIDENCE, NOT STRING ARRAYS. An evidence link names its SEMANTIC
-- ROLE (baseline / during / immediate-post / retention / transfer /
-- counterevidence / adverse-response / context) and its TYPED SOURCE
-- (a training attempt, readiness entry, assessment, film-study
-- observation, activity-log row). Heterogeneous sources participate
-- without being flattened into one observations table; the writing module
-- validates existence, organization, and athlete scope per source kind.
-- Links are never deleted -- removal stamps them with a reason.
--
-- THREE SEPARATE ANSWERS, NEVER ONE SCORE. A review records
-- PerformanceOutcome (what happened), HypothesisResult (what happened to
-- the belief), and LearningSignal (what the episode revealed) as three
-- columns with their own vocabularies. The failure-learning rules are
-- database constraints, not conventions:
--   * a miss cannot validate success -- declined/unchanged performance
--     cannot coexist with a supported hypothesis;
--   * confounded or insufficient evidence cannot strengthen a prior
--     belief.
-- A miss CAN still produce real learning (non-response, boundary
-- discovered, transfer failure...) -- that is the point of the ledger.
--
-- HUMAN REVIEW ONLY: a review row structurally requires the reviewing
-- account. Nothing in this schema computes a verdict.
--
-- Idempotent like every migration in this directory: create table/index
-- if not exists, no alters, no drops, safe to re-run wholesale.

create table if not exists pilot.intervention_evidence_links (
  organization_id       text not null references pilot.organizations(organization_id) on delete cascade,
  link_id               text not null,
  execution_id          text not null,
  evidence_role         text not null
    check (evidence_role in ('baseline', 'during_intervention', 'immediate_post', 'retention',
                             'transfer', 'counterevidence', 'adverse_response', 'context')),
  source_kind           text not null
    check (source_kind in ('training_attempt', 'readiness', 'assessment', 'film_study', 'activity_log')),
  source_id             text not null check (length(btrim(source_id)) > 0),
  note                  text not null default '',
  status                text not null default 'active' check (status in ('active', 'removed')),
  removed_reason        text not null default ''
    check (status <> 'removed' or length(btrim(removed_reason)) > 0),
  linked_by_account_id  text not null references pilot.accounts(account_id),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  primary key (organization_id, link_id),
  constraint pilot_intervention_evidence_execution_fk
    foreign key (organization_id, execution_id)
    references pilot.intervention_executions(organization_id, execution_id) on delete cascade
);

-- The same source cannot play the same role twice on one execution while
-- active -- duplicate links add noise, not evidence.
create unique index if not exists idx_intervention_evidence_no_duplicates
  on pilot.intervention_evidence_links(organization_id, execution_id, evidence_role, source_kind, source_id)
  where status = 'active';

create index if not exists idx_intervention_evidence_by_execution
  on pilot.intervention_evidence_links(organization_id, execution_id, created_at desc);

create table if not exists pilot.intervention_outcome_reviews (
  organization_id        text not null references pilot.organizations(organization_id) on delete cascade,
  review_id              text not null,
  execution_id           text not null,
  supersedes_review_id   text null,
  performance_result     text not null
    check (performance_result in ('improved', 'unchanged', 'declined', 'mixed', 'unknown')),
  performance_notes      text not null check (length(btrim(performance_notes)) > 0),
  hypothesis_result      text not null
    check (hypothesis_result in ('supported', 'partially_supported', 'contradicted',
                                 'unresolved', 'confounded', 'insufficient_evidence')),
  learning_signal        text not null
    check (learning_signal in ('prior_belief_strengthened', 'prior_belief_weakened',
                               'boundary_condition_discovered', 'intervention_non_response',
                               'transfer_failure', 'retention_failure', 'implementation_failure',
                               'attribution_changed', 'redundant_evidence', 'unresolved')),
  learning_notes         text not null default '',
  status                 text not null default 'active' check (status in ('active', 'superseded')),
  reviewed_by_account_id text not null references pilot.accounts(account_id),
  reviewed_at            timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  primary key (organization_id, review_id),
  constraint pilot_intervention_reviews_execution_fk
    foreign key (organization_id, execution_id)
    references pilot.intervention_executions(organization_id, execution_id) on delete cascade,
  constraint pilot_intervention_reviews_supersedes_fk
    foreign key (organization_id, supersedes_review_id)
    references pilot.intervention_outcome_reviews(organization_id, review_id),
  -- A miss must not validate success: performance that declined or did
  -- not move cannot carry a supported hypothesis.
  constraint pilot_intervention_reviews_miss_check
    check (performance_result not in ('declined', 'unchanged')
           or hypothesis_result not in ('supported', 'partially_supported')),
  -- Confounded or insufficient evidence does not establish efficacy.
  constraint pilot_intervention_reviews_confound_check
    check (hypothesis_result not in ('confounded', 'insufficient_evidence')
           or learning_signal <> 'prior_belief_strengthened')
);

-- One ACTIVE review per execution: re-review supersedes, it does not
-- accumulate parallel verdicts.
create unique index if not exists idx_intervention_reviews_one_active
  on pilot.intervention_outcome_reviews(organization_id, execution_id)
  where status = 'active';

create index if not exists idx_intervention_reviews_by_execution
  on pilot.intervention_outcome_reviews(organization_id, execution_id, reviewed_at desc);
