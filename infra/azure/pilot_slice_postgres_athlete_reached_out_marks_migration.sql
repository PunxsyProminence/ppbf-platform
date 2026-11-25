-- The "reached out" mark on the "who has stopped coming" page
-- (pilot.athlete_reached_out_marks): lane W4-6, PR SC-3a-1 (the table; its
-- module and routes are SC-3a-2, the button on the page SC-3b).
--
-- WHY. Jason's ruling OW27-33 B (OD-2026-11-21-006): the stopped-coming page
-- lists people, opens the athlete, "plus mark 'reached out'", so two coaches
-- do not both reach out, or neither. Overwatch's W4-6 answer Q4 A (on #2163):
-- "who and when only, no free text, one current mark per athlete; taking it
-- back keeps the row and is audited".
--
-- WHO AND WHEN, NOTHING ELSE, FOR ANY AGE. The card's con was "a new record
-- about minors", so the table has nowhere to type a note, a channel or a
-- reason: the only words are the role list below.
-- reachedOutMarksSchemaOwnership.test.ts pins the column list so a text column
-- cannot be added quietly.
--
-- ONE CURRENT MARK PER ATHLETE. The primary key is (organization_id,
-- athlete_id): marking again replaces who and when on the same row, and the
-- audit stream (written by reachedOutMarks.ts, SC-3a-2) keeps each change.
--
-- TAKING IT BACK KEEPS THE ROW. cleared_at and cleared_by_account_id are set
-- together (and only together); marking again clears them. Reads skip a
-- cleared mark. The page shows a mark only while it is newer than the
-- athlete's last day they came, so an athlete who came back and stopped again
-- starts clean without a write.
--
-- WHO MAY WRITE AND READ is the module's rule (SC-3a-2), not this file's:
-- coach, organization admin and admin with an active staff membership here,
-- for a live athlete of the gym. This file only refuses a mark made in any
-- other role. The account ids carry no foreign key, as rest marks' do not: an
-- account's purge must not be held up by a mark, and the reader shows a name,
-- never an id.
--
-- No `begin;`/`commit;` here on purpose: the runner
-- (apps/web/scripts/pilot-apply-athlete-reached-out-marks-migration.mjs) opens
-- the transaction itself. Idempotent: create ... if not exists.

create table if not exists pilot.athlete_reached_out_marks (
  organization_id        text not null references pilot.organizations(organization_id) on delete cascade,
  athlete_id             text not null,
  marked_by_account_id   text not null,
  marked_by_role         text not null
    constraint pilot_athlete_reached_out_marks_role_check check (marked_by_role in ('coach', 'organization_admin', 'admin')),
  marked_at              timestamptz not null default clock_timestamp(),
  cleared_at             timestamptz null,
  cleared_by_account_id  text null,
  primary key (organization_id, athlete_id),
  -- A take-back names who took it back, and only a take-back does.
  constraint pilot_athlete_reached_out_marks_clear_check
    check ((cleared_at is null) = (cleared_by_account_id is null)),
  constraint pilot_athlete_reached_out_marks_athlete_fk
    foreign key (organization_id, athlete_id)
    references pilot.athletes(organization_id, athlete_id)
    on delete cascade
);

-- The read path is the gym's marks, by organization: the primary key's leading
-- column serves it, so there is no other index.

comment on table pilot.athlete_reached_out_marks is
  'Who on the staff last marked that they reached out to an athlete on the stopped-coming list, and when (OW27-33 B; Overwatch W4-6 Q4 A). One current mark per athlete; a take-back keeps its row (cleared_at). No note or free text for any age. Staff only. Lane W4-6, SC-3a-1.';
