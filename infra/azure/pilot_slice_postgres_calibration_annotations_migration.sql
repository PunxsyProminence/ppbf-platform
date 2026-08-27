-- Calibration annotation sets and events (pilot.calibration_annotation_sets,
-- pilot.calibration_annotation_events) -- what one annotator says they saw in
-- one clip, under boxing-ontology-0.1.
--
-- STACKED ON the calibration projects migration. It needs
-- pilot.calibration_clips to exist.
--
-- ONE ANNOTATOR, ONE CLIP, ONE SET. That uniqueness is the unit of
-- measurement. Two people labelling the same clip produce two sets, and the
-- whole point of the exercise is that neither is derived from the other.
--
-- THE ORIGINAL IS NEVER OVERWRITTEN. Once a set is submitted, its events
-- cannot be inserted, updated, or deleted -- enforced by a trigger, not by
-- application code, for the reason the feedback-submission freeze already
-- states: any process with write access can issue an UPDATE, and only the
-- database sees all of them. Here it is stronger than a data-integrity nicety.
-- If annotator A could revise their set after seeing B's, "independent" would
-- be a claim about intent rather than a property of the system, and every
-- agreement figure computed downstream would be worthless.
--
-- TIMESTAMPS ARE IN VIDEO COORDINATES, not clip-relative -- the same origin
-- pilot.calibration_clips.start_ms uses. Three reasons, all of which bite
-- later if the other choice is made: an event stays meaningful if its clip is
-- ever re-cut; two clips overlapping the same moment describe it identically;
-- and the Film Study bridge can one day compare a model proposal to a human
-- event without a coordinate conversion nobody would remember to apply.
--
-- CONTAINMENT IS A FOREIGN KEY, NOT A HOPE. An event must lie inside its
-- clip. That cannot be a plain CHECK, because the bounds live in another
-- table -- so the clip's bounds are carried on the event and tied back by a
-- composite foreign key onto (organization_id, calibration_clip_id, start_ms,
-- end_ms). The copied bounds therefore cannot drift from the clip's real
-- ones, and a simple CHECK against them becomes sufficient. An annotation of
-- footage the annotator was not asked to look at is not storable.
--
-- RELATIONSHIPS CANNOT CROSS ANNOTATORS. counter_against_event_id and
-- defends_against_event_id are self-referential composite foreign keys that
-- include annotation_set_id, so annotator A's event physically cannot point
-- at annotator B's. The blinding rule is enforced at the level where it is
-- an invariant rather than a policy.
--
-- WHAT IS NOT HERE, and must not be added without owner ratification: any
-- notion of fatigue, power, punch quality, technique score, ring control,
-- fight IQ, counter opportunity, scoring blow, or good/bad anything. Every
-- column below records something an annotator can point at on screen.
--
-- Additive and idempotent. No `begin;`/`commit;` here on purpose: the runner
-- (apps/web/scripts/pilot-apply-calibration-annotations-migration.mjs) opens
-- the transaction itself.

-- ---------------------------------------------------------------------------
-- PREREQUISITE on the clips table: a key carrying the bounds.
--
-- Lets an event's copy of its clip's bounds be foreign-keyed back to the
-- clip, which is what turns containment from an application check into a
-- database guarantee. Cannot fail on existing data: (organization_id,
-- calibration_clip_id) is already the primary key, so any superset is unique.
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('pilot.calibration_clips') is not null
    and not exists (
      select 1 from pg_constraint
      where conrelid = to_regclass('pilot.calibration_clips')
        and conname = 'pilot_calibration_clips_bounds_key'
    )
  then
    alter table pilot.calibration_clips
      add constraint pilot_calibration_clips_bounds_key
      unique (organization_id, calibration_clip_id, start_ms, end_ms);
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- One annotator's independent pass over one clip.
-- ---------------------------------------------------------------------------
create table if not exists pilot.calibration_annotation_sets (
  organization_id text not null
    references pilot.organizations(organization_id) on delete cascade,
  annotation_set_id text not null,
  calibration_clip_id text not null,

  annotator_account_id text not null references pilot.accounts(account_id),

  -- Copied from the project rather than joined, so a set carries the
  -- vocabulary it was created under even if it is read alone.
  ontology_version text not null check (length(btrim(ontology_version)) > 0),

  -- in_progress: the annotator is still working, and may edit or delete their
  --   own events.
  -- submitted: finished. The set and its events are frozen by trigger.
  --
  -- There is no 'reopened'. Un-submitting would destroy the only evidence
  -- that a pass was ever completed independently; a genuine re-annotation is
  -- a NEW set, which is also the only shape that preserves both readings.
  status text not null default 'in_progress'
    check (status in ('in_progress', 'submitted')),

  created_at timestamptz not null default now(),
  submitted_at timestamptz null,

  constraint pilot_calibration_sets_pkey
    primary key (organization_id, annotation_set_id),

  -- ONE SET PER ANNOTATOR PER CLIP. The unit of measurement.
  constraint pilot_calibration_sets_one_per_annotator_uq
    unique (organization_id, calibration_clip_id, annotator_account_id),

  -- Target for the events' set-and-clip composite foreign key, so an event
  -- cannot be attached to a set whose clip it does not belong to.
  constraint pilot_calibration_sets_clip_key
    unique (organization_id, annotation_set_id, calibration_clip_id),

  -- The status and its timestamp are one fact, not two. A set that says it is
  -- submitted with no submission time cannot be ordered against another
  -- annotator's, which is the one thing a blinding audit needs to do.
  constraint pilot_calibration_sets_submission_attested check (
    (status = 'in_progress' and submitted_at is null)
    or (status = 'submitted' and submitted_at is not null)
  ),

  constraint pilot_calibration_sets_clip_fk
    foreign key (organization_id, calibration_clip_id)
    references pilot.calibration_clips(organization_id, calibration_clip_id)
    on delete cascade
);

create index if not exists idx_calibration_sets_clip
  on pilot.calibration_annotation_sets(organization_id, calibration_clip_id, status);

create index if not exists idx_calibration_sets_annotator
  on pilot.calibration_annotation_sets(organization_id, annotator_account_id, status);

-- ---------------------------------------------------------------------------
-- What the annotator saw.
-- ---------------------------------------------------------------------------
create table if not exists pilot.calibration_annotation_events (
  organization_id text not null
    references pilot.organizations(organization_id) on delete cascade,
  event_id text not null,
  annotation_set_id text not null,
  calibration_clip_id text not null,

  -- The clip's own bounds, carried so containment can be a CHECK. Kept honest
  -- by pilot_calibration_events_clip_fk, which references the clip's bounds
  -- key -- these cannot say something the clip does not.
  clip_start_ms integer not null,
  clip_end_ms integer not null,

  event_class text not null check (event_class in ('punch', 'defense')),

  -- Which fighter. Free text on purpose: the ontology ratifies labels for
  -- what a fighter DID, not for how a study names its participants, and a
  -- fixed 'A'/'B' vocabulary would be this file inventing one.
  actor_track text not null check (length(btrim(actor_track)) > 0),
  opponent_track text null,

  -- Video-coordinate milliseconds. See the header.
  start_ms integer not null,
  end_ms integer not null,

  -- Optional and INDEPENDENT of each other. A punch may have an observable
  -- contact and no observable peak, or the reverse; requiring both would
  -- force an annotator to invent one to record the other.
  contact_ms integer null,
  peak_ms integer null,

  -- The actor's body. Permitted on both classes: a block has a hand and a
  -- stance just as a hook does.
  physical_hand text null check (physical_hand in ('left', 'right', 'unknown')),
  hand_role text null check (hand_role in ('lead', 'rear', 'unknown')),
  stance text null check (stance in ('orthodox', 'southpaw', 'transition', 'unknown')),

  -- Punch only.
  punch_type text null check (punch_type in (
    'lead_straight', 'rear_straight',
    'lead_hook', 'rear_hook',
    'lead_uppercut', 'rear_uppercut',
    'other_punch', 'unclassifiable_punch'
  )),
  -- Where it was AIMED.
  target_zone text null check (target_zone in ('head', 'torso', 'unknown')),
  -- What it DID.
  contact_result text null check (contact_result in (
    'clean_target_contact', 'glancing_target_contact', 'guard_contact',
    'non_target_contact', 'no_contact', 'uncertain_contact'
  )),
  -- What it REACHED. 'none' is an observed miss; 'unknown' is an unobservable
  -- outcome. Neither may stand in for the other.
  contact_zone text null check (contact_zone in (
    'head', 'torso', 'glove', 'forearm', 'arm', 'non_target', 'none', 'unknown'
  )),

  -- Defense only. Names the MOVEMENT, never whether it worked -- whether the
  -- incoming punch landed is recorded on that punch's own contact_result.
  defense_type text null check (defense_type in (
    'block', 'parry', 'slip', 'roll_weave', 'duck', 'pull_back', 'step_back',
    'lateral_step', 'pivot', 'smother', 'clinch_defense',
    'other_defense', 'unclassifiable_defense'
  )),

  -- Required on EVERY event, and never defaulted.
  --
  -- visibility is a property of the FOOTAGE, certainty of the ANNOTATOR. They
  -- share the token 'clear' and mean different things by it, which is why
  -- they are separate columns with separate CHECKs rather than one field.
  -- Without visibility, a disagreement cannot be told apart from a camera
  -- angle, and the study measures nothing.
  visibility text not null check (visibility in (
    'clear', 'partially_occluded', 'fully_occluded', 'outside_frame', 'camera_cut'
  )),
  certainty text not null check (certainty in ('clear', 'probable', 'uncertain')),

  -- Punch only. A label for one exchange, and this event's place in it.
  combination_group text null check (combination_group is null or length(btrim(combination_group)) > 0),
  sequence_order integer null check (sequence_order is null or sequence_order > 0),

  counter_against_event_id text null,
  defends_against_event_id text null,

  created_at timestamptz not null default now(),

  constraint pilot_calibration_events_pkey
    primary key (organization_id, event_id),

  -- Target for the self-referential relationship foreign keys below.
  constraint pilot_calibration_events_set_key
    unique (organization_id, annotation_set_id, event_id),

  -- An event is a span.
  constraint pilot_calibration_events_span check (start_ms < end_ms),

  -- Inclusive on both ends: contact at the exact first or last millisecond of
  -- the event is an observation, not an error.
  constraint pilot_calibration_events_contact_within check (
    contact_ms is null or (contact_ms >= start_ms and contact_ms <= end_ms)
  ),
  constraint pilot_calibration_events_peak_within check (
    peak_ms is null or (peak_ms >= start_ms and peak_ms <= end_ms)
  ),

  -- Containment, made checkable by the carried bounds above.
  constraint pilot_calibration_events_within_clip check (
    start_ms >= clip_start_ms and end_ms <= clip_end_ms
  ),

  -- THE SHAPE OF THE ROW SAYS WHICH KIND OF CLAIM IT IS, in both directions,
  -- the same stance pilot_film_study_proposals_provenance takes. A defense
  -- cannot borrow a punch's fields and a punch cannot borrow a defense's, so
  -- neither class can be half-populated into looking like the other.
  constraint pilot_calibration_events_class_shape check (
    (event_class = 'punch'
      and punch_type is not null
      and physical_hand is not null
      and hand_role is not null
      and target_zone is not null
      and contact_result is not null
      and defense_type is null
      and defends_against_event_id is null)
    or (event_class = 'defense'
      and defense_type is not null
      and punch_type is null
      and target_zone is null
      and contact_result is null
      and contact_zone is null
      and combination_group is null
      and sequence_order is null
      and counter_against_event_id is null)
  ),

  -- An event cannot counter or defend against itself.
  constraint pilot_calibration_events_no_self_counter
    check (counter_against_event_id is distinct from event_id),
  constraint pilot_calibration_events_no_self_defends
    check (defends_against_event_id is distinct from event_id),

  -- The event belongs to a set, and to the clip that set is about. One key
  -- for both, so the two can never disagree.
  constraint pilot_calibration_events_set_fk
    foreign key (organization_id, annotation_set_id, calibration_clip_id)
    references pilot.calibration_annotation_sets(organization_id, annotation_set_id, calibration_clip_id)
    on delete cascade,

  -- Containment's other half: these bounds are the clip's real bounds.
  constraint pilot_calibration_events_clip_fk
    foreign key (organization_id, calibration_clip_id, clip_start_ms, clip_end_ms)
    references pilot.calibration_clips(organization_id, calibration_clip_id, start_ms, end_ms)
    on delete cascade,

  -- RELATIONSHIPS STAY INSIDE ONE ANNOTATOR'S SET. Including annotation_set_id
  -- in the referencing key is what makes cross-annotator linkage impossible
  -- rather than merely discouraged. MATCH SIMPLE means these are unchecked
  -- when the relationship column is null, which is the correct reading of
  -- "this event relates to nothing".
  --
  -- ON DELETE SET NULL: removing the event a counter pointed at removes the
  -- RELATIONSHIP, never the countering event. Only reachable while the set is
  -- in_progress -- after submission the trigger below refuses the delete that
  -- would trigger it.
  constraint pilot_calibration_events_counter_fk
    foreign key (organization_id, annotation_set_id, counter_against_event_id)
    references pilot.calibration_annotation_events(organization_id, annotation_set_id, event_id)
    on delete set null,
  constraint pilot_calibration_events_defends_fk
    foreign key (organization_id, annotation_set_id, defends_against_event_id)
    references pilot.calibration_annotation_events(organization_id, annotation_set_id, event_id)
    on delete set null
);

create index if not exists idx_calibration_events_set
  on pilot.calibration_annotation_events(organization_id, annotation_set_id, start_ms);

create index if not exists idx_calibration_events_clip_class
  on pilot.calibration_annotation_events(organization_id, calibration_clip_id, event_class);

-- ---------------------------------------------------------------------------
-- THE FREEZE. What makes "independent" a property rather than a promise.
-- ---------------------------------------------------------------------------

-- A submitted set stays submitted, by the same annotator, about the same
-- clip, under the same vocabulary.
--
-- submitted_at is frozen with the status because a re-stamped submission time
-- would let a set that was finished after seeing another one claim to have
-- been finished before it.
create or replace function pilot.calibration_annotation_sets_freeze()
returns trigger
language plpgsql
as $pilot_calibration_sets_freeze$
begin
  if old.status = 'submitted'
     and (new.status is distinct from old.status
       or new.submitted_at is distinct from old.submitted_at
       or new.annotator_account_id is distinct from old.annotator_account_id
       or new.calibration_clip_id is distinct from old.calibration_clip_id
       or new.ontology_version is distinct from old.ontology_version)
  then
    raise exception 'CALIBRATION_ANNOTATION_SET_SUBMITTED'
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$pilot_calibration_sets_freeze$;

drop trigger if exists pilot_calibration_sets_freeze
  on pilot.calibration_annotation_sets;
create trigger pilot_calibration_sets_freeze
  before update on pilot.calibration_annotation_sets
  for each row
  execute function pilot.calibration_annotation_sets_freeze();

-- A submitted set's events are read-only: no insert, no update, no delete.
--
-- WHY THE PARENT LOOKUP RATHER THAN A COLUMN ON THE EVENT. A denormalised
-- status on each event would need updating at submission time -- an UPDATE
-- this very trigger would then have to make an exception for, which is the
-- hole it exists to close.
--
-- DELETION STILL WORKS, and must. When a clip, a set, or the source video is
-- deleted, the parent row goes first and this lookup finds nothing, so
-- parent_status is null and the cascade proceeds. That is deliberate: a
-- submitted annotation set must never be able to block a data-deletion
-- request made on behalf of a minor. calibrationAnnotations.pg.test.ts
-- asserts this directly, because the naive version of this trigger -- one
-- that refuses any delete of a submitted set's events -- would have made
-- deletion impossible while looking correct.
create or replace function pilot.calibration_annotation_events_freeze()
returns trigger
language plpgsql
as $pilot_calibration_events_freeze$
declare
  parent_status text;
  target_org text;
  target_set text;
begin
  if tg_op = 'DELETE' then
    target_org := old.organization_id;
    target_set := old.annotation_set_id;
  else
    target_org := new.organization_id;
    target_set := new.annotation_set_id;
  end if;

  select status into parent_status
    from pilot.calibration_annotation_sets
   where organization_id = target_org
     and annotation_set_id = target_set;

  if parent_status = 'submitted' then
    raise exception 'CALIBRATION_ANNOTATION_SET_SUBMITTED'
      using errcode = 'restrict_violation';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$pilot_calibration_events_freeze$;

drop trigger if exists pilot_calibration_events_freeze
  on pilot.calibration_annotation_events;
create trigger pilot_calibration_events_freeze
  before insert or update or delete on pilot.calibration_annotation_events
  for each row
  execute function pilot.calibration_annotation_events_freeze();
