-- Citation resolution checks -- machine verification of what a source claims to be.
--
-- THE GAP THIS CLOSES. pilot.shadow_library_sources carries verification_state, but the only
-- thing that can set it is reviewShadowLibrarySource() called by a human evidence reviewer. There
-- is no mechanism anywhere in the platform that asks the simpler, mechanical question: does the
-- identifier on this row actually resolve, and does the record it resolves to match the title the
-- row claims? A reviewer approving 40 sources cannot check 40 DOIs by hand, so in practice that
-- question goes unasked -- which is exactly how a plausible-looking citation that points at the
-- wrong paper survives review.
--
-- This is not hypothetical. During the research program that produced the seeded corpus, a PMID
-- regex that harvested digits from inside DOI suffixes produced 173 rows whose "verified" PMID
-- pointed at an unrelated paper; 31 of those had no real PMID at all. Every one of them looked
-- correct in a spreadsheet. Only re-resolution against the live index found them.
--
-- MACHINE CHECK AND HUMAN REVIEW ARE DIFFERENT ACTS, AND THIS TABLE KEEPS THEM SEPARATE.
--   verification_state on the source  = a qualified human judged this source sound. Unchanged.
--   a row in this table               = a machine confirmed the identifier resolves and the
--                                       retrieved title matches. Nothing more.
-- A resolved identifier says the citation points where it claims. It says NOTHING about whether
-- the study is good, whether it applies to boxing, or whether the claim drawn from it is fair.
-- Passing this check must never advance verification_state, and no code path may treat it as
-- reviewer approval.
--
-- WHY THE RETRIEVED TITLE IS STORED. Storing what the identifier actually resolved to is what
-- makes a mismatch visible later. A boolean pass/fail would have hidden the DOI-fragment defect --
-- those rows "resolved" perfectly well, just to the wrong article.
--
-- DEPENDS ON pilot.organizations, pilot.shadow_library_sources. No begin;/commit; here on
-- purpose, matching this repo's runner-opens-the-transaction convention (the runner is
-- apps/web/scripts/pilot-apply-source-citation-checks-migration.mjs).

create table if not exists pilot.source_citation_checks (
  organization_id     text not null references pilot.organizations(organization_id) on delete cascade,
  check_id            text not null,
  source_id           text not null references pilot.shadow_library_sources(source_id) on delete cascade,

  identifier_kind     text not null check (identifier_kind in ('pmid','doi','isbn','url','none')),
  identifier_value    text not null default '',
  resolver            text not null check (resolver in
                        ('ncbi_eutils','crossref','openalex','http_head','manual','not_attempted')),

  outcome             text not null check (outcome in
                        ('resolved_title_match',      -- identifier resolves, title matches the row
                         'resolved_title_mismatch',   -- resolves, but to a DIFFERENT paper
                         'resolved_title_unknown',    -- resolves, resolver returned no title
                         'unresolved',                -- identifier does not resolve
                         'no_identifier',             -- governing-body doc, statute, internal source
                         'resolver_unavailable')),    -- network/rate-limit; NOT a failure of the row

  retrieved_title     text null,
  retrieved_year      text null,
  retrieved_container text null,          -- journal or publisher as the resolver reports it
  match_method        text null check (match_method is null or match_method in
                        ('title_overlap','author_year','multi_source_best','manual','none')),
  match_score         numeric(4,3) null check (match_score is null or match_score between 0 and 1),

  checked_at          timestamptz not null default now(),
  checker_version     text not null,      -- script version, so a rerun under new logic is distinguishable
  detail              text not null default '',

  constraint pilot_source_citation_checks_pkey primary key (organization_id, check_id),
  -- A mismatch must record what it actually found, or it cannot be adjudicated.
  constraint pilot_scc_mismatch_detail check (
    outcome <> 'resolved_title_mismatch' or retrieved_title is not null
  ),
  -- A claimed resolution must name the resolver that produced it.
  constraint pilot_scc_resolver check (
    outcome not in ('resolved_title_match','resolved_title_mismatch','resolved_title_unknown')
    or resolver <> 'not_attempted'
  )
);

create index if not exists pilot_scc_source
  on pilot.source_citation_checks(organization_id, source_id, checked_at desc);
create index if not exists pilot_scc_outcome
  on pilot.source_citation_checks(organization_id, outcome, checked_at desc);

-- Latest check per source. Reviewers read THIS, not the raw history.
-- security_invoker=true so the view runs with the querying role's own privileges.
create or replace view pilot.v_source_citation_status
  with (security_invoker = true) as
select distinct on (c.organization_id, c.source_id)
  c.organization_id,
  c.source_id,
  s.title                   as claimed_title,
  s.source_type,
  s.authority_tier,
  s.approval_state,
  s.verification_state,
  c.identifier_kind,
  c.identifier_value,
  c.resolver,
  c.outcome,
  c.retrieved_title,
  c.match_method,
  c.match_score,
  c.checked_at,
  c.checker_version,
  case
    when c.outcome = 'resolved_title_mismatch' then 'needs_adjudication'
    when c.outcome = 'unresolved'              then 'needs_adjudication'
    when c.outcome = 'resolver_unavailable'    then 'recheck_pending'
    when c.outcome = 'no_identifier'           then 'not_machine_checkable'
    else 'ok'
  end as review_signal
from pilot.source_citation_checks c
join pilot.shadow_library_sources s
  on s.source_id = c.source_id and s.organization_id = c.organization_id
order by c.organization_id, c.source_id, c.checked_at desc;

comment on view pilot.v_source_citation_status is
  'Latest machine citation check per source. review_signal flags rows a human should adjudicate. A resolved identifier is NOT reviewer approval and must never set verification_state.';

-- Sources that have never been machine-checked, or whose check predates the source's last edit.
-- This is the queue the verification script consumes.
create or replace view pilot.v_sources_needing_citation_check
  with (security_invoker = true) as
select
  s.organization_id,
  s.source_id,
  s.title,
  s.source_type,
  s.url,
  s.metadata,
  s.approval_state,
  s.updated_at,
  st.checked_at        as last_checked_at,
  case
    when st.checked_at is null                then 'never_checked'
    when st.checked_at < s.updated_at         then 'stale_source_edited'
    when st.outcome = 'resolver_unavailable'  then 'retry_resolver'
    else 'current'
  end as check_state
from pilot.shadow_library_sources s
left join pilot.v_source_citation_status st
  on st.source_id = s.source_id and st.organization_id = s.organization_id
where s.status = 'active';

comment on view pilot.v_sources_needing_citation_check is
  'Work queue for the citation verification script. check_state <> current means it needs a run.';
