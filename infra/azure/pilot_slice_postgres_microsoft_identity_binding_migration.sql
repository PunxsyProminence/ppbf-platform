-- Microsoft sign-in: bind an account to the Entra object id, not the email.
--
-- Audit finding CL-A19 (claude-A-auth.md): loginWithMicrosoftEmail matched
-- the account on the token's email / preferred_username / upn claim and
-- nothing else. Those are mutable directory attributes. Inside the pinned
-- tenant, anyone who can change a user's mail attribute could sign in as the
-- account that address belongs to. The object id (oid) is fixed for the life
-- of the directory user, and is only unique within its tenant (tid), so the
-- pair is the identity.
--
-- Design (overwatch, option 1 of the auth-hardening lane's analysis):
--   * first successful sign-in by email stores oid + tid (trust on first use);
--   * a later sign-in for that account must present the same pair;
--   * a different pair is refused before any session is minted;
--   * no backfill: every account starts unbound and binds on its next sign-in.
--
-- Additive and idempotent. Changes no existing row.
--
-- APPLY BEFORE DEPLOYING THE CODE THAT COMES WITH IT. The Microsoft sign-in
-- query names both columns, so code deployed ahead of this migration fails
-- every Microsoft sign-in (platform owner and organization admin included).
--
-- APPLY AFTER audit-event-vocabulary. The refusal is recorded as audit event
-- 'microsoft_identity_mismatch', which that migration's constraint admits; the
-- runner refuses (MICROSOFT_IDENTITY_BINDING_NOT_READY audit_vocabulary_ready)
-- on a database where it does not yet.
--
-- No begin/commit here: pilot-apply-microsoft-identity-binding-migration.mjs
-- wraps the file and its readiness check in one transaction.

alter table pilot.accounts
  add column if not exists microsoft_oid text null;
alter table pilot.accounts
  add column if not exists microsoft_tid text null;

do $microsoft_identity_constraints$
begin
  -- An oid without its tenant is not an identity (oids are unique per tenant
  -- only), and a tenant without an oid binds nobody. Both or neither.
  if not exists (
    select 1 from pg_constraint
     where conname = 'pilot_accounts_microsoft_identity_pair_check'
       and conrelid = 'pilot.accounts'::regclass
  ) then
    alter table pilot.accounts add constraint pilot_accounts_microsoft_identity_pair_check
      check ((microsoft_oid is null) = (microsoft_tid is null));
  end if;
end
$microsoft_identity_constraints$;

-- One directory user, one account. Without it, a second account whose email
-- the same person can present would bind to the same oid, and the binding
-- would stop saying who the account belongs to.
create unique index if not exists pilot_accounts_microsoft_identity_uq
  on pilot.accounts (microsoft_tid, microsoft_oid)
  where microsoft_oid is not null;

comment on column pilot.accounts.microsoft_oid is
  'Entra object id (oid claim) bound at the first Microsoft sign-in. A later sign-in must present the same oid and tid. Null = not yet bound.';
comment on column pilot.accounts.microsoft_tid is
  'Entra tenant id (tid claim) bound with microsoft_oid. Set and cleared together with it.';
