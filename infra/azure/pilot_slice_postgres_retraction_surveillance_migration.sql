-- Retraction and correction surveillance -- is the thing a source points at still standing?
--
-- WHY THIS IS SEPARATE FROM THE CITATION CHECK. A citation check asks "does this identifier point
-- where it claims". A retraction check asks "is the thing it points at still standing". Those are
-- different questions with different answers over time: a citation that resolves correctly today
-- resolves just as correctly the day after the paper is withdrawn. The first check is a one-time
-- fact about a row; the second is a standing subscription to the outside world.
--
-- WHY IT MUST RECUR. This is the failure mode nobody notices. A source is added, reviewed,
-- approved, and cited in coaching guidance -- and two years later it is retracted, and nothing in
-- the platform ever asks again. The claim keeps its tier, keeps appearing in retrieval, and keeps
-- informing what a coach is told. Retraction surveillance is worthless as a one-off; the value is
-- entirely in it running on a schedule forever -- see pilot.v_sources_needing_retraction_check's
-- 90-day recheck below.
--
-- WHAT CAN ACTUALLY BE DETECTED, verified against the live APIs before this table was designed:
--   PubMed  -- esummary `pubtype` includes 'Retracted Publication' on a retracted record.
--              Confirmed against PMID 9500320 (Wakefield 1998), which returns
--              ['Journal Article', "Research Support, Non-U.S. Gov't", 'Retracted Publication'].
--   Crossref -- `updated-by` carries entries with type 'retraction', 'correction',
--              'expression_of_concern' and similar, sourced from the Retraction Watch database
--              (source: 'retraction-watch'). Confirmed on DOI 10.1016/S0140-6736(97)11096-0,
--              which returns both a correction and a retraction entry.
-- Both are free and require no key. Neither is exhaustive, and a source with no PMID or DOI --
-- a rulebook, a statute -- cannot be surveilled at all. That limit is recorded, not hidden.
--
-- WHAT THE SYSTEM MAY DO WITH A RETRACTION, AND WHAT IT MAY NOT.
-- It may FLAG, SUPPRESS FROM RETRIEVAL, and NOTIFY. It may not silently delete the source, and it
-- may not quietly downgrade the claims that rest on it. A retraction is a fact that a human needs
-- to see and act on -- deleting the row would destroy the audit trail that shows the claim was
-- once made in good faith on evidence that later failed, which is exactly the history a reviewer
-- or a funder is entitled to.
--
-- DEPENDS ON pilot.organizations, pilot.shadow_library_sources, pilot.accounts, and (for
-- dependent_chunks) pilot.shadow_library_documents/pilot.shadow_library_chunks. No begin;/commit;
-- here on purpose, matching this repo's runner-opens-the-transaction convention (the runner is
-- apps/web/scripts/pilot-apply-retraction-surveillance-migration.mjs).

create table if not exists pilot.source_retraction_checks (
  organization_id     text not null references pilot.organizations(organization_id) on delete cascade,
  retraction_check_id text not null,
  source_id           text not null references pilot.shadow_library_sources(source_id) on delete cascade,

  identifier_kind     text not null check (identifier_kind in ('pmid','doi','none')),
  identifier_value    text not null default '',
  resolver            text not null check (resolver in ('ncbi_eutils','crossref','manual','not_attempted')),

  status              text not null check (status in
                        ('clear',                   -- checked, no retraction or concern found
                         'retracted',               -- the work has been retracted
                         'expression_of_concern',   -- editorial concern raised, not retracted
                         'corrected',               -- correction/erratum issued; claim may still stand
                         'withdrawn',               -- withdrawn before formal publication
                         'not_checkable',           -- no PMID or DOI; rulebook, statute, internal doc
                         'resolver_unavailable')),  -- network/rate limit; NOT a finding

  notice_type         text null,          -- resolver's own label, verbatim
  notice_doi          text null,          -- DOI of the retraction/correction notice itself
  notice_date         date null,
  notice_source       text null,          -- e.g. 'retraction-watch', 'pubmed_pubtype'
  evidence_snippet    text not null default '',   -- what the resolver actually returned

  checked_at          timestamptz not null default now(),
  checker_version     text not null,

  -- Human handling of a positive finding. The check raises it; a person disposes of it.
  acknowledged_by_account_id text null references pilot.accounts(account_id) on delete set null,
  acknowledged_at     timestamptz null,
  disposition         text null check (disposition is null or disposition in
                        ('suppress_source','keep_with_caveat','claim_unaffected','superseded_by_newer','under_review')),
  disposition_note    text null,

  constraint pilot_src_retraction_pkey primary key (organization_id, retraction_check_id),
  -- A positive finding must carry the evidence for it. An unevidenced retraction flag is a rumour.
  constraint pilot_src_retraction_evidence check (
    status not in ('retracted','expression_of_concern','withdrawn')
    or length(btrim(evidence_snippet)) > 0
  ),
  -- Disposing of a retraction is a decision. It carries a name and a reason.
  constraint pilot_src_retraction_disposition check (
    disposition is null
    or (acknowledged_by_account_id is not null and acknowledged_at is not null
        and disposition_note is not null and length(btrim(disposition_note)) >= 15)
  )
);

create index if not exists pilot_src_retraction_source
  on pilot.source_retraction_checks(organization_id, source_id, checked_at desc);
create index if not exists pilot_src_retraction_open
  on pilot.source_retraction_checks(organization_id, status, checked_at desc)
  where status in ('retracted','expression_of_concern','withdrawn');

-- Latest retraction status per source, with the claims that depend on it.
-- A retracted source is not interesting on its own -- what matters is what was built on it.
-- security_invoker=true so the view runs with the querying role's own privileges.
create or replace view pilot.v_source_retraction_status
  with (security_invoker = true) as
select distinct on (rc.organization_id, rc.source_id)
  rc.organization_id,
  rc.source_id,
  s.title,
  s.approval_state,
  s.verification_state,
  rc.status,
  rc.notice_type,
  rc.notice_doi,
  rc.notice_date,
  rc.notice_source,
  rc.checked_at,
  rc.disposition,
  rc.acknowledged_at,
  (select count(*)::int from pilot.shadow_library_chunks c
     join pilot.shadow_library_documents d
       on d.document_id = c.document_id and d.organization_id = c.organization_id
    where d.source_id = rc.source_id and d.organization_id = rc.organization_id) as dependent_chunks,
  case
    when rc.status in ('retracted','withdrawn') and rc.disposition is null then 'urgent_unhandled'
    when rc.status = 'expression_of_concern'    and rc.disposition is null then 'needs_review'
    when rc.status = 'corrected'                and rc.disposition is null then 'informational'
    when rc.status = 'resolver_unavailable'                                then 'recheck_pending'
    when rc.status = 'not_checkable'                                       then 'not_surveillable'
    else 'handled'
  end as action_signal
from pilot.source_retraction_checks rc
join pilot.shadow_library_sources s
  on s.source_id = rc.source_id and s.organization_id = rc.organization_id
order by rc.organization_id, rc.source_id, rc.checked_at desc;

comment on view pilot.v_source_retraction_status is
  'Latest retraction status per source with dependent chunk count. action_signal=urgent_unhandled means a retracted source is still live in the library.';

-- Surveillance queue. A source checked six months ago is not checked -- retraction is a moving
-- target, so "current" decays with time rather than being permanent.
create or replace view pilot.v_sources_needing_retraction_check
  with (security_invoker = true) as
select
  s.organization_id,
  s.source_id,
  s.title,
  s.source_type,
  s.url,
  s.metadata,
  s.approval_state,
  rs.checked_at as last_checked_at,
  rs.status     as last_status,
  case
    when rs.checked_at is null                                    then 'never_checked'
    when rs.status = 'resolver_unavailable'                       then 'retry_resolver'
    when rs.checked_at < now() - interval '90 days'               then 'stale_recheck_due'
    else 'current'
  end as check_state
from pilot.shadow_library_sources s
left join pilot.v_source_retraction_status rs
  on rs.source_id = s.source_id and rs.organization_id = s.organization_id
where s.status = 'active'
  and coalesce(rs.status, '') not in ('not_checkable');

comment on view pilot.v_sources_needing_retraction_check is
  'Work queue for retraction surveillance. Recheck interval is 90 days: retraction is a moving target and a past clear result expires.';

-- ---------------------------------------------------------------------------
-- Suppression is explicit, reversible, and never a delete.
alter table pilot.shadow_library_sources
  add column if not exists retrieval_suppressed boolean not null default false,
  add column if not exists suppression_reason text null,
  add column if not exists suppressed_at timestamptz null,
  add column if not exists suppressed_by_account_id text null references pilot.accounts(account_id);

comment on column pilot.shadow_library_sources.retrieval_suppressed is
  'Excluded from retrieval and citation while true. The row, its documents and its chunks are PRESERVED: a retracted source is part of the audit trail showing what was believed and when.';

do $$
begin
  if not exists (select 1 from pg_constraint where conname='pilot_library_sources_suppression_reason'
                 and conrelid='pilot.shadow_library_sources'::regclass) then
    alter table pilot.shadow_library_sources add constraint pilot_library_sources_suppression_reason
      check (retrieval_suppressed = false
             or (suppression_reason is not null and length(btrim(suppression_reason)) >= 10
                 and suppressed_by_account_id is not null));
  end if;
end
$$;
