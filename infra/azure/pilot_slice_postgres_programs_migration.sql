-- Programs: the durable named group an athlete enrolls in -- "Junior
-- Boxing", "Competition Team", "6 PM Adults", "Fight Camp".
--
-- WHY THIS EXISTS: pilot.program_memberships already carries persistent
-- group membership (org-scoped, lifecycle, one-active-per-program,
-- re-enroll-as-new-row), but the GROUP itself was never an entity --
-- program_name was free text typed independently on the memberships page
-- and the program-phases page, so "Junior Boxing" vs "junior boxing" vs
-- "Jr Boxing" silently split one real group into several. This table makes
-- the program a durable named record with an org-scoped unique name, so
-- every enrollment picks from a catalog instead of retyping a string.
--
-- WHAT THIS DELIBERATELY IS NOT
--   * A change to pilot.program_memberships. Memberships stay where they
--     are and keep joining by (organization_id, program_name) -- this
--     migration adds the catalog beside them, no ALTER, no FK backfill,
--     no rewrite of enrollment history. Archiving a program never touches
--     its membership rows.
--   * Floor groups. pilot.floor_groups is the separate per-day concept
--     (who trains together on the floor today); a program is the durable
--     enrollment group that persists across days and seasons.
--
-- Archived, not deleted: a program that ends keeps its name reserved and
-- its enrollment history joinable. status is a two-value check constraint
-- following pilot.program_memberships.status (hard-coded vocabulary, not a
-- lookup table). Name uniqueness is case-insensitive on the trimmed name
-- (see the unique index below); the name DISPLAYS as typed.
--
-- Idempotent like every migration in this directory: create table if not
-- exists, no alters, no drops, safe to re-run wholesale. No begin;/commit;
-- here -- the runner (apps/web/scripts/pilot-apply-programs-migration.mjs)
-- opens the transaction itself, matching the club-members and
-- program-memberships runners.
--
-- DEPENDS ON pilot.organizations, pilot.accounts.

create table if not exists pilot.programs (
  organization_id text not null references pilot.organizations(organization_id) on delete cascade,
  program_id      text not null,
  program_name    text not null check (length(btrim(program_name)) > 0),
  status          text not null default 'active' check (status in ('active','archived')),
  notes           text not null default '',
  created_by_account_id text not null references pilot.accounts(account_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, program_id)
);

-- The whole point: one name, one group, per gym. Uniqueness is on the
-- CANONICAL name -- lowercased, trimmed -- because "Junior Boxing" vs
-- "junior boxing" is exactly the spelling drift this catalog exists to
-- refuse; a plain column-unique would have let the case variants coexist
-- and recreate the split roster. The display name stays as typed:
-- program_name keeps its capitalization, only the uniqueness check
-- canonicalizes.
create unique index if not exists pilot_programs_name_unique
  on pilot.programs (organization_id, lower(btrim(program_name)));
