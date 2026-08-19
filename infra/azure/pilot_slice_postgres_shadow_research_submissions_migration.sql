-- SHADOW research submissions: the link record that connects a research
-- requirement (a SHADOW-generated or human-created knowledge gap) to a
-- library source submitted as candidate evidence.
--
-- Design contracts enforced here:
--   1. Duplicate source per requirement is refused at the database level
--      (unique constraint). Duplicate submission ≠ corroboration.
--   2. This table never touches shadow_research_requirements.status.
--      The answer-state ladder is computed from submissions; it does not
--      write 'resolved'. The only path to 'resolved' is the existing
--      human Mark-Resolved path in the requirements route.
--   3. review_verdict is nullable: null means "not yet reviewed". The
--      check constraint limits the set of final verdicts the UI can file.

begin;

create table if not exists pilot.shadow_research_submissions (
  submission_id       uuid        primary key default gen_random_uuid(),
  organization_id     text        not null references pilot.organizations(organization_id) on delete cascade,
  research_requirement_id bigint  not null,
  source_id           text        not null,
  submitted_by_account_id text    not null references pilot.accounts(account_id),
  submitted_by_role   text        not null,
  -- provenance fields (all optional at submission time)
  doi                 text        null,
  pmid                text        null,
  provider_provenance text        null,
  why_this_source     text        null,
  -- applicability review fields (filled by the reviewer, not the submitter)
  review_verdict      text        null
    check (review_verdict in (
      'relevant',
      'partial',
      'irrelevant',
      'weak',
      'conflicting',
      'duplicate',
      'population_mismatch'
    )),
  reviewed_by_account_id text     null,
  reviewed_at         timestamptz null,
  metadata            jsonb       not null default '{}',
  created_at          timestamptz not null default now(),
  -- One source per requirement. Duplicate ≠ corroboration.
  unique (research_requirement_id, source_id),
  foreign key (research_requirement_id)
    references pilot.shadow_research_requirements(research_requirement_id)
    on delete cascade,
  foreign key (source_id)
    references pilot.shadow_library_sources(source_id)
    on delete cascade
);

create index if not exists idx_shadow_research_submissions_requirement
  on pilot.shadow_research_submissions(organization_id, research_requirement_id, created_at desc);

create index if not exists idx_shadow_research_submissions_source
  on pilot.shadow_research_submissions(organization_id, source_id);

commit;
