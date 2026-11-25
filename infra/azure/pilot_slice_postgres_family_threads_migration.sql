-- A message a guardian starts to the coach about their own child, and the
-- replies under it (W4 item 4, scrub FAM-09; lane W4-4, PM-1a). Jason, OW27-24:
-- "A: A message box on the Parent Hub (Recommended)" (OD-2026-11-21-006).
--
-- WHAT THIS SOLVES. A guardian can answer a coach's note
-- (pilot.family_message_replies) but cannot start one. This is that place: a
-- thread a guardian opens about a child, which the gym's staff answer under.
--
-- TWO NEW TABLES, NOTHING EXISTING CHANGED. pilot.coach_observations is a
-- shared bus whose note_type filters are the safety mechanism, so it gains no
-- column and no note type, and the three family tables (replies, message
-- reads, reply reads) are not altered (Overwatch Q1 A on #2161).
--
-- pilot.family_thread_posts holds every post. The guardian's opening post has
-- thread_id = post_id and author_role 'parent'. Every other post points at an
-- opening post (never at another reply) and is either:
--   - a staff reply: coach, organization admin or admin, holding that role on
--     an active seat in this gym; or
--   - the SAME guardian writing again in their own thread (Overwatch Q2 A on
--     #2161, applying OW27-24 A and keeping OD-2026-10-12-024: no other
--     guardian writes in it).
-- A post's athlete is its thread's athlete: the thread reference carries
-- athlete_id, over a unique key that states the primary key's fact in a form a
-- foreign key can use.
--
-- pilot.family_thread_reads holds the first time a reader saw a post from the
-- other side: a staff member reading a guardian's post (the unread count,
-- OW27-27 A, is each staff member's own), and the guardian who opened the
-- thread reading a staff post in it. A guardian never reads here what another
-- guardian wrote or was written; staff never record reads of staff posts.
--
-- WHO MAY READ WHICH THREAD is the application's to enforce, as for the family
-- tables: the guardian link on every request (guardianAccess.ts, which also
-- ends it at 18 and on a deleted athlete), staff through
-- assertActorCanAccessAthlete. The database holds the shape: roles, the
-- thread's author, a guardian's link to THIS child through pilot.parents and
-- pilot.guardian_links, a staff member's seat in the gym, and a live account.
-- Each rule is checked against rows that already exist, so a post or a read
-- whose thread is not yet stored is refused rather than left to a foreign key
-- that would only look at the end of the statement.
--
-- APPEND-ONLY. A post is not edited; a correction is a new post (FC-02 Q3 A).
-- The one change allowed is author_account_id going to NULL when that account
-- is removed (the foreign key's own SET NULL, never a hand UPDATE): the post stays, detached from its author (D-9, 2026-08-29: "Keep
-- it, detached from the author"), and author_role still says who wrote it. A
-- read is never changed: the first time is the record (FC-04 Q-B A), and it
-- goes with the reader's account (FC-04 Q-D A).
--
-- NOT DELETED BY HAND. A DELETE issued directly is refused; one that arrives as
-- a cascade (the athlete, the gym, an opening post or an account going) runs
-- from inside another trigger, so pg_trigger_depth() is above 1 and it goes
-- through. A thread dies with its athlete.
--
-- EACH REFUSAL NAMES ITSELF: 23514 with its own constraint name.
--
-- AUDIT (Overwatch condition 4 on #2161), for the application to write: a
-- staff reply gets an audit row, as the staff "Post to Family" write does
-- (intake/domain-upsert, entity intake_coach_note), with shadow_mirror false
-- and entity type family_thread_reply, which joins no audit read allow-list
-- (FAMILY_ALLOWED_AUDIT_ENTITY_TYPES stays empty). A guardian's post gets
-- none, as a guardian's reply gets none (parent/message-replies). Reads get
-- none, as the family read tables get none. Nothing here is mirrored to the
-- SHADOW feed.
--
-- DEPENDS ON pilot.organizations, pilot.accounts, pilot.athletes and
-- pilot.organization_memberships. Idempotent: if-not-exists throughout, the
-- trigger functions are create-or-replace, and the triggers are dropped-and-
-- created by name. No drops of any table or data, no backfill. No
-- begin;/commit; here on purpose, matching this repo's runner-opens-the-
-- transaction convention (the runner is
-- apps/web/scripts/pilot-apply-family-threads-migration.mjs).

create table if not exists pilot.family_thread_posts (
  organization_id text not null references pilot.organizations(organization_id) on delete cascade,
  post_id uuid not null,
  thread_id uuid not null,
  athlete_id text not null,

  author_account_id text null references pilot.accounts(account_id) on delete set null,
  author_role text not null,

  post_text text not null,
  created_at timestamptz not null default now(),

  constraint pilot_family_thread_posts_pkey primary key (organization_id, post_id),
  constraint pilot_family_thread_posts_post_athlete_key unique (organization_id, post_id, athlete_id),

  constraint pilot_family_thread_posts_athlete_fk
    foreign key (organization_id, athlete_id)
    references pilot.athletes(organization_id, athlete_id) on delete cascade,

  -- Under its opening post, about the same athlete; dies with it.
  constraint pilot_family_thread_posts_thread_fk
    foreign key (organization_id, thread_id, athlete_id)
    references pilot.family_thread_posts(organization_id, post_id, athlete_id) on delete cascade,

  constraint pilot_family_thread_posts_role_check
    check (author_role in ('parent', 'coach', 'organization_admin', 'admin')),

  -- Only a guardian opens a thread.
  constraint pilot_family_thread_posts_opening_check
    check (post_id <> thread_id or author_role = 'parent'),

  constraint pilot_family_thread_posts_text_check
    check (post_text ~ '[^[:space:]]' and length(post_text) <= 2000)
);

-- A thread's posts, oldest first; one athlete's threads; one author's own
-- (account first, so an account's removal finds its posts).
create index if not exists idx_family_thread_posts_thread
  on pilot.family_thread_posts(organization_id, thread_id, created_at);
create index if not exists idx_family_thread_posts_athlete
  on pilot.family_thread_posts(organization_id, athlete_id, created_at);
create index if not exists idx_family_thread_posts_author
  on pilot.family_thread_posts(author_account_id, organization_id);

create or replace function pilot.family_thread_posts_guard()
returns trigger
language plpgsql
as $family_thread_posts_guard$
declare
  opening record;
begin
  if tg_op = 'DELETE' then
    if pg_trigger_depth() = 1 then
      raise exception 'FAMILY_THREAD_POST_IS_NOT_DELETED'
        using errcode = '23514', constraint = 'pilot_family_thread_posts_no_delete';
    end if;
    return old;
  end if;

  if tg_op = 'INSERT' then
    -- Missing keys are left to NOT NULL, and a role outside the list to the
    -- role check, so each is reported by its own name.
    if new.organization_id is null or new.post_id is null or new.thread_id is null
       or new.athlete_id is null or new.author_role is null
       or new.author_role not in ('parent', 'coach', 'organization_admin', 'admin') then
      return new;
    end if;
    -- Every post is written by someone. Only the account's removal, later,
    -- may take the author away (D-9).
    if new.author_account_id is null then
      raise exception 'FAMILY_THREAD_POST_NEEDS_AN_AUTHOR'
        using errcode = '23514', constraint = 'pilot_family_thread_posts_author_required';
    end if;

    if new.author_role = 'parent' then
      -- A guardian of THIS child in this gym, on a live account (the same
      -- join as guardianAccess.ts; the 18 rule is the application's).
      if not exists (
        select 1 from pilot.parents p
          join pilot.guardian_links gl
            on gl.organization_id = p.organization_id and gl.parent_id = p.parent_id
          join pilot.accounts a on a.account_id = p.account_id
         where p.organization_id = new.organization_id and p.account_id = new.author_account_id
           and gl.athlete_id = new.athlete_id
           and a.active_flag and a.deleted_at is null
      ) then
        raise exception 'FAMILY_THREAD_POST_GUARDIAN_OF_THIS_CHILD'
          using errcode = '23514', constraint = 'pilot_family_thread_posts_guardian_of_child';
      end if;
    elsif not exists (
      select 1 from pilot.organization_memberships om
        join pilot.accounts a on a.account_id = om.account_id
       where om.account_id = new.author_account_id and om.organization_id = new.organization_id
         and om.active_flag and om.role = new.author_role
         and a.active_flag and a.deleted_at is null
    ) then
      raise exception 'FAMILY_THREAD_POST_STAFF_OF_THIS_GYM'
        using errcode = '23514', constraint = 'pilot_family_thread_posts_staff_of_this_gym';
    end if;

    -- An opening post: the opening check has already said it is a guardian's.
    if new.post_id = new.thread_id then
      return new;
    end if;

    -- The thread, about this child, already stored. Not left to the thread
    -- foreign key: that looks only at the end of the statement, after this
    -- guard has passed rows the rules below were never applied to.
    select p.thread_id, p.author_account_id
      into opening
      from pilot.family_thread_posts p
     where p.organization_id = new.organization_id and p.post_id = new.thread_id
       and p.athlete_id = new.athlete_id;
    if not found then
      raise exception 'FAMILY_THREAD_POST_THREAD_NOT_FOUND'
        using errcode = '23503', constraint = 'pilot_family_thread_posts_thread_fk';
    end if;
    if opening.thread_id <> new.thread_id then
      raise exception 'FAMILY_THREAD_POST_UNDER_AN_OPENING_POST'
        using errcode = '23514', constraint = 'pilot_family_thread_posts_under_opening';
    end if;
    -- A guardian writes again only in the thread they opened (Q2 A). A thread
    -- whose opener's account has gone takes no more guardian posts.
    if new.author_role = 'parent'
       and (opening.author_account_id is null or opening.author_account_id <> new.author_account_id) then
      raise exception 'FAMILY_THREAD_POST_GUARDIAN_OWN_THREAD_ONLY'
        using errcode = '23514', constraint = 'pilot_family_thread_posts_own_thread';
    end if;
    return new;
  end if;

  -- UPDATE: only the author's removal.
  if new.organization_id is distinct from old.organization_id
     or new.post_id is distinct from old.post_id
     or new.thread_id is distinct from old.thread_id
     or new.athlete_id is distinct from old.athlete_id
     or new.author_role is distinct from old.author_role
     or new.post_text is distinct from old.post_text
     or new.created_at is distinct from old.created_at
     or (new.author_account_id is distinct from old.author_account_id
         and (new.author_account_id is not null or pg_trigger_depth() = 1))
  then
    raise exception 'FAMILY_THREAD_POST_IS_APPEND_ONLY'
      using errcode = '23514', constraint = 'pilot_family_thread_posts_append_only';
  end if;
  return new;
end;
$family_thread_posts_guard$;

drop trigger if exists trg_family_thread_posts_guard on pilot.family_thread_posts;
create trigger trg_family_thread_posts_guard
  before insert or update or delete on pilot.family_thread_posts
  for each row execute function pilot.family_thread_posts_guard();

create table if not exists pilot.family_thread_reads (
  organization_id text not null references pilot.organizations(organization_id) on delete cascade,
  post_id uuid not null,

  reader_account_id text not null references pilot.accounts(account_id) on delete cascade,
  reader_role text not null,

  first_read_at timestamptz not null default now(),

  -- One read per post per reader: a second look is the same row.
  constraint pilot_family_thread_reads_pkey primary key (organization_id, post_id, reader_account_id),

  -- Dies with its post; the post already dies with its thread and athlete.
  constraint pilot_family_thread_reads_post_fk
    foreign key (organization_id, post_id)
    references pilot.family_thread_posts(organization_id, post_id) on delete cascade,

  constraint pilot_family_thread_reads_role_check
    check (reader_role in ('parent', 'coach', 'organization_admin', 'admin'))
);

-- A reader's own reads (account first, so an account's removal finds them).
create index if not exists idx_family_thread_reads_reader
  on pilot.family_thread_reads(reader_account_id, organization_id);

create or replace function pilot.family_thread_reads_guard()
returns trigger
language plpgsql
as $family_thread_reads_guard$
declare
  post record;
begin
  if tg_op = 'DELETE' then
    if pg_trigger_depth() = 1 then
      raise exception 'FAMILY_THREAD_READ_IS_NOT_DELETED'
        using errcode = '23514', constraint = 'pilot_family_thread_reads_no_delete';
    end if;
    return old;
  end if;

  if tg_op = 'INSERT' then
    if new.organization_id is null or new.post_id is null or new.reader_account_id is null
       or new.reader_role is null
       or new.reader_role not in ('parent', 'coach', 'organization_admin', 'admin') then
      return new;
    end if;

    select p.author_role, p.athlete_id, o.author_account_id as opener_account_id
      into post
      from pilot.family_thread_posts p
      join pilot.family_thread_posts o
        on o.organization_id = p.organization_id and o.post_id = p.thread_id
     where p.organization_id = new.organization_id and p.post_id = new.post_id;
    -- The post already stored; not left to the foreign key (see the posts guard).
    if not found then
      raise exception 'FAMILY_THREAD_READ_POST_NOT_FOUND'
        using errcode = '23503', constraint = 'pilot_family_thread_reads_post_fk';
    end if;

    if new.reader_role = 'parent' then
      -- The guardian who opened the thread, reading what staff wrote in it,
      -- while still a guardian of the child on a live account.
      if post.author_role = 'parent' or post.opener_account_id is distinct from new.reader_account_id then
        raise exception 'FAMILY_THREAD_READ_GUARDIAN_READS_STAFF_IN_OWN_THREAD'
          using errcode = '23514', constraint = 'pilot_family_thread_reads_guardian_own_thread';
      end if;
      if not exists (
        select 1 from pilot.parents pa
          join pilot.guardian_links gl
            on gl.organization_id = pa.organization_id and gl.parent_id = pa.parent_id
          join pilot.accounts a on a.account_id = pa.account_id
         where pa.organization_id = new.organization_id and pa.account_id = new.reader_account_id
           and gl.athlete_id = post.athlete_id
           and a.active_flag and a.deleted_at is null
      ) then
        raise exception 'FAMILY_THREAD_READ_GUARDIAN_OF_THIS_CHILD'
          using errcode = '23514', constraint = 'pilot_family_thread_reads_guardian_of_child';
      end if;
      return new;
    end if;

    -- Staff, reading what a guardian wrote, through an active seat here.
    if post.author_role <> 'parent' then
      raise exception 'FAMILY_THREAD_READ_STAFF_READS_GUARDIAN_POSTS'
        using errcode = '23514', constraint = 'pilot_family_thread_reads_staff_reads_guardian';
    end if;
    if not exists (
      select 1 from pilot.organization_memberships om
        join pilot.accounts a on a.account_id = om.account_id
       where om.account_id = new.reader_account_id and om.organization_id = new.organization_id
         and om.active_flag and om.role = new.reader_role
         and a.active_flag and a.deleted_at is null
    ) then
      raise exception 'FAMILY_THREAD_READER_OF_THIS_GYM'
        using errcode = '23514', constraint = 'pilot_family_thread_reads_reader_of_this_gym';
    end if;
    return new;
  end if;

  -- UPDATE: never. The first read is the record.
  raise exception 'FAMILY_THREAD_READ_IS_NOT_CHANGED'
    using errcode = '23514', constraint = 'pilot_family_thread_reads_first_read_kept';
end;
$family_thread_reads_guard$;

drop trigger if exists trg_family_thread_reads_guard on pilot.family_thread_reads;
create trigger trg_family_thread_reads_guard
  before insert or update or delete on pilot.family_thread_reads
  for each row execute function pilot.family_thread_reads_guard();
