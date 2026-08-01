-- Feedback submissions (pilot.feedback_submissions) -- the comment box, and the
-- disclosure channel it also is.
--
-- Any signed-in user says what is broken, what frustrates them, what they wish
-- existed, so the gym can decide what to build and what to dissolve. Nothing in
-- the database holds that today: pilot.shadow_feedback is a rating attached to
-- one SHADOW answer, keyed to a conversation message, and it cannot carry a
-- sentence about the app that is not about an answer.
--
-- THE SAFEGUARDING DECISION. Some of the people typing into this box are
-- children. A free-text field offered to a minor is a disclosure channel
-- whether or not it was built as one. A submission from an ATHLETE that trips
-- safety language -- fear, pain, injury, someone hurting them -- is not a
-- product ticket: it routes to a SAFEGUARDING queue that a human works, and the
-- athlete is told a person will read it. Everyone else's submissions go to the
-- product queue.
--
-- ROUTE IS DECIDED AT WRITE TIME AND STORED. `route` is not null and carries NO
-- default, so a writer that has not decided where a submission goes cannot
-- insert one; there is no value it can fall into, and in particular it cannot
-- fall into 'product'. And once written it cannot move: the freeze trigger
-- below refuses any UPDATE that changes route, body or submitted_by_role.
-- Detection rules get edited -- that is what detection rules are for -- and a
-- re-classification pass over stored bodies would carry a child's disclosure
-- out of the safeguarding queue months after a person was promised it had been
-- read. What was said, in what capacity, and where it went are facts about a
-- moment. Triage status and the triage note are the part that moves.
--
-- ROUTE IS NOT CONSTRAINED BY ROLE, deliberately. The athlete rule is about who
-- the detection runs for, not about who may reach a human. A check of the form
-- "route = 'safeguarding' implies submitted_by_role = 'athlete'" would make the
-- database refuse a parent reporting that someone is hurting their child, and a
-- coach reporting what they witnessed. The queue stays reachable from every
-- role.
--
-- ROLE AT SUBMISSION TIME. submitted_by_role is a copy, not a join. Roles
-- change -- an athlete ages into a volunteer, a parent becomes a coach -- and a
-- join to pilot.accounts would restate every past submission in today's terms.
-- The safeguarding queue's entire basis is that a child said this, so the
-- capacity has to be part of the record rather than a lookup that drifts.
--
-- THE SUBMISSION OUTLIVES THE ACCOUNT. submitted_by_account_id clears rather
-- than cascades. A disclosure that disappears when an account is closed is the
-- hazard and not the fix: an account closing is one of the things that can
-- FOLLOW a disclosure, and a safeguarding record that a deletion can erase is
-- no record at all. The row survives with its body, its route and its frozen
-- submitted_by_role intact, so it still reads as an athlete's disclosure after
-- the athlete's account is gone. That FK action is itself an UPDATE against
-- this table, which is why the freeze trigger names the three frozen columns
-- instead of refusing updates outright -- freezing submitted_by_account_id
-- would make deleting an account impossible.
--
-- For the same reason there is no constraint requiring a triaged row to name
-- its triager. triaged_by_account_id clears when that staff account is removed,
-- and a check tying triage_status to a non-null triager would turn that
-- clearing UPDATE into a constraint violation -- an account nobody can delete
-- because of a comment they once filed.
--
-- THE SAFEGUARDING QUEUE MUST BE FAST. A child's disclosure waiting behind a
-- sequential scan of every suggestion the gym ever received is a response-time
-- problem, not a performance problem. idx_pilot_feedback_submissions_route_queue
-- covers (organization_id, route, triage_status, created_at desc), which is the
-- queue read exactly: this gym, the safeguarding lane, the ones nobody has
-- picked up, newest first.
--
-- Additive and idempotent. Apply through the controlled migration runner, never
-- from an HTTP request.
--
-- No `begin;`/`commit;` here on purpose: the runner
-- (apps/web/scripts/pilot-apply-feedback-migration.mjs) opens the transaction
-- itself, matching the announcements / volunteer-program / board-seats
-- convention. The shadow-runtime runner takes the opposite one.

create table if not exists pilot.feedback_submissions (
  submission_id uuid primary key default gen_random_uuid(),
  organization_id text not null references pilot.organizations(organization_id) on delete cascade,

  -- Who wrote it, and the capacity they wrote it in. The account reference
  -- clears if the account is removed; the role does not, because the role is
  -- what makes a safeguarding row legible without it.
  submitted_by_account_id text null references pilot.accounts(account_id) on delete set null,
  submitted_by_role text not null,

  kind text not null,
  body text not null,

  -- Written by the caller that decided it. No default: see the header.
  route text not null,

  triage_status text not null default 'new',
  triage_note text null,
  triaged_by_account_id text null references pilot.accounts(account_id) on delete set null,
  triaged_at timestamptz null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- PostgreSQL has no `add constraint if not exists`, so every vocabulary here is
-- catalog-guarded. Declaring them out of line keeps one copy of each list in
-- this file and reaches a table that was created before this migration existed.
do $pilot_feedback_submissions_constraints$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'pilot_feedback_submissions_kind_check'
      and conrelid = 'pilot.feedback_submissions'::regclass
  ) then
    alter table pilot.feedback_submissions
      add constraint pilot_feedback_submissions_kind_check
      check (kind in ('bug', 'idea', 'frustration', 'other'));
  end if;

  -- Two lanes and no third. A route the reading side does not know is a
  -- submission that appears in neither queue.
  if not exists (
    select 1
    from pg_constraint
    where conname = 'pilot_feedback_submissions_route_check'
      and conrelid = 'pilot.feedback_submissions'::regclass
  ) then
    alter table pilot.feedback_submissions
      add constraint pilot_feedback_submissions_route_check
      check (route in ('product', 'safeguarding'));
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'pilot_feedback_submissions_triage_status_check'
      and conrelid = 'pilot.feedback_submissions'::regclass
  ) then
    alter table pilot.feedback_submissions
      add constraint pilot_feedback_submissions_triage_status_check
      check (triage_status in ('new', 'triaged', 'planned', 'declined', 'done'));
  end if;

  -- The platform's role vocabulary, frozen into the row. A value outside it
  -- could not have been a role anyone held.
  if not exists (
    select 1
    from pg_constraint
    where conname = 'pilot_feedback_submissions_role_check'
      and conrelid = 'pilot.feedback_submissions'::regclass
  ) then
    alter table pilot.feedback_submissions
      add constraint pilot_feedback_submissions_role_check
      check (submitted_by_role in (
        'platform_owner',
        'organization_admin',
        'admin',
        'coach',
        'athlete',
        'parent',
        'board',
        'volunteer',
        'staff'
      ));
  end if;

  -- A blank submission is a queue entry that renders as nothing. Whitespace is
  -- not a report, so the row never exists to be displayed as one. btrim's
  -- default set is spaces alone, and a body of newlines is just as empty.
  if not exists (
    select 1
    from pg_constraint
    where conname = 'pilot_feedback_submissions_body_present_check'
      and conrelid = 'pilot.feedback_submissions'::regclass
  ) then
    alter table pilot.feedback_submissions
      add constraint pilot_feedback_submissions_body_present_check
      check (length(btrim(body, E' \t\r\n')) > 0);
  end if;
end
$pilot_feedback_submissions_constraints$;

-- The rule that keeps a routing decision a fact rather than a cached opinion.
-- Application code cannot hold it: any process with write access -- a migration
-- of detection rules, a backfill, a well-meant cleanup -- can issue the UPDATE
-- that reclassifies a disclosure, and only the database sees all of them.
--
-- submitted_by_account_id and triaged_by_account_id are deliberately NOT frozen:
-- their on-delete-set-null actions arrive here as updates, and refusing those
-- would make account deletion impossible.
create or replace function pilot.feedback_submissions_freeze_disclosure()
returns trigger
language plpgsql
as $pilot_feedback_submissions_freeze$
begin
  if new.route is distinct from old.route
     or new.body is distinct from old.body
     or new.submitted_by_role is distinct from old.submitted_by_role then
    raise exception 'FEEDBACK_SUBMISSION_IMMUTABLE'
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$pilot_feedback_submissions_freeze$;

drop trigger if exists pilot_feedback_submissions_freeze_disclosure
  on pilot.feedback_submissions;
create trigger pilot_feedback_submissions_freeze_disclosure
  before update on pilot.feedback_submissions
  for each row
  execute function pilot.feedback_submissions_freeze_disclosure();

-- The queue read, for both lanes. Safeguarding is the one that must not wait,
-- and the product backlog rides the same shape.
create index if not exists idx_pilot_feedback_submissions_route_queue
  on pilot.feedback_submissions(organization_id, route, triage_status, created_at desc);

-- What one person has already told the gym, so the app can show them their own
-- submissions without scanning the organization's.
create index if not exists idx_pilot_feedback_submissions_submitter
  on pilot.feedback_submissions(organization_id, submitted_by_account_id, created_at desc);
