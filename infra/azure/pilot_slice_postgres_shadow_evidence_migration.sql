-- Additive SHADOW evidence provenance, review, and citation hardening.
-- Apply after pilot_slice_postgres_shadow_runtime_migration.sql.
-- Existing library records intentionally remain unapproved until reviewed.
begin;

alter table pilot.shadow_library_sources
  add column if not exists approval_state text not null default 'pending_review',
  add column if not exists verification_state text not null default 'unverified',
  add column if not exists approved_by_account_id text null references pilot.accounts(account_id),
  add column if not exists approved_at timestamptz null,
  add column if not exists verified_by_account_id text null references pilot.accounts(account_id),
  add column if not exists verified_at timestamptz null;

alter table pilot.shadow_library_documents
  add column if not exists index_completed_at timestamptz null,
  add column if not exists approval_state text not null default 'pending_review',
  add column if not exists verification_state text not null default 'unverified',
  add column if not exists approved_by_account_id text null references pilot.accounts(account_id),
  add column if not exists approved_at timestamptz null,
  add column if not exists verified_by_account_id text null references pilot.accounts(account_id),
  add column if not exists verified_at timestamptz null;

do $shadow_evidence_review_constraints$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'pilot.shadow_library_sources'::regclass
      and conname = 'shadow_library_sources_approval_state_check'
  ) then
    alter table pilot.shadow_library_sources
      add constraint shadow_library_sources_approval_state_check
      check (approval_state in ('pending_review', 'approved', 'rejected'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'pilot.shadow_library_sources'::regclass
      and conname = 'shadow_library_sources_verification_state_check'
  ) then
    alter table pilot.shadow_library_sources
      add constraint shadow_library_sources_verification_state_check
      check (verification_state in ('unverified', 'verified'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'pilot.shadow_library_sources'::regclass
      and conname = 'shadow_library_sources_review_pair_check'
  ) then
    alter table pilot.shadow_library_sources
      add constraint shadow_library_sources_review_pair_check
      check (
        (approval_state = 'approved'
          and verification_state = 'verified'
          and approved_by_account_id is not null
          and approved_at is not null
          and verified_by_account_id is not null
          and verified_at is not null)
        or
        (approval_state <> 'approved'
          and verification_state = 'unverified'
          and approved_by_account_id is null
          and approved_at is null
          and verified_by_account_id is null
          and verified_at is null)
      );
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'pilot.shadow_library_documents'::regclass
      and conname = 'shadow_library_documents_approval_state_check'
  ) then
    alter table pilot.shadow_library_documents
      add constraint shadow_library_documents_approval_state_check
      check (approval_state in ('pending_review', 'approved', 'rejected'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'pilot.shadow_library_documents'::regclass
      and conname = 'shadow_library_documents_verification_state_check'
  ) then
    alter table pilot.shadow_library_documents
      add constraint shadow_library_documents_verification_state_check
      check (verification_state in ('unverified', 'verified'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'pilot.shadow_library_documents'::regclass
      and conname = 'shadow_library_documents_review_pair_check'
  ) then
    alter table pilot.shadow_library_documents
      add constraint shadow_library_documents_review_pair_check
      check (
        (approval_state = 'approved'
          and verification_state = 'verified'
          and ingest_state = 'indexed'
          and index_completed_at is not null
          and approved_by_account_id is not null
          and approved_at is not null
          and verified_by_account_id is not null
          and verified_at is not null)
        or
        (approval_state <> 'approved'
          and verification_state = 'unverified'
          and approved_by_account_id is null
          and approved_at is null
          and verified_by_account_id is null
          and verified_at is null)
      );
  end if;
end
$shadow_evidence_review_constraints$;

create index if not exists idx_shadow_library_sources_retrieval
  on pilot.shadow_library_sources(organization_id, status, approval_state, verification_state);

create index if not exists idx_shadow_library_documents_retrieval
  on pilot.shadow_library_documents(
    organization_id,
    ingest_state,
    approval_state,
    verification_state,
    index_completed_at
  );

create unique index if not exists idx_shadow_library_sources_tenant_identity
  on pilot.shadow_library_sources(source_id, organization_id);

create unique index if not exists idx_shadow_library_documents_tenant_identity
  on pilot.shadow_library_documents(document_id, organization_id);

create unique index if not exists idx_shadow_library_chunks_tenant_identity
  on pilot.shadow_library_chunks(chunk_id, organization_id);

create unique index if not exists idx_shadow_chat_messages_owner_identity
  on pilot.shadow_chat_messages(message_id, organization_id, account_id);

create table if not exists pilot.shadow_evidence_bundles (
  bundle_id uuid primary key,
  organization_id text not null references pilot.organizations(organization_id) on delete cascade,
  account_id text not null references pilot.accounts(account_id) on delete cascade,
  subject_id text null,
  query_sha256 text not null check (query_sha256 ~ '^[0-9a-f]{64}$'),
  availability text not null check (availability in ('available', 'unavailable')),
  item_count smallint not null check (item_count between 0 and 8),
  created_at timestamptz not null default now(),
  unique (bundle_id, organization_id, account_id),
  foreign key (organization_id, subject_id)
    references pilot.athletes(organization_id, athlete_id)
    on delete cascade
);

create table if not exists pilot.shadow_evidence_items (
  evidence_id uuid primary key,
  bundle_id uuid not null,
  organization_id text not null,
  account_id text not null,
  source_id text not null,
  document_id text not null,
  chunk_id text not null,
  ordinal smallint not null check (ordinal between 1 and 8),
  excerpt_sha256 text not null check (excerpt_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  unique (bundle_id, chunk_id),
  unique (evidence_id, bundle_id, organization_id, account_id),
  foreign key (bundle_id, organization_id, account_id)
    references pilot.shadow_evidence_bundles(bundle_id, organization_id, account_id)
    on delete cascade,
  foreign key (source_id, organization_id)
    references pilot.shadow_library_sources(source_id, organization_id),
  foreign key (document_id, organization_id)
    references pilot.shadow_library_documents(document_id, organization_id),
  foreign key (chunk_id, organization_id)
    references pilot.shadow_library_chunks(chunk_id, organization_id)
);

create table if not exists pilot.shadow_evidence_claims (
  claim_id uuid primary key,
  organization_id text not null,
  account_id text not null,
  conversation_id uuid not null references pilot.shadow_chat_sessions(conversation_id) on delete cascade,
  assistant_message_id uuid not null,
  bundle_id uuid not null,
  claim_status text not null
    check (claim_status in ('supported', 'research_needed', 'unavailable', 'filtered')),
  created_at timestamptz not null default now(),
  unique (assistant_message_id),
  foreign key (assistant_message_id, organization_id, account_id)
    references pilot.shadow_chat_messages(message_id, organization_id, account_id)
    on delete cascade,
  foreign key (bundle_id, organization_id, account_id)
    references pilot.shadow_evidence_bundles(bundle_id, organization_id, account_id)
);

create table if not exists pilot.shadow_message_citations (
  assistant_message_id uuid not null,
  evidence_id uuid not null,
  bundle_id uuid not null,
  organization_id text not null,
  account_id text not null,
  ordinal smallint not null check (ordinal between 1 and 8),
  created_at timestamptz not null default now(),
  primary key (assistant_message_id, evidence_id),
  unique (assistant_message_id, ordinal),
  foreign key (assistant_message_id, organization_id, account_id)
    references pilot.shadow_chat_messages(message_id, organization_id, account_id)
    on delete cascade,
  foreign key (evidence_id, bundle_id, organization_id, account_id)
    references pilot.shadow_evidence_items(evidence_id, bundle_id, organization_id, account_id),
  foreign key (bundle_id, organization_id, account_id)
    references pilot.shadow_evidence_bundles(bundle_id, organization_id, account_id)
);

create index if not exists idx_shadow_evidence_bundles_owner_created
  on pilot.shadow_evidence_bundles(organization_id, account_id, created_at desc);

create index if not exists idx_shadow_evidence_items_bundle_ordinal
  on pilot.shadow_evidence_items(bundle_id, ordinal);

create index if not exists idx_shadow_evidence_claims_conversation
  on pilot.shadow_evidence_claims(organization_id, account_id, conversation_id, created_at desc);

create index if not exists idx_shadow_message_citations_message
  on pilot.shadow_message_citations(organization_id, account_id, assistant_message_id, ordinal);

commit;
