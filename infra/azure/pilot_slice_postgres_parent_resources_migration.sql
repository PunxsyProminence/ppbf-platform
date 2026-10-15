-- Parent resources: a gym's curated list of guides, checklists, videos and
-- policies for families (PH-10, issue #1593; the storage half of PH-11).
--
-- WHY A NEW TABLE (PH-10 Q2 B, after the inventory on #1542): no existing
-- record can carry it. pilot.video_publications and research_library are one
-- athlete's video each, with a consent-retraction meaning; pilot.announcements
-- is a notice feed with no title, type, link or program; drills, templates
-- and help content are things a resource can point at, not a catalog.
--
-- IT POINTS, IT DOES NOT COPY. A resource names where it lives: an app path
-- ('internal', starting with a single '/') or an https address ('external').
-- The guide, drill or video itself stays where it is.
--
-- EVERY FAMILY, OR ONE PROGRAM. program_id null means every family of the
-- gym; otherwise the resource is for families of that program
-- (pilot.programs). The program reference is ON DELETE NO ACTION: deleting a
-- program that still has resources is refused, so a resource meant for one
-- group never silently becomes a resource for everyone (PH-10 Q-A default A).
-- NO ACTION rather than RESTRICT because it is checked at the end of the
-- statement: a gym being removed takes its programs and its resources in one
-- cascade, and that goes through. Programs are archived, not deleted, in this
-- app.
--
-- PUBLISHED OR NOT. state is 'draft', 'published' or 'archived';
-- published_at is when it was first published and is kept after that. A
-- draft has none; a published resource has one; an archived one has one only
-- if it was ever published (a draft can be archived without being published).
-- Who reads what is PH-11's (published only, by the child's program).
--
-- WHO PUBLISHES: coaches and organization admins (PH-10 Q1 default A). A
-- resource is born with its author named (the column is nullable only for
-- the account-removal set null); the writer is kept and never changes by hand; a change by hand must carry an
-- editor (the application sets it to whoever makes that change). When the
-- writer's account is removed the resource stays with no writer (set null).
--
-- NOTHING IS HARD-DELETED. A direct DELETE is refused; one that arrives as a
-- cascade (the gym going) runs from inside another trigger, so
-- pg_trigger_depth() is above 1 and it goes through. Each refusal is a 23514
-- with its own constraint name.
--
-- DEPENDS ON pilot.organizations, pilot.accounts, pilot.programs.
-- Idempotent: if-not-exists throughout, the trigger function is create-or-
-- replace, and the trigger is dropped-and-created by name. No drops of any
-- table or data, no backfill. No begin;/commit; here on purpose, matching this
-- repo's runner-opens-the-transaction convention (the runner is
-- apps/web/scripts/pilot-apply-parent-resources-migration.mjs).

create table if not exists pilot.parent_resources (
  organization_id text not null references pilot.organizations(organization_id) on delete cascade,
  resource_id uuid not null default gen_random_uuid(),

  title text not null,
  summary text not null,
  resource_type text not null,

  destination_kind text not null,
  destination text not null,

  -- Null: every family of the gym.
  program_id text,

  state text not null default 'draft',
  published_at timestamptz,

  created_by_account_id text references pilot.accounts(account_id) on delete set null,
  created_by_role text not null,
  updated_by_account_id text references pilot.accounts(account_id) on delete set null,
  updated_by_role text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint pilot_parent_resources_pkey primary key (organization_id, resource_id),

  constraint pilot_parent_resources_program_fk
    foreign key (organization_id, program_id)
    references pilot.programs(organization_id, program_id) on delete no action,

  constraint pilot_parent_resources_title_check
    check (char_length(btrim(title)) between 1 and 200),
  constraint pilot_parent_resources_summary_check
    check (char_length(btrim(summary)) between 1 and 1000),
  constraint pilot_parent_resources_type_check
    check (resource_type in ('guide', 'checklist', 'video', 'policy')),
  -- An app path ('/x', never '//host'), or an https address with a host.
  -- No whitespace and no backslash anywhere: browsers read '\' as '/' in a
  -- link, so '/\evil.example' would leave the app. No '@' before the host:
  -- 'https://usaboxing.org@evil.example' goes to evil.example.
  constraint pilot_parent_resources_destination_check
    check (
      char_length(destination) <= 2000
      and destination !~ '[\s\\]'
      and (
        (destination_kind = 'internal' and destination ~ '^/[^/]')
        or (destination_kind = 'external' and destination ~ '^https://[^/@?#]+(/|$)' and destination !~ '^https://[^/]*@')
      )
    ),
  constraint pilot_parent_resources_state_check
    check (state in ('draft', 'published', 'archived')),
  -- First published at a recorded time; a draft has never been published.
  constraint pilot_parent_resources_published_check
    check (
      (state <> 'draft' or published_at is null)
      and (state <> 'published' or published_at is not null)
    ),
  constraint pilot_parent_resources_created_by_role_check
    check (created_by_role in ('coach', 'organization_admin', 'admin')),
  constraint pilot_parent_resources_updated_by_role_check
    check (updated_by_role is null or updated_by_role in ('coach', 'organization_admin', 'admin'))
);

-- A gym's published list, optionally by program.
create index if not exists idx_parent_resources_catalog
  on pilot.parent_resources(organization_id, state, program_id);

create or replace function pilot.parent_resources_guard()
returns trigger
language plpgsql
as $parent_resources_guard$
begin
  if tg_op = 'DELETE' then
    if pg_trigger_depth() = 1 then
      raise exception 'PARENT_RESOURCE_IS_NOT_DELETED'
        using errcode = '23514', constraint = 'pilot_parent_resources_no_delete';
    end if;
    return old;
  end if;

  if tg_op = 'INSERT' then
    if new.created_by_account_id is null then
      raise exception 'PARENT_RESOURCE_NAMES_ITS_AUTHOR'
        using errcode = '23514', constraint = 'pilot_parent_resources_author_named';
    end if;
    return new;
  end if;

  -- UPDATE. A cascade (an account going sets its writer columns to null) runs
  -- from inside the foreign key's own trigger, so it is let through as is.
  if pg_trigger_depth() > 1 then
    return new;
  end if;

  if new.organization_id is distinct from old.organization_id
     or new.resource_id is distinct from old.resource_id then
    raise exception 'PARENT_RESOURCE_DOES_NOT_MOVE'
      using errcode = '23514', constraint = 'pilot_parent_resources_fixed_gym';
  end if;

  if new.created_by_account_id is distinct from old.created_by_account_id
     or new.created_by_role is distinct from old.created_by_role
     or new.created_at is distinct from old.created_at then
    raise exception 'PARENT_RESOURCE_WRITER_IS_KEPT'
      using errcode = '23514', constraint = 'pilot_parent_resources_fixed_writer';
  end if;

  -- First published is kept: archiving or re-publishing does not move it.
  if old.published_at is not null and new.published_at is distinct from old.published_at then
    raise exception 'PARENT_RESOURCE_FIRST_PUBLISHED_IS_KEPT'
      using errcode = '23514', constraint = 'pilot_parent_resources_published_kept';
  end if;

  if new.updated_by_account_id is null or new.updated_by_role is null then
    raise exception 'PARENT_RESOURCE_CHANGE_NAMES_ITS_EDITOR'
      using errcode = '23514', constraint = 'pilot_parent_resources_editor_named';
  end if;

  new.updated_at := now();
  return new;
end;
$parent_resources_guard$;

drop trigger if exists trg_parent_resources_guard on pilot.parent_resources;
create trigger trg_parent_resources_guard
  before insert or update or delete on pilot.parent_resources
  for each row execute function pilot.parent_resources_guard();
