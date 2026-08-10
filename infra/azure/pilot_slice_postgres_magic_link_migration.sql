-- Magic-link sign-in for coaches, staff, volunteers and parents.
-- Apply after pilot_slice_postgres_multiorg_migration.sql, which owns the
-- auth_provider constraint this widens.
--
-- Adds one value to the auth_provider vocabulary and one table to hold
-- single-use sign-in tokens. Creates no account and changes no existing row:
-- every account keeps the provider it already has.
begin;

-- Widen the vocabulary.
--
-- TWO constraints govern auth_provider on a deployed database, not one:
--
--   accounts_auth_provider_check        the inline CHECK in the base schema's
--                                       CREATE TABLE, auto-named by PostgreSQL
--   pilot_accounts_auth_provider_check  added by the multiorg migration
--
-- A row must satisfy both. The first version of this migration dropped and
-- re-added only the named one, so magic_link was still refused -- by a
-- constraint nobody had written down anywhere, on a name nobody had chosen.
-- Widening the inline CHECK in pilot_slice_postgres.sql fixes fresh databases
-- and does nothing for existing ones, which is the worst combination: local
-- tests pass, staging refuses the write.
--
-- So this drops EVERY check constraint on the column and re-adds exactly one.
-- Enumerating rather than naming means a third constraint added by some
-- future migration cannot silently outvote this one either.
do $magic_link_vocabulary$
declare
  existing record;
begin
  for existing in
    select conname
      from pg_constraint
     where conrelid = 'pilot.accounts'::regclass
       and contype = 'c'
       and pg_get_constraintdef(oid) ilike '%auth_provider%'
  loop
    execute format('alter table pilot.accounts drop constraint %I', existing.conname);
  end loop;
end
$magic_link_vocabulary$;

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
