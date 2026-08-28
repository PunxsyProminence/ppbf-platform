-- Coach self-development: a coach's own goals, and the development work they
-- actually did.
--
-- WHAT THIS IS. Two tables. pilot.coach_development_goals is what a coach
-- says they are trying to get better at. pilot.coach_development_activities
-- is what they did about it -- a course, a clinic, a workshop, a topic they
-- worked through, an afternoon watching somebody else's class. A goal is an
-- intention; an activity is a fact that happened. They are separate tables
-- because they are separate kinds of thing, and one table with a `kind`
-- column would leave half its columns null in every row.
--
-- WHY IT EXISTS. The Coach Workspace has carried a "Coach Development" tab
-- and a "Coach Goals" tab since it was built, both of them stamped "Planned
-- -- Not Yet Implemented", because no table anywhere stored a coach's own
-- development. The nearest things are not it, and were read before this was
-- written:
--
--   * pilot.goals is ATHLETE-scoped -- athlete_id is NOT NULL with a
--     composite FK into pilot.athletes -- so storing a coach's goal there
--     would mean creating an athlete row for a member of staff. That row
--     would then appear in the roster, in attendance, in achievements and in
--     every read that walks pilot.athletes. A coach is not an athlete, and
--     the fix for a missing table is not a fake person.
--   * pilot.mentorships is athlete-to-athlete: both FKs point at
--     pilot.athletes and a CHECK forbids self-pairing. It records which older
--     kid looks after which younger one. It cannot express a coach at all.
--   * pilot.person_clearances IS the credential record and is deliberately
--     untouched -- see the next paragraph, which is the most important one
--     in this file.
--
-- THIS IS NOT A CREDENTIAL STORE, AND MUST NEVER BECOME ONE. Certifications,
-- background checks, SafeSport, CPR -- the whole safeguarding record -- live
-- in pilot.person_clearances, are uploaded through /coach/credentials, and
-- are moved to 'current' only by an administrator through
-- /api/pilot/admin/credentials. Nothing here duplicates any of that. There
-- is deliberately no status, no verified_by, no verified_at, no issued_on,
-- no expires_on and no document_ref column in either table below, and none
-- may be added: a row here is SELF-ENTERED AND UNVERIFIED, and a
-- self-entered row that looked like a clearance would be a safeguarding
-- record nobody checked. Logging "SafeSport refresher" as an activity
-- confers no clearance, proves nothing, and is not evidence of anything --
-- it is a coach's note to themselves about their own learning.
--
-- NO TOTAL IS COMPUTED, AND duration_minutes IS NOT CEU HOURS. Each activity
-- may record how long it took. Nothing sums them. A platform-computed
-- "development hours this year" sitting on the same page as a certification
-- band would be read as compliance evidence -- and it would be a compliance
-- number built entirely out of unverified self-report. The certifying body
-- counts hours; this platform does not.
--
-- NO PROGRESS PERCENTAGE, AND THIS ONE IS NOT HYPOTHETICAL. The Coach Goals
-- tab used to render three hardcoded goals with progress bars and figures
-- like "68%", shown identically to every coach regardless of who was logged
-- in. They were removed as fake personal data. There is no progress,
-- percent_complete, score, level, rank or completion column here, and none
-- may be added -- not for a goal and not for a topic. How far along a coach
-- is in their own development is not a number this platform can compute, and
-- a bar that moved when a row was inserted would be measuring typing.
--
-- LIFECYCLE IS THE REPOSITORY'S, NOT A NEW ONE. draft/active/completed/
-- cancelled is the vocabulary pilot.athlete_development_blocks and
-- pilot.return_to_training_plans already use. A goal is written before it is
-- worked, so it starts at 'draft'. There is no 'abandoned' and no 'failed':
-- a goal somebody stopped pursuing was cancelled, and the database rejects
-- anything else.
--
-- TENANCY IS A DATABASE FACT, NOT A QUERY HABIT -- AND THE RIGHT PARENT IS
-- THE MEMBERSHIP, NOT THE ACCOUNT. Both tables carry a composite FK into
-- pilot.organization_memberships(account_id, organization_id), so a
-- development record cannot name a coach who is not a member of that gym.
-- Not "should not": cannot.
--
-- The obvious alternative was rejected on a measurement.
-- uq_pilot_accounts_org_account on pilot.accounts(organization_id,
-- account_id) exists (multiorg migration), so a composite FK into accounts
-- was available -- and it would have been wrong. pilot.accounts
-- .organization_id is the account's single denormalized HOME organization,
-- so that FK would refuse a coach whose home gym is elsewhere but who holds
-- an active membership here. That is not a hypothetical: it is the case
-- auth.ts's resolvePrincipal INNER JOINs the membership table to handle, and
-- the case athleteDevelopmentBlocks.hasActiveMembership was written for,
-- with a passing test ("a coach whose home organization is elsewhere may
-- still author here, if their membership is active"). The membership table
-- is where belonging actually lives, so it is what these rows hang off.
--
-- MEMBERSHIP EXISTING IS NOT MEMBERSHIP BEING ACTIVE. The FK proves the
-- coach belongs to this gym; it says nothing about active_flag, and it is
-- deliberately not asked to. A coach whose membership was deactivated keeps
-- their development history -- deleting somebody's record of their own
-- learning because their membership lapsed would be destroying it, not
-- securing it. Whether they may WRITE is the data layer's check, the same
-- active-membership floor every other write path in this codebase stands on.
--
-- ON DELETE CASCADE ON THE MEMBERSHIP FK, MEASURED BEFORE CHOOSING. No
-- production code path deletes a pilot.organization_memberships row -- the
-- only `delete from pilot.organization_memberships` in the repository is in
-- guardianClaimOnInvite.pg.test.ts, setting up a test. So this restricts and
-- loses nothing that exists today. If a removal path is ever added, a
-- departed coach's personal development notes leave the gym with them, which
-- is the data-minimisation reading and the one that does not leave a
-- nonprofit holding a former volunteer's private learning record. The
-- safeguarding record is unaffected: pilot.person_clearances is a different
-- table with its own retention rules, and this migration does not touch it.
--
-- THE GOAL LINK CARRIES NO ON DELETE ACTION, AND THAT IS A MEASUREMENT, NOT
-- A DEFAULT NOBODY THOUGHT ABOUT. This slice ships no way to delete a goal:
-- a goal that is no longer wanted is 'cancelled', the same refusal
-- pilot.athlete_development_blocks makes, because a record of what somebody
-- intended is still true after they stop intending it. So the only path that
-- could reach this FK's delete behaviour is one that does not exist, and the
-- default makes that loud -- whoever adds a delete path has to decide what
-- happens to the activities, in the open, instead of inheriting a choice
-- made here on their behalf. The intent, when they come to it, is that an
-- ACTIVITY OUTLIVES THE GOAL IT SERVED: the coach genuinely attended that
-- clinic, and deleting the goal does not unhappen the training. (That is the
-- reverse of pilot_athlete_development_blocks_target_competition_fk's
-- choice, for the reason that inverts: there the plan was the valuable
-- record and the competition was the pointer.)
--
-- `on delete set null` was written first and REMOVED after a real-Postgres
-- test failed on it. On a multi-column foreign key, SET NULL nulls EVERY
-- referencing column -- organization_id included -- so deleting a goal died
-- with `null value in column "organization_id" ... violates not-null
-- constraint`. It applies cleanly at migration time and only fails at delete
-- time, which is the worst place to find it. The column-list form that does
-- what was meant, `on delete set null (goal_id)`, requires PostgreSQL 15 or
-- newer, and this repository does not record the production server's major
-- version anywhere; a migration whose syntax depends on a version nobody has
-- written down is a dispatch failure waiting for a release window.
--
-- WHAT IS DELIBERATELY ABSENT, so a later reader does not read absence as
-- oversight:
--   * No coach-to-coach mentorship table. A row saying "Coach B mentors
--     Coach A" names a second member of staff, and who may assert that,
--     whether B consents, and who may see it are product and consent
--     decisions nobody has made. A coach can already record a mentorship
--     SESSION THEY ATTENDED as an activity in their own words, which claims
--     nothing about anybody else's role. The relationship itself waits for a
--     decision.
--   * No curriculum or topic vocabulary table. "Boxing Technique
--     Instruction", "Youth Development Psychology" and the rest are a
--     reference list in the UI; promoting them to a database vocabulary
--     would make this platform the author of a coaching curriculum it does
--     not possess. A topic a coach worked through is an activity, titled in
--     their own words. The same refusal
--     pilot.athlete_development_blocks.training_emphasis makes.
--   * No cross-coach read. Every route over these tables takes no account
--     id and serves the caller their own record only, matching
--     /api/pilot/coach/credentials. Whether a head coach may see their
--     staff's development goals is a real question and not this slice's to
--     answer; building the read first and gating it later is how that
--     question gets answered by accident.
--
-- Idempotent like every migration in this directory: create table/index if
-- not exists, no alters, no drops, safe to re-run wholesale. No begin;/
-- commit; here -- the runner
-- (apps/web/scripts/pilot-apply-coach-development-migration.mjs) opens the
-- transaction itself.
--
-- DEPENDS ON pilot.organizations, pilot.organization_memberships.

create table if not exists pilot.coach_development_goals (
  organization_id       text not null references pilot.organizations(organization_id) on delete cascade,
  goal_id               text not null,
  coach_account_id      text not null,
  -- BLANK MEANS BLANK, INCLUDING A TAB. btrim/1's default character set is
  -- ' ' -- spaces only -- so a title of E'\t\n' passes the one-argument
  -- spelling used elsewhere in this directory while every JavaScript
  -- caller's .trim() calls the same value empty, leaving the database the
  -- looser of the two layers. The explicit set closes that. Same fix, and
  -- the same reason, as pilot.athlete_development_blocks.
  title                 text not null
                        check (length(btrim(title, E' \t\r\n\f\v')) > 0),
  -- The coach's own words for what they are trying to get better at. Stored
  -- verbatim, never coerced into a competency framework and never
  -- algorithmically reinterpreted. A goal whose stated focus is blank is a
  -- title pretending to be an intention.
  development_focus     text not null
                        check (length(btrim(development_focus, E' \t\r\n\f\v')) > 0),
  -- Optional. Plenty of real development has no deadline, and a required
  -- date would be answered with a made-up one.
  target_on             date null,
  status                text not null default 'draft',
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  primary key (organization_id, goal_id),
  -- Named rather than inline so the runner's readiness assertion and the
  -- migration test can both address them, and so a failure says which rule
  -- was broken.
  constraint pilot_coach_development_goals_status_check
    check (status in ('draft', 'active', 'completed', 'cancelled')),
  constraint pilot_coach_development_goals_coach_fk
    foreign key (coach_account_id, organization_id)
    references pilot.organization_memberships(account_id, organization_id) on delete cascade
);

create table if not exists pilot.coach_development_activities (
  organization_id       text not null references pilot.organizations(organization_id) on delete cascade,
  activity_id           text not null,
  coach_account_id      text not null,
  -- Optional. A course taken for its own sake is a real thing that happened
  -- and does not need a goal to justify it.
  goal_id               text null,
  title                 text not null
                        check (length(btrim(title, E' \t\r\n\f\v')) > 0),
  -- Who ran it. Empty means nobody recorded one -- never a provider named
  -- '' and never an invented one. Same NOT NULL DEFAULT '' shape
  -- pilot.external_competitions.sanctioning_body uses, and read the same
  -- way at the surface.
  provider              text not null default '',
  -- When it happened. Required: an activity with no date is a claim, not a
  -- record, and the whole value of this table is that it is a record.
  occurred_on           date not null,
  -- Optional, and NOT CEU hours. Nothing sums this column. See the header.
  duration_minutes      integer null,
  notes                 text not null default '',
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  primary key (organization_id, activity_id),
  -- Zero minutes is not a duration and a negative one is a typo. Null is the
  -- honest "not recorded" and stays allowed.
  constraint pilot_coach_development_activities_duration_check
    check (duration_minutes is null or duration_minutes > 0),
  constraint pilot_coach_development_activities_coach_fk
    foreign key (coach_account_id, organization_id)
    references pilot.organization_memberships(account_id, organization_id) on delete cascade,
  -- No ON DELETE action on purpose -- see the header. Nothing deletes a goal
  -- in this slice, and the next person to want to is the one who should
  -- decide what happens to the work that was done against it.
  constraint pilot_coach_development_activities_goal_fk
    foreign key (organization_id, goal_id)
    references pilot.coach_development_goals(organization_id, goal_id)
);

-- A coach's own goals, newest first: the only read either surface makes.
create index if not exists idx_coach_development_goals_by_coach
  on pilot.coach_development_goals(organization_id, coach_account_id, created_at desc);

-- A coach's own activity history, most recent work first.
create index if not exists idx_coach_development_activities_by_coach
  on pilot.coach_development_activities(organization_id, coach_account_id, occurred_on desc);

-- "What did I do about this goal" -- partial, because most activities carry
-- no goal and have no business in this index.
create index if not exists idx_coach_development_activities_by_goal
  on pilot.coach_development_activities(organization_id, goal_id)
  where goal_id is not null;

comment on table pilot.coach_development_goals is
  'A coach''s own stated development intention: a title, what they say they are trying to get better at, an optional target date, and a lifecycle state. Records an intention; computes nothing. No progress, percentage, score, level or completion value is stored or derived here.';

comment on column pilot.coach_development_goals.development_focus is
  'The coach''s own words for what they are trying to get better at. Stored verbatim, never coerced into a competency framework and never algorithmically reinterpreted.';

comment on column pilot.coach_development_goals.status is
  'draft (written, not being worked) / active / completed / cancelled. Set by the coach; the platform never advances it.';

comment on table pilot.coach_development_activities is
  'Development work a coach actually did: a course, clinic, workshop, topic or observation, with when it happened and optionally how long it took. SELF-ENTERED AND UNVERIFIED. This is not a credential record -- clearances live in pilot.person_clearances and are verified by an administrator -- and a row here confers no clearance and is not evidence of one.';

comment on column pilot.coach_development_activities.duration_minutes is
  'Optional. How long this one activity took, in minutes. NOT CEU hours: nothing in this platform sums this column, because a computed total built from unverified self-report would be read as compliance evidence.';

comment on column pilot.coach_development_activities.provider is
  'Who ran it, or empty when nobody recorded one. Empty reads as nothing at every surface, never as a provider named with the empty string.';
