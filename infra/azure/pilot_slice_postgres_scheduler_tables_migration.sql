-- Additive migration: brings production up to the canonical schema's
-- scheduler tables (pilot_slice_postgres.sql lines ~604-696). These were
-- part of the base schema staging's fresh install already had, but were
-- never applied to production via an additive migration -- discovered
-- while applying the scheduler-registration-race unique index, which
-- failed with "relation pilot.scheduler_registrations does not exist".
-- Every statement here is copied verbatim from the canonical schema file,
-- all guarded with if not exists. No existing table altered, no data touched.
begin;

create table if not exists pilot.scheduler_classes (
  organization_id            text not null references pilot.organizations(organization_id) on delete cascade,
  class_id                   text not null,
  title                      text not null,
  start_at                   timestamptz not null,
  end_at                     timestamptz not null,
  location                   text not null,
  capacity                   integer not null check (capacity > 0 and capacity <= 200),
  scheduled_by_account_id    text not null,
  coach_account_id           text not null,
  covering_coach_account_id  text null,
  status                     text not null check (status in ('open', 'full', 'cancelled')),
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now(),
  primary key (organization_id, class_id)
);

create index if not exists idx_scheduler_classes_org_start
  on pilot.scheduler_classes(organization_id, start_at asc);

create table if not exists pilot.scheduler_registrations (
  organization_id             text not null references pilot.organizations(organization_id) on delete cascade,
  registration_id             text not null,
  class_id                    text not null,
  athlete_id                  text not null,
  requested_by_role           text not null check (requested_by_role in ('athlete', 'parent', 'coach', 'organization_admin', 'admin')),
  requested_by_account_id     text not null,
  parent_reviewed             boolean not null default false,
  parent_reviewed_at          timestamptz null,
  parent_reviewer_account_id  text null,
  status                      text not null check (status in ('registered', 'waitlisted', 'cancelled')),
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  primary key (organization_id, registration_id),
  foreign key (organization_id, class_id)
    references pilot.scheduler_classes(organization_id, class_id)
    on delete cascade,
  foreign key (organization_id, athlete_id)
    references pilot.athletes(organization_id, athlete_id)
    on delete cascade
);

create index if not exists idx_scheduler_registrations_org_class
  on pilot.scheduler_registrations(organization_id, class_id, status);

create index if not exists idx_scheduler_registrations_org_athlete
  on pilot.scheduler_registrations(organization_id, athlete_id, created_at desc);

create table if not exists pilot.scheduler_coaching_requests (
  organization_id            text not null references pilot.organizations(organization_id) on delete cascade,
  request_id                 text not null,
  athlete_id                 text not null,
  requested_by_role          text not null check (requested_by_role in ('athlete', 'parent', 'coach', 'organization_admin', 'admin')),
  requested_by_account_id    text not null,
  preferred_at               timestamptz not null,
  goals                      text not null,
  status                     text not null check (status in ('pending', 'approved', 'declined')),
  assigned_coach_account_id  text null,
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now(),
  primary key (organization_id, request_id),
  foreign key (organization_id, athlete_id)
    references pilot.athletes(organization_id, athlete_id)
    on delete cascade
);

create index if not exists idx_scheduler_coaching_requests_org_athlete
  on pilot.scheduler_coaching_requests(organization_id, athlete_id, created_at desc);

create table if not exists pilot.scheduler_attendance (
  organization_id         text not null references pilot.organizations(organization_id) on delete cascade,
  attendance_id           text not null,
  class_id                text not null,
  athlete_id              text not null,
  status                  text not null check (status in ('present', 'absent', 'excused')),
  method                  text not null check (method in ('self', 'coach_override', 'admin_override')),
  checked_in_by_role      text not null check (checked_in_by_role in ('athlete', 'parent', 'coach', 'organization_admin', 'admin')),
  checked_in_by_account_id text not null,
  note                    text not null default '',
  checked_in_at           timestamptz not null,
  updated_at              timestamptz not null default now(),
  primary key (organization_id, attendance_id),
  unique (organization_id, class_id, athlete_id),
  foreign key (organization_id, class_id)
    references pilot.scheduler_classes(organization_id, class_id)
    on delete cascade,
  foreign key (organization_id, athlete_id)
    references pilot.athletes(organization_id, athlete_id)
    on delete cascade
);

create index if not exists idx_scheduler_attendance_org_class
  on pilot.scheduler_attendance(organization_id, class_id, checked_in_at desc);

commit;
