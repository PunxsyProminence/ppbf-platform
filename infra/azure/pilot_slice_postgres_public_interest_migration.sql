-- Public interest intake -- real backend for the public marketing site's
-- lead-capture form (app/public/page.tsx).
--
-- The form previously had no backend at all: it only wrote to local React
-- state via addTrace, so every real visitor's name/email/phone/message was
-- lost on refresh, while the confirmation message claimed "Interest
-- received... Admin review required." This migration adds the table that
-- backs the real, rate-limited, unauthenticated POST endpoint at
-- app/api/pilot/public-interest/route.ts, plus an authenticated GET/review
-- surface for staff so submissions do not land in a queue nobody reads.
--
-- Anonymous submitters have no account, so this table intentionally has no
-- created_by_account_id and organization_id defaults to the platform's
-- single default organization (getPilotDefaultOrganizationId()) rather than
-- being derived from a session.
create table if not exists pilot.public_interest_submissions (
  submission_id uuid primary key default gen_random_uuid(),
  organization_id text not null references pilot.organizations(organization_id) on delete cascade,
  full_name text not null check (length(full_name) between 1 and 200),
  email text not null check (length(email) between 3 and 320),
  phone text null check (phone is null or length(phone) <= 40),
  visitor_type text not null check (length(visitor_type) <= 60),
  program_interest text not null check (length(program_interest) <= 60),
  preferred_contact_method text not null check (preferred_contact_method in ('Email', 'Phone', 'Either')),
  message text null check (message is null or length(message) <= 4000),
  consent_to_contact boolean not null default false,
  submitted_ip text null check (submitted_ip is null or length(submitted_ip) <= 64),
  review_state text not null default 'new' check (review_state in ('new', 'contacted', 'archived')),
  reviewed_by_account_id text null,
  reviewed_at timestamptz null,
  created_at timestamptz not null default now()
);

create index if not exists idx_public_interest_submissions_org_created
  on pilot.public_interest_submissions(organization_id, created_at desc);

create index if not exists idx_public_interest_submissions_review_state
  on pilot.public_interest_submissions(organization_id, review_state, created_at desc);
