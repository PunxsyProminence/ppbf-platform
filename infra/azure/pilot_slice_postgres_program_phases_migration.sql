-- Program phases (register module 129): what block a program is in right
-- now, declared by a human -- "foundation until October, competition prep
-- after". A phase is a STATED INTENT for a program, never a computed
-- state and never a judgment about any athlete.
--
-- ONE CURRENT PHASE PER PROGRAM: a program cannot be in two blocks at
-- once (partial unique index on the open phase). Starting a new phase
-- ends the previous one -- history is kept, never overwritten, so a
-- session recorded in March still reads as having happened during the
-- phase that was open in March.
--
-- Phases carry no athlete ids: this is program-level context, and nothing
-- here changes what any individual athlete is doing or allowed to do.
--
-- Idempotent: create table/index if not exists, no alters, no drops.

create table if not exists pilot.program_phases (
  organization_id       text not null references pilot.organizations(organization_id) on delete cascade,
  phase_id              text not null,
  program_name          text not null check (length(btrim(program_name)) > 0),
  phase_name            text not null check (length(btrim(phase_name)) > 0),
  focus                 text not null default '',
  started_on            date not null,
  ended_on              date null,
  notes                 text not null default '',
  created_by_account_id text not null references pilot.accounts(account_id),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  primary key (organization_id, phase_id),
  -- A phase cannot end before it began.
  constraint pilot_program_phases_interval_check
    check (ended_on is null or ended_on >= started_on)
);

-- The open phase is the current one, and there is at most one per program.
create unique index if not exists idx_program_phases_one_open
  on pilot.program_phases(organization_id, program_name)
  where ended_on is null;

create index if not exists idx_program_phases_history
  on pilot.program_phases(organization_id, program_name, started_on desc);
