-- Program memberships with scholarship-as-discount (radar rows "Membership
-- Tracking" and "Scholarship Tracking", built as one record type).
--
-- WHAT THIS IS: the administrative record that an athlete is enrolled in a
-- named program, with a lifecycle (active/lapsed/ended) and a scholarship
-- expressed as a DISCOUNT PERCENTAGE on that membership. 100 means full
-- scholarship. This is the payment slot's own rule made structural:
-- "scholarships must be representable as 100% discounts, not bypasses" --
-- a scholarship kid has a real membership row like everyone else, and when
-- charging arrives the fee computes from this stored fact instead of the
-- child being invisibly waved past the system.
--
-- WHAT THIS DELIBERATELY IS NOT: billing. No invoice, no charge, no amount
-- owed lives here -- fees arrive with the payment slot's checkout slice and
-- will read this table, not extend it ad hoc.
--
-- Safeguarding note: membership rows carry the athlete LINK only (composite
-- FK into pilot.athletes); names join through the org-scoped athlete record.
--
-- Idempotent like every migration in this directory: create table/index
-- if not exists, no alters, no drops, safe to re-run wholesale.

create table if not exists pilot.program_memberships (
  organization_id        text not null,
  membership_id          text not null,
  athlete_id             text not null,
  program_name           text not null check (length(btrim(program_name)) > 0),
  status                 text not null default 'active' check (status in ('active', 'lapsed', 'ended')),
  started_on             date not null,
  ended_on               date null,
  scholarship_percent    integer not null default 0 check (scholarship_percent between 0 and 100),
  scholarship_note       text not null default '',
  notes                  text not null default '',
  created_by_account_id  text not null references pilot.accounts(account_id),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  primary key (organization_id, membership_id),
  constraint pilot_program_memberships_athlete_fk
    foreign key (organization_id, athlete_id)
    references pilot.athletes(organization_id, athlete_id) on delete cascade,
  -- An end date only makes sense on an ended row, and never before the start.
  constraint pilot_program_memberships_ended_check
    check (ended_on is null or (status = 'ended' and ended_on >= started_on))
);

-- One ACTIVE membership per athlete per program: re-enrolling after an end
-- is a NEW row (history is kept), but two live enrollments in the same
-- program is a bookkeeping error the database refuses.
create unique index if not exists idx_program_memberships_one_active
  on pilot.program_memberships(organization_id, athlete_id, program_name)
  where status = 'active';

-- The page's query: who is in what, live memberships first.
create index if not exists idx_program_memberships_by_org
  on pilot.program_memberships(organization_id, status, program_name);
