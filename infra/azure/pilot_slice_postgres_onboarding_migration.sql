-- Additive onboarding migration.
-- Apply after the canonical pilot schema, the multi-organization migration,
-- and the board role migration.
--
-- Adds the one-time activation code table used by athlete self-service PIN
-- claim. A code is never stored in plaintext: only its sha256 hash is kept,
-- so an operator with database read access cannot redeem an outstanding
-- code on an athlete's behalf.
begin;

create table if not exists pilot.account_activation_tokens (
  token_hash text primary key,
  account_id text not null references pilot.accounts(account_id) on delete cascade,
  organization_id text not null references pilot.organizations(organization_id),
  issued_by_account_id text not null,
  issued_by_role text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz null,
  -- Set when a newer code is issued for the same account. A superseded code
  -- is dead even if it has not expired yet, so re-issuing a code always
  -- invalidates whatever was handed out before it.
  superseded_at timestamptz null
);

-- Redemption looks a code up by hash (primary key). These indexes serve the
-- other two access paths: superseding every outstanding code for an account
-- on re-issue, and the admin view that reports which athletes still have an
-- unclaimed code.
create index if not exists idx_account_activation_tokens_account
  on pilot.account_activation_tokens (account_id)
  where consumed_at is null and superseded_at is null;

create index if not exists idx_account_activation_tokens_organization
  on pilot.account_activation_tokens (organization_id, expires_at desc);

-- Retention sweep support: expired/consumed rows are deleted on a schedule
-- rather than kept forever.
create index if not exists idx_account_activation_tokens_expires
  on pilot.account_activation_tokens (expires_at);

commit;
