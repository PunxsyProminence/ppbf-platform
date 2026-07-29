-- Additive SHADOW runtime/schema alignment migration.
-- Apply through the controlled migration runner, never from an HTTP request.
begin;

create table if not exists pilot.shadow_chat_sessions (
  conversation_id uuid primary key,
  organization_id text not null references pilot.organizations(organization_id) on delete cascade,
  account_id text not null references pilot.accounts(account_id) on delete cascade,
  athlete_id text null,
  title text not null default 'New conversation',
  session_type text not null default 'quick_round',
  deleted_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (organization_id, athlete_id)
    references pilot.athletes(organization_id, athlete_id) on delete cascade
);

create index if not exists idx_shadow_chat_sessions_owner
  on pilot.shadow_chat_sessions(organization_id, account_id, updated_at desc)
  where deleted_at is null;

create table if not exists pilot.shadow_chat_messages (
  message_id uuid primary key,
  conversation_id uuid not null references pilot.shadow_chat_sessions(conversation_id) on delete cascade,
  organization_id text not null references pilot.organizations(organization_id) on delete cascade,
  account_id text not null references pilot.accounts(account_id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  response_state text null check (response_state in ('ok', 'filtered')),
  topic text not null default 'general',
  session_type text not null default 'quick_round',
  created_at timestamptz not null default now()
);

-- evidence_tier and handoff are persisted per assistant message because the
-- chat UI renders both, and without them a restored conversation was not a
-- faithful replay of what the user was originally shown. A message stored
-- without an evidence grade rendered at the EMERGING style -- the second
-- darkest, meaning well-evidenced -- so an answer originally graded
-- RESEARCH_NEEDED reopened looking more authoritative than it was. Worse, the
-- dropped handoff meant the "Human Handoff Required" banner disappeared on
-- reopen, taking instructions like "talk to your medical team before changing
-- any weight-cut plan" with it. Both are nullable: rows written before this
-- migration have no grade to recover, and the read path treats null as
-- RESEARCH_NEEDED rather than inventing a better one.
alter table pilot.shadow_chat_messages
  add column if not exists topic text not null default 'general',
  add column if not exists session_type text not null default 'quick_round',
  add column if not exists evidence_tier text null
    check (evidence_tier in ('PROVEN', 'EMERGING', 'EXPERIMENTAL', 'RESEARCH_NEEDED')),
  add column if not exists handoff text null;

create index if not exists idx_shadow_chat_messages_conversation
  on pilot.shadow_chat_messages(organization_id, account_id, conversation_id, created_at asc);

create table if not exists pilot.shadow_human_review_queue (
  review_id uuid primary key,
  organization_id text not null references pilot.organizations(organization_id) on delete cascade,
  conversation_id uuid null references pilot.shadow_chat_sessions(conversation_id) on delete set null,
  account_id text not null references pilot.accounts(account_id) on delete cascade,
  category text not null,
  severity text not null check (severity in ('moderate', 'high', 'critical')),
  summary text not null,
  status text not null default 'open'
    check (status in ('open', 'in_review', 'resolved', 'dismissed')),
  metadata jsonb not null default '{}'::jsonb,
  reviewed_by text null,
  reviewed_at timestamptz null,
  created_at timestamptz not null default now()
);

create index if not exists idx_shadow_human_review_org_status
  on pilot.shadow_human_review_queue(organization_id, status, created_at desc);

create table if not exists pilot.shadow_data_deletion_requests (
  request_id uuid primary key,
  organization_id text not null references pilot.organizations(organization_id) on delete cascade,
  account_id text not null references pilot.accounts(account_id) on delete cascade,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'completed', 'denied')),
  requested_at timestamptz not null default now(),
  completed_at timestamptz null,
  processed_by text null
);

create index if not exists idx_shadow_deletion_requests_org_status
  on pilot.shadow_data_deletion_requests(organization_id, status, requested_at desc);

create table if not exists pilot.shadow_chat_memory_corrections (
  correction_id uuid primary key,
  organization_id text not null references pilot.organizations(organization_id) on delete cascade,
  account_id text not null references pilot.accounts(account_id) on delete cascade,
  fact_key text not null,
  corrected_value text null,
  action text not null check (action in ('replace', 'forget')),
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'applied', 'denied')),
  reviewed_by_account_id text null,
  reviewed_at timestamptz null,
  created_at timestamptz not null default now()
);

create index if not exists idx_shadow_memory_corrections_owner
  on pilot.shadow_chat_memory_corrections(organization_id, account_id, created_at desc);

create table if not exists pilot.shadow_jobs (
  job_id uuid primary key default gen_random_uuid(),
  job_type text not null
    check (job_type in (
      'heavy_bag_session', 'scout_report', 'board_summary',
      'library_update', 'film_study', 'learning_loop'
    )),
  organization_id text not null references pilot.organizations(organization_id) on delete cascade,
  account_id text not null references pilot.accounts(account_id) on delete cascade,
  subject_id text null,
  role text not null,
  status text not null default 'pending'
    check (status in ('pending', 'running', 'completed', 'failed', 'cancelled')),
  input_payload jsonb not null default '{}'::jsonb,
  output_payload jsonb null,
  error_message text null
    check (error_message is null or error_message ~ '^[A-Z][A-Z0-9_]{2,79}$'),
  safety_status text not null default 'pending'
    check (safety_status in ('pending', 'passed', 'filtered', 'not_applicable')),
  priority integer not null default 3 check (priority between 1 and 5),
  retry_count integer not null default 0 check (retry_count >= 0),
  max_retries integer not null default 3 check (max_retries between 1 and 10),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz null,
  completed_at timestamptz null,
  expires_at timestamptz not null default now() + interval '24 hours',
  foreign key (organization_id, subject_id)
    references pilot.athletes(organization_id, athlete_id)
    on delete cascade
);

alter table pilot.shadow_jobs
  add column if not exists subject_id text null,
  add column if not exists safety_status text not null default 'pending',
  add column if not exists updated_at timestamptz not null default now();

create index if not exists idx_shadow_jobs_status_priority
  on pilot.shadow_jobs(status, priority asc, created_at asc)
  where status = 'pending';
create index if not exists idx_shadow_jobs_owner_created
  on pilot.shadow_jobs(organization_id, account_id, created_at desc);
create index if not exists idx_shadow_jobs_subject_created
  on pilot.shadow_jobs(organization_id, subject_id, created_at desc)
  where subject_id is not null;

create table if not exists pilot.shadow_research_requirements (
  research_requirement_id bigserial primary key,
  organization_id text not null references pilot.organizations(organization_id) on delete cascade,
  source_event_name text not null,
  source_entity_type text not null,
  source_entity_id text not null,
  research_requirement text not null,
  knowledge_gap text not null,
  evidence_label text null,
  source_status text not null,
  source_confidence_tier text not null,
  source_verification_state text not null,
  status text not null default 'open' check (status in ('open', 'resolved')),
  created_by_account_id text not null,
  created_by_role text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  resolved_at timestamptz null
);
create index if not exists idx_shadow_research_requirements_org_created
  on pilot.shadow_research_requirements(organization_id, created_at desc);

alter table pilot.shadow_feedback
  add column if not exists outcome_signal text null,
  add column if not exists correlation_type text null,
  add column if not exists correlation_id text null,
  add column if not exists verification_state text not null default 'unverified',
  add column if not exists human_review_required boolean not null default true,
  add column if not exists reviewed_by_account_id text null references pilot.accounts(account_id) on delete set null,
  add column if not exists reviewed_at timestamptz null;
create index if not exists idx_shadow_feedback_correlation
  on pilot.shadow_feedback(organization_id, account_id, correlation_type, correlation_id);
create unique index if not exists idx_shadow_feedback_unique_message
  on pilot.shadow_feedback(organization_id, account_id, correlation_id)
  where correlation_type = 'shadow_message'
    and correlation_id is not null;

alter table pilot.shadow_authority_checks
  add column if not exists source_confidence_tier text null,
  add column if not exists source_verification_state text null;

create table if not exists pilot.shadow_recommendation_effectiveness (
  effectiveness_id bigserial primary key,
  organization_id text not null references pilot.organizations(organization_id) on delete cascade,
  account_id text not null references pilot.accounts(account_id) on delete cascade,
  feedback_id bigint null unique references pilot.shadow_feedback(feedback_id) on delete set null,
  recommendation_id text null,
  recommendation_type text not null,
  outcome text not null check (outcome in ('improved', 'neutral', 'degraded', 'unknown')),
  effectiveness_score numeric(4,3) null check (effectiveness_score between 0 and 1),
  verification_state text not null default 'unverified'
    check (verification_state in ('unverified', 'durable_client', 'human_reviewed')),
  human_review_required boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists idx_shadow_recommendation_effectiveness_org_created
  on pilot.shadow_recommendation_effectiveness(organization_id, created_at desc);

create table if not exists pilot.shadow_learning_events (
  event_id uuid primary key default gen_random_uuid(),
  organization_id text not null references pilot.organizations(organization_id) on delete cascade,
  account_id text not null references pilot.accounts(account_id) on delete cascade,
  role text not null,
  feedback_id bigint not null references pilot.shadow_feedback(feedback_id) on delete cascade,
  shadow_event_id bigint null references pilot.shadow_events(shadow_event_id) on delete set null,
  message_id text not null,
  topic text not null default 'general',
  session_type text not null default 'quick_round',
  outcome_signal text not null,
  effectiveness_score numeric(4,3) null
    check (effectiveness_score between 0 and 1),
  verification_state text not null default 'unverified'
    check (verification_state in ('unverified', 'durable_client', 'human_reviewed')),
  human_review_required boolean not null default true,
  actions_taken jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  unique (feedback_id, verification_state)
);
alter table pilot.shadow_learning_events
  add column if not exists feedback_id bigint null references pilot.shadow_feedback(feedback_id) on delete cascade,
  add column if not exists shadow_event_id bigint null references pilot.shadow_events(shadow_event_id) on delete set null,
  add column if not exists message_id text null,
  add column if not exists effectiveness_score numeric(4,3) null,
  add column if not exists verification_state text not null default 'unverified',
  add column if not exists human_review_required boolean not null default true;
create index if not exists idx_learning_events_org_date
  on pilot.shadow_learning_events(organization_id, created_at desc);

create table if not exists pilot.shadow_library_review_flags (
  flag_id uuid primary key default gen_random_uuid(),
  organization_id text not null references pilot.organizations(organization_id) on delete cascade,
  account_id text null references pilot.accounts(account_id) on delete set null,
  feedback_id bigint null references pilot.shadow_feedback(feedback_id) on delete set null,
  topic text not null,
  session_type text null,
  outcome_signal text null,
  user_note text null,
  flag_count integer not null default 1 check (flag_count >= 1),
  review_state text not null default 'pending'
    check (review_state in ('pending', 'approved', 'rejected', 'resolved')),
  proposed_action text null check (proposed_action in ('promote', 'demote', 'retain')),
  flagged_at timestamptz not null default now(),
  last_flagged_at timestamptz not null default now(),
  latest_outcome_signal text null,
  reviewed_by_account_id text null,
  reviewed_at timestamptz null,
  unique (organization_id, topic)
);
alter table pilot.shadow_library_review_flags
  add column if not exists feedback_id bigint null references pilot.shadow_feedback(feedback_id) on delete set null,
  add column if not exists review_state text not null default 'pending',
  add column if not exists proposed_action text null,
  add column if not exists reviewed_by_account_id text null,
  add column if not exists reviewed_at timestamptz null;
create index if not exists idx_shadow_library_review_flags_org_state
  on pilot.shadow_library_review_flags(organization_id, review_state, last_flagged_at desc);

create table if not exists pilot.shadow_monthly_stats (
  monthly_stat_id bigserial primary key,
  organization_id text not null references pilot.organizations(organization_id) on delete cascade,
  month text not null check (month ~ '^[0-9]{4}-[0-9]{2}$'),
  interaction_count integer not null default 0 check (interaction_count >= 0),
  avg_filter_rate numeric(6,5) null check (avg_filter_rate between 0 and 1),
  avg_effectiveness_score numeric(6,5) null
    check (avg_effectiveness_score between 0 and 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, month)
);

create table if not exists pilot.shadow_formula_observations (
  observation_id text primary key,
  organization_id text not null references pilot.organizations(organization_id) on delete cascade,
  athlete_id text null,
  context_id text not null,
  observation_kind text not null,
  numeric_value numeric null,
  unit text not null,
  observed_at timestamptz not null,
  source_type text not null,
  source_quality text not null
    check (source_quality in ('verified', 'high', 'moderate', 'low', 'failed')),
  source_reference_id text not null,
  source_quality_notes text null,
  supersedes_observation_id text null references pilot.shadow_formula_observations(observation_id),
  created_by_account_id text null references pilot.accounts(account_id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key (organization_id, athlete_id)
    references pilot.athletes(organization_id, athlete_id) on delete cascade
);
create index if not exists idx_shadow_formula_observations_scope
  on pilot.shadow_formula_observations(
    organization_id, athlete_id, context_id, observation_kind, observed_at desc
  );

create table if not exists pilot.shadow_formula_results (
  result_id text primary key,
  formula_id text not null,
  formula_version text not null,
  organization_id text not null references pilot.organizations(organization_id) on delete cascade,
  athlete_id text null,
  context_id text null,
  numeric_value numeric null,
  unit text not null,
  computed_at timestamptz not null,
  input_observation_ids text[] not null default '{}',
  provenance jsonb not null default '[]'::jsonb,
  validation_state text not null
    check (validation_state in ('valid', 'warning', 'invalid', 'insufficient', 'unsupported')),
  hard_blocks text[] not null default '{}',
  warnings text[] not null default '{}',
  confidence text not null
    check (confidence in ('HIGH', 'MODERATE', 'LOW', 'INSUFFICIENT')),
  completeness numeric(6,5) not null check (completeness between 0 and 1),
  worst_source_quality text null,
  unavailable_reason text null,
  human_review_required boolean not null default false,
  created_at timestamptz not null default now(),
  foreign key (organization_id, athlete_id)
    references pilot.athletes(organization_id, athlete_id) on delete cascade
);
create index if not exists idx_shadow_formula_results_scope
  on pilot.shadow_formula_results(
    organization_id, athlete_id, formula_id, formula_version, computed_at desc
  );

create table if not exists pilot.shadow_formula_baseline_snapshots (
  baseline_snapshot_id uuid primary key default gen_random_uuid(),
  organization_id text not null references pilot.organizations(organization_id) on delete cascade,
  athlete_id text not null,
  formula_id text not null,
  formula_version text not null,
  window_size integer not null check (window_size between 1 and 1000),
  history_status text not null
    check (history_status in ('insufficient_history', 'building', 'adequate')),
  baseline_mean numeric null,
  baseline_sample_sd numeric null,
  observation_ids text[] not null default '{}',
  effective_at timestamptz not null,
  created_at timestamptz not null default now(),
  foreign key (organization_id, athlete_id)
    references pilot.athletes(organization_id, athlete_id) on delete cascade
);
create index if not exists idx_shadow_formula_baseline_scope
  on pilot.shadow_formula_baseline_snapshots(
    organization_id, athlete_id, formula_id, effective_at desc
  );

create table if not exists pilot.shadow_rate_limit_buckets (
  organization_id text not null references pilot.organizations(organization_id) on delete cascade,
  account_id text not null references pilot.accounts(account_id) on delete cascade,
  endpoint_key text not null,
  window_started_at timestamptz not null,
  window_seconds integer not null check (window_seconds between 1 and 86400),
  request_count integer not null default 0 check (request_count >= 0),
  updated_at timestamptz not null default now(),
  primary key (organization_id, account_id, endpoint_key, window_started_at)
);

create index if not exists idx_shadow_rate_limit_buckets_window
  on pilot.shadow_rate_limit_buckets(window_started_at, updated_at);

-- Harden tables created by an earlier version of this additive migration.
-- Every check reports only a stable table/category identifier. Existing rows
-- are never rewritten or deleted to make a constraint pass.
do $shadow_runtime_precheck$
begin
  if exists (
    select 1 from pilot.shadow_feedback
    where verification_state not in ('unverified', 'durable_client', 'human_reviewed')
      or (
        reviewed_by_account_id is not null
        and not exists (
          select 1
          from pilot.accounts
          where accounts.account_id = shadow_feedback.reviewed_by_account_id
        )
      )
  ) then
    raise exception using
      errcode = '23514',
      message = 'SHADOW_RUNTIME_PRECHECK_FAILED',
      detail = 'shadow_feedback';
  end if;

  if exists (
    select 1 from pilot.shadow_jobs
    where job_type not in (
      'heavy_bag_session', 'scout_report', 'board_summary',
      'library_update', 'film_study', 'learning_loop'
    )
      or status not in ('pending', 'running', 'completed', 'failed', 'cancelled')
      or (error_message is not null and error_message !~ '^[A-Z][A-Z0-9_]{2,79}$')
      or safety_status not in ('pending', 'passed', 'filtered', 'not_applicable')
      or priority not between 1 and 5
      or retry_count < 0
      or max_retries not between 1 and 10
      or (
        subject_id is not null
        and not exists (
          select 1
          from pilot.athletes
          where athletes.organization_id = shadow_jobs.organization_id
            and athletes.athlete_id = shadow_jobs.subject_id
        )
      )
  ) then
    raise exception using
      errcode = '23514',
      message = 'SHADOW_RUNTIME_PRECHECK_FAILED',
      detail = 'shadow_jobs';
  end if;

  if exists (
    select 1 from pilot.shadow_research_requirements
    where status not in ('open', 'resolved')
  ) or exists (
    select 1
    from pilot.shadow_research_requirements
    group by organization_id, source_event_name, source_entity_type, source_entity_id
    having count(*) > 1
  ) then
    raise exception using
      errcode = '23514',
      message = 'SHADOW_RUNTIME_PRECHECK_FAILED',
      detail = 'shadow_research_requirements';
  end if;

  if exists (
    select 1 from pilot.shadow_recommendation_effectiveness
    where outcome not in ('improved', 'neutral', 'degraded', 'unknown')
      or (effectiveness_score is not null and effectiveness_score not between 0 and 1)
      or verification_state not in ('unverified', 'durable_client', 'human_reviewed')
  ) then
    raise exception using
      errcode = '23514',
      message = 'SHADOW_RUNTIME_PRECHECK_FAILED',
      detail = 'shadow_recommendation_effectiveness';
  end if;

  if exists (
    select 1 from pilot.shadow_learning_events
    where feedback_id is null
      or message_id is null
      or (effectiveness_score is not null and effectiveness_score not between 0 and 1)
      or verification_state not in ('unverified', 'durable_client', 'human_reviewed')
  ) or exists (
    select 1
    from pilot.shadow_learning_events
    group by feedback_id, verification_state
    having count(*) > 1
  ) then
    raise exception using
      errcode = '23514',
      message = 'SHADOW_RUNTIME_PRECHECK_FAILED',
      detail = 'shadow_learning_events';
  end if;

  if exists (
    select 1 from pilot.shadow_library_review_flags
    where flag_count < 1
      or review_state not in ('pending', 'approved', 'rejected', 'resolved')
      or (
        proposed_action is not null
        and proposed_action not in ('promote', 'demote', 'retain')
      )
  ) then
    raise exception using
      errcode = '23514',
      message = 'SHADOW_RUNTIME_PRECHECK_FAILED',
      detail = 'shadow_library_review_flags';
  end if;

  if exists (
    select 1 from pilot.shadow_monthly_stats
    where month !~ '^[0-9]{4}-[0-9]{2}$'
      or interaction_count < 0
      or (avg_filter_rate is not null and avg_filter_rate not between 0 and 1)
      or (
        avg_effectiveness_score is not null
        and avg_effectiveness_score not between 0 and 1
      )
  ) then
    raise exception using
      errcode = '23514',
      message = 'SHADOW_RUNTIME_PRECHECK_FAILED',
      detail = 'shadow_monthly_stats';
  end if;

  if exists (
    select 1 from pilot.shadow_formula_observations
    where source_quality not in ('verified', 'high', 'moderate', 'low', 'failed')
  ) then
    raise exception using
      errcode = '23514',
      message = 'SHADOW_RUNTIME_PRECHECK_FAILED',
      detail = 'shadow_formula_observations';
  end if;

  if exists (
    select 1 from pilot.shadow_formula_results
    where validation_state not in ('valid', 'warning', 'invalid', 'insufficient', 'unsupported')
      or confidence not in ('HIGH', 'MODERATE', 'LOW', 'INSUFFICIENT')
      or completeness not between 0 and 1
  ) then
    raise exception using
      errcode = '23514',
      message = 'SHADOW_RUNTIME_PRECHECK_FAILED',
      detail = 'shadow_formula_results';
  end if;

  if exists (
    select 1 from pilot.shadow_formula_baseline_snapshots
    where window_size not between 1 and 1000
      or history_status not in ('insufficient_history', 'building', 'adequate')
  ) then
    raise exception using
      errcode = '23514',
      message = 'SHADOW_RUNTIME_PRECHECK_FAILED',
      detail = 'shadow_formula_baseline_snapshots';
  end if;
end
$shadow_runtime_precheck$;

create unique index if not exists idx_shadow_research_requirements_source
  on pilot.shadow_research_requirements(
    organization_id,
    source_event_name,
    source_entity_type,
    source_entity_id
  );

alter table pilot.shadow_learning_events
  alter column feedback_id set not null,
  alter column message_id set not null;

do $shadow_runtime_constraints$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'pilot.shadow_feedback'::regclass
      and conname = 'shadow_feedback_verification_state_check'
  ) then
    alter table pilot.shadow_feedback
      add constraint shadow_feedback_verification_state_check
      check (verification_state in ('unverified', 'durable_client', 'human_reviewed'));
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'pilot.shadow_feedback'::regclass
      and conname = 'shadow_feedback_reviewed_by_account_id_fkey'
  ) then
    alter table pilot.shadow_feedback
      add constraint shadow_feedback_reviewed_by_account_id_fkey
      foreign key (reviewed_by_account_id)
      references pilot.accounts(account_id)
      on delete set null;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'pilot.shadow_jobs'::regclass
      and conname = 'shadow_jobs_job_type_check'
  ) then
    alter table pilot.shadow_jobs
      add constraint shadow_jobs_job_type_check
      check (job_type in (
        'heavy_bag_session', 'scout_report', 'board_summary',
        'library_update', 'film_study', 'learning_loop'
      ));
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'pilot.shadow_jobs'::regclass
      and conname = 'shadow_jobs_status_check'
  ) then
    alter table pilot.shadow_jobs
      add constraint shadow_jobs_status_check
      check (status in ('pending', 'running', 'completed', 'failed', 'cancelled'));
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'pilot.shadow_jobs'::regclass
      and conname = 'shadow_jobs_error_message_check'
  ) then
    alter table pilot.shadow_jobs
      add constraint shadow_jobs_error_message_check
      check (error_message is null or error_message ~ '^[A-Z][A-Z0-9_]{2,79}$');
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'pilot.shadow_jobs'::regclass
      and conname = 'shadow_jobs_safety_status_check'
  ) then
    alter table pilot.shadow_jobs
      add constraint shadow_jobs_safety_status_check
      check (safety_status in ('pending', 'passed', 'filtered', 'not_applicable'));
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'pilot.shadow_jobs'::regclass
      and conname = 'shadow_jobs_priority_check'
  ) then
    alter table pilot.shadow_jobs
      add constraint shadow_jobs_priority_check check (priority between 1 and 5);
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'pilot.shadow_jobs'::regclass
      and conname = 'shadow_jobs_retry_count_check'
  ) then
    alter table pilot.shadow_jobs
      add constraint shadow_jobs_retry_count_check check (retry_count >= 0);
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'pilot.shadow_jobs'::regclass
      and conname = 'shadow_jobs_max_retries_check'
  ) then
    alter table pilot.shadow_jobs
      add constraint shadow_jobs_max_retries_check check (max_retries between 1 and 10);
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'pilot.shadow_jobs'::regclass
      and conname = 'shadow_jobs_organization_id_subject_id_fkey'
  ) then
    alter table pilot.shadow_jobs
      add constraint shadow_jobs_organization_id_subject_id_fkey
      foreign key (organization_id, subject_id)
      references pilot.athletes(organization_id, athlete_id)
      on delete cascade;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'pilot.shadow_research_requirements'::regclass
      and conname = 'shadow_research_requirements_status_check'
  ) then
    alter table pilot.shadow_research_requirements
      add constraint shadow_research_requirements_status_check
      check (status in ('open', 'resolved'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'pilot.shadow_recommendation_effectiveness'::regclass
      and conname = 'shadow_recommendation_effectiveness_outcome_check'
  ) then
    alter table pilot.shadow_recommendation_effectiveness
      add constraint shadow_recommendation_effectiveness_outcome_check
      check (outcome in ('improved', 'neutral', 'degraded', 'unknown'));
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'pilot.shadow_recommendation_effectiveness'::regclass
      and conname = 'shadow_recommendation_effectiveness_effectiveness_score_check'
  ) then
    alter table pilot.shadow_recommendation_effectiveness
      add constraint shadow_recommendation_effectiveness_effectiveness_score_check
      check (effectiveness_score between 0 and 1);
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'pilot.shadow_recommendation_effectiveness'::regclass
      and conname = 'shadow_recommendation_effectiveness_verification_state_check'
  ) then
    alter table pilot.shadow_recommendation_effectiveness
      add constraint shadow_recommendation_effectiveness_verification_state_check
      check (verification_state in ('unverified', 'durable_client', 'human_reviewed'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'pilot.shadow_learning_events'::regclass
      and conname = 'shadow_learning_events_effectiveness_score_check'
  ) then
    alter table pilot.shadow_learning_events
      add constraint shadow_learning_events_effectiveness_score_check
      check (effectiveness_score between 0 and 1);
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'pilot.shadow_learning_events'::regclass
      and conname = 'shadow_learning_events_verification_state_check'
  ) then
    alter table pilot.shadow_learning_events
      add constraint shadow_learning_events_verification_state_check
      check (verification_state in ('unverified', 'durable_client', 'human_reviewed'));
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'pilot.shadow_learning_events'::regclass
      and conname = 'shadow_learning_events_feedback_id_verification_state_key'
  ) then
    alter table pilot.shadow_learning_events
      add constraint shadow_learning_events_feedback_id_verification_state_key
      unique (feedback_id, verification_state);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'pilot.shadow_library_review_flags'::regclass
      and conname = 'shadow_library_review_flags_flag_count_check'
  ) then
    alter table pilot.shadow_library_review_flags
      add constraint shadow_library_review_flags_flag_count_check check (flag_count >= 1);
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'pilot.shadow_library_review_flags'::regclass
      and conname = 'shadow_library_review_flags_review_state_check'
  ) then
    alter table pilot.shadow_library_review_flags
      add constraint shadow_library_review_flags_review_state_check
      check (review_state in ('pending', 'approved', 'rejected', 'resolved'));
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'pilot.shadow_library_review_flags'::regclass
      and conname = 'shadow_library_review_flags_proposed_action_check'
  ) then
    alter table pilot.shadow_library_review_flags
      add constraint shadow_library_review_flags_proposed_action_check
      check (proposed_action in ('promote', 'demote', 'retain'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'pilot.shadow_monthly_stats'::regclass
      and conname = 'shadow_monthly_stats_month_check'
  ) then
    alter table pilot.shadow_monthly_stats
      add constraint shadow_monthly_stats_month_check
      check (month ~ '^[0-9]{4}-[0-9]{2}$');
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'pilot.shadow_monthly_stats'::regclass
      and conname = 'shadow_monthly_stats_interaction_count_check'
  ) then
    alter table pilot.shadow_monthly_stats
      add constraint shadow_monthly_stats_interaction_count_check check (interaction_count >= 0);
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'pilot.shadow_monthly_stats'::regclass
      and conname = 'shadow_monthly_stats_avg_filter_rate_check'
  ) then
    alter table pilot.shadow_monthly_stats
      add constraint shadow_monthly_stats_avg_filter_rate_check
      check (avg_filter_rate between 0 and 1);
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'pilot.shadow_monthly_stats'::regclass
      and conname = 'shadow_monthly_stats_avg_effectiveness_score_check'
  ) then
    alter table pilot.shadow_monthly_stats
      add constraint shadow_monthly_stats_avg_effectiveness_score_check
      check (avg_effectiveness_score between 0 and 1);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'pilot.shadow_formula_observations'::regclass
      and conname = 'shadow_formula_observations_source_quality_check'
  ) then
    alter table pilot.shadow_formula_observations
      add constraint shadow_formula_observations_source_quality_check
      check (source_quality in ('verified', 'high', 'moderate', 'low', 'failed'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'pilot.shadow_formula_results'::regclass
      and conname = 'shadow_formula_results_validation_state_check'
  ) then
    alter table pilot.shadow_formula_results
      add constraint shadow_formula_results_validation_state_check
      check (validation_state in ('valid', 'warning', 'invalid', 'insufficient', 'unsupported'));
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'pilot.shadow_formula_results'::regclass
      and conname = 'shadow_formula_results_confidence_check'
  ) then
    alter table pilot.shadow_formula_results
      add constraint shadow_formula_results_confidence_check
      check (confidence in ('HIGH', 'MODERATE', 'LOW', 'INSUFFICIENT'));
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'pilot.shadow_formula_results'::regclass
      and conname = 'shadow_formula_results_completeness_check'
  ) then
    alter table pilot.shadow_formula_results
      add constraint shadow_formula_results_completeness_check
      check (completeness between 0 and 1);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'pilot.shadow_formula_baseline_snapshots'::regclass
      and conname = 'shadow_formula_baseline_snapshots_window_size_check'
  ) then
    alter table pilot.shadow_formula_baseline_snapshots
      add constraint shadow_formula_baseline_snapshots_window_size_check
      check (window_size between 1 and 1000);
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'pilot.shadow_formula_baseline_snapshots'::regclass
      and conname = 'shadow_formula_baseline_snapshots_history_status_check'
  ) then
    alter table pilot.shadow_formula_baseline_snapshots
      add constraint shadow_formula_baseline_snapshots_history_status_check
      check (history_status in ('insufficient_history', 'building', 'adequate'));
  end if;
end
$shadow_runtime_constraints$;

commit;
