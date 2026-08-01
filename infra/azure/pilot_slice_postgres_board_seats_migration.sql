-- Board seats (pilot.board_seats) -- the eight governing-board seats as data.
--
-- The board has eight seats: President, Chair, Vice Chair, Treasurer,
-- Secretary, Program & Safety Director, Community & Development Director,
-- Director-at-Large. In the database they are one value: pilot.accounts.role
-- and pilot.organization_memberships.role each admit exactly 'board'.
-- Everything that separates one seat from another lives in
-- apps/web/app/board/boardWorkspaceConfig.ts as display copy, so the seat a
-- person holds is a URL slug and nothing more -- no query can answer "who is
-- the Treasurer of this gym", and nothing stops two people from both
-- presenting as President.
--
-- This table makes a seat a fact about the organization.
--
-- WHAT THIS TABLE DELIBERATELY DOES NOT HOLD: no athlete identifier, no
-- entity_id, no payload, no event reference. The board role is aggregate-only
-- -- a board member never sees athlete-scoped or individually identifiable
-- youth data -- and a governance table carrying an entity_id would be the
-- shortest path from a seat assignment to a youth record. Every column here
-- describes an adult board member's own appointment.
--
-- SEAT VOCABULARY: the eight slugs are the ones the /board/[seat] pages route
-- on, read from boardWorkspaceConfig.ts. A slug the app cannot render is an
-- assignment nobody can open, so the check refuses it rather than storing a
-- seat that leads nowhere.
--
-- ONE PRIMARY PER SEAT, ENFORCED BY THE DATABASE: a partial unique index over
-- (organization_id, seat) where is_primary. Co-chairs, a successor shadowing
-- an outgoing officer, and someone covering an absence are all legal -- they
-- are rows with is_primary = false, and a seat may carry any number of them.
-- What is never legal is two people holding one seat outright. Application
-- code cannot enforce that: two concurrent assignments each read no existing
-- primary and both write. Only the index holds under concurrency.
--
-- is_primary defaults to false. Naming the holder of a seat is a deliberate
-- act; an insert that says nothing about it joins the seat rather than
-- silently taking it from whoever holds it.
--
-- KEY (organization_id, seat, account_id): one person cannot hold the same
-- seat twice, and one person may hold more than one seat -- small boards
-- double up.
--
-- No foreign key to pilot.organization_memberships: onboarding has never
-- written a membership row for every account it creates, so requiring one
-- would refuse assignments for accounts that are otherwise entirely valid.
-- organization_id and account_id carry their own foreign keys instead, and
-- organization_id is part of the key, so every row is organization-scoped.
--
-- assigned_by_account_id records who made the appointment and clears rather
-- than blocks when that account is removed; the seat assignment outlives the
-- administrator who entered it.
--
-- No `begin;`/`commit;` here on purpose: the runner
-- (apps/web/scripts/pilot-apply-board-seats-migration.mjs) opens the
-- transaction itself, matching the announcements / volunteer-program /
-- compliance convention. The shadow-runtime runner takes the opposite one.

create table if not exists pilot.board_seats (
  organization_id text not null references pilot.organizations(organization_id) on delete cascade,
  seat text not null,
  account_id text not null references pilot.accounts(account_id) on delete cascade,
  is_primary boolean not null default false,
  assigned_by_account_id text null references pilot.accounts(account_id) on delete set null,
  assigned_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pilot_board_seats_pkey primary key (organization_id, seat, account_id)
);

-- PostgreSQL has no `add constraint if not exists`, so the vocabulary
-- constraint is catalog-guarded. Declaring it here rather than inline in the
-- create-table keeps exactly one copy of the eight slugs in this file and
-- reaches a table that was created before this migration existed.
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'pilot_board_seats_seat_check'
      and conrelid = 'pilot.board_seats'::regclass
  ) then
    alter table pilot.board_seats
      add constraint pilot_board_seats_seat_check
      check (seat in (
        'president',
        'chair',
        'vice-chair',
        'treasurer',
        'secretary',
        'safety-director',
        'community-director',
        'at-large'
      ));
  end if;
end
$$;

-- The rule the board depends on, in the only place that can hold it. Rows with
-- is_primary = false fall outside the predicate and are unconstrained.
create unique index if not exists pilot_board_seats_one_primary_per_seat
  on pilot.board_seats(organization_id, seat)
  where is_primary;

-- Landing a member on their own seat. The other read -- every holder of one
-- seat -- is served by the primary key's leading (organization_id, seat)
-- columns; this direction is covered by nothing else.
create index if not exists idx_pilot_board_seats_org_account
  on pilot.board_seats(organization_id, account_id, seat);
