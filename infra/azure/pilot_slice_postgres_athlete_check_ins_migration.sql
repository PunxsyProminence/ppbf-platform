-- Athlete self check-in (Phase 2 slice 1, owner-approved sequencing: the
-- athlete client's first surface -- it generates the data the other role
-- views read).
--
-- WHAT THIS IS: the athlete's own arrival record -- "I'm here, and this is
-- how I feel" -- one row per athlete per day, written by the athlete.
--
-- WHAT THIS IS NOT: attendance. pilot.attendance stays the coach/terminal
-- register (passbook counts it); a self check-in never writes attendance
-- and never double-counts a day. And it is NOT pilot.readiness: that table
-- carries formula scores read by the readiness board with GREEN/YELLOW
-- thresholds -- mixing self-reports in would contaminate it (the board
-- reads the table unfiltered). Self-report lives here, under its own name.
--
-- Wellness fields are OPTIONAL 1-5 self-reports. Skipping them is legal:
-- an athlete who doesn't want to rate their soreness still gets to say
-- "I'm here". Absent is absent -- no default is invented.
--
-- Idempotent: create table/index if not exists, no alters, no drops.

create table if not exists pilot.athlete_check_ins (
  organization_id text not null references pilot.organizations(organization_id) on delete cascade,
  check_in_id     text not null,
  athlete_id      text not null,
  checked_in_on   date not null default current_date,
  energy          integer null check (energy is null or energy between 1 and 5),
  soreness        integer null check (soreness is null or soreness between 1 and 5),
  focus           integer null check (focus is null or focus between 1 and 5),
  note            text not null default '',
  created_at      timestamptz not null default now(),
  primary key (organization_id, check_in_id),
  constraint pilot_athlete_check_ins_athlete_fk
    foreign key (organization_id, athlete_id)
    references pilot.athletes(organization_id, athlete_id) on delete cascade
);

-- One check-in per athlete per day: arriving is a fact, not a counter.
create unique index if not exists idx_athlete_check_ins_one_per_day
  on pilot.athlete_check_ins(organization_id, athlete_id, checked_in_on);
