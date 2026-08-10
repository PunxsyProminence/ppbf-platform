-- Achievements beyond the fight: personal goals, coach recognition, non-fight
-- milestones, mentorship, and the program somebody actually came here for.
--
-- WHY THIS EXISTS
--
-- The gym runs four programs -- youth mentorship, fitness-only membership,
-- adult recreational boxing, and competitive boxing -- and the platform could
-- only measure one of them. Everything an athlete could accumulate was a
-- session count or a fight-shaped metric, so a fitness-only member and a kid
-- who comes for the mentorship both opened a progression system that was not
-- measuring what they came for. Worse, there was no path at all for a coach to
-- tell an athlete they did well: every coach-to-athlete write in the schema is
-- a gap, an assignment, a review, or a restriction.
--
-- NOTHING HERE CAN PUNISH AN ABSENCE
--
-- This is the load-bearing constraint of the whole achievement system and the
-- argument is written out at apps/web/components/TrainingCard.tsx lines 19-24:
-- the platform runs a safety gate that locks athletes out for medical reasons,
-- so any run, chain or streak would mean an athlete watching progress die
-- because a doctor protected them -- a direct incentive to under-report a
-- concussion, in a contact sport, to children.
--
-- So there is no column anywhere in this file that can hold a streak, a run
-- length, a last-seen date used as a decay input, a required cadence, or an
-- expiry. Every award below is a row that is written once and never comes off.
-- An athlete who trains for six weeks and then misses three months has exactly
-- the same achievement record on the day they come back as on the day they
-- left. That is not a nicety, it is the schema's shape: there is nothing to
-- decay because nothing here is a rate.
--
-- NOTHING HERE CAN BE RANKED BETWEEN ATHLETES
--
-- Every table is athlete-scoped and every read the application performs is by
-- one athlete_id. There is deliberately no score column, no points column, no
-- weight, no tier, no ordinal, and no aggregate view. A leaderboard needs a
-- comparable number per athlete and this schema does not have one to offer:
-- the closest thing is `count(*)`, and the application layer exposes no route
-- that groups by athlete_id (recognitionNoRanking.test.ts pins that).
--
-- NOTHING HERE MAY ENCODE HEALTH, INJURY, CLEARANCE OR DISCIPLINE
--
-- pilot.athlete_programs deliberately does NOT reuse pilot.athletes.gym_status,
-- which wallDisplayPrivacy.test.ts already classifies as a record about a
-- person's body. A program is the answer to "what did you come here for", it is
-- chosen by the athlete, and its vocabulary is four program names with no
-- medical or disciplinary reading. pilot.recognitions carries a closed
-- POSITIVE-ONLY vocabulary enforced by a check constraint, no severity, no
-- rating and no numeric column -- there is no way to express a negative
-- observation in it, which is what keeps "catching somebody being good" from
-- becoming a behaviour file.
--
-- No `begin;`/`commit;` here: the runner
-- (apps/web/scripts/pilot-apply-achievements-migration.mjs) opens the
-- transaction itself, matching the drills / announcements / board-seats
-- convention.

-- ---------------------------------------------------------------------------
-- A. PERSONAL GOALS, IN THE ATHLETE'S OWN WORDS
--
-- pilot.goals already exists and already holds free text, so this EXTENDS it
-- rather than opening a second goals table that would split one athlete's
-- goals across two places. Every column added is nullable or defaulted, so
-- every goal written before this migration stays exactly as valid as it was.
--
-- target_date loses its NOT NULL. "Run a mile without stopping" and "show up on
-- the days I don't want to" are real goals with no date, and the old column
-- forced an athlete to invent a deadline for a goal that has none -- which is
-- the first step toward a goal that can be failed on a calendar. Existing
-- writers still send a date; nothing about their rows changes.
-- ---------------------------------------------------------------------------

alter table pilot.goals
  add column if not exists goal_kind text not null default 'smart';

alter table pilot.goals
  add column if not exists own_words text not null default '';

alter table pilot.goals
  add column if not exists why_it_matters text not null default '';

alter table pilot.goals
  add column if not exists set_by_role text not null default 'unknown';

-- The moment reached, which is what the ceremony fires on. NULL means "still
-- working", never "failed" -- there is no failed state for a goal somebody set
-- for themselves, and no column here can express one.
alter table pilot.goals
  add column if not exists reached_at timestamptz null;

alter table pilot.goals
  alter column target_date drop not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'pilot_goals_kind_check'
      and conrelid = 'pilot.goals'::regclass
  ) then
    alter table pilot.goals
      add constraint pilot_goals_kind_check
      check (goal_kind in ('smart', 'own_words'));
  end if;
end
$$;

-- The athlete's own goals, newest first -- the only read this half adds.
create index if not exists idx_pilot_goals_org_athlete_kind
  on pilot.goals(organization_id, athlete_id, goal_kind, created_at desc);

-- ---------------------------------------------------------------------------
-- B. RECOGNITION -- A COACH CATCHING SOMEBODY BEING GOOD
--
-- The single largest missing feature in the platform: there was no path for a
-- coach to tell an athlete they did well.
--
-- THE VOCABULARY IS CLOSED AND POSITIVE. Every value in the check constraint
-- is a good thing a person did. There is no 'concern', no 'warning', no
-- 'incident', no severity, no rating, and no numeric column, so a negative
-- observation is not merely discouraged here -- it is unrepresentable. Widening
-- this constraint with a negative value would be a schema change, reviewed,
-- and it would fail recognition.test.ts.
--
-- THE ATHLETE ALWAYS SEES IT. There is no visibility column, no coach-private
-- flag, and no draft state. A record whose subject reads every row of it cannot
-- quietly become a file kept on them.
--
-- IT IS APPEND-ONLY. No updated_at, no status, no retracted flag. The
-- application exposes no edit and no delete, for the same reason the training
-- card never un-stamps: something a coach said to an athlete is not something
-- the platform should be able to take back off them, and a rescindable
-- compliment is a lever.
--
-- note is capped at 140 characters by the constraint below. That is enough for
-- "that was the best round you've had, kid" and far too little for an incident
-- report, which is the point.
-- ---------------------------------------------------------------------------

create table if not exists pilot.recognitions (
  organization_id text not null references pilot.organizations(organization_id),
  recognition_id text not null,
  athlete_id text not null,
  -- Who said it. The account, plus the name as it stood that day: a coach can
  -- leave the gym and their words still have to carry a person's name.
  coach_account_id text not null,
  coach_display_name text not null,
  kind text not null,
  note text not null default '',
  created_at timestamptz not null default now(),
  constraint pilot_recognitions_pkey primary key (organization_id, recognition_id),
  constraint pilot_recognitions_athlete_fk
    foreign key (organization_id, athlete_id)
    references pilot.athletes(organization_id, athlete_id) on delete cascade
);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'pilot_recognitions_kind_check'
      and conrelid = 'pilot.recognitions'::regclass
  ) then
    alter table pilot.recognitions
      add constraint pilot_recognitions_kind_check
      check (kind in (
        'helped_someone',
        'showed_up_hard_day',
        'back_after_a_loss',
        'worked_when_it_was_hard',
        'good_partner',
        'took_the_correction',
        'in_early_and_ready',
        'left_it_better',
        'spoke_up_well',
        'looked_after_someone_new'
      ));
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'pilot_recognitions_note_length_check'
      and conrelid = 'pilot.recognitions'::regclass
  ) then
    alter table pilot.recognitions
      add constraint pilot_recognitions_note_length_check
      check (char_length(note) <= 140);
  end if;
end
$$;

-- The only read: one athlete's own recognitions, newest first. Deliberately not
-- an index that would serve `group by athlete_id` cheaply -- there is no such
-- read, and there is not going to be one.
create index if not exists idx_pilot_recognitions_org_athlete_created
  on pilot.recognitions(organization_id, athlete_id, created_at desc);

-- ---------------------------------------------------------------------------
-- C. NON-FIGHT MILESTONES
--
-- Conditioning, craft, community and consistency, so a member who will never
-- spar has a complete progression rather than a boxing ladder with the fighting
-- rungs greyed out.
--
-- The CATALOGUE of milestones lives in apps/web/src/shared/achievementPaths.ts,
-- not here: it is program design that a reviewer should be able to read in one
-- screen, and a milestone_key that is not in the catalogue simply renders as
-- its key rather than breaking a read. This table holds the AWARDS.
--
-- ONE AWARD PER MILESTONE PER ATHLETE, held by the primary key. A milestone is
-- a thing that happened once; awarding it twice would be the first appearance
-- of a countable quantity per athlete, which is the raw material of a
-- leaderboard.
--
-- awarded_at is when it happened. There is no expiry, no review date and no
-- re-qualification: nothing here is a certification that can lapse, because a
-- lapsing achievement is a decay clock and a decay clock punishes an absence.
-- ---------------------------------------------------------------------------

create table if not exists pilot.athlete_milestones (
  organization_id text not null references pilot.organizations(organization_id),
  athlete_id text not null,
  milestone_key text not null,
  -- 'coach' or 'self'. A fitness-only member logs their own mile; a coach marks
  -- the first full round they watched. Both are legitimate and the difference
  -- is worth keeping, but neither outranks the other.
  awarded_by_role text not null default 'coach',
  awarded_by_account_id text null,
  note text not null default '',
  awarded_at timestamptz not null default now(),
  constraint pilot_athlete_milestones_pkey
    primary key (organization_id, athlete_id, milestone_key),
  constraint pilot_athlete_milestones_athlete_fk
    foreign key (organization_id, athlete_id)
    references pilot.athletes(organization_id, athlete_id) on delete cascade
);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'pilot_athlete_milestones_awarded_by_check'
      and conrelid = 'pilot.athlete_milestones'::regclass
  ) then
    alter table pilot.athlete_milestones
      add constraint pilot_athlete_milestones_awarded_by_check
      check (awarded_by_role in ('coach', 'self', 'parent'));
  end if;
end
$$;

create index if not exists idx_pilot_athlete_milestones_org_athlete
  on pilot.athlete_milestones(organization_id, athlete_id, awarded_at desc);

-- ---------------------------------------------------------------------------
-- D. MENTORSHIP
--
-- Who is mentoring whom, visible on both sides. This is what turns a roster
-- into a community structure, and it is the only table here that relates two
-- athletes.
--
-- ended_on closes a pairing without deleting it: people move on, and the fact
-- that somebody mentored somebody else last season is still true. A closed
-- pairing is history, never a failure -- there is no outcome column and no
-- reason column, so nothing here can record that a mentorship "did not work".
--
-- The partial unique index permits exactly one OPEN pairing per (mentor,
-- mentee) while allowing the same two people to be paired again later.
-- ---------------------------------------------------------------------------

create table if not exists pilot.mentorships (
  organization_id text not null references pilot.organizations(organization_id),
  mentorship_id text not null,
  mentor_athlete_id text not null,
  mentee_athlete_id text not null,
  started_on date not null default current_date,
  ended_on date null,
  created_by_account_id text null,
  note text not null default '',
  created_at timestamptz not null default now(),
  constraint pilot_mentorships_pkey primary key (organization_id, mentorship_id),
  constraint pilot_mentorships_mentor_fk
    foreign key (organization_id, mentor_athlete_id)
    references pilot.athletes(organization_id, athlete_id) on delete cascade,
  constraint pilot_mentorships_mentee_fk
    foreign key (organization_id, mentee_athlete_id)
    references pilot.athletes(organization_id, athlete_id) on delete cascade,
  -- Nobody mentors themselves, and a self-pairing would double-count the
  -- person on both sides of every read.
  constraint pilot_mentorships_distinct_people_check
    check (mentor_athlete_id <> mentee_athlete_id)
);

create unique index if not exists pilot_mentorships_one_open_pair
  on pilot.mentorships(organization_id, mentor_athlete_id, mentee_athlete_id)
  where ended_on is null;

-- Both directions are read: "who do I mentor" and "who mentors me". Neither is
-- served by the other's index.
create index if not exists idx_pilot_mentorships_org_mentor
  on pilot.mentorships(organization_id, mentor_athlete_id, ended_on);

create index if not exists idx_pilot_mentorships_org_mentee
  on pilot.mentorships(organization_id, mentee_athlete_id, ended_on);

-- ---------------------------------------------------------------------------
-- E. THE PROGRAM SOMEBODY CAME FOR
--
-- Which progression an athlete sees. NOT derived from pilot.athletes.gym_status
-- -- that column is already classified as a record about a person's body
-- (wallDisplayPrivacy.test.ts), and a progression path must never be readable
-- as a medical or disciplinary fact.
--
-- The vocabulary is four programs the gym actually runs. None of them is a
-- rank, none is a level, and none is above another: a fitness-only member is
-- not a competitive athlete who has not got there yet. That ordering is exactly
-- the thing this table exists to refuse.
--
-- A missing row is not an error. An athlete with no row sees the general path,
-- which is every track except the competition one -- and the competition track
-- is ABSENT for them rather than greyed out, because a greyed-out rung is how
-- a system tells somebody they are the incomplete version of somebody else.
-- ---------------------------------------------------------------------------

create table if not exists pilot.athlete_programs (
  organization_id text not null references pilot.organizations(organization_id),
  athlete_id text not null,
  program text not null,
  updated_at timestamptz not null default now(),
  constraint pilot_athlete_programs_pkey primary key (organization_id, athlete_id),
  constraint pilot_athlete_programs_athlete_fk
    foreign key (organization_id, athlete_id)
    references pilot.athletes(organization_id, athlete_id) on delete cascade
);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'pilot_athlete_programs_program_check'
      and conrelid = 'pilot.athlete_programs'::regclass
  ) then
    alter table pilot.athlete_programs
      add constraint pilot_athlete_programs_program_check
      check (program in ('fitness', 'youth', 'recreational', 'competitive'));
  end if;
end
$$;

comment on table pilot.recognitions is
  'Coach-to-athlete positive recognition. Closed positive vocabulary, append-only, always visible to the athlete it is about. Never a behaviour or disciplinary record; there is no column in which a negative observation can be written.';

comment on table pilot.athlete_milestones is
  'Non-fight milestone awards (conditioning, craft, community, consistency). One row per athlete per milestone, never removed, never expiring -- an absence cannot reduce it.';

comment on table pilot.mentorships is
  'Who mentors whom, visible to both. ended_on closes a pairing; there is no outcome or reason column, so a closed pairing is history rather than a failure.';

comment on table pilot.athlete_programs is
  'What an athlete came to the gym for. Deliberately separate from pilot.athletes.gym_status, which is body data. Not a rank: the four programs do not order.';
