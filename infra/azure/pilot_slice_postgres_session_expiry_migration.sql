-- PPBF Pilot Session Expiry Migration
-- Safe, additive, idempotent migration for existing pilot schema installations.
-- Adds an absolute 24-hour session lifetime (pilot.session_tokens.expires_at)
-- and ensures every account has an active organization membership row, which
-- resolvePrincipal now requires.

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

-- 4) resolvePrincipal now requires an active pilot.organization_memberships
--    row matching the session's organization. Some account-creation paths
--    (athlete/coach/parent onboarding) never wrote a membership row, so
--    backfill one for every account that's missing it, matching the
--    account's current role and organization. This mirrors the same
--    idempotent backfill already used by the multi-org migration.
insert into pilot.organization_memberships (account_id, organization_id, role, active_flag)
select account_id, organization_id, role, active_flag from pilot.accounts
on conflict (account_id, organization_id) do nothing;
