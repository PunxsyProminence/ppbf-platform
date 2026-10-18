-- The learning loop's storage (lane L49, ChatGPT non-video ML audit item 9):
-- what a coach saw an athlete do, the gym's shared list of behaviour names,
-- and the versioned bars the pattern and lesson evaluators read
-- (apps/web/src/server/pilot/patterns/, which persists nothing itself).
--
-- OWNER RULINGS (Jason 2026-10-18, relayed by Overwatch):
--   Q1 "A: Shared growing list" -- a behaviour is named from the gym's own
--      list, each name under one skill code, and coaches grow the list.
--   Q2 "A: Staff only" -- these rows are coaching records about children;
--      nothing here is served to an athlete, a parent or a public surface.
--   Q3 "Needs to be backed by research" -- a bar is stored only with its
--      citations. This migration ships NO bar: the tables start empty, and
--      the evaluators abstain until a person ratifies a cited version.
--
-- ONE ROW PER REPORT, ONE EPISODE PER ATTEMPT. Two coaches reporting the same
-- rep are two rows sharing one episode_id, and the evaluator counts the
-- episode once. Every report of an episode must be about the same athlete,
-- behaviour, session and drill; the guard refuses one that is not. A
-- coach's own second report of an episode supersedes their first.
--
-- APPEND-ONLY. A report is never edited or deleted by hand. The only
-- updates take identification away: the purge's de-identification (the
-- athlete key becomes the purge's anon_ token; Jason 2026-10-06, "delete any
-- thing that personally Identifys the person but we keep data that [makes]
-- the Ai and ML better"), the purge's name scrub of a coach's note (Jason
-- 2026-10-07, "Scrub the child's name, keep"; "Gym-wide"), and the
-- observer's account being set null when that account is deleted. An
-- athlete delete that has NOT de-identified first takes the athlete's rows
-- with it (the follow trigger below), the same shape as
-- pilot_slice_postgres_shadow_deidentify_keys_migration.sql, whose token
-- shape (anon_<uuid>) the de-identified rows must match.
--
-- DEPENDS ON pilot.organizations, pilot.accounts, pilot.athletes,
-- pilot.organization_memberships, pilot.intervention_protocols and
-- pilot.intervention_executions. Idempotent: if-not-exists throughout,
-- functions create-or-replace, triggers dropped and created by name. No
-- begin;/commit; (the runner is scripts/pilot-apply-learning-loop-migration.mjs).

create table if not exists pilot.behaviour_keys (
  organization_id text not null references pilot.organizations(organization_id) on delete cascade,
  behaviour_key text not null,
  label text not null,
  skill_id text not null,
  status text not null default 'active',
  created_by_account_id text null references pilot.accounts(account_id) on delete set null,
  created_at timestamptz not null default now(),
  constraint pilot_behaviour_keys_pkey primary key (organization_id, behaviour_key),
  constraint pilot_behaviour_keys_key_check check (behaviour_key ~ '^[a-z][a-z0-9_]{2,79}$'),
  constraint pilot_behaviour_keys_label_check
    check (length(btrim(label)) between 3 and 120 and label ~ '[^[:space:]]'),
  -- The skill code shape contentImport/ids.ts SKILL_CODE_PATTERN names (SK-STANCE-01).
  constraint pilot_behaviour_keys_skill_check check (skill_id ~ '^SK-[A-Z]+-[0-9]{2}$'),
  constraint pilot_behaviour_keys_status_check check (status in ('active', 'retired'))
);

-- A name keeps its meaning once coaches file reports under it: only its
-- status moves (retire it and add a new name rather than re-word or re-file
-- one), its creator is set null when their account goes, and the purge may
-- scrub a purged person's name out of its label (Jason 2026-10-07, "Scrub the
-- child's name, keep"; "Gym-wide"). That scrub is checked EXACTLY: the purge
-- sets its name pattern for the transaction (pilot.name_scrub_pattern) and the
-- label must become precisely what that pattern makes of it, so the one
-- admitted change can only turn names into [name].
create or replace function pilot.behaviour_keys_guard()
returns trigger
language plpgsql
as $behaviour_keys_guard$
begin
  if tg_op = 'DELETE' then
    if pg_trigger_depth() = 1 then
      raise exception 'BEHAVIOUR_KEY_IS_RETIRED_NOT_DELETED'
        using errcode = '23514', constraint = 'pilot_behaviour_keys_no_delete';
    end if;
    return old;
  end if;
  if tg_op = 'UPDATE' then
    if to_jsonb(new) - 'status' = to_jsonb(old) - 'status' then
      return new;
    end if;
    if coalesce(current_setting('pilot.name_scrub_pattern', true), '') <> ''
       and new.label is distinct from old.label
       and new.label = left(regexp_replace(old.label, current_setting('pilot.name_scrub_pattern', true), '[name]', 'gi'), 120)
       and to_jsonb(new) - 'label' = to_jsonb(old) - 'label' then
      return new;
    end if;
    if pg_trigger_depth() > 1 and new.created_by_account_id is null
       and to_jsonb(new) - 'created_by_account_id' = to_jsonb(old) - 'created_by_account_id' then
      return new;
    end if;
    raise exception 'BEHAVIOUR_KEY_MEANING_IS_FIXED'
      using errcode = '23514', constraint = 'pilot_behaviour_keys_meaning_fixed';
  end if;
  -- A new name is always someone's: the creator is nullable only so their
  -- account can go later (on delete set null), never on the way in.
  if new.organization_id is not null and (new.created_by_account_id is null or not exists (
    select 1 from pilot.organization_memberships om
      join pilot.accounts acc on acc.account_id = om.account_id
     where om.account_id = new.created_by_account_id and om.organization_id = new.organization_id
       and om.active_flag and om.role in ('coach', 'organization_admin', 'admin')
       and acc.active_flag and acc.deleted_at is null
  )) then
    raise exception 'BEHAVIOUR_KEY_CREATOR_OF_THIS_GYM'
      using errcode = '23514', constraint = 'pilot_behaviour_keys_creator_of_this_gym';
  end if;
  return new;
end;
$behaviour_keys_guard$;

drop trigger if exists trg_behaviour_keys_guard on pilot.behaviour_keys;
create trigger trg_behaviour_keys_guard
  before insert or update or delete on pilot.behaviour_keys
  for each row execute function pilot.behaviour_keys_guard();

create table if not exists pilot.behaviour_observations (
  organization_id text not null references pilot.organizations(organization_id) on delete cascade,
  observation_id uuid not null default gen_random_uuid(),
  -- No foreign key: an anon_ token satisfies none. The guard checks the
  -- athlete on insert and the follow trigger deletes with the athlete.
  athlete_id text not null,
  behaviour_key text not null,
  episode_id text not null,
  session_key text not null,
  task_context_key text not null,
  task_constraint text not null,
  fatigue_context text not null default 'unknown',
  polarity text not null,
  attribution_target text not null,
  attribution_certainty text not null,
  source_type text not null,
  source_quality text not null,
  interpretation text not null default 'human_observed',
  observer_account_id text null references pilot.accounts(account_id) on delete set null,
  author_role text not null,
  supersedes_observation_id uuid null,
  note text not null default '',
  observed_at timestamptz not null,
  created_at timestamptz not null default now(),
  deidentified_at timestamptz null,
  constraint pilot_behaviour_observations_pkey primary key (organization_id, observation_id),
  constraint pilot_behaviour_observations_key_fk foreign key (organization_id, behaviour_key)
    references pilot.behaviour_keys(organization_id, behaviour_key),
  constraint pilot_behaviour_observations_supersedes_fk foreign key (organization_id, supersedes_observation_id)
    references pilot.behaviour_observations(organization_id, observation_id),
  -- The library's vocabularies (patterns/types.ts), verbatim.
  constraint pilot_behaviour_observations_constraint_check
    check (task_constraint in ('controlled', 'constrained_live', 'live')),
  constraint pilot_behaviour_observations_fatigue_check
    check (fatigue_context in ('fresh', 'moderate', 'fatigued', 'unknown')),
  constraint pilot_behaviour_observations_polarity_check
    check (polarity in ('occurrence', 'counterexample')),
  constraint pilot_behaviour_observations_attribution_check
    check (attribution_target in ('athlete', 'coach_cue', 'task_design', 'partner_role',
                                  'environment', 'equipment', 'unresolved')),
  constraint pilot_behaviour_observations_certainty_check
    check (attribution_certainty in ('stated', 'probable', 'uncertain')),
  constraint pilot_behaviour_observations_quality_check
    check (source_quality in ('verified', 'high', 'moderate', 'low', 'failed')),
  -- v1 is a person's own eyes only. Film or model output enters later, as
  -- its own widening of these two checks.
  constraint pilot_behaviour_observations_source_check check (source_type in ('coach_tag', 'manual')),
  constraint pilot_behaviour_observations_interpretation_check check (interpretation = 'human_observed'),
  constraint pilot_behaviour_observations_role_check
    check (author_role in ('coach', 'organization_admin', 'admin')),
  -- A session is a run, or the gym's calendar day when there is no run.
  constraint pilot_behaviour_observations_session_check
    check (session_key ~ '^(run:[^[:space:]]+|day:[0-9]{4}-[0-9]{2}-[0-9]{2})$'),
  constraint pilot_behaviour_observations_context_check
    check (task_context_key ~ '^(drill|block|context):[^[:space:]]+$'),
  -- A logged training attempt is its own episode; otherwise the server mints one.
  constraint pilot_behaviour_observations_episode_check
    check (episode_id ~ '^(attempt:[^[:space:]]+|ep:[0-9a-f-]{36})$'),
  constraint pilot_behaviour_observations_note_check check (length(note) <= 2000),
  constraint pilot_behaviour_observations_deidentified_check
    check (deidentified_at is null or athlete_id ~ '^anon_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
);

create index if not exists idx_behaviour_observations_athlete
  on pilot.behaviour_observations(organization_id, athlete_id, behaviour_key, observed_at);
create index if not exists idx_behaviour_observations_episode
  on pilot.behaviour_observations(organization_id, episode_id);
-- A report is superseded at most once: revisions form a chain, never a fork.
create unique index if not exists idx_behaviour_observations_one_successor
  on pilot.behaviour_observations(organization_id, supersedes_observation_id)
  where supersedes_observation_id is not null;

create or replace function pilot.behaviour_observations_guard()
returns trigger
language plpgsql
as $behaviour_observations_guard$
declare
  prior pilot.behaviour_observations%rowtype;
  leaf_id uuid;
begin
  if tg_op = 'DELETE' then
    -- Only as a consequence: the athlete follow trigger or a gym cascade.
    if pg_trigger_depth() = 1 then
      raise exception 'BEHAVIOUR_OBSERVATION_IS_NOT_DELETED'
        using errcode = '23514', constraint = 'pilot_behaviour_observations_no_delete';
    end if;
    return old;
  end if;

  if tg_op = 'UPDATE' then
    -- Three updates only, and each can only take identification away.
    -- (1) The observer's account going: the foreign key's own set-null
    -- action, which runs this deeper than 1; nothing else moves.
    if pg_trigger_depth() > 1 and new.observer_account_id is null
       and to_jsonb(new) - 'observer_account_id' = to_jsonb(old) - 'observer_account_id' then
      return new;
    end if;
    -- (2) The purge's de-identification of a DELETED athlete's reports,
    -- before it deletes the athlete (scripts/pilot-cleanup-deleted-data.mjs,
    -- deidentifyBehaviourObservations): the athlete key becomes the purge's
    -- token and the note is emptied, or scrubbed of the child's names by
    -- exactly the pattern the purge set for the transaction; nothing else
    -- moves, and it happens once.
    if old.deidentified_at is null and new.deidentified_at is not null
       and new.athlete_id ~ '^anon_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       and not exists (
         select 1 from pilot.athletes a
          where a.organization_id = old.organization_id and a.athlete_id = old.athlete_id
            and a.deleted_at is null)
       and (new.note = ''
            or (coalesce(current_setting('pilot.name_scrub_pattern', true), '') <> ''
                and new.note = left(regexp_replace(old.note, current_setting('pilot.name_scrub_pattern', true), '[name]', 'gi'), 2000)))
       and to_jsonb(new) - array['athlete_id', 'note', 'deidentified_at']
         = to_jsonb(old) - array['athlete_id', 'note', 'deidentified_at'] then
      return new;
    end if;
    -- (3) The purge's gym-wide name scrub (scrubGymNotes): another report's
    -- note naming a purged person becomes exactly what the purge's pattern
    -- makes of it; nothing else moves.
    if coalesce(current_setting('pilot.name_scrub_pattern', true), '') <> ''
       and new.note is distinct from old.note
       and new.note = left(regexp_replace(old.note, current_setting('pilot.name_scrub_pattern', true), '[name]', 'gi'), 2000)
       and to_jsonb(new) - 'note' = to_jsonb(old) - 'note' then
      return new;
    end if;
    raise exception 'BEHAVIOUR_OBSERVATION_IS_NOT_CHANGED'
      using errcode = '23514', constraint = 'pilot_behaviour_observations_append_only';
  end if;

  -- INSERT. A missing key is left to NOT NULL, and an out-of-vocabulary value
  -- to its own check, so each is reported by its own name.
  if new.organization_id is null or new.athlete_id is null or new.behaviour_key is null
     or new.episode_id is null or new.author_role is null then
    return new;
  end if;
  if new.deidentified_at is not null or new.athlete_id like 'anon\_%' then
    raise exception 'BEHAVIOUR_OBSERVATION_NEW_ROW_NAMES_AN_ATHLETE'
      using errcode = '23514', constraint = 'pilot_behaviour_observations_live_athlete';
  end if;
  if not exists (
    select 1 from pilot.athletes a
     where a.organization_id = new.organization_id and a.athlete_id = new.athlete_id and a.deleted_at is null
  ) then
    raise exception 'BEHAVIOUR_OBSERVATION_ATHLETE_OF_THIS_GYM'
      using errcode = '23514', constraint = 'pilot_behaviour_observations_live_athlete';
  end if;
  if new.observer_account_id is null or not exists (
    select 1 from pilot.organization_memberships om
      join pilot.accounts acc on acc.account_id = om.account_id
     where om.account_id = new.observer_account_id and om.organization_id = new.organization_id
       and om.active_flag and om.role = new.author_role
       and acc.active_flag and acc.deleted_at is null
  ) then
    raise exception 'BEHAVIOUR_OBSERVATION_OBSERVER_OF_THIS_GYM'
      using errcode = '23514', constraint = 'pilot_behaviour_observations_observer_of_this_gym';
  end if;
  if not exists (
    select 1 from pilot.behaviour_keys k
     where k.organization_id = new.organization_id and k.behaviour_key = new.behaviour_key and k.status = 'active'
  ) then
    raise exception 'BEHAVIOUR_OBSERVATION_KEY_NOT_ACTIVE'
      using errcode = '23514', constraint = 'pilot_behaviour_observations_active_key';
  end if;
  -- One episode's reports are written one at a time, so two arriving together
  -- cannot each miss the other and name two athletes.
  perform pg_advisory_xact_lock(
    hashtextextended('pilot.behaviour_observations|' || new.organization_id || '|' || new.episode_id, 0));
  if exists (
    select 1 from pilot.behaviour_observations o
     where o.organization_id = new.organization_id and o.episode_id = new.episode_id
       and (o.athlete_id, o.behaviour_key, o.session_key, o.task_context_key)
           is distinct from (new.athlete_id, new.behaviour_key, new.session_key, new.task_context_key)
  ) then
    raise exception 'BEHAVIOUR_OBSERVATION_EPISODE_MISMATCH'
      using errcode = '23514', constraint = 'pilot_behaviour_observations_one_episode';
  end if;
  if new.supersedes_observation_id is not null then
    select * into prior from pilot.behaviour_observations o
     where o.organization_id = new.organization_id and o.observation_id = new.supersedes_observation_id;
    -- A revision is the same person's own call on the same episode, of a
    -- report already written: never itself, never a cycle.
    if not found or new.supersedes_observation_id = new.observation_id
       or prior.episode_id <> new.episode_id
       or prior.observer_account_id is distinct from new.observer_account_id then
      raise exception 'BEHAVIOUR_OBSERVATION_REVISION_IS_OWN'
        using errcode = '23514', constraint = 'pilot_behaviour_observations_own_revision';
    end if;
  end if;
  -- One person's call on a moment counts once: once they have reported it,
  -- their next report of it must revise their latest one (under the episode
  -- lock above, so a retried submit cannot slip in a second root report).
  select o.observation_id into leaf_id from pilot.behaviour_observations o
   where o.organization_id = new.organization_id and o.episode_id = new.episode_id
     and o.observer_account_id = new.observer_account_id
     and not exists (
       select 1 from pilot.behaviour_observations s
        where s.organization_id = o.organization_id and s.supersedes_observation_id = o.observation_id)
   order by o.created_at desc, o.observation_id desc
   limit 1;
  if leaf_id is not null and new.supersedes_observation_id is distinct from leaf_id then
    raise exception 'BEHAVIOUR_OBSERVATION_REVISION_IS_OWN'
      using errcode = '23514', constraint = 'pilot_behaviour_observations_own_revision';
  end if;
  return new;
end;
$behaviour_observations_guard$;

drop trigger if exists trg_behaviour_observations_guard on pilot.behaviour_observations;
create trigger trg_behaviour_observations_guard
  before insert or update or delete on pilot.behaviour_observations
  for each row execute function pilot.behaviour_observations_guard();

create or replace function pilot.behaviour_observations_follow_athlete()
returns trigger
language plpgsql
as $behaviour_observations_follow_athlete$
begin
  delete from pilot.behaviour_observations
   where organization_id = old.organization_id and athlete_id = old.athlete_id;
  return old;
end;
$behaviour_observations_follow_athlete$;

drop trigger if exists pilot_behaviour_observations_follow_athlete on pilot.athletes;
create trigger pilot_behaviour_observations_follow_athlete
  before delete on pilot.athletes
  for each row execute function pilot.behaviour_observations_follow_athlete();

-- THE BARS. One versioned row per ratified bar; the evaluators read the
-- active one. Three kinds (Jason 2026-10-18, approving the threshold research):
-- when a behaviour is an emerging, a pattern or an established one; when a
-- lesson improved, likely worked or worked, replicated; and when a coach
-- pair's reports are calibrated enough to count. Q3: a bar is backed by
-- research, so a row without at least one citation ({"source": "...",
-- "note": "..."}) is refused. The parameters are validated by the application
-- (learningPolicies.ts barFor) before insert; the database holds the record of
-- who signed which numbers, when, on what evidence. A new version is always
-- the one in force: it is born active, and only supersedes the last.
create table if not exists pilot.learning_policies (
  organization_id text not null references pilot.organizations(organization_id) on delete cascade,
  policy_id uuid not null default gen_random_uuid(),
  policy_kind text not null,
  version integer not null,
  parameters jsonb not null,
  citations jsonb not null,
  ratified_by_account_id text not null references pilot.accounts(account_id),
  ratified_by_role text not null,
  ratified_at timestamptz not null default now(),
  status text not null default 'active',
  supersedes_policy_id uuid null,
  constraint pilot_learning_policies_pkey primary key (organization_id, policy_id),
  constraint pilot_learning_policies_version_key unique (organization_id, policy_kind, version),
  constraint pilot_learning_policies_supersedes_fk foreign key (organization_id, supersedes_policy_id)
    references pilot.learning_policies(organization_id, policy_id),
  constraint pilot_learning_policies_kind_check
    check (policy_kind in ('pattern_formation', 'athlete_lesson', 'observer_calibration')),
  constraint pilot_learning_policies_version_check check (version >= 1),
  constraint pilot_learning_policies_parameters_check check (jsonb_typeof(parameters) = 'object'),
  constraint pilot_learning_policies_citations_check
    check (jsonb_typeof(citations) = 'array' and jsonb_array_length(citations) >= 1),
  -- Jason 2026-10-18: "A: Gym admin only (Rec.)" -- the organization admin, not the legacy admin role.
  constraint pilot_learning_policies_role_check check (ratified_by_role = 'organization_admin'),
  constraint pilot_learning_policies_status_check check (status in ('active', 'superseded'))
);

-- One bar in force per gym and kind.
create unique index if not exists idx_learning_policies_one_active
  on pilot.learning_policies(organization_id, policy_kind) where status = 'active';

create or replace function pilot.learning_policies_guard()
returns trigger
language plpgsql
as $learning_policies_guard$
declare
  citation jsonb;
begin
  if tg_op = 'DELETE' then
    if pg_trigger_depth() = 1 then
      raise exception 'LEARNING_POLICY_IS_NOT_DELETED'
        using errcode = '23514', constraint = 'pilot_learning_policies_no_delete';
    end if;
    return old;
  end if;

  if tg_op = 'UPDATE' then
    -- Retiring a version is the one change: active to superseded, nothing else.
    if old.status = 'active' and new.status = 'superseded'
       and to_jsonb(new) - 'status' = to_jsonb(old) - 'status' then
      return new;
    end if;
    raise exception 'LEARNING_POLICY_IS_NOT_CHANGED'
      using errcode = '23514', constraint = 'pilot_learning_policies_versioned';
  end if;

  if new.status is distinct from 'active' then
    raise exception 'LEARNING_POLICY_IS_BORN_ACTIVE'
      using errcode = '23514', constraint = 'pilot_learning_policies_new_is_active';
  end if;
  if jsonb_typeof(new.citations) = 'array' then
    for citation in select value from jsonb_array_elements(new.citations) loop
      -- coalesce: a missing key reads as null, and null must refuse, not
      -- pass. A source of only spaces, tabs or newlines names nothing.
      if jsonb_typeof(citation) <> 'object'
         or coalesce(jsonb_typeof(citation->'source'), '') <> 'string'
         or coalesce(citation->>'source', '') !~ '[^[:space:]]' then
        raise exception 'LEARNING_POLICY_CITATION_NAMES_A_SOURCE'
          using errcode = '23514', constraint = 'pilot_learning_policies_citation_source';
      end if;
    end loop;
  end if;
  if new.ratified_by_role is distinct from 'organization_admin' then
    return new;
  end if;
  if not exists (
    select 1 from pilot.organization_memberships om
      join pilot.accounts acc on acc.account_id = om.account_id
     where om.account_id = new.ratified_by_account_id and om.organization_id = new.organization_id
       and om.active_flag and om.role = new.ratified_by_role
       and acc.active_flag and acc.deleted_at is null
  ) then
    raise exception 'LEARNING_POLICY_RATIFIER_OF_THIS_GYM'
      using errcode = '23514', constraint = 'pilot_learning_policies_ratifier_of_this_gym';
  end if;
  if new.supersedes_policy_id is not null and not exists (
    select 1 from pilot.learning_policies p
     where p.organization_id = new.organization_id and p.policy_id = new.supersedes_policy_id
       and p.policy_kind = new.policy_kind and p.version = new.version - 1
  ) then
    raise exception 'LEARNING_POLICY_SUPERSEDES_ITS_PREVIOUS_VERSION'
      using errcode = '23514', constraint = 'pilot_learning_policies_version_chain';
  end if;
  if (new.version = 1) <> (new.supersedes_policy_id is null) then
    raise exception 'LEARNING_POLICY_SUPERSEDES_ITS_PREVIOUS_VERSION'
      using errcode = '23514', constraint = 'pilot_learning_policies_version_chain';
  end if;
  return new;
end;
$learning_policies_guard$;

drop trigger if exists trg_learning_policies_guard on pilot.learning_policies;
create trigger trg_learning_policies_guard
  before insert or update or delete on pilot.learning_policies
  for each row execute function pilot.learning_policies_guard();

-- Which behaviour an intervention protocol targets, and the drill an
-- execution was actually trained in, in the observations' own key shape
-- (the lesson evaluator's trainedTaskContextKey). Both optional; no backfill.
alter table pilot.intervention_protocols add column if not exists behaviour_key text null;
alter table pilot.intervention_executions add column if not exists trained_task_context_key text null;

do $learning_loop_intervention_keys$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = to_regclass('pilot.intervention_protocols')
       and conname = 'pilot_intervention_protocols_behaviour_key_fk'
  ) then
    alter table pilot.intervention_protocols
      add constraint pilot_intervention_protocols_behaviour_key_fk
      foreign key (organization_id, behaviour_key)
      references pilot.behaviour_keys(organization_id, behaviour_key);
  end if;
  if not exists (
    select 1 from pg_constraint
     where conrelid = to_regclass('pilot.intervention_executions')
       and conname = 'pilot_intervention_executions_trained_context_key_check'
  ) then
    alter table pilot.intervention_executions
      add constraint pilot_intervention_executions_trained_context_key_check
      check (trained_task_context_key is null
             or trained_task_context_key ~ '^(drill|block|context):[^[:space:]]+$');
  end if;
end
$learning_loop_intervention_keys$;
