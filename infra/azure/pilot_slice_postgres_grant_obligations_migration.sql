-- Grant obligations (owner decision 2026-08-15: "build the internal half now").
--
-- WHAT THIS IS: the organization's own deadline ledger for grants -- reports
-- due, deliverables promised, renewals, filings. Internal administrative
-- records about the ORGANIZATION's commitments to funders.
--
-- WHAT THIS DELIBERATELY IS NOT, and must never grow into by column
-- addition: a disclosure surface. The unresolved question "what aggregate
-- minor-related data may be disclosed externally" is PARKED as
-- BACKLOG-grant-packet in docs/current/ACTIVE_WORK.md, and this table keeps
-- it parked STRUCTURALLY: there is no athlete_id, no athlete FK, no count,
-- no aggregate, no join path to any table holding a child's data. A grant
-- packet generator, when a real grant defines its disclosure set, will be
-- its own reviewed work against its own decision -- not a column here.
--
-- Idempotent like every migration in this directory: create table/index
-- if not exists, no alters, no drops, safe to re-run wholesale.

create table if not exists pilot.grant_obligations (
  organization_id        text not null references pilot.organizations(organization_id) on delete cascade,
  obligation_id          text not null,
  grant_name             text not null check (length(btrim(grant_name)) > 0),
  funder_name            text not null default '',
  obligation_type        text not null check (obligation_type in ('report', 'deliverable', 'renewal', 'filing', 'acknowledgment', 'other')),
  description            text not null check (length(btrim(description)) > 0),
  due_date               date not null,
  status                 text not null default 'open' check (status in ('open', 'in_progress', 'submitted', 'complete', 'waived')),
  completed_at           timestamptz null,
  notes                  text not null default '',
  created_by_account_id  text not null references pilot.accounts(account_id),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  primary key (organization_id, obligation_id),
  -- A completed_at only makes sense on a settled row; an open obligation
  -- claiming a completion timestamp is a bookkeeping error worth refusing.
  constraint pilot_grant_obligations_completed_check
    check (completed_at is null or status in ('complete', 'waived', 'submitted'))
);

-- The page's one query: what is due, soonest first, within an organization.
create index if not exists idx_grant_obligations_due
  on pilot.grant_obligations(organization_id, status, due_date);
