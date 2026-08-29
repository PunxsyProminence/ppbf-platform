-- pilot.organization_memberships.account_id: give it the foreign key it never
-- had, so purging an account does not leave the account behind.
--
-- THE GAP. organization_memberships names two things and constrains one.
-- organization_id references pilot.organizations ON DELETE CASCADE;
-- account_id is `text not null` with no reference at all. Every other table
-- holding an account's session or profile -- session_tokens,
-- account_profiles, magic_link_tokens, account_activation_tokens -- carries
-- ON DELETE CASCADE onto pilot.accounts. This one was missed.
--
-- WHY IT IS A RETENTION PROBLEM, NOT A TIDINESS PROBLEM. The retention purge
-- hard-deletes parent accounts one year after withdrawal, and every usable
-- account has a membership row -- resolvePrincipal() authenticates by joining
-- pilot.organization_memberships and refuses an account without an active one,
-- so the row is not optional. With no foreign key the delete succeeds and the
-- membership row stays, still holding that person's account_id.
--
-- An account_id on this platform resolves to the login email unless an admin
-- supplied a hint (staffProvisioning.ts). So the row left behind is not a
-- harmless dangling key: it is the guardian's email address, surviving a purge
-- whose entire purpose was to remove it, in a table nobody would think to look
-- in. docs/DATA_RETENTION.md promises the record is deleted.
--
-- Nothing has produced such a row yet, because until very recently the purge
-- could not delete a guardian at all. That is why this is worth doing now: the
-- first successful purge is what starts creating them, and a foreign key added
-- before then never has to argue with existing data.
--
-- ON DELETE CASCADE, matching every sibling table. A membership is an
-- authorization row, not an audit record -- it says "this account may act in
-- this organization", which is meaningless once the account is gone. Audit
-- lives in pilot.audit_events, which deliberately holds actor_account_id as
-- plain text with no foreign key so that history survives. This is the
-- opposite kind of row and takes the opposite treatment.
--
-- VALIDATED, NOT `NOT VALID`. A `not valid` constraint would enforce the rule
-- for new rows while recording that the existing ones were never checked --
-- which is the state pilot_slice_postgres_discipline_fk_validation exists to
-- clean up elsewhere in this schema, and not a state worth creating on
-- purpose. If a database somewhere does hold an orphan, this ALTER fails with
-- 23503 naming the constraint and touches nothing; that is a better outcome
-- than a constraint that quietly means less than it says. Deleting orphan rows
-- is a data decision and is deliberately NOT taken here.
--
-- Idempotent: catalog-guarded, no drops, no destructive alters, no backfill.
-- No begin;/commit; here on purpose, matching this repo's
-- runner-opens-the-transaction convention (the runner is
-- apps/web/scripts/pilot-apply-membership-account-fk-migration.mjs).

do $pilot_org_memberships_account_fk$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'pilot_organization_memberships_account_fk'
      and conrelid = to_regclass('pilot.organization_memberships')
  ) then
    alter table pilot.organization_memberships
      add constraint pilot_organization_memberships_account_fk
      foreign key (account_id) references pilot.accounts(account_id)
      on delete cascade;
  end if;
end
$pilot_org_memberships_account_fk$;

comment on constraint pilot_organization_memberships_account_fk on pilot.organization_memberships is
  'ON DELETE CASCADE, like session_tokens and account_profiles. A membership is an authorization row, not an audit record: it is meaningless once the account is gone, and account_id resolves to a login email, so leaving it behind would survive the retention purge that exists to remove it.';
