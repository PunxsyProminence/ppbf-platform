-- Announcement placements for pilot.announcements.
--
-- Where an announcement renders is a property of the record: placement names
-- the surface, kind separates a gym notice from motivational copy, active
-- retires an item without deleting it, and starts_at / ends_at bound an
-- optional window. Coaches and admins author notices, banners and
-- motivational content in the app, so this text is data rather than something
-- compiled into the component that draws it.
--
-- ROWS THAT PREDATE THESE COLUMNS STAY VISIBLE
--
-- Without a placement, the login page's Gym Notices panel is the only surface
-- a row can reach, so every such row IS a visible gym notice and the defaults
-- say exactly that: placement, kind and active are `not null default`, which
-- makes PostgreSQL fill them with 'gym_notices' / 'notice' / true. A read
-- filtered on placement therefore still returns them. Adding a defaulted
-- column is a catalog-only change on PostgreSQL 11+, so no row is rewritten.
--
-- starts_at / ends_at are nullable instead of defaulted: NULL is the honest
-- value for a window nobody set, and a reader treats it as always-on rather
-- than as a bound. A default of now() would silently backdate every existing
-- notice to the moment this migration ran.
--
-- DEPENDS ON pilot.announcements
--
-- This file only ALTERs. pilot_slice_postgres_announcements_migration.sql
-- creates the table, and the `all` loop orders it ahead of this one;
-- dispatching `announcement-placements` alone against a fresh environment
-- requires `announcements` first.
--
-- No `begin;`/`commit;`: the runner
-- (apps/web/scripts/pilot-apply-announcement-placements-migration.mjs) opens
-- the transaction itself, matching the announcements and volunteer-program
-- runners. The shadow-runtime runner takes the opposite convention.

alter table pilot.announcements
  add column if not exists placement text not null default 'gym_notices',
  add column if not exists kind text not null default 'notice',
  add column if not exists active boolean not null default true,
  add column if not exists starts_at timestamptz null,
  add column if not exists ends_at timestamptz null;

-- PostgreSQL has no `ADD CONSTRAINT IF NOT EXISTS`, so both constraints are
-- catalog-guarded. Both vocabularies are closed sets: a placement names a
-- surface that exists, and an unrecognized one renders nowhere at all, which
-- is worse than the write being refused.
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'pilot_announcements_placement_check'
      and conrelid = 'pilot.announcements'::regclass
  ) then
    alter table pilot.announcements
      add constraint pilot_announcements_placement_check
      check (placement in ('gym_notices', 'athlete_workspace', 'coach_workspace', 'everywhere'));
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'pilot_announcements_kind_check'
      and conrelid = 'pilot.announcements'::regclass
  ) then
    alter table pilot.announcements
      add constraint pilot_announcements_kind_check
      check (kind in ('notice', 'motivation'));
  end if;
end
$$;

-- Matches the read path: one organization's items for one surface, of one
-- kind, still active, newest first. idx_pilot_announcements_org_created stays
-- -- it serves the unfiltered organization-wide read.
create index if not exists idx_pilot_announcements_org_placement_kind_active_created
  on pilot.announcements(organization_id, placement, kind, active, created_at desc);
