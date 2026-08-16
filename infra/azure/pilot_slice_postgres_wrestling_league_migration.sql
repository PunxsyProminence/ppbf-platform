-- Wrestling league minimal skeleton (owner decision 2026-08-15: "build both
-- skeletons knowing requirements are guessed until a real league exists").
--
-- WHAT THIS IS: three deliberately skeletal record types -- a season, an
-- event inside a season, and a roster entry linking an athlete to a season.
-- Enough structure for the organization to write down that a league exists
-- and who is in it, and nothing more.
--
-- WHAT THIS DELIBERATELY IS NOT, until a real league defines it: no match
-- cards, no brackets, no weigh-ins, no scoring, no officials, no scheduling
-- engine. Those columns and tables must come from a real league's real
-- requirements, not be guessed here.
--
-- Safeguarding note: roster entries carry the athlete LINK only (composite
-- FK into pilot.athletes). No athlete attribute -- name, dob, weight -- is
-- copied into these tables; reads join through the existing org-scoped
-- athlete records, so athlete data stays governed where it already lives.
--
-- Idempotent like every migration in this directory: create table/index
-- if not exists, no alters, no drops, safe to re-run wholesale.

create table if not exists pilot.wrestling_league_seasons (
  organization_id        text not null references pilot.organizations(organization_id) on delete cascade,
  season_id              text not null,
  season_name            text not null check (length(btrim(season_name)) > 0),
  starts_on              date not null,
  ends_on                date null,
  status                 text not null default 'planned' check (status in ('planned', 'active', 'completed')),
  notes                  text not null default '',
  created_by_account_id  text not null references pilot.accounts(account_id),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  primary key (organization_id, season_id),
  constraint pilot_wrestling_league_seasons_dates_check
    check (ends_on is null or ends_on >= starts_on)
);

create table if not exists pilot.wrestling_league_events (
  organization_id        text not null,
  event_id               text not null,
  season_id              text not null,
  event_name             text not null check (length(btrim(event_name)) > 0),
  event_date             date not null,
  location               text not null default '',
  status                 text not null default 'planned' check (status in ('planned', 'completed', 'cancelled')),
  notes                  text not null default '',
  created_by_account_id  text not null references pilot.accounts(account_id),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  primary key (organization_id, event_id),
  -- Composite FK: an event can only hang off a season in the SAME
  -- organization. FKs prove existence, this shape also proves tenancy.
  constraint pilot_wrestling_league_events_season_fk
    foreign key (organization_id, season_id)
    references pilot.wrestling_league_seasons(organization_id, season_id) on delete cascade
);

create table if not exists pilot.wrestling_league_roster_entries (
  organization_id        text not null,
  entry_id               text not null,
  season_id              text not null,
  athlete_id             text not null,
  status                 text not null default 'active' check (status in ('active', 'inactive')),
  created_by_account_id  text not null references pilot.accounts(account_id),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  primary key (organization_id, entry_id),
  constraint pilot_wrestling_league_roster_season_fk
    foreign key (organization_id, season_id)
    references pilot.wrestling_league_seasons(organization_id, season_id) on delete cascade,
  constraint pilot_wrestling_league_roster_athlete_fk
    foreign key (organization_id, athlete_id)
    references pilot.athletes(organization_id, athlete_id) on delete cascade,
  -- One roster row per athlete per season; re-adding is an update to the
  -- existing row's status, not a second membership.
  constraint pilot_wrestling_league_roster_unique
    unique (organization_id, season_id, athlete_id)
);

-- The page's queries: a season's events by date, and a season's roster.
create index if not exists idx_wrestling_league_events_by_season
  on pilot.wrestling_league_events(organization_id, season_id, event_date);
create index if not exists idx_wrestling_league_roster_by_season
  on pilot.wrestling_league_roster_entries(organization_id, season_id);
