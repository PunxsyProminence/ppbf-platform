-- Parent password sign-in: storage only.
-- Jason, 2026-10-01: "yes they will need away to sign in with a password ...
-- the magic link should prompt them to make a password".
--
-- Additive and idempotent. Changes no existing row: every account keeps a null
-- password, and every existing session keeps a null sign_in_method.
--
-- APPLY BEFORE DEPLOYING THE CODE THAT COMES WITH IT. Redeeming an emailed
-- sign-in link names pilot.session_tokens.sign_in_method in its insert, so
-- code deployed ahead of this migration fails every link redemption.
--
-- No begin/commit here: pilot-apply-parent-password-migration.mjs wraps the
-- file and its readiness check in one transaction.

-- A password is its own credential, not pin_hash. Parent rows can still hold
-- an admin-typed PIN hash from the retired createParentAccount path, and a
-- re-invite nulls pin_hash; reusing the column would make the first a live
-- password and let the second wipe one.
alter table pilot.accounts
  add column if not exists password_hash text null;
alter table pilot.accounts
  add column if not exists password_set_at timestamptz null;

-- How a session was minted. Null means "not recorded", which is every session
-- minted before this migration and every path that does not say; a reader
-- that needs proof of a method treats null as no proof.
alter table pilot.session_tokens
  add column if not exists sign_in_method text null;

do $parent_password_constraints$
begin
  -- A hash without its timestamp, or a timestamp without a hash, is a write
  -- that set half a credential.
  if not exists (
    select 1 from pg_constraint
     where conname = 'pilot_accounts_password_pair_check'
       and conrelid = 'pilot.accounts'::regclass
  ) then
    alter table pilot.accounts add constraint pilot_accounts_password_pair_check
      check ((password_hash is null) = (password_set_at is null));
  end if;

  -- The four doors. Only 'magic_link' is written today; the rest are named so
  -- the door that starts recording itself needs no second migration.
  if not exists (
    select 1 from pg_constraint
     where conname = 'pilot_session_tokens_sign_in_method_check'
       and conrelid = 'pilot.session_tokens'::regclass
  ) then
    alter table pilot.session_tokens add constraint pilot_session_tokens_sign_in_method_check
      check (sign_in_method is null or sign_in_method in ('magic_link', 'password', 'pin', 'microsoft'));
  end if;
end
$parent_password_constraints$;

comment on column pilot.accounts.password_hash is
  'scrypt hash of a password the account holder chose (security.ts hashPassword). Null until one is set. Never the PIN.';
comment on column pilot.session_tokens.sign_in_method is
  'How this session was minted: magic_link, password, pin or microsoft. Null = not recorded; never read null as proof of a method.';
