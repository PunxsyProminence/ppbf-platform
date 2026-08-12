-- PPBF Pilot Slice: platform-wide SHADOW evidence baseline
--
-- WHAT THIS IS FOR
--
-- The SHADOW Library is tenant-scoped in every column: shadow_library_sources,
-- _documents, _chunks and shadow_capability_map all carry organization_id NOT
-- NULL, every retrieval query filters on it, and every join between them
-- restates it (d.organization_id = c.organization_id). That is correct for a
-- gym's own material -- floor observations, coach notes, its own commissioned
-- research -- and it is the reason the Library is empty for a new gym: there is
-- nowhere to put evidence that is true for everybody.
--
-- The platform baseline is that missing shelf: sourced, peer-reviewed material
-- that is not specific to any athlete, user, or gym. This migration gives it a
-- home WITHOUT introducing a second notion of ownership.
--
-- WHY A RESERVED ORGANIZATION AND NOT A `scope` COLUMN
--
-- The obvious shape is `alter table ... add column scope text` with platform
-- rows pointing at some owner organization. It was rejected: `scope =
-- 'platform'` would then be true exactly when organization_id is the platform
-- owner, so the column is derivable from the one beside it. Two columns
-- answering one question is how they come to disagree, and this schema already
-- pays for one instance of that pattern elsewhere.
--
-- Nullable organization_id was rejected for two independent reasons. Postgres
-- treats NULLs as distinct in a unique constraint, so UNIQUE (organization_id,
-- url) would stop de-duplicating the platform corpus entirely; and every join
-- in the retrieval path is an equality on organization_id, which is never true
-- for NULL -- platform chunks would join to nothing and every bundle would come
-- back empty.
--
-- Separate platform_library_* tables were rejected on cost: `library_` appears
-- 167 times across 40 files, and duplicating four tables means duplicating the
-- importer, the three write routes, retraction surveillance, citation checks,
-- the rabbit-hole citation join and the evidence-bundle writer, then keeping
-- two schemas in lockstep forever.
--
-- So: the baseline is owned by one reserved organization. Every existing
-- constraint, composite foreign key and tenant-coherent join keeps working
-- unchanged, and the importer needs no changes at all -- it already resolves
-- its target from PPBF_ORG_ID and already admits a platform_owner actor whose
-- own organization differs from the target.
--
-- HOW A GYM IS KEPT OUT OF IT
--
-- The risk this design creates is the inverse of the one it removes: a read
-- that forgets the platform id merely hides the baseline, but a WRITE that
-- reaches the reserved organization would pollute the corpus every tenant
-- reads. That is closed here rather than by convention. Every write path in the
-- application derives organization_id from the authenticated principal, and
-- section 2 makes it impossible for a principal to exist in the reserved
-- organization: no account, no membership, and no athlete may reference it. The
-- only writer that can reach it is an operator running the importer with
-- PPBF_ORG_ID set to the reserved id and a platform_owner actor.

-- No BEGIN/COMMIT here: pilot-apply-platform-library-scope-migration.mjs opens
-- the transaction and runs its readiness assertions inside it, so an inner
-- COMMIT would let a half-applied migration through the check.

-- ---------------------------------------------------------------------------
-- 1. The reserved organization.
-- ---------------------------------------------------------------------------
--
-- Deliberately NOT created through createOrganization(): that function also
-- seeds default compliance rules and safety gates, which are per-gym
-- operational policy. The baseline shelf has no floor, no members and no
-- sessions, so it must not carry either. auth.ts refuses the reserved id for
-- the same reason.
--
-- `do nothing` rather than `do update`: re-running this migration must never
-- rename or reactivate a row an operator has deliberately changed.
insert into pilot.organizations (organization_id, organization_name, status)
values ('__platform__', 'PPBF Platform Evidence Baseline', 'active')
on conflict (organization_id) do nothing;

-- ---------------------------------------------------------------------------
-- 2. Nobody lives in the reserved organization.
-- ---------------------------------------------------------------------------
--
-- These three tables are what "being in an organization" means: accounts is
-- what resolvePrincipal reads, organization_memberships is the multi-org
-- widening of it, and athletes is what a subject-scoped chunk or bundle points
-- at. A CHECK on each is a database-level guarantee that the reserved
-- organization can never appear in a principal, and therefore can never be the
-- target of a principal-derived write.
--
-- session_tokens is intentionally not constrained: it can only ever carry an
-- organization an account already has, so the guarantee above covers it, and a
-- fourth constraint would suggest the invariant lives in four places.
--
-- Constraints are added through DO blocks because ADD CONSTRAINT has no IF NOT
-- EXISTS form and this migration is in the `all` rebuild loop.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'pilot_accounts_not_platform_library_org'
      and conrelid = to_regclass('pilot.accounts')
  ) then
    alter table pilot.accounts
      add constraint pilot_accounts_not_platform_library_org
      check (organization_id <> '__platform__');
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'pilot_org_memberships_not_platform_library_org'
      and conrelid = to_regclass('pilot.organization_memberships')
  ) then
    alter table pilot.organization_memberships
      add constraint pilot_org_memberships_not_platform_library_org
      check (organization_id <> '__platform__');
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'pilot_athletes_not_platform_library_org'
      and conrelid = to_regclass('pilot.athletes')
  ) then
    alter table pilot.athletes
      add constraint pilot_athletes_not_platform_library_org
      check (organization_id <> '__platform__');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 3. An evidence item may cite a platform chunk.
-- ---------------------------------------------------------------------------
--
-- This is the one place the reserved-organization design does NOT fall out for
-- free, and it is a hard blocker without this section.
--
-- shadow_evidence_items carried a single organization_id used for two different
-- purposes at once: a composite foreign key to the bundle (bundle_id,
-- organization_id, account_id), which requires the asking gym; and three
-- composite foreign keys to the library rows (source_id, organization_id) etc.,
-- which require the owner of the cited row. While those are always the same
-- organization the overload is invisible. The moment a gym cites a platform
-- chunk it needs to be both values simultaneously, and the insert dies on a
-- foreign key violation AFTER retrieval has already returned the chunk.
--
-- So the two meanings get two columns. organization_id keeps its meaning --
-- which tenant's bundle this is -- and library_organization_id records who owns
-- the row being cited. The CHECK is what keeps this from becoming a tenancy
-- hole: an item may cite its own organization's library row or the platform
-- baseline, and nothing else. That is strictly narrower than "any organization"
-- and exactly one case wider than the equality the foreign keys used to force.
alter table pilot.shadow_evidence_items
  add column if not exists library_organization_id text null;

-- Every existing row cites its own organization by construction: the foreign
-- keys being replaced below made anything else impossible.
update pilot.shadow_evidence_items
   set library_organization_id = organization_id
 where library_organization_id is null;

alter table pilot.shadow_evidence_items
  alter column library_organization_id set not null;

-- Drop the library foreign keys that key on organization_id. Found by shape
-- rather than by name because the originals were auto-named by Postgres, and
-- skipping any definition that already mentions library_organization_id is what
-- makes this idempotent across a re-run.
do $$
declare
  items regclass := to_regclass('pilot.shadow_evidence_items');
  stale record;
begin
  for stale in
    select conname
    from pg_constraint
    where conrelid = items
      and contype = 'f'
      and confrelid in (
        to_regclass('pilot.shadow_library_sources'),
        to_regclass('pilot.shadow_library_documents'),
        to_regclass('pilot.shadow_library_chunks')
      )
      and pg_get_constraintdef(oid) not like '%library_organization_id%'
  loop
    execute format('alter table pilot.shadow_evidence_items drop constraint %I', stale.conname);
  end loop;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'pilot_shadow_evidence_items_source_library_fkey'
      and conrelid = to_regclass('pilot.shadow_evidence_items')
  ) then
    alter table pilot.shadow_evidence_items
      add constraint pilot_shadow_evidence_items_source_library_fkey
      foreign key (source_id, library_organization_id)
      references pilot.shadow_library_sources(source_id, organization_id);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'pilot_shadow_evidence_items_document_library_fkey'
      and conrelid = to_regclass('pilot.shadow_evidence_items')
  ) then
    alter table pilot.shadow_evidence_items
      add constraint pilot_shadow_evidence_items_document_library_fkey
      foreign key (document_id, library_organization_id)
      references pilot.shadow_library_documents(document_id, organization_id);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'pilot_shadow_evidence_items_chunk_library_fkey'
      and conrelid = to_regclass('pilot.shadow_evidence_items')
  ) then
    alter table pilot.shadow_evidence_items
      add constraint pilot_shadow_evidence_items_chunk_library_fkey
      foreign key (chunk_id, library_organization_id)
      references pilot.shadow_library_chunks(chunk_id, organization_id);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'pilot_shadow_evidence_items_library_scope_check'
      and conrelid = to_regclass('pilot.shadow_evidence_items')
  ) then
    alter table pilot.shadow_evidence_items
      add constraint pilot_shadow_evidence_items_library_scope_check
      check (
        library_organization_id = organization_id
        or library_organization_id = '__platform__'
      );
  end if;
end $$;

-- The three replacement foreign keys are satisfied by the tenant-identity
-- unique indexes the shadow-evidence migration already created; no new unique
-- index is needed. This index supports the reverse direction -- "what cites
-- this platform row" -- which retraction and takedown review now has to ask
-- across tenants rather than within one.
create index if not exists idx_shadow_evidence_items_library_owner
  on pilot.shadow_evidence_items(library_organization_id, source_id);
