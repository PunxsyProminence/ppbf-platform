-- Issued workouts (pilot.workout_issues, pilot.workout_issue_steps): an issued
-- workout template keeps its shape (lane P7c, issue #1419; OD-2026-10-10-004
-- ruling 5, Jason: "Fix or build it").
--
-- WHY THIS EXISTS. Issuing a template (workoutTemplates.ts issueWorkoutTemplate)
-- writes one pilot.drill_assignments row per step. That table has no place for
-- a step's block, its order, its scale level, its contact level, the coach's
-- note or the template it came from, so the athlete received a flat set of
-- drills. These two tables hold exactly what the assignment cannot: one row for
-- the act of issuing, one row per step tying an assignment to its place in the
-- workout.
--
-- A SNAPSHOT, NOT A JOIN BACK TO THE TEMPLATE. A step copies its block,
-- ordinal, scale level, contact level and note from the template item on the
-- day, and the issue copies the template's name and version. Templates are
-- superseded and withdrawn by the content import, never edited in place, so a
-- join would show the athlete a workout the coach did not issue.
--
-- WHAT IS NOT HERE: the drill, the rep count, the minutes, the status and the
-- completions. The assignment already holds them; a second copy could drift.
--
-- SCALE LEVEL IS NEVER FORCED. Null on the template item ("the coach picks the
-- level at delivery") stays null here. Nothing defaults it.
--
-- CONTACT LEVEL IS THE COACH'S ENTRY. It is stored as written. Nothing here
-- compares it with anything.
--
-- WRITTEN ONCE. The application inserts these rows inside the transaction that
-- writes the assignments and never updates or deletes them. They leave only by
-- cascade: with the athlete (the retention purge deletes pilot.athletes) or
-- with the assignment. (organization_id also cascades, as on every table
-- here, but an organization that still has athletes cannot be deleted.)
--
-- EVERY READER JOINS ON THE ORGANIZATION. pilot.drill_assignments is keyed by
-- assignment_id alone, so the step's foreign key cannot carry the
-- organization. The writer ties a step only to an assignment of the same
-- organization and athlete; a reader joins a step to its assignment on
-- organization_id AND assignment_id, never on assignment_id alone.
--
-- request_key (nullable, unique per gym when set) lets a later change make a
-- repeated tap or a retry after a lost answer return the first issue instead
-- of writing a second one. Nothing reads or writes it yet; it is here so that
-- change needs no second migration (Overwatch, lane P7c question 2).
--
-- issuance_id on pilot.drill_assignments is NOT reused: it means one drill
-- issued to many athletes (coach-cards migration), and a workout is many
-- drills issued to one.
--
-- DEPENDS ON pilot.athletes, pilot.accounts, pilot.drill_assignments
-- (progression, coach-cards) and pilot.workout_templates
-- (workout-templates-v2), all earlier in apply-migrations.yml's `all` list.
-- No `begin;`/`commit;` here on purpose: the runner
-- (apps/web/scripts/pilot-apply-workout-issues-migration.mjs) opens the
-- transaction itself. Idempotent: create ... if not exists.

create table if not exists pilot.workout_issues (
  organization_id       text not null references pilot.organizations(organization_id) on delete cascade,
  issue_id              uuid not null,
  athlete_id            text not null,
  template_id           text not null,
  -- The template as it was named and numbered when it was issued.
  template_name         text not null,
  template_version      integer not null,
  issued_by_account_id  text not null references pilot.accounts(account_id),
  issued_at             timestamptz not null default now(),
  request_key           text null
    constraint pilot_workout_issues_request_key_check check (
      request_key is null or (length(btrim(request_key)) > 0 and length(request_key) <= 200)
    ),
  constraint pilot_workout_issues_pkey primary key (organization_id, issue_id),
  constraint pilot_workout_issues_athlete_fk
    foreign key (organization_id, athlete_id)
    references pilot.athletes(organization_id, athlete_id)
    on delete cascade,
  -- No cascade: a template row is never deleted, only superseded or withdrawn.
  constraint pilot_workout_issues_template_fk
    foreign key (organization_id, template_id)
    references pilot.workout_templates(organization_id, template_id)
);

create table if not exists pilot.workout_issue_steps (
  organization_id   text not null references pilot.organizations(organization_id) on delete cascade,
  issue_id          uuid not null,
  ordinal           integer not null
    constraint pilot_workout_issue_steps_ordinal_check check (ordinal > 0),
  block             text not null,
  scale_level       text null
    constraint pilot_workout_issue_steps_scale_level_check check (scale_level is null or scale_level in ('A', 'B', 'C')),
  contact_level     text not null
    constraint pilot_workout_issue_steps_contact_level_check check (
      contact_level in ('none', 'light_technical', 'conditioned', 'controlled_sparring', 'open_sparring')
    ),
  coach_note        text null,
  -- Where the step came from. Not a foreign key: it is a record, not a link.
  template_item_id  text not null,
  assignment_id     text not null,
  constraint pilot_workout_issue_steps_pkey primary key (organization_id, issue_id, ordinal),
  constraint pilot_workout_issue_steps_issue_fk
    foreign key (organization_id, issue_id)
    references pilot.workout_issues(organization_id, issue_id)
    on delete cascade,
  constraint pilot_workout_issue_steps_assignment_fk
    foreign key (assignment_id)
    references pilot.drill_assignments(assignment_id)
    on delete cascade
);

-- An assignment is a step of at most one workout. Also the read path: the
-- screens ask "which workout steps do these assignments belong to".
create unique index if not exists pilot_workout_issue_steps_one_per_assignment
  on pilot.workout_issue_steps(assignment_id);

create unique index if not exists pilot_workout_issues_one_per_request_key
  on pilot.workout_issues(organization_id, request_key)
  where request_key is not null;

create index if not exists idx_workout_issues_athlete
  on pilot.workout_issues(organization_id, athlete_id, issued_at desc);

comment on table pilot.workout_issues is
  'One row per workout template issued to one athlete: the template link and its name and version on the day. Written once inside the issue transaction; leaves only by cascade. Lane P7c, OD-2026-10-10-004 ruling 5.';

comment on table pilot.workout_issue_steps is
  'One row per step of an issued workout: block, ordinal, scale level (null = coach picks at delivery), contact level as the coach wrote it, coach note, and the assignment that step became. A snapshot of the template item; the drill, reps, minutes and status stay on the assignment.';
