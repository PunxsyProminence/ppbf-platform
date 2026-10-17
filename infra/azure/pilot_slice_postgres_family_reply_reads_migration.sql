-- When a staff member first saw a guardian's reply (FC-09; the storage half of
-- "coach-side unread for replies", issue #1542's track, lane L29).
--
-- WHAT THIS SOLVES. A guardian replies under a coach's family note
-- (pilot.family_message_replies, FC-02/FC-03) and the coach reads the replies
-- under the note on /coach/decision-loop. Nothing records which replies a
-- coach has already seen, so a new reply looks the same as one read a week
-- ago. This is that record: one row per reply per staff account, written the
-- first time that staff member has the reply on screen.
--
-- PER STAFF ACCOUNT, NOT PER GYM. Every coach of the gym reads these replies
-- (whole-gym coach reach, OD-2026-10-11-007), and "new to me" is each coach's
-- own state: one coach seeing a reply does not make it seen for the others.
-- (Overwatch to L29, 2026-10-17: "Build coach-side unread for replies".)
--
-- WHAT COUNTS AS SEEN is the application's to decide and write. Loading the
-- panel is not a read of everything in it, and nothing here infers one.
--
-- THE FIRST READ IS KEPT. The application writes with ON CONFLICT DO NOTHING,
-- and the guard below refuses any UPDATE, so the first time is what stays.
--
-- THE READ'S REPLY IS A REAL REPLY OF THIS GYM: the reference is
-- (organization_id, reply_id) over the replies table's primary key, so a read
-- cannot name another gym's reply.
--
-- ONLY STAFF OF THIS GYM READ HERE. The role check admits coach,
-- organization_admin and admin, the roles that read replies today
-- (coach/family-message-replies/route.ts). The guard also requires the reader
-- to hold that role in the reply's gym through an ACTIVE organization
-- membership, on an account that is active and not deleted -- the seat
-- sign-in grants authority from (auth.ts, "THE ROLE COMES FROM THE
-- MEMBERSHIP") -- the same rule the family-goals, parent-resources and
-- family-support-records migrations use for their writers. A guardian's own reads of coach
-- messages are pilot.family_message_reads; nothing here is about guardians.
--
-- WHO SEES IT is the application's to enforce: a staff member reads only
-- their own receipts (their own new/seen state). Nothing here is served to a
-- family, and no family-facing read joins this table.
--
-- EACH REFUSAL NAMES ITSELF (23514 with its own constraint name), and NOT
-- DELETED BY HAND: a direct DELETE is refused; one that arrives as a cascade
-- (its reply, note, athlete, gym or reader account going) runs from inside
-- another trigger, so pg_trigger_depth() is above 1 and it goes through. A
-- receipt is about the reader, so it goes with the reader's account.
--
-- DEPENDS ON pilot.organizations, pilot.accounts,
-- pilot.organization_memberships and pilot.family_message_replies.
-- Idempotent: if-not-exists throughout, the trigger function is create-or-
-- replace, and the trigger is dropped-and-created by name. No drops of any
-- table or data, no backfill. No begin;/commit; here on purpose, matching this
-- repo's runner-opens-the-transaction convention (the runner is
-- apps/web/scripts/pilot-apply-family-reply-reads-migration.mjs).

create table if not exists pilot.family_reply_reads (
  organization_id text not null references pilot.organizations(organization_id) on delete cascade,
  reply_id uuid not null,

  reader_account_id text not null references pilot.accounts(account_id) on delete cascade,
  reader_role text not null,

  first_read_at timestamptz not null default now(),

  -- One read per reply per staff account: a second look is the same row.
  constraint pilot_family_reply_reads_pkey primary key (organization_id, reply_id, reader_account_id),

  -- Dies with its reply; the reply already dies with its note and athlete.
  constraint pilot_family_reply_reads_reply_fk
    foreign key (organization_id, reply_id)
    references pilot.family_message_replies(organization_id, reply_id) on delete cascade,

  constraint pilot_family_reply_reads_role_check
    check (reader_role in ('coach', 'organization_admin', 'admin'))
);

-- A staff member's own reads in their gym.
create index if not exists idx_family_reply_reads_reader
  on pilot.family_reply_reads(organization_id, reader_account_id);

create or replace function pilot.family_reply_reads_guard()
returns trigger
language plpgsql
as $family_reply_reads_guard$
begin
  if tg_op = 'DELETE' then
    if pg_trigger_depth() = 1 then
      raise exception 'FAMILY_REPLY_READ_IS_NOT_DELETED'
        using errcode = '23514', constraint = 'pilot_family_reply_reads_no_delete';
    end if;
    return old;
  end if;

  if tg_op = 'INSERT' then
    -- Missing keys are left to NOT NULL, and a role outside the list to the
    -- role check, so each is reported by its own name.
    if new.organization_id is null or new.reader_account_id is null
       or new.reader_role is null
       or new.reader_role not in ('coach', 'organization_admin', 'admin') then
      return new;
    end if;
    if not exists (
      select 1 from pilot.organization_memberships om
        join pilot.accounts a on a.account_id = om.account_id
       where om.account_id = new.reader_account_id and om.organization_id = new.organization_id
         and om.active_flag and om.role = new.reader_role
         and a.active_flag and a.deleted_at is null
    ) then
      raise exception 'FAMILY_REPLY_READER_OF_THIS_GYM'
        using errcode = '23514', constraint = 'pilot_family_reply_reads_reader_of_this_gym';
    end if;
    return new;
  end if;

  -- UPDATE: never. The first read is the record.
  raise exception 'FAMILY_REPLY_READ_IS_NOT_CHANGED'
    using errcode = '23514', constraint = 'pilot_family_reply_reads_first_read_kept';
end;
$family_reply_reads_guard$;

drop trigger if exists trg_family_reply_reads_guard on pilot.family_reply_reads;
create trigger trg_family_reply_reads_guard
  before insert or update or delete on pilot.family_reply_reads
  for each row execute function pilot.family_reply_reads_guard();
