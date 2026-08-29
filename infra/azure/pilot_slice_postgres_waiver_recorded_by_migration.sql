-- pilot.waivers: record WHO ENTERED the waiver, which is not who signed it.
--
-- THE GAP. pilot.waivers.signed_by_name is `text not null` -- a name somebody
-- typed. For media consent that is enough on its own, because those rows also
-- carry parent_id, written only by POST /api/pilot/parent/consent, which is a
-- real link to a real account. Every other waiver type has no such link:
-- /api/pilot/intake/domain-upsert and /api/pilot/intake/review-action both
-- write signed_by_name straight from the request and pass no parent_id at all.
--
-- So a travel waiver -- the document that authorises taking a minor off the
-- premises, and the one competitionSafetyGates.ts refuses competition entry
-- without -- records a typed string and nothing else. Nobody can be asked
-- afterwards what they entered or why.
--
-- WHAT THIS RECORDS, AND WHAT IT DELIBERATELY DOES NOT. It records the signed-in
-- account that PUT THE ROW ON FILE. It does not claim to identify the signer,
-- and must never be read as doing so: intake is data entry from paper, and the
-- guardian who signed that paper frequently has no account on this platform at
-- all. Requiring a link to the signer would either block honest paper intake or
-- invite staff to attach the nearest account to a signature that is not theirs.
-- Who signed stays in signed_by_name, with its existing honesty about being
-- free text. Who is answerable for the record is what this adds.
--
-- NULLABLE, AND NOT BACKFILLED. Every pre-existing row has no recorded entrant,
-- and there is no honest way to invent one -- the same reasoning
-- pilot_slice_postgres_observation_author_role_migration.sql sets out for
-- author_role, and that pilot.readiness.recorded_by_account_id already follows
-- in this schema. NULL means "not recorded", and for those rows that is the
-- correct answer permanently. A backfill would manufacture provenance
-- indistinguishable from the real thing.
--
-- Idempotent: add column if not exists, catalog-guarded constraint, no drops,
-- no destructive alters, no backfill. No begin;/commit; here on purpose,
-- matching this repo's runner-opens-the-transaction convention (the runner is
-- apps/web/scripts/pilot-apply-waiver-recorded-by-migration.mjs).

alter table pilot.waivers
  add column if not exists recorded_by_account_id text null;

-- ON DELETE SET NULL, AND THE FIRST DRAFT OF THIS FILE HAD IT WRONG.
--
-- The obvious shape for an audit column is a plain reference with no ON DELETE
-- clause, so that deleting an account which entered a waiver is REFUSED rather
-- than silently detaching the record from its author. That is what
-- pilot.readiness.recorded_by_account_id does, and this file was written to
-- mirror it.
--
-- It is wrong here, because accounts on this platform ARE hard-deleted. The
-- retention purge -- dataDeletion.ts purgeExpiredDeletedData() and
-- scripts/pilot-cleanup-deleted-data.mjs, which run the same statement --
-- issues `delete from pilot.accounts ... and role = 'parent'` for parent
-- accounts soft-deleted beyond the retention window. A parent's own media
-- consent, written by POST /api/pilot/parent/consent, carries that parent's
-- account id in this column. A restricting foreign key would therefore make
-- the purge raise, and because the purge does its athlete delete, its account
-- delete and its audit insert in ONE transaction, the whole sweep would abort
-- and purge nothing at all. Retention would silently stop working, and the
-- first symptom would be personal data still present a year after it was due
-- for deletion.
--
-- SET NULL is not a weakening of the audit trail here; it is the same
-- statement the column already makes. NULL means "not recorded", and once the
-- account is gone there is nothing left to record -- the account id resolves
-- to a login email (staffProvisioning.ts), so it is itself the personal data
-- the purge exists to remove. Keeping a dangling identifier after the purge
-- would defeat the deletion; inventing a replacement would fabricate
-- provenance. What survives is the waiver: signed_by_name, type, status and
-- dates are untouched.
--
-- NOT CASCADE, which would be the catastrophic reading of the same problem:
-- purging a parent account must never delete the waiver rows that authorise
-- a minor's participation.
--
-- Safe to add against existing data without validation: every pre-existing row
-- is NULL, and a foreign key does not constrain NULL.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'pilot_waivers_recorded_by_fk'
      and conrelid = to_regclass('pilot.waivers')
  ) then
    alter table pilot.waivers add constraint pilot_waivers_recorded_by_fk
      foreign key (recorded_by_account_id) references pilot.accounts(account_id)
      on delete set null;
  end if;
end
$$;

comment on column pilot.waivers.recorded_by_account_id is
  'The signed-in account that put this row on file. NOT the signer -- signed_by_name is who signed, and for intake-entered waivers that person often has no account here. NULL means not recorded: either the row predates this column, or the recording account has since been purged by data retention (the foreign key is ON DELETE SET NULL). It is never backfilled, because a fabricated attribution is worse than an absent one.';
