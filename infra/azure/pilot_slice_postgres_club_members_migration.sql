-- Club members: the general roster record for a dues-paying member who is
-- not necessarily an athlete.
--
-- WHY THIS EXISTS: a real 30-row membership export (owner-supplied) carries
-- a Mbr Type column with four known values -- Athlete, Non-Athlete, Junior
-- Fitness Non-Contact, Adult Fitness Non-Contact -- plus a home address per
-- person. Several rows, including the gym owner and his spouse, are
-- Non-Athlete: adults with no training record in this platform's existing
-- sense at all.
--
-- WHERE THIS DOES NOT FIT, AND WHY A NEW TABLE
--   * pilot.athletes is training-specific (dob not null, weight_class,
--     gym_status, coach_id all not null) and holds no address or membership
--     type. Putting a Non-Athlete adult in it would be semantically wrong --
--     an "athlete" table holding people who are not athletes -- and would
--     force fabricated dob/weight_class/coach values just to satisfy
--     constraints that do not apply to them.
--   * pilot.accounts.role is authentication/authorization ('platform_owner',
--     'organization_admin', 'admin', 'coach', 'athlete', 'parent', 'board',
--     'volunteer', 'staff') -- system access, not club membership -- and has
--     no "member, not staff, not athlete" role. This table does not touch
--     accounts or roles; a club member gets no login from this migration,
--     matching the roster importer's existing "creates no credentials" rule.
--   * pilot.program_memberships links ATHLETE to a named PROGRAM
--     (organization_id, athlete_id) with an enrollment lifecycle and a
--     scholarship discount. That is a different fact (which program a
--     trainee is enrolled in) from the roster's Mbr Type (what category of
--     club member a person is), and its FK is athlete-only -- widening it to
--     accept a non-athlete would conflate the two concepts. Left untouched.
--   * No "member" or "household" concept exists anywhere else in pilot.*.
--
-- THE SHAPE: one row per roster entry, athlete or not. `athlete_id` is set
-- when the person also has a pilot.athletes record (an Athlete-type row) and
-- null otherwise (every other Mbr Type). Both kinds of row use the SAME
-- membership_type + address columns -- the roster's own fields, not
-- duplicated per table.
--
-- SAFEGUARDING NOTE, matching pilot.program_memberships and the wrestling
-- league tables: a row that IS an athlete does not duplicate the athlete's
-- name here -- full_name stays null and every read joins through
-- pilot.athletes, so a minor's name lives in exactly one place. A
-- non-athlete row has no other record to join through, so full_name is
-- required there. pilot_club_members_name_check enforces exactly this
-- split structurally, not by convention alone.
--
-- CONTROLLED VOCABULARY: membership_type is a hard-coded check constraint
-- naming the four values the real export uses today, following
-- pilot.program_memberships.status and the wrestling-league status columns
-- (both check-constrained, not lookup tables). This is a judgment call, not
-- a certainty -- pilot.clearance_types shows the alternative (a
-- per-organization editable lookup table) for a vocabulary expected to vary
-- by org. If membership categories turn out to need per-gym customization,
-- that argues for migrating to a lookup table later; nothing here forecloses
-- it.
--
-- Idempotent like every migration in this directory: create table/index if
-- not exists, no alters, no drops, safe to re-run wholesale. No begin;/
-- commit; here -- the runner
-- (apps/web/scripts/pilot-apply-club-members-migration.mjs) opens the
-- transaction itself, matching the wrestling-league and program-memberships
-- runners.
--
-- DEPENDS ON pilot.organizations, pilot.accounts, pilot.athletes.

create table if not exists pilot.club_members (
  organization_id        text not null references pilot.organizations(organization_id) on delete cascade,
  member_id               text not null,
  athlete_id              text null,
  full_name               text null,
  membership_type         text not null check (membership_type in
                             ('athlete', 'non_athlete', 'junior_fitness_non_contact', 'adult_fitness_non_contact')),
  address_line1           text not null default '',
  city                    text not null default '',
  state                   text not null default '',
  postal_code             text not null default '',
  created_by_account_id   text not null references pilot.accounts(account_id),
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  primary key (organization_id, member_id),
  -- Composite FK, nullable: a row with athlete_id null satisfies MATCH
  -- SIMPLE trivially (Postgres default), so a non-athlete member is not
  -- forced to reference anything. A row that DOES set athlete_id can only
  -- point at an athlete in the SAME organization -- tenancy proven
  -- structurally, same pattern as the wrestling-league tables.
  constraint pilot_club_members_athlete_fk
    foreign key (organization_id, athlete_id)
    references pilot.athletes(organization_id, athlete_id) on delete cascade,
  -- The name-lives-in-one-place split described above: an athlete-linked
  -- row must NOT carry its own copy of the name; a non-athlete row must.
  constraint pilot_club_members_name_check
    check (
      (athlete_id is not null and full_name is null)
      or (athlete_id is null and length(btrim(coalesce(full_name, ''))) > 0)
    )
);

-- At most one club_members row per athlete link -- a second import of the
-- same person under a different member_id would otherwise silently create a
-- duplicate membership record for one athlete.
create unique index if not exists idx_club_members_one_per_athlete
  on pilot.club_members(organization_id, athlete_id)
  where athlete_id is not null;

-- The roster-import lookup and any future membership-type listing.
create index if not exists idx_club_members_by_org
  on pilot.club_members(organization_id, membership_type);
