-- A guardian's reply to a coach's note on the family page (FC-02; the
-- storage half of FC-03, issue #1542's track).
--
-- WHAT THIS SOLVES. A coach posts to a family through pilot.coach_observations
-- (note_type 'parent_message'), and the family can mark it done
-- (pilot.parent_task_state). There is nowhere for the family to answer:
-- parent/messages/route.ts takes completion only. This is that place.
--
-- A COMPANION TABLE, KEYED TO THE NOTE, for the reason the parent-task-state
-- migration gives: pilot.coach_observations is a shared bus whose note_type
-- filters are the safety mechanism, and a reply is not a coach observation. The
-- bus gains no column and no note type.
--
-- THE REPLY'S ATHLETE IS THE NOTE'S ATHLETE, and the database holds that, not
-- only the application. The note reference is (organization_id, note_id,
-- athlete_id), which needs a unique index over those three columns of
-- pilot.coach_observations. note_id is already unique within an organization
-- (its primary key), so the index states an existing fact in a form a foreign
-- key can use; it adds no column and changes no reader.
--
-- ONLY A PARENT MESSAGE TAKES A REPLY. A foreign key cannot see note_type, so a
-- trigger refuses a reply to anything else -- a coach observation or a
-- guardian's own barrier report is not a conversation with the family.
--
-- EACH REFUSAL NAMES ITSELF. The guard raises 23514 like a check constraint,
-- with its own constraint name (..._author_required, ..._parent_message,
-- ..._append_only), so a caller can tell it from the text check's
-- "blank or too long" by name rather than by code alone.
--
-- AND NOT DELETED BY HAND. A DELETE issued directly against this table is
-- refused; one that arrives as a cascade (its note, athlete or gym going) is a
-- referential action run from inside another trigger, so pg_trigger_depth() is
-- above 1 and it goes through. Nothing here is hard-deleted except with what
-- it hangs off.
--
-- APPEND-ONLY. A reply is not edited; a correction is a new reply (FC-02 Q3
-- default A). The trigger refuses any UPDATE that changes what was said, about
-- what, by which role, or when. The one change it lets through is
-- author_account_id going to NULL, which is the purge below.
--
-- WHEN THE GUARDIAN'S ACCOUNT IS PURGED: the reply stays, detached from its
-- author (FC-02 Q2 default A). That is the rule the owner set for
-- guardian-authored text about a child (D-9, 2026-08-29: "Keep it, detached
-- from the author"; pilot_slice_postgres_parent_authored_purge_migration.sql),
-- and author_role keeps saying a guardian wrote it. So author_account_id is
-- nullable with ON DELETE SET NULL; nothing in the application writes NULL.
--
-- WHO READS IT is the application's to enforce (FC-03): a guardian sees only
-- their own replies (Jason, 2026-10-12: with two guardians each sees only
-- their own), and staff of the athlete's gym see them under the note.
--
-- DEPENDS ON pilot.organizations, pilot.accounts, pilot.coach_observations.
-- Idempotent: if-not-exists throughout, the trigger function is create-or-
-- replace, and the trigger is dropped-and-created by name. No drops of any
-- table or data, no backfill. No begin;/commit; here on purpose, matching this
-- repo's runner-opens-the-transaction convention (the runner is
-- apps/web/scripts/pilot-apply-family-message-replies-migration.mjs).

create unique index if not exists uq_pilot_coach_observations_org_note_athlete
  on pilot.coach_observations(organization_id, note_id, athlete_id);

create table if not exists pilot.family_message_replies (
  organization_id text not null references pilot.organizations(organization_id) on delete cascade,
  reply_id uuid not null,
  note_id uuid not null,
  athlete_id text not null,

  author_account_id text null references pilot.accounts(account_id) on delete set null,
  -- FC-03 is guardian replies only. A later slice that lets staff reply widens
  -- this check in its own migration, rather than this one guessing at it.
  author_role text not null,

  reply_text text not null,
  created_at timestamptz not null default now(),

  constraint pilot_family_message_replies_pkey primary key (organization_id, reply_id),

  -- Dies with its note; the note already dies with its athlete.
  constraint pilot_family_message_replies_note_fk
    foreign key (organization_id, note_id, athlete_id)
    references pilot.coach_observations(organization_id, note_id, athlete_id) on delete cascade,

  constraint pilot_family_message_replies_role_check check (author_role = 'parent'),

  constraint pilot_family_message_replies_text_check
    check (length(btrim(reply_text)) > 0 and length(reply_text) <= 2000)
);

-- The replies under one note, oldest first, which is how a thread reads.
create index if not exists idx_family_message_replies_note
  on pilot.family_message_replies(organization_id, note_id, created_at);

create or replace function pilot.family_message_replies_guard()
returns trigger
language plpgsql
as $family_message_replies_guard$
begin
  if tg_op = 'DELETE' then
    if pg_trigger_depth() = 1 then
      raise exception 'FAMILY_MESSAGE_REPLY_IS_NOT_DELETED'
        using errcode = '23514', constraint = 'pilot_family_message_replies_no_delete';
    end if;
    return old;
  end if;

  if tg_op = 'INSERT' then
    -- Missing keys are left to NOT NULL, so they are not reported as a wrong note.
    if new.organization_id is null or new.note_id is null then
      return new;
    end if;
    -- Every reply is written by someone. Only the purge, later, may take the
    -- author away (D-9); a reply born without one would be unattributable.
    if new.author_account_id is null then
      raise exception 'FAMILY_MESSAGE_REPLY_NEEDS_AN_AUTHOR'
        using errcode = '23514', constraint = 'pilot_family_message_replies_author_required';
    end if;
    if not exists (
      select 1 from pilot.coach_observations co
       where co.organization_id = new.organization_id
         and co.note_id = new.note_id
         and co.note_type = 'parent_message'
    ) then
      raise exception 'FAMILY_MESSAGE_REPLY_NOT_TO_A_PARENT_MESSAGE'
        using errcode = '23514', constraint = 'pilot_family_message_replies_parent_message';
    end if;
    return new;
  end if;

  -- UPDATE: only the purge's author null-out.
  if new.organization_id is distinct from old.organization_id
     or new.reply_id is distinct from old.reply_id
     or new.note_id is distinct from old.note_id
     or new.athlete_id is distinct from old.athlete_id
     or new.author_role is distinct from old.author_role
     or new.reply_text is distinct from old.reply_text
     or new.created_at is distinct from old.created_at
     or (new.author_account_id is distinct from old.author_account_id and new.author_account_id is not null)
  then
    raise exception 'FAMILY_MESSAGE_REPLY_IS_APPEND_ONLY'
      using errcode = '23514', constraint = 'pilot_family_message_replies_append_only';
  end if;
  return new;
end;
$family_message_replies_guard$;

drop trigger if exists trg_family_message_replies_guard on pilot.family_message_replies;
create trigger trg_family_message_replies_guard
  before insert or update or delete on pilot.family_message_replies
  for each row execute function pilot.family_message_replies_guard();
