-- ---------------------------------------------------------------------------
-- A coach marks a draft reference drill floor-tested, per gym.
--
-- OWNER DECISION, VERBATIM (OD-2026-10-06-026 ruling 3, Jason, 2026-10-07):
--   "Coach validates each first (Recommended)" -- "They stay drafts until a
--   coach marks them floor-tested."
-- The question: the 114 draft drills marked 'REQUIRES FLOOR VALIDATION':
-- adopt them as they are, or does a coach have to try each on the floor first?
--
-- WHERE THE MARK LIVES. Not on pilot.drill_library: that is the seeded,
-- canonical reference shelf, and a mutable "this gym tested it" column there
-- would make one gym's floor time look like a fact about the drill itself. The
-- mark is a fact about a GYM and a reference drill, so it is its own
-- per-organization table (overwatch design ruling, 2026-10-07).
--
-- ONE ROW PER MARK, NEVER REWRITTEN. drill_id names a pilot.drill_library row,
-- which IS a version: a revised reference drill is new content and needs its
-- own floor test. A coach who marks the same version again adds a second row;
-- the newest row is the current mark and the earlier ones stay as history. No
-- application path updates or deletes a row (drillFloorValidations.ts has no
-- such function); the organization and drill foreign keys cascade only when
-- the parent itself is removed, so this table can never block either deletion.
--
-- WHAT IT GATES. drillAdoptionReadiness refuses to adopt a reference whose
-- field_provenance is one of the two REQUIRES FLOOR VALIDATION values until
-- the adopting organization has a row here for it. Nothing bulk-adopts the
-- drafts and nothing here changes a drill_library row.
--
-- Additive: one new table and one index. Idempotent (if not exists). Refuses
-- to run before drill-library-v3, whose table it references.
-- ---------------------------------------------------------------------------

do $$
begin
  if to_regclass('pilot.drill_library') is null then
    raise exception 'DRILL_FLOOR_VALIDATIONS_NOT_READY: pilot.drill_library does not exist -- apply the drill library v3 migration first';
  end if;
end $$;

create table if not exists pilot.drill_floor_validations (
  organization_id         text not null references pilot.organizations(organization_id) on delete cascade,
  validation_id           text not null,
  drill_id                text not null,
  validated_by_account_id text not null,
  validated_by_role       text not null,
  validated_at            timestamptz not null default now(),
  note                    text not null default '',
  constraint pilot_drill_floor_validations_pkey primary key (organization_id, validation_id),
  constraint pilot_drill_floor_validations_drill_fk foreign key (organization_id, drill_id)
    references pilot.drill_library(organization_id, drill_id) on delete cascade,
  -- The two roles the owner named: a coach, or the gym's own admin. Not the
  -- platform owner, who is not of the gym; not 'admin', which does not stand
  -- on a gym floor.
  constraint pilot_drill_floor_validations_role_check
    check (validated_by_role in ('coach', 'organization_admin'))
);

-- The read is "this gym's newest mark for each of these drills".
create index if not exists idx_pilot_drill_floor_validations_org_drill_newest
  on pilot.drill_floor_validations (organization_id, drill_id, validated_at desc);

comment on table pilot.drill_floor_validations is
  'A coach of this organization marked this reference drill (a pilot.drill_library row, i.e. one version) floor-tested. Append-only: a re-mark adds a row; the newest row is current. OD-2026-10-06-026 ruling 3.';
