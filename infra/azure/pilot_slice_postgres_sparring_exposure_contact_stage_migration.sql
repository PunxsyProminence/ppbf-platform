-- The contact-ladder stage a sparring segment was done at (map item 15).
--
-- WHAT CHANGES. pilot.sparring_exposure gains contact_stage: one rung of the
-- ladder drills, templates, cohorts and coach-set caps already use
-- (contentImport/vocabularies.ts contact_level): none < light_technical <
-- conditioned < controlled_sparring < open_sparring. It is NULLABLE with no
-- default: every row written before this migration, and any entry where the
-- coach did not pick a stage, reads as "not recorded" -- never as a guessed
-- stage.
--
-- WHY. A coach-set cap (pilot.athlete_contact_caps) names a highest allowed
-- stage. The sparring entry screen compares an entry's stage to that cap and
-- WARNS when it is above it; the entry always saves and the coach decides
-- (Jason, 2026-10-04: "Warn only").
--
-- NO DATA IS REWRITTEN. The column is added empty and the check admits null.
--
-- STILL REFUSED, MATCHING THE ORIGINAL MIGRATION'S HEADER: no damage score, no
-- cumulative risk index, no recommended limit, no clearance. A coach-set cap is
-- the coach's own number, not the app's.
--
-- DEPENDS ON sparring-exposure (pilot_slice_postgres_sparring_exposure_and_load_migration.sql).
-- No begin;/commit; here; the runner
-- (apps/web/scripts/pilot-apply-sparring-exposure-contact-stage-migration.mjs)
-- opens the transaction. Idempotent: add column if not exists, constraint
-- added only when absent.

do $$
begin
  if to_regclass('pilot.sparring_exposure') is null then
    raise exception 'SPARRING_EXPOSURE_CONTACT_STAGE_REQUIRES_SPARRING_EXPOSURE: apply sparring-exposure first';
  end if;
end
$$;

alter table pilot.sparring_exposure add column if not exists contact_stage text null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'pilot_sparring_exposure_contact_stage_check'
                 and conrelid = 'pilot.sparring_exposure'::regclass) then
    alter table pilot.sparring_exposure add constraint pilot_sparring_exposure_contact_stage_check
      check (
        contact_stage is null
        or contact_stage in ('none', 'light_technical', 'conditioned', 'controlled_sparring', 'open_sparring')
      );
  end if;
end
$$;
