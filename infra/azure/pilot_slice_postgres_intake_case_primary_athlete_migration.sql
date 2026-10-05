-- Intake cases: backfill primary_athlete_id from the athlete promotion bound
-- the case's documents to.
--
-- Build-list row "Intake cases never get primary_athlete_id written" (added
-- 2026-10-03; OD-2026-09-29-002 item 4, live bugs go on the build list).
-- Until 2026-10-05 no code path wrote pilot.intake_cases.primary_athlete_id,
-- so every case carried NULL, the review queue's coach scope and deletion
-- filter had nothing to match, and the athlete the case was about lived only
-- on its documents (bindIntakeDocumentsToOwner stamps owner_entity_type
-- 'athlete' and owner_entity_id across the whole case at promotion). From
-- this release that same function also writes the case column. This sets it
-- on the cases promoted before then.
--
-- WHAT IS SET, AND WHAT IS NOT:
--   * Set: a case whose column is NULL and whose documents name exactly ONE
--     athlete owner. That is every case promotion has bound, because
--     promotion binds every document of the case to one athlete.
--   * Not set: a case with no athlete owner (still pending, approved or
--     rejected before promotion) -- it is about nobody yet, and guessing would
--     open it to a coach it has nothing to do with.
--   * Not set: a case whose documents name two or more athletes. The column
--     holds one, and picking one would hide the other from the access gate's
--     "every athlete must pass" rule. resolveIntakeCaseAuthority (intake.ts)
--     still reads every owner from the documents, so such a case stays gated
--     on all of them.
--   * Never overwritten: a case that already has a value.
--
-- DATA ONLY AND IDEMPOTENT. No schema change. The second run finds nothing
-- with a NULL column and one owner, and changes no row. updated_at is left
-- alone on purpose: the review queue orders by it, and a backfill is not an
-- edit to the case.
--
-- The runner opens the transaction and checks that no case is left with a
-- NULL column and exactly one athlete owner
-- (apps/web/scripts/pilot-apply-intake-case-primary-athlete-migration.mjs).

with sole_owner as (
  select
    d.organization_id,
    d.intake_case_id,
    min(d.owner_entity_id) as athlete_id
  from pilot.intake_documents d
  where d.owner_entity_type = 'athlete'
    and d.owner_entity_id is not null
  group by d.organization_id, d.intake_case_id
  having count(distinct d.owner_entity_id) = 1
)
update pilot.intake_cases c
set primary_athlete_id = s.athlete_id
from sole_owner s
where c.organization_id = s.organization_id
  and c.intake_case_id = s.intake_case_id
  and c.primary_athlete_id is null;
