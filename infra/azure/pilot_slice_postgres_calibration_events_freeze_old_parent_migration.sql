-- Calibration events freeze, the set an event leaves.
--
-- STACKED ON the calibration annotations migration. It needs
-- pilot.calibration_annotation_sets and pilot.calibration_annotation_events.
--
-- THE HOLE IT CLOSES. pilot.calibration_annotation_events_freeze (annotations
-- migration) looks up NEW's parent set on UPDATE. The events' foreign key to
-- the sets is (organization, set, clip), so an UPDATE that changes
-- annotation_set_id from a submitted set to an in-progress set on the same
-- clip passed: the event left a submitted set, which the freeze exists to
-- prevent. Reported by the TEACH-BIOMECH-01-b and 01-c reviewers.
--
-- WHAT IS HERE: a second BEFORE UPDATE trigger that, when an update moves an
-- event to another set (or organization), reads the set it is LEAVING and
-- refuses with the freeze's own error if that set is submitted. The existing
-- freeze still checks the set it is entering.
--
-- WHY A NEW FUNCTION RATHER THAN EDITING THE FREEZE. A re-run of the
-- calibration-annotations migration on its own would `create or replace` the
-- freeze back to its original body and silently reopen the hole. A separate
-- function cannot be reverted that way. The same reason 01-b left the freeze
-- unedited.
--
-- DELETION IS UNTOUCHED. This trigger is UPDATE-only, and it returns at once
-- unless the update changes the event's set or organization. The updates a
-- deletion causes (ON DELETE SET NULL on counter_against_event_id and
-- defends_against_event_id) change neither, so a submitted set never blocks
-- a data-deletion request made on behalf of a minor.
-- calibrationEventsFreezeOldParent.pg.test.ts asserts this for the footage,
-- clip, set and organization.
--
-- LOCK: the leaving set is read FOR SHARE, so a submission of it waits for
-- this move to commit and then sees the set without the event, rather than
-- both passing their checks unseen to each other.
--
-- Additive and idempotent. No `begin;`/`commit;` here on purpose: the runner
-- (apps/web/scripts/pilot-apply-calibration-events-freeze-old-parent-migration.mjs)
-- opens the transaction itself.

create or replace function pilot.calibration_annotation_events_freeze_old_parent()
returns trigger
language plpgsql
as $pilot_calibration_events_freeze_old_parent$
declare
  old_parent_status text;
begin
  if new.organization_id is not distinct from old.organization_id
     and new.annotation_set_id is not distinct from old.annotation_set_id
  then
    return new;
  end if;

  select status into old_parent_status
    from pilot.calibration_annotation_sets
   where organization_id = old.organization_id
     and annotation_set_id = old.annotation_set_id
     for share;

  if old_parent_status = 'submitted' then
    raise exception 'CALIBRATION_ANNOTATION_SET_SUBMITTED'
      using errcode = 'restrict_violation';
  end if;

  return new;
end;
$pilot_calibration_events_freeze_old_parent$;

drop trigger if exists pilot_calibration_events_freeze_old_parent
  on pilot.calibration_annotation_events;
create trigger pilot_calibration_events_freeze_old_parent
  before update on pilot.calibration_annotation_events
  for each row
  execute function pilot.calibration_annotation_events_freeze_old_parent();
