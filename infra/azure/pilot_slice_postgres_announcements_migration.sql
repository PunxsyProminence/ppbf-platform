-- Gym Notices (pilot.announcements) -- promoting a runtime-created table into
-- the migration path.
--
-- This table had no migration. It existed only because `ensureAnnouncementTable()`
-- in apps/web/src/server/pilot/announcements.ts issued CREATE TABLE from inside
-- request handlers, so whichever request arrived first created the schema.
-- Once GET /api/pilot/announcements/public shipped unauthenticated, that path
-- became reachable by anonymous callers: an internet request could execute DDL
-- against production Postgres. The DDL is removed in the same change that adds
-- this file.
--
-- The shape below is copied verbatim from that runtime DDL, so applying this to
-- an environment where the table already exists (staging and production both,
-- as of 2026-07-30) is a genuine no-op rather than a redefinition. No data is
-- read, written, or dropped.
--
-- No `begin;`/`commit;` here on purpose: the runner
-- (apps/web/scripts/pilot-apply-announcements-migration.mjs) opens the
-- transaction itself, matching the public-interest / scheduler-tables runners.
-- The shadow-runtime runner takes the opposite convention and asserts that its
-- files carry their own boundaries -- do not move a file between the two
-- without changing it to match.

create table if not exists pilot.announcements (
  organization_id text not null references pilot.organizations(organization_id),
  announcement_id uuid not null,
  message text not null,
  author_name text not null,
  author_role text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pilot_announcements_pk primary key (organization_id, announcement_id)
);

create index if not exists idx_pilot_announcements_org_created
  on pilot.announcements(organization_id, created_at desc);
