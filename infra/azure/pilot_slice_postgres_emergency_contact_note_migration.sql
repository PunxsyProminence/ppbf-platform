-- CT-15: pilot.athletes.emergency_contact is a free-text NOTE, not the
-- authoritative emergency contact record -- pilot.emergency_contacts
-- (structured: full_name, relationship_to_athlete, phone, email, is_primary)
-- is. Two admin surfaces (/admin/athletes, /admin/people) showed and edited
-- the free-text column with no indication it was a note rather than the
-- verified record an emergency read should trust: TWO SOURCES OF TRUTH FOR A
-- SAFETY-CRITICAL FIELD, where the wrong one could be read in an emergency.
--
-- The fix is a rename, but a rename here cannot drop what it is renaming: the
-- column is required at athlete creation today, and a gym's real phone
-- number may live only in this free-text field, never entered into the
-- structured table. Dropping it would be the actual safety risk, worse than
-- the ambiguity being fixed. So this is additive: a correctly-named column
-- is added, existing notes are copied into it once, and the application
-- (apps/web/src/server/pilot/entities.ts#upsertAthlete,
-- #insertAthleteIfAbsent) writes both columns identically on every insert
-- and update from now on, so the two can never diverge going forward. The
-- old column stays -- unused by anything written after this migration, kept
-- only because dropping it is not this change's call to make.
--
-- Idempotent: add column if not exists, guarded backfill, no drops, no
-- destructive alters.

alter table pilot.athletes
  add column if not exists emergency_contact_note text not null default '';

-- One-time backfill, guarded so re-running this migration (idempotent by
-- design, same as every other migration here) never overwrites a value the
-- application has since written through the new column. Because entities.ts
-- keeps both columns identical on every write from this migration forward, a
-- row that has already been touched already carries the same value in both,
-- and re-running this UPDATE against it is a no-op.
update pilot.athletes
set emergency_contact_note = emergency_contact
where emergency_contact_note = '';
