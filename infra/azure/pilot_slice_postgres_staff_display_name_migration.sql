-- Staff display name: the name the gym types for a coach or staff member.
--
-- WHY. No screen can name a coach by their real name, because the platform
-- has nowhere to keep one. pilot.accounts has no name column, so every
-- surface builds a name from the stem of the login address instead: "Coach "
-- + the stem (deriveCoachDisplayName), the stem alone (deriveStaffDisplayName;
-- both apps/web/src/shared/coachDisplayName.ts), or the stem with the account
-- id as its floor (profileDb.ts staffDisplayName, a function, not this
-- column). A shared or role login names nobody ("Coach Coach", "From Ppbf";
-- parent walk 2026-10-19 item 6). Jason 2026-10-19, parent-portal Q1 "C: A
-- now, B later (Rec.)": A strips the role words from the stem (PR #1786); B,
-- this file and the two pull requests after it, is "a real display-name field
-- so the gym types each coach's name".
--
-- WHERE IT LIVES, AND WHY HERE. pilot.account_profiles, keyed
-- (organization_id, account_id), is already the record of the part of a
-- person that is not their credential, and its migration says coaches and
-- staff get a row there (pilot_slice_postgres_profile_identity_migration.sql).
-- Keying on the organization gives a coach who works at two gyms one name per
-- gym, the same answer the name lookup already gives through the membership
-- (achievements.ts memberLoginEmail). Not on pilot.accounts: that row is read
-- on every request and identity was kept off it on purpose (same file). Not
-- display_nickname: that is the ring name a member picks for themselves,
-- 24 characters, which staff can clear. This one is set by the gym's admin
-- and is the person's name as the gym wants families to read it.
--
-- WHAT CHANGES. One column on pilot.account_profiles:
--   staff_display_name -- the name, or NULL when the gym has not typed one.
--                         Every existing row stays NULL, and a NULL name
--                         falls back to today's derived name on every
--                         surface. No default: an empty string would make
--                         "not typed" look like "typed as nothing".
-- One check: a name, when present, is 1 to 60 characters (characters, not
-- bytes), with no leading or trailing space and no control character (a tab
-- or a line break would split the name across lines on a printed card). btrim
-- strips only the ASCII space, so the application's own validator, which
-- trims all whitespace and normalises the text, is the full rule; the check
-- is what holds when a later writer forgets to call it.
-- Which accounts may carry one (staff roles only) and who may set it (the
-- organization admin) are application rules, enforced where the name is
-- written; this file adds no role check, because the role lives on another
-- table.
--
-- Requires pilot.account_profiles
-- (pilot_slice_postgres_profile_identity_migration.sql); the `all` chain runs
-- it first.
--
-- Idempotent: add column if not exists; the check is added only when the table
-- has no check of that name, so a re-run (the `all` chain) does not re-scan the
-- table. A same-named check with any other definition is left for the runner's
-- readiness check to refuse. Additive only: nothing is dropped or rewritten.
-- No `begin;`/`commit;` here: the runner
-- (apps/web/scripts/pilot-apply-staff-display-name-migration.mjs) opens the
-- transaction.

alter table pilot.account_profiles
  add column if not exists staff_display_name text null;

do $pilot_account_profiles_staff_display_name_check$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'pilot_account_profiles_staff_display_name_check'
      and conrelid = to_regclass('pilot.account_profiles')
  ) then
    alter table pilot.account_profiles
      add constraint pilot_account_profiles_staff_display_name_check check (
        staff_display_name is null
        or (
          char_length(staff_display_name) between 1 and 60
          and staff_display_name = btrim(staff_display_name)
          and staff_display_name !~ '[[:cntrl:]]'
        )
      );
  end if;
end
$pilot_account_profiles_staff_display_name_check$;

comment on column pilot.account_profiles.staff_display_name is
  'The name the gym''s organization admin typed for this coach or staff member at this organization, or NULL when none has been typed. Surfaces that name staff prefer it and fall back to the name derived from the login. 1-60 characters, no leading or trailing space, no control character (pilot_account_profiles_staff_display_name_check).';
