-- Labelling PIN for the shared-tablet hand-over: storage only.
-- OD-2026-10-02-010 section 2 item 4: "pick your name, then a short PIN";
-- Jason's H1-H8 answers (2026-10-03): the coach sets their own PIN and a
-- labelling display name; an organization admin may clear it, never see or
-- choose it; the PIN opens labelling-station mode only.
--
-- A SEPARATE CREDENTIAL, NOT pilot.accounts.pin_hash. That column is the
-- account's sign-in PIN under pinPolicy.ts (six digits). Four digits stored
-- there would become a credential for the whole account; stored here, nothing
-- but the labelling station reads it.
--
-- Additive and idempotent. Creates one table; changes no existing row.
--
-- No begin/commit here: pilot-apply-labeller-credentials-migration.mjs wraps
-- the file and its readiness check in one transaction.

create table if not exists pilot.labeller_credentials (
  organization_id text not null,
  account_id text not null,
  -- What the station's picker shows. Chosen by the labeller, because the
  -- schema holds no staff name and one is not invented from an email.
  display_name text not null,
  -- security.ts hashPin (scrypt, salted). Never the PIN.
  pin_hash text not null,
  set_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, account_id),
  -- Belongs to a membership: deleting the membership row removes it. A
  -- membership switched off (active_flag false) keeps the row, which then
  -- neither appears in the picker nor verifies (eligibility is read live), and
  -- comes back into use if the membership is switched on again.
  constraint pilot_labeller_credentials_membership_fk
    foreign key (account_id, organization_id)
    references pilot.organization_memberships (account_id, organization_id)
    on delete cascade,
  constraint pilot_labeller_credentials_display_name_check
    check (char_length(display_name) between 1 and 40 and display_name = btrim(display_name)),
  constraint pilot_labeller_credentials_pin_hash_check
    check (pin_hash like 'scrypt$%')
);

-- Two labellers called "Mike" make the picker a guess.
create unique index if not exists pilot_labeller_credentials_display_name_uq
  on pilot.labeller_credentials (organization_id, lower(display_name));

comment on table pilot.labeller_credentials is
  'Four-digit labelling PIN and picker name per member, for the Teach Shadow labelling station only. Never a sign-in credential.';
comment on column pilot.labeller_credentials.pin_hash is
  'scrypt hash (security.ts hashPin) of a four-digit labelling PIN the member chose. Never pilot.accounts.pin_hash.';
