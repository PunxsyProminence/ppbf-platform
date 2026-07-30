-- SHADOW closed decision-loop migration.
-- Apply through the controlled migration runner, never from an HTTP request.
-- New tables only -- no changes to shadow_recommendation_effectiveness
-- (post-hoc chat-feedback scoring) or any existing pilot.* table.
begin;

-- Read-only-to-recommendation-logic gate. Only shadowMedicalStatus.ts's
-- write path may insert here; shadowRecommendations.ts/shadowDecisions.ts
-- only ever read the latest row per athlete.
create table if not exists pilot.shadow_medical_administrative_status (
  status_id uuid primary key default gen_random_uuid(),
  organization_id text not null references pilot.organizations(organization_id) on delete cascade,
  athlete_id text not null,
  status text not null check (status in ('cleared', 'restricted', 'not_cleared', 'pending')),
  restriction_flags jsonb not null default '{}'::jsonb,
  source_reference text null,
  set_by_account_id text not null references pilot.accounts(account_id) on delete cascade,
  set_by_role text not null,
  effective_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  foreign key (organization_id, athlete_id)
    references pilot.athletes(organization_id, athlete_id) on delete cascade
);

create index if not exists idx_shadow_medical_status_athlete
  on pilot.shadow_medical_administrative_status(organization_id, athlete_id, effective_at desc);

-- Forward-looking, provisional-by-default recommendation. Distinct from
-- shadow_recommendation_effectiveness, which only scores past chat
-- interactions after the fact and has no status/expected_outcome concept.
create table if not exists pilot.shadow_recommendations (
  recommendation_id uuid primary key default gen_random_uuid(),
  organization_id text not null references pilot.organizations(organization_id) on delete cascade,
  athlete_id text not null,
  source_formula_result_id text null references pilot.shadow_formula_results(result_id) on delete set null,
  recommendation_text text not null,
  expected_outcome text not null,
  status text not null default 'provisional'
    check (status in ('provisional', 'accepted', 'rejected', 'expired', 'superseded')),
  created_by_account_id text not null references pilot.accounts(account_id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  decided_by_account_id text null references pilot.accounts(account_id) on delete set null,
  decided_at timestamptz null,
  foreign key (organization_id, athlete_id)
    references pilot.athletes(organization_id, athlete_id) on delete cascade
);

create index if not exists idx_shadow_recommendations_athlete_status
  on pilot.shadow_recommendations(organization_id, athlete_id, status, created_at desc);

-- A human decision. May stand alone (a coach can log a decision with no
-- prior recommendation) or reference one.
create table if not exists pilot.shadow_decisions (
  decision_id uuid primary key default gen_random_uuid(),
  organization_id text not null references pilot.organizations(organization_id) on delete cascade,
  athlete_id text not null,
  recommendation_id uuid null references pilot.shadow_recommendations(recommendation_id) on delete set null,
  decision_text text not null,
  expected_outcome text not null,
  decided_by_account_id text not null references pilot.accounts(account_id) on delete cascade,
  decided_by_role text not null,
  medical_status_snapshot_id uuid null
    references pilot.shadow_medical_administrative_status(status_id) on delete set null,
  status text not null default 'active'
    check (status in ('active', 'superseded', 'reversed')),
  decided_at timestamptz not null default now(),
  foreign key (organization_id, athlete_id)
    references pilot.athletes(organization_id, athlete_id) on delete cascade
);

create index if not exists idx_shadow_decisions_athlete
  on pilot.shadow_decisions(organization_id, athlete_id, decided_at desc);

-- Human-flagged only in this pass; a system-detected heuristic (e.g. an
-- acute:chronic contact-exposure ratio crossing a threshold with no
-- decision on file) is deliberately deferred, not implemented here.
create table if not exists pilot.shadow_near_misses (
  near_miss_id uuid primary key default gen_random_uuid(),
  organization_id text not null references pilot.organizations(organization_id) on delete cascade,
  athlete_id text not null,
  decision_id uuid null references pilot.shadow_decisions(decision_id) on delete set null,
  description text not null,
  severity text not null check (severity in ('low', 'moderate', 'high', 'critical')),
  detected_by text not null check (detected_by in ('system', 'human')),
  detected_by_account_id text null references pilot.accounts(account_id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  foreign key (organization_id, athlete_id)
    references pilot.athletes(organization_id, athlete_id) on delete cascade
);

create index if not exists idx_shadow_near_misses_athlete
  on pilot.shadow_near_misses(organization_id, athlete_id, created_at desc);

-- Closes the loop: a human reviewer compares a decision's expected_outcome
-- against what actually happened. Always a recorded human judgment, never
-- an automated comparison.
create table if not exists pilot.shadow_decision_outcomes (
  outcome_id uuid primary key default gen_random_uuid(),
  organization_id text not null references pilot.organizations(organization_id) on delete cascade,
  decision_id uuid not null references pilot.shadow_decisions(decision_id) on delete cascade,
  observation_ids text[] not null default '{}',
  match_state text not null check (match_state in ('match', 'partial', 'miss', 'confounded')),
  notes text null,
  evaluated_by_account_id text not null references pilot.accounts(account_id) on delete cascade,
  evaluated_at timestamptz not null default now()
);

create index if not exists idx_shadow_decision_outcomes_decision
  on pilot.shadow_decision_outcomes(decision_id, evaluated_at desc);

-- Domain-specific governance log for the four tables above -- distinct from
-- the generic pilot.audit_events / pilot.shadow_chat_audit security logs.
-- Every write path in this loop writes one row here inside the same
-- transaction as its primary write.
create table if not exists pilot.shadow_audit_entries (
  audit_entry_id uuid primary key default gen_random_uuid(),
  organization_id text not null references pilot.organizations(organization_id) on delete cascade,
  entity_type text not null
    check (entity_type in ('recommendation', 'decision', 'medical_status', 'near_miss', 'outcome')),
  entity_id text not null,
  action text not null,
  actor_account_id text not null references pilot.accounts(account_id) on delete cascade,
  actor_role text not null,
  before_state jsonb null,
  after_state jsonb null,
  created_at timestamptz not null default now()
);

create index if not exists idx_shadow_audit_entries_entity
  on pilot.shadow_audit_entries(organization_id, entity_type, entity_id, created_at desc);

commit;
