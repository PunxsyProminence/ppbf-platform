-- Volunteer program fields for pilot.volunteers.
--
-- Why this exists: apps/web/src/server/pilot/volunteers.ts inserted five
-- columns that do not exist on the live table --
--
--   role_focus, availability, certification_status, background_check_status, notes
--
-- so every volunteer create failed at the database, 100% of the time, from the
-- day the feature shipped. Measured against production 2026-07-30: the table
-- had only the base-schema shape and contained zero rows. The module's own
-- `ensureVolunteerTable()` never repaired this, because `create table if not
-- exists` is a no-op against an existing table -- it silently agreed with a
-- shape it did not match. That helper is deleted in the same change as this
-- file.
--
-- Shape decision (deliberate): the BASE SCHEMA key wins. `volunteer_id` stays
-- `text` with the composite primary key `(organization_id, volunteer_id)`,
-- matching every other entity in this schema. The runtime DDL wanted a
-- `bigserial` single-column key, which would have broken the multi-org model,
-- so the module now mints a uuid per volunteer instead.
--
-- Nullability: the four program strings are nullable rather than
-- `not null default ''`. The write path always supplies them (the API 400s
-- without them), so the only rows that could be missing values are ones that
-- predate this migration -- and for those, NULL honestly means "never
-- recorded" while '' would assert an empty answer nobody gave.
--
-- `status` is the exception: it is `not null default 'pending'`, because a
-- volunteer row with no status genuinely IS pending review, and the code and
-- UI both branch on exactly three values.
--
-- Deliberately NO check constraint on certification_status /
-- background_check_status: the code does not constrain them. The route
-- validates presence only and the admin UI seeds the free-text value
-- 'Pending'. Inventing a vocabulary here would reject values the product
-- currently accepts.
--
-- No `begin;`/`commit;`: the runner
-- (apps/web/scripts/pilot-apply-volunteer-program-migration.mjs) opens the
-- transaction itself, matching the public-interest and announcements runners.
-- The shadow-runtime runner takes the opposite convention.

alter table pilot.volunteers
  add column if not exists role_focus text null,
  add column if not exists availability text null,
  add column if not exists certification_status text null,
  add column if not exists background_check_status text null,
  add column if not exists notes text null,
  add column if not exists status text not null default 'pending';

-- PostgreSQL has no `ADD CONSTRAINT IF NOT EXISTS`, so the constraint is
-- catalog-guarded. The three values are the ones volunteers.ts and the admin
-- UI actually write -- read from the code, not invented.
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'pilot_volunteers_status_check'
      and conrelid = 'pilot.volunteers'::regclass
  ) then
    alter table pilot.volunteers
      add constraint pilot_volunteers_status_check
      check (status in ('active', 'pending', 'inactive'));
  end if;
end
$$;

create index if not exists idx_pilot_volunteers_org_status_created
  on pilot.volunteers(organization_id, status, created_at desc);
