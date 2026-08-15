-- External competition minimal skeleton (owner decision 2026-08-15: "build
-- both skeletons knowing requirements are guessed until a real league
-- exists" -- the same constraint governs this, the second of the two).
--
-- WHAT THIS IS: two deliberately skeletal record types -- an external
-- competition (a meet or tournament run by someone else) and an entry
-- linking an athlete to it. Enough structure to write down that the gym is
-- taking athletes somewhere and who is going, and nothing more.
--
-- WHAT THIS DELIBERATELY IS NOT, until real competitions define it: no
-- federation integration, no result sync, no brackets or seeding, no travel
-- logistics, no compliance checklists. Those must come from real external
-- requirements, not be guessed here.
--
-- Safeguarding note: entries carry the athlete LINK only (composite FK into
-- pilot.athletes). No athlete attribute is copied into these tables; reads
-- join through the existing org-scoped athlete records, so athlete data
-- stays governed where it already lives.
--
-- Idempotent like every migration in this directory: create table/index
-- if not exists, no alters, no drops, safe to re-run wholesale.

create table if not exists pilot.external_competitions (
  organization_id        text not null references pilot.organizations(organization_id) on delete cascade,
  competition_id         text not null,
  competition_name       text not null check (length(btrim(competition_name)) > 0),
  competition_date       date not null,
  location               text not null default '',
  sanctioning_body       text not null default '',
  status                 text not null default 'planned' check (status in ('planned', 'completed', 'cancelled')),
  notes                  text not null default '',
  created_by_account_id  text not null references pilot.accounts(account_id),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  primary key (organization_id, competition_id)
);

create table if not exists pilot.external_competition_entries (
  organization_id        text not null,
  entry_id               text not null,
  competition_id         text not null,
  athlete_id             text not null,
  status                 text not null default 'entered' check (status in ('entered', 'withdrawn')),
  created_by_account_id  text not null references pilot.accounts(account_id),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  primary key (organization_id, entry_id),
  -- Composite FKs: an entry can only reference a competition and an athlete
  -- in the SAME organization. FKs prove existence, this shape proves tenancy.
  constraint pilot_external_competition_entries_competition_fk
    foreign key (organization_id, competition_id)
    references pilot.external_competitions(organization_id, competition_id) on delete cascade,
  constraint pilot_external_competition_entries_athlete_fk
    foreign key (organization_id, athlete_id)
    references pilot.athletes(organization_id, athlete_id) on delete cascade,
  -- One entry per athlete per competition; re-entering is an update to the
  -- existing row's status, not a second entry.
  constraint pilot_external_competition_entries_unique
    unique (organization_id, competition_id, athlete_id)
);

-- The page's queries: what is coming up, and who is entered where.
create index if not exists idx_external_competitions_by_date
  on pilot.external_competitions(organization_id, status, competition_date);
create index if not exists idx_external_competition_entries_by_competition
  on pilot.external_competition_entries(organization_id, competition_id);
