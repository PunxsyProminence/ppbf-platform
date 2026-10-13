-- When a guardian first opened a coach's message on the family page (FC-04;
-- the storage half of FC-05, issue #1542's track).
--
-- WHAT THIS SOLVES. A coach posts to a family through pilot.coach_observations
-- (note_type 'parent_message') and can see whether the family ticked a task
-- done (pilot.parent_task_state) and what they replied
-- (pilot.family_message_replies). Nothing records whether the message was
-- opened at all. This is that record: one row per message per guardian
-- account, written the first time that guardian opens that message.
--
-- WHAT COUNTS AS READ is the application's to decide and write (FC-04 Q-A
-- default A: the guardian opens or expands that specific message). Loading the
-- inbox is not a read of everything in it, and nothing here infers one.
--
-- THE FIRST READ IS KEPT. A second open does not move first_read_at (FC-04 Q-B
-- default A): the application writes with ON CONFLICT DO NOTHING, and the guard
-- below refuses any UPDATE, so the first time is what stays.
--
-- A COMPANION TABLE, KEYED TO THE NOTE, for the reason the parent-task-state
-- and family-message-replies migrations give: pilot.coach_observations is a
-- shared bus whose note_type filters are the safety mechanism, and a read is
-- not a coach observation. The bus gains no column and no note type.
--
-- THE READ'S ATHLETE IS THE NOTE'S ATHLETE, held by the database: the note
-- reference is (organization_id, note_id, athlete_id) over the unique index
-- the family-message-replies migration created (repeated here with if-not-
-- exists, so this file stands on its own).
--
-- ONLY A PARENT MESSAGE IS READ HERE, and only by a guardian. A foreign key
-- cannot see note_type, so the guard refuses a read of anything else; the role
-- check refuses any reader role but 'parent'. Whether that guardian may read
-- that message (linked to the athlete, in this gym) is the application's
-- (FC-05), as it is for replies.
--
-- WHO SEES WHO READ IT is the application's to enforce (FC-04 Q-C default A):
-- staff see an aggregate "read by family" with the first time, never which
-- guardian or another guardian's activity. The row holds the reader so a
-- guardian's own read can be known, and so two guardians are two reads.
--
-- EACH REFUSAL NAMES ITSELF (23514 with its own constraint name), and NOT
-- DELETED BY HAND: a direct DELETE is refused; one that arrives as a cascade
-- (its note, athlete, gym or reader account going) runs from inside another
-- trigger, so pg_trigger_depth() is above 1 and it goes through. A read
-- receipt is about the reader, so when the guardian's account is removed the
-- receipt goes with it (FC-04 Q-D default A), unlike a reply, whose text about
-- the child stays detached (D-9).
--
-- DEPENDS ON pilot.organizations, pilot.accounts, pilot.coach_observations,
-- and the unique index the family-message-replies migration creates.
-- Idempotent: if-not-exists throughout, the trigger function is create-or-
-- replace, and the trigger is dropped-and-created by name. No drops of any
-- table or data, no backfill. No begin;/commit; here on purpose, matching this
-- repo's runner-opens-the-transaction convention (the runner is
-- apps/web/scripts/pilot-apply-family-message-reads-migration.mjs).

create unique index if not exists uq_pilot_coach_observations_org_note_athlete
  on pilot.coach_observations(organization_id, note_id, athlete_id);

create table if not exists pilot.family_message_reads (
  organization_id text not null references pilot.organizations(organization_id) on delete cascade,
  note_id uuid not null,
  athlete_id text not null,

  reader_account_id text not null references pilot.accounts(account_id) on delete cascade,
  -- Parent messages are read by guardians. A later slice that addresses
  -- athletes (FC-06) widens this in its own migration rather than this one
  -- guessing at it.
  reader_role text not null,

  first_read_at timestamptz not null default now(),

  -- One read per message per guardian: a second open is the same row.
  constraint pilot_family_message_reads_pkey primary key (organization_id, note_id, reader_account_id),

  -- Dies with its note; the note already dies with its athlete.
  constraint pilot_family_message_reads_note_fk
    foreign key (organization_id, note_id, athlete_id)
    references pilot.coach_observations(organization_id, note_id, athlete_id) on delete cascade,

  constraint pilot_family_message_reads_role_check check (reader_role = 'parent')
);

-- A guardian's own reads across their messages.
create index if not exists idx_family_message_reads_reader
  on pilot.family_message_reads(organization_id, reader_account_id);

create or replace function pilot.family_message_reads_guard()
returns trigger
language plpgsql
as $family_message_reads_guard$
begin
  if tg_op = 'DELETE' then
    if pg_trigger_depth() = 1 then
      raise exception 'FAMILY_MESSAGE_READ_IS_NOT_DELETED'
        using errcode = '23514', constraint = 'pilot_family_message_reads_no_delete';
    end if;
    return old;
  end if;

  if tg_op = 'INSERT' then
    -- Missing keys are left to NOT NULL, so they are not reported as a wrong note.
    if new.organization_id is null or new.note_id is null then
      return new;
    end if;
    if not exists (
      select 1 from pilot.coach_observations co
       where co.organization_id = new.organization_id
         and co.note_id = new.note_id
         and co.note_type = 'parent_message'
    ) then
      raise exception 'FAMILY_MESSAGE_READ_NOT_OF_A_PARENT_MESSAGE'
        using errcode = '23514', constraint = 'pilot_family_message_reads_parent_message';
    end if;
    return new;
  end if;

  -- UPDATE: never. The first read is the record (Q-B A).
  raise exception 'FAMILY_MESSAGE_READ_IS_NOT_CHANGED'
    using errcode = '23514', constraint = 'pilot_family_message_reads_first_read_kept';
end;
$family_message_reads_guard$;

drop trigger if exists trg_family_message_reads_guard on pilot.family_message_reads;
create trigger trg_family_message_reads_guard
  before insert or update or delete on pilot.family_message_reads
  for each row execute function pilot.family_message_reads_guard();
