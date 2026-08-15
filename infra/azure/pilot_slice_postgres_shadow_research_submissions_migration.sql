-- SHADOW research submissions (issue #345, slice 1: the link record).
--
-- WHAT THIS IS: the missing relationship in the research lifecycle. A
-- research requirement (pilot.shadow_research_requirements) says what SHADOW
-- needs to know; the library (pilot.shadow_library_sources/_documents) holds
-- reviewed evidence; until now NOTHING connected them, so "which sources were
-- submitted against this question" lived in an operator's head or a
-- SharePoint folder name. Each row here is one source submitted against one
-- requirement, with its provenance and its own applicability-review state.
--
-- WHAT THIS MUST NEVER DO (issue #345's non-negotiables, held structurally):
--
--   * A submission NEVER resolves a requirement. There is no trigger, no
--     status write-through, no path from this table to
--     shadow_research_requirements.status. Resolution remains the existing
--     human act on the requirement row itself. The answer-state ladder the
--     app shows is COMPUTED from these links plus review states, and its
--     'resolved' rung is reachable only through that human act.
--   * "PDF uploaded" is not "question answered": a new row starts
--     applicability_state 'unreviewed', and nothing here changes library
--     ingest/approval rules -- the library's own reviewer gates stay
--     authoritative for whether evidence is citable at all.
--   * Duplicate source != corroboration; the unique constraint refuses the
--     same source linked twice to the same requirement.
--
-- Idempotent like every migration in this directory.

create table if not exists pilot.shadow_research_submissions (
  organization_id          text not null references pilot.organizations(organization_id) on delete cascade,
  submission_id            text not null,
  research_requirement_id  bigint not null references pilot.shadow_research_requirements(research_requirement_id) on delete cascade,
  source_id                text not null references pilot.shadow_library_sources(source_id) on delete cascade,
  document_id              text null references pilot.shadow_library_documents(document_id) on delete set null,
  -- Provenance as submitted: original filename, DOI/PMID, provider (e.g.
  -- Penn State library), design, population notes. Free-form by design --
  -- the reviewed, structured home for source metadata remains the library
  -- source row; this preserves what the SUBMITTER knew at submission time.
  provenance               jsonb not null default '{}'::jsonb,
  submission_note          text not null default '',
  -- The applicability review: is this source actually responsive to THIS
  -- requirement? Distinct from the library's own ingest/approval state,
  -- because a perfectly good paper can be irrelevant, population-mismatched,
  -- or only partially responsive to the question it was submitted against.
  applicability_state      text not null default 'unreviewed'
    check (applicability_state in ('unreviewed', 'responsive', 'partially_responsive', 'not_responsive', 'duplicate')),
  reviewed_by_account_id   text null references pilot.accounts(account_id),
  reviewed_at              timestamptz null,
  review_note              text not null default '',
  submitted_by_account_id  text not null references pilot.accounts(account_id),
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  primary key (organization_id, submission_id),
  -- Same source, same requirement, once.
  constraint pilot_shadow_research_submissions_unique_link
    unique (organization_id, research_requirement_id, source_id),
  -- A review verdict must carry its reviewer; an unreviewed row must not
  -- claim one.
  constraint pilot_shadow_research_submissions_review_attribution
    check (
      (applicability_state = 'unreviewed' and reviewed_by_account_id is null and reviewed_at is null)
      or
      (applicability_state <> 'unreviewed' and reviewed_by_account_id is not null and reviewed_at is not null)
    )
);

-- The workspace's read: everything submitted against a requirement.
create index if not exists idx_shadow_research_submissions_requirement
  on pilot.shadow_research_submissions(organization_id, research_requirement_id, created_at desc);
