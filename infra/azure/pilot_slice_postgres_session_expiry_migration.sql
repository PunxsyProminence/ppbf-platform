-- PPBF Pilot Session Expiry Migration
-- Safe, additive, idempotent migration for existing pilot schema installations.
-- Adds an absolute 24-hour session lifetime (pilot.session_tokens.expires_at)
-- and ensures every account has an active organization membership row, which
-- resolvePrincipal now requires.
--
-- SAFE ROLLOUT ORDER (this repository's deploy workflows do not apply
-- migrations automatically -- this must be run by hand, against each
-- environment, before deploying the application code from this change).
-- These are two DIFFERENT sequences; a fresh installation never runs this
-- migration at all.
--
-- Fresh installation:
--   1. Apply the canonical base schema
--        npm run --workspace apps/web pilot:apply-schema
--   2. Do NOT run this migration -- pilot_slice_postgres.sql already
--      includes pilot.session_tokens.expires_at (and its indexes) directly,
--      so a brand-new environment already has everything this file adds.
--   3. Deploy the application code.
--
-- Existing installation:
--   1. If not already applied, run the multi-org migration first
--        npm run --workspace apps/web pilot:apply-multiorg
--   2. Apply THIS migration
--        npm run --workspace apps/web pilot:apply-session-expiry
--   3. Confirm the transaction committed successfully (it runs as a single
--      BEGIN/COMMIT/ROLLBACK -- see pilot-apply-session-expiry-migration.mjs
--      -- so it either fully applies or leaves the previous schema
--      completely untouched; check the script's own PASS/FAIL output).
--   4. Only after step 3 confirms a commit: deploy the application code
--      that depends on pilot.session_tokens.expires_at and the
--      active-membership check in resolvePrincipal. Deploying the code
--      before the column exists means every request fails with a database
--      error, since resolvePrincipal's query directly selects/filters on
--      expires_at.

-- 1) Add expires_at to session_tokens.
alter table pilot.session_tokens add column if not exists expires_at timestamptz;

-- 2) Fail closed for pre-existing sessions: anything created before this
--    migration has no reliable 24-hour baseline under the new policy, so
--    revoke it outright rather than trust a backfilled value.
update pilot.session_tokens
set revoked_at = now()
where expires_at is null
  and revoked_at is null;

-- 3) Backfill a non-null value so the column can be made NOT NULL. These rows
--    were just revoked above, so the exact value has no security relevance.
update pilot.session_tokens
set expires_at = created_at + interval '24 hours'
where expires_at is null;

alter table pilot.session_tokens alter column expires_at set not null;
alter table pilot.session_tokens alter column expires_at set default (now() + interval '24 hours');

create index if not exists idx_pilot_session_tokens_expires_at on pilot.session_tokens(expires_at);
create index if not exists idx_pilot_session_tokens_account_id on pilot.session_tokens(account_id);

-- 4) Preflight: any null-organization account must be a legitimate platform
--    owner (role = 'platform_owner' AND is_platform_owner = true). Platform
--    owners are intentionally org-less -- resolvePrincipal already bypasses
--    the organization/membership check for them -- so the backfill below
--    deliberately skips them rather than assigning a bootstrap
--    organization_id they should never have. Any other null-organization
--    account is data this migration was never designed to reconcile; fail
--    closed (and roll back everything above) rather than silently drop or
--    misassign it.
do $$
declare
  invalid_count integer;
begin
  select count(*) into invalid_count
  from pilot.accounts
  where organization_id is null
    and not (role = 'platform_owner' and is_platform_owner = true);

  if invalid_count > 0 then
    raise exception 'session-expiry migration preflight failed: % account(s) have a null organization_id and are not a legitimate platform owner', invalid_count;
  end if;
end $$;

-- 5) resolvePrincipal now requires an active pilot.organization_memberships
--    row matching the session's organization. Some account-creation paths
--    (athlete/coach/parent onboarding) never wrote a membership row, so
--    backfill one for every account that's missing it, matching the
--    account's current role and organization. This mirrors the same
--    idempotent backfill already used by the multi-org migration. Null-org
--    accounts are excluded -- the preflight above already proved every one
--    of them is a legitimate platform owner, and organization_memberships.
--    organization_id is NOT NULL, so they must never reach this insert.
insert into pilot.organization_memberships (account_id, organization_id, role, active_flag)
select account_id, organization_id, role, active_flag from pilot.accounts
where organization_id is not null
on conflict (account_id, organization_id) do nothing;
