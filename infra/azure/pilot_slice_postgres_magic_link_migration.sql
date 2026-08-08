-- Magic-link sign-in for coaches, staff, volunteers and parents.
-- Apply after pilot_slice_postgres_multiorg_migration.sql, which owns the
-- auth_provider constraint this widens.
--
-- Adds one value to the auth_provider vocabulary and one table to hold
-- single-use sign-in tokens. Creates no account and changes no existing row:
-- every account keeps the provider it already has.
begin;

-- Widen the vocabulary. The constraint is dropped and re-added rather than
-- altered because PostgreSQL has no ALTER CONSTRAINT for a check.
-- authProviderVocabulary.test.ts asserts this list matches authProviders.ts
-- exactly, in both directions -- the audit vocabulary drifted for want of
-- precisely that check.
alter table pilot.accounts drop constraint if exists pilot_accounts_auth_provider_check;
alter table pilot.accounts add constraint pilot_accounts_auth_provider_check
  check (auth_provider in ('ppbf_local', 'microsoft', 'magic_link'));

-- Single-use sign-in tokens.
--
-- Only the hash is stored. A readable token column would mean anyone with
-- database read access -- a backup, a support query, this repository's own
-- retention scripts -- could sign in as any coach or parent. The same reason
-- pilot.session_tokens stores token_hash and not the token.
create table if not exists pilot.magic_link_tokens (
  token_hash text primary key,
  account_id text not null references pilot.accounts(account_id) on delete cascade,
  organization_id text not null references pilot.organizations(organization_id) on delete cascade,
  -- The address the link was actually sent to, recorded as sent. If an
  -- account's email is later changed, a token already in flight must not
  -- become a way into the new address.
  sent_to_email text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz null,
  -- Set when a token is invalidated without being used: a newer link was
  -- requested, or an admin revoked it. Distinct from consumed_at so
  -- "someone clicked this" and "we cancelled this" stay separable in an audit.
  invalidated_at timestamptz null,
  requested_from_ip text null,
  constraint pilot_magic_link_tokens_expiry_after_creation
    check (expires_at > created_at),
  -- A token cannot be both used and cancelled. Catches a double-write in the
  -- consume path rather than leaving an ambiguous row behind.
  constraint pilot_magic_link_tokens_single_outcome
    check (consumed_at is null or invalidated_at is null)
);

-- Lookup on the way in is by hash alone (the primary key). This index serves
-- the sweep that expires old rows and the "invalidate this account's
-- outstanding links" write that issuing a new one performs.
create index if not exists idx_magic_link_tokens_account_live
  on pilot.magic_link_tokens (account_id, expires_at)
  where consumed_at is null and invalidated_at is null;

-- Supports the retention sweep without scanning the table.
create index if not exists idx_magic_link_tokens_expires_at
  on pilot.magic_link_tokens (expires_at);

commit;
