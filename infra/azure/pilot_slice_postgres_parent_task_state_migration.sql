-- Due-and-done state for a parent-support task, kept OFF the message bus.
--
-- WHAT THIS SOLVES. A coach can already tell a guardian something -- "bring
-- gloves Thursday", "the paperwork is still outstanding" -- through a
-- pilot.coach_observations row with note_type = 'parent_message'. What that
-- path cannot do is track whether it happened: listParentMessages returns
-- note_id, athlete_id, sender_role, note_text, created_at, and nothing else.
-- A message is a notification, not a task.
--
-- WHY A COMPANION TABLE AND NOT TWO COLUMNS ON pilot.coach_observations.
--
-- That table is a shared bus. It already carries coach observations, guardian
-- barrier reports, transportation barriers and parent messages, and which
-- reader may see which note_type is the whole safety mechanism --
-- coachObservationNoteTypesForReader exists because a guardian-authored
-- barrier report reaching the other household, or the child, is a real
-- disclosure this repo has already had to fix. Adding due_date and
-- completed_at to that table would put two columns on every row of a bus
-- doing four jobs, NULL for all of them but the fourth, readable by every
-- projection that selects from it.
--
-- Keyed to the note instead, the bus gains nothing. A message that is not a
-- task simply has no row here. Every existing reader, every note_type filter
-- and every projection over pilot.coach_observations is untouched by this
-- migration, which is the point of it.
--
-- AND NO NEW note_type. A task IS a 'parent_message' -- already audience-
-- filtered to the guardian, already scoped through guardianAthleteIds. A new
-- note_type would have to be added to the right reader sets in the right
-- files, and being missed out of one of them is exactly the failure mode the
-- filters were written to stop. Reusing the type means there is nothing to
-- miss.
--
-- WHAT IS DELIBERATELY ABSENT: any verification. pilot.assignment_completions
-- carries verification_status ('pending','verified','disputed') and
-- verified_by_account_id because an athlete's technical work is verified by a
-- coach. A guardian bringing gloves is not athlete technical work, and a
-- coach being asked to VERIFY that a parent brought them is the masquerade
-- this table exists to avoid. completed_by_account_id records who ticked it.
-- Nobody countersigns it, and there is no column to countersign in.
--
-- DEPENDS ON pilot.organizations, pilot.accounts, pilot.coach_observations.
-- No begin;/commit; here on purpose, matching this repo's
-- runner-opens-the-transaction convention (the runner is
-- apps/web/scripts/pilot-apply-parent-task-state-migration.mjs).

create table if not exists pilot.parent_task_state (
  organization_id text not null references pilot.organizations(organization_id) on delete cascade,
  note_id uuid not null,

  -- Nullable: a task can be "outstanding, no deadline" and still be worth
  -- tracking. A gym that says "when you can" should not have to invent a date
  -- to use this at all.
  due_date date null,

  -- The done state IS the timestamp. A separate boolean could disagree with
  -- it; one column cannot.
  completed_at timestamptz null,
  completed_by_account_id text null references pilot.accounts(account_id) on delete restrict,

  created_by_account_id text not null references pilot.accounts(account_id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint pilot_parent_task_state_pkey
    primary key (organization_id, note_id),

  -- One task per message, and it dies with the message. A note deleted or
  -- cascaded away by its athlete's deletion must not leave task state behind
  -- pointing at nothing.
  constraint pilot_parent_task_state_note_fk
    foreign key (organization_id, note_id)
    references pilot.coach_observations(organization_id, note_id) on delete cascade,

  -- Who completed it and when move together or not at all. A completed_at
  -- with nobody against it is an unattributable claim that a family did
  -- something, and a completer with no time is not a completion.
  constraint pilot_parent_task_state_completion_paired check (
    (completed_at is null and completed_by_account_id is null)
    or (completed_at is not null and completed_by_account_id is not null)
  )
);

-- The open-work read: which of this organization's tasks are still
-- outstanding. Partial on the incomplete case because that is the question a
-- hub asks on every load; a completed task is of interest to an audit.
create index if not exists idx_parent_task_state_open
  on pilot.parent_task_state(organization_id, due_date)
  where completed_at is null;
