-- Records the author's ROLE on an observation, at the moment it is written.
--
-- pilot.coach_observations records who wrote a note (coach_account_id) and
-- what kind of note it is (note_type), but never what the author WAS. The two
-- readers that report an author role -- intake.ts's listParentMessages
-- (sender_role) and listBarrierReports (reporter_role) -- recover it by
-- joining pilot.accounts.role at read time.
--
-- pilot.accounts.role is mutable. upsertOrganizationMembership does
-- `update pilot.accounts set role = $3` whenever an organization admin
-- changes someone's membership, and several activation paths set it to
-- 'athlete'. So authorship is not stored anywhere -- it is recomputed on
-- every read from a value that can change afterwards, and changing a
-- person's role silently rewrites the attribution of everything they ever
-- wrote.
--
-- Measured against embedded PostgreSQL before this migration existed: a
-- coach writes a parent_message; listParentMessages reports sender_role
-- 'coach'; the account's role is changed to 'staff'; the same query on the
-- same untouched row reports sender_role 'staff'. The note did not move. The
-- claim about who wrote it did.
--
-- This matters most in the direction the platform cares about. A guardian's
-- barrier report -- "we have no lift to the gym" -- is a parent's account of
-- their own household. If that guardian is later given a coach or staff role,
-- the same row starts reading as a coach's professional observation of a
-- family, which is a different kind of statement with a different weight.
--
-- NULLABLE, AND DELIBERATELY NOT BACKFILLED.
--
-- Every row written before this migration has no recorded author role, and
-- there is no honest way to invent one: the account's role today is exactly
-- the value that cannot be trusted to describe the past. A backfill would
-- manufacture provenance and make it indistinguishable from the real thing.
-- NULL means "not recorded", readers must present it as unknown rather than
-- guessing, and that is the correct answer for those rows forever.
--
-- The CHECK mirrors pilot.accounts.role and pilot.organization_memberships.role
-- rather than leaving free text, so a typo cannot enter the vocabulary. It
-- admits NULL because unrecorded is a legitimate state here, unlike on the
-- account tables where a role is always known.
--
-- Idempotent and safe to re-apply. No outer do-block wrapper, for the reason
-- the data-retention migration records at length: a wrapper buys nothing when
-- every statement is already `if not exists`, and costs a deployment when it
-- collides with dollar-quoting.

alter table pilot.coach_observations
  add column if not exists author_role text null;

do $pilot_observation_author_role_check$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'pilot_coach_observations_author_role_check'
  ) then
    alter table pilot.coach_observations
      add constraint pilot_coach_observations_author_role_check
      check (author_role is null or author_role in (
        'platform_owner', 'organization_admin', 'admin', 'coach',
        'athlete', 'parent', 'volunteer', 'staff'
      ));
  end if;
end
$pilot_observation_author_role_check$;
