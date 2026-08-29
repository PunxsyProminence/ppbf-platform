-- pilot.waivers -> pilot.parents: scope the SET NULL to the column that may
-- actually be nulled.
--
-- THE DEFECT. pilot_waivers_parent_fk is a COMPOSITE foreign key --
-- (organization_id, parent_id) -- declared ON DELETE SET NULL. Postgres
-- applies SET NULL to EVERY column in the key, so deleting a pilot.parents row
-- that has waivers tries to null waivers.organization_id as well, and that
-- column is `text not null`. The delete fails:
--
--   23502: null value in column "organization_id" of relation "waivers"
--          violates not-null constraint
--
-- Measured on PostgreSQL 18.4 against the schema this repository builds, not
-- inferred from the catalog: the delete raises before this migration and
-- succeeds after it.
--
-- WHY IT MATTERS. Deleting a guardian record is not hypothetical -- it is what
-- data retention does. The retention purge is the only path that deletes a
-- pilot.parents row today, and it carries an explicit `update pilot.waivers
-- set parent_id = null` ahead of the delete precisely to keep this referential
-- action from ever firing. That statement is a workaround for this constraint,
-- and it only protects the one caller that remembers it. A second caller --
-- an admin tool, a merge, a future consolidation of the two purge
-- implementations -- would hit 23502 with no constraint name in the error and
-- nothing to tell them why.
--
-- THE FIX IS THE INTENT THE CONSTRAINT ALREADY MEANT. ON DELETE SET NULL
-- (parent_id) nulls the pointer and leaves the tenant column alone, which is
-- what "the guardian record is gone, the waiver is not" has always meant here.
-- The waiver keeps signed_by_name, waiver_type, status and its dates: purging
-- a withdrawn family must never destroy the document that authorised a minor's
-- participation.
--
-- NOT THE OTHER "FIX". The alternative someone reaches for when they see
-- 23502 is to make waivers.organization_id nullable. That would be a tenancy
-- hole -- every projection, gate and index in this schema keys on
-- organization_id -- so the runner for this migration asserts the column is
-- STILL NOT NULL and refuses a database where it is not.
--
-- POSTGRESQL 15 IS REQUIRED. The column-list form of SET NULL arrived in
-- PostgreSQL 15. The version the Azure server runs is UNVERIFIED from this
-- repository -- nothing here records it, and the only instrument that can read
-- it is scripts/pilot-export-verify-dump.mjs against the live database. So
-- this refuses loudly on an older server rather than half-applying: the
-- exception below names the requirement, and the constraint is left exactly as
-- it was.
--
-- Idempotent, and shape-aware rather than name-aware. `all` re-runs every
-- migration on every dispatch, and a guard that only asked whether a
-- constraint by this name exists would skip a database still carrying the
-- broken whole-key version -- which is every database that has this schema
-- today. So the drop is conditional on the OLD shape and the add on the
-- constraint being absent. No begin;/commit; here on purpose, matching this
-- repo's runner-opens-the-transaction convention (the runner is
-- apps/web/scripts/pilot-apply-waiver-parent-fk-migration.mjs).

do $pilot_waivers_parent_fk_scope$
begin
  if current_setting('server_version_num')::int < 150000 then
    raise exception 'WAIVER_PARENT_FK_REQUIRES_PG15: server_version_num is %, and ON DELETE SET NULL (column) needs 150000 or later. The constraint is unchanged.',
      current_setting('server_version_num');
  end if;

  -- The broken shape: SET NULL (confdeltype = 'n') with no column list
  -- (confdelsetcols is null), meaning "null every column in the key".
  if exists (
    select 1 from pg_constraint
    where conname = 'pilot_waivers_parent_fk'
      and conrelid = to_regclass('pilot.waivers')
      and contype = 'f'
      and confdeltype = 'n'
      and confdelsetcols is null
  ) then
    alter table pilot.waivers drop constraint pilot_waivers_parent_fk;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'pilot_waivers_parent_fk'
      and conrelid = to_regclass('pilot.waivers')
  ) then
    alter table pilot.waivers
      add constraint pilot_waivers_parent_fk
      foreign key (organization_id, parent_id) references pilot.parents(organization_id, parent_id)
      on delete set null (parent_id);
  end if;
end
$pilot_waivers_parent_fk_scope$;

comment on constraint pilot_waivers_parent_fk on pilot.waivers is
  'ON DELETE SET NULL is scoped to parent_id alone. The unscoped form nulls every column in the composite key, including organization_id, which is NOT NULL -- so deleting a guardian record with waivers failed with 23502. The waiver survives the guardian record; only the pointer to it goes.';
