-- Calibration body points (pilot.calibration_body_moments,
-- pilot.calibration_body_points) -- where a coach marked each of the 24 body
-- points at the three moments of a punch or a defence, under
-- boxing-ontology-0.2 only (OD-2026-10-02-008 section 2; OD-2026-10-02-011
-- sections 2, 3a, 3b).
--
-- STACKED ON the calibration annotations migration. It needs
-- pilot.calibration_annotation_sets and pilot.calibration_annotation_events.
--
-- EVENT -> MOMENT -> POINT. A moment is one of the three marked times of one
-- event (start, middle, end), on the person whose action the event is. A point is one of the 24 on that
-- moment, either placed on the picture or marked not visible. Not a JSON blob
-- and not a list column, so every rule below is a constraint the database can
-- hold, not a shape the application promises to keep.
--
-- WHAT IS HERE, and the rule each piece holds:
--   * A 0.1 set cannot hold a moment, and so cannot hold a point. Old studies
--     finish on old labels; never mixed (OD-2026-10-02-008 4A).
--   * A moment sits exactly on its event's start, end or contact time, or for
--     a middle moment with no contact, inside the event. The event's bounds are
--     carried and foreign-keyed back, the containment pattern of the
--     annotations migration.
--   * The middle moment's kind follows from the event, never chosen freely:
--     contact when the event has a contact time; otherwise full extension for
--     a punch and furthest point for a defence (OD-2026-10-02-011 3a;
--     OD-2026-10-02-016 D2 A; the stand-in architect's furthest_point).
--   * Points are always on the person whose action the event is. There is no
--     marking of the other boxer inside a punch: the person hit is marked on
--     their own event (Jason 2026-10-03, answering what "contact against
--     them" in OD-2026-10-02-008 9A means: "It should be on the individuals
--     action", then "1 and 3" -- their own defence event, and a separate
--     received-punch event that is a later vocabulary item).
--   * A placed point has x and y in [0, 1], relative to the video's own
--     picture; a not-visible point has neither.
--   * A submitted set's moments and points are frozen; deleting the footage,
--     the clip, the set, the event or the organization still removes them.
--
-- WHAT IS NOT HERE, and must not be added without owner ratification: any
-- score, quality label, good or bad guard, overall number, machine-proposed
-- point, or per-point certainty. Every column records something a coach can
-- point at. Body points enter no gold record and no export.
--
-- Not here yet (TEACH-BIOMECH-01-c): the per-event stance-type label, the 0.2
-- rules on the event row itself, and the completeness check at submission.
--
-- Additive and idempotent. No `begin;`/`commit;` here on purpose: the runner
-- (apps/web/scripts/pilot-apply-calibration-body-points-migration.mjs) opens
-- the transaction itself.

-- ---------------------------------------------------------------------------
-- PREREQUISITE on the events table: a key carrying the event's bounds.
--
-- Lets a moment's copy of its event's start and end be foreign-keyed back to
-- the event, so "start sits on the event's start" is a CHECK against values
-- that cannot drift. It also means an event's start or end cannot be moved
-- while a moment hangs off it (the foreign key is NO ACTION on update).
--
-- Cannot fail on existing data: (organization_id, event_id) is already the
-- primary key, so any superset is unique.
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('pilot.calibration_annotation_events') is not null
    and not exists (
      select 1 from pg_constraint
      where conrelid = to_regclass('pilot.calibration_annotation_events')
        and conname = 'pilot_calibration_events_bounds_key'
    )
  then
    alter table pilot.calibration_annotation_events
      add constraint pilot_calibration_events_bounds_key
      unique (organization_id, annotation_set_id, event_id, start_ms, end_ms);
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- One marked moment of one event, on the event's actor.
-- ---------------------------------------------------------------------------
create table if not exists pilot.calibration_body_moments (
  organization_id text not null
    references pilot.organizations(organization_id) on delete cascade,
  body_moment_id text not null,
  annotation_set_id text not null,
  calibration_clip_id text not null,
  event_id text not null,

  -- The event's own bounds, kept honest by pilot_calibration_body_moments_event_fk.
  event_start_ms integer not null,
  event_end_ms integer not null,

  moment_slot text not null,
  moment_kind text not null,

  -- Video-coordinate milliseconds, the origin the events use.
  observation_ms integer not null,

  -- Null until the coach picks one; the submission check (01-c) requires both.
  lead_side text null,
  guard_type text null,

  -- The picture size the player reported when the coach marked this moment,
  -- for later export checks. Not a screen size.
  source_frame_width_px integer null,
  source_frame_height_px integer null,

  created_at timestamptz not null default now(),

  constraint pilot_calibration_body_moments_pkey
    primary key (organization_id, body_moment_id),

  -- Target for the points' foreign key, so a point cannot name a moment in
  -- another set.
  constraint pilot_calibration_body_moments_set_key
    unique (organization_id, annotation_set_id, body_moment_id),

  -- One moment per event and slot.
  constraint pilot_calibration_body_moments_one_per_slot
    unique (organization_id, event_id, moment_slot),

  -- Vocabularies, each the exact output of vocabularyCheckSql in ontology.ts.
  constraint pilot_calibration_body_moments_slot_vocab
    check (moment_slot in ('start', 'middle', 'end')),
  constraint pilot_calibration_body_moments_kind_vocab
    check (moment_kind in ('start', 'contact', 'full_extension', 'furthest_point', 'end')),
  constraint pilot_calibration_body_moments_lead_side_vocab
    check (lead_side in ('orthodox', 'southpaw', 'neutral', 'transition', 'unknown')),
  constraint pilot_calibration_body_moments_guard_vocab
    check (guard_type in ('usa_boxing__high_double_guard', 'usa_boxing__half_guard', 'aiba__high_shoulder_and_high_lead_arm', 'aiba__low_arms', 'aiba__lead_hand_high', 'aiba__lead_hand_low', 'aiba__closed_arms_with_bodyweight_to_front', 'aiba__lower_arms_with_bodyweight_to_front', 'aiba__lead_hand_high_with_balanced_bodyweight_distribution', 'aiba__high_guard', 'aiba__double_guard', 'aiba__stances_with_closed_guard', 'aiba__stances_with_arms_down', 'boxing_australia__closed_guard', 'boxing_australia__open_guard', 'boxing_australia__double_guard_to_the_straight', 'other', 'unknown')),

  -- The slot says which of the three moments; the kind says what that moment
  -- is. Start and end are themselves; the middle is one of the three middle
  -- kinds, and which one is decided by the event (trigger below).
  constraint pilot_calibration_body_moments_slot_kind check (
    (moment_slot = 'start' and moment_kind = 'start')
    or (moment_slot = 'end' and moment_kind = 'end')
    or (moment_slot = 'middle' and moment_kind in ('contact', 'full_extension', 'furthest_point'))
  ),

  -- Inside the event, and exactly on its edges for start and end.
  constraint pilot_calibration_body_moments_within_event check (
    observation_ms >= event_start_ms and observation_ms <= event_end_ms
  ),
  constraint pilot_calibration_body_moments_on_edge check (
    (moment_kind <> 'start' or observation_ms = event_start_ms)
    and (moment_kind <> 'end' or observation_ms = event_end_ms)
  ),

  -- Both or neither, and positive.
  constraint pilot_calibration_body_moments_frame_size check (
    (source_frame_width_px is null and source_frame_height_px is null)
    or (source_frame_width_px > 0 and source_frame_height_px > 0)
  ),

  -- The event belongs to this set, and these bounds are its real bounds.
  constraint pilot_calibration_body_moments_event_fk
    foreign key (organization_id, annotation_set_id, event_id, event_start_ms, event_end_ms)
    references pilot.calibration_annotation_events(organization_id, annotation_set_id, event_id, start_ms, end_ms)
    on delete cascade,

  -- The set is about this clip.
  constraint pilot_calibration_body_moments_set_fk
    foreign key (organization_id, annotation_set_id, calibration_clip_id)
    references pilot.calibration_annotation_sets(organization_id, annotation_set_id, calibration_clip_id)
    on delete cascade
);

-- ---------------------------------------------------------------------------
-- One of the 24 points on one moment.
-- ---------------------------------------------------------------------------
create table if not exists pilot.calibration_body_points (
  organization_id text not null
    references pilot.organizations(organization_id) on delete cascade,
  body_point_id text not null,
  -- Carried so the freeze reads the parent set directly; tied to the moment's
  -- own set by pilot_calibration_body_points_moment_fk.
  annotation_set_id text not null,
  body_moment_id text not null,

  point_code text not null,
  state text not null,

  -- Fractions of the video's own picture, 0 at the left and top edges.
  x_norm double precision null,
  y_norm double precision null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint pilot_calibration_body_points_pkey
    primary key (organization_id, body_point_id),

  constraint pilot_calibration_body_points_one_per_moment
    unique (organization_id, body_moment_id, point_code),

  constraint pilot_calibration_body_points_code_vocab
    check (point_code in ('nose', 'chin', 'neck', 'mid_hip', 'left_shoulder', 'left_elbow', 'left_wrist', 'left_glove', 'left_hip', 'left_knee', 'left_ankle', 'left_heel', 'left_big_toe', 'left_small_toe', 'right_shoulder', 'right_elbow', 'right_wrist', 'right_glove', 'right_hip', 'right_knee', 'right_ankle', 'right_heel', 'right_big_toe', 'right_small_toe')),
  constraint pilot_calibration_body_points_state_vocab
    check (state in ('placed', 'not_visible')),

  -- A placed point has a position on the picture; a not-visible one has none.
  -- NaN and infinity fail the range test (NaN sorts above every number).
  constraint pilot_calibration_body_points_position check (
    (state = 'placed'
      and x_norm is not null and y_norm is not null
      and x_norm >= 0 and x_norm <= 1
      and y_norm >= 0 and y_norm <= 1)
    or (state = 'not_visible' and x_norm is null and y_norm is null)
  ),

  constraint pilot_calibration_body_points_moment_fk
    foreign key (organization_id, annotation_set_id, body_moment_id)
    references pilot.calibration_body_moments(organization_id, annotation_set_id, body_moment_id)
    on delete cascade
);

create index if not exists idx_calibration_body_points_set
  on pilot.calibration_body_points(organization_id, annotation_set_id);

-- ---------------------------------------------------------------------------
-- THE GUARDS. Each one stops a well-formed row that should not exist.
-- ---------------------------------------------------------------------------

-- Moments: freeze, fixed identity, version gate, middle-kind rule.
--
-- FREEZE: the annotations migration's parent lookup. On DELETE, when the set
-- itself (or its clip, footage or organization) is being deleted, the parent
-- row is already gone, the lookup finds nothing, and the cascade proceeds: the
-- freeze never blocks a deletion made on behalf of a minor.
--
-- FIXED IDENTITY: a row cannot be moved to another set, event or slot
-- by UPDATE, so the freeze never has to reason about where a row came from.
--
-- VERSION GATE: the set's ontology_version must be one of
-- BODY_POINT_ONTOLOGY_VERSIONS in ontology.ts. calibrationBodyPoints.pg.test.ts
-- asserts the list below equals that array.
create or replace function pilot.calibration_body_moments_guard()
returns trigger
language plpgsql
as $pilot_calibration_body_moments_guard$
declare
  parent_status text;
  parent_version text;
  ev_class text;
  ev_contact_ms integer;
begin
  if tg_op = 'DELETE' then
    select status into parent_status
      from pilot.calibration_annotation_sets
     where organization_id = old.organization_id
       and annotation_set_id = old.annotation_set_id;
    if parent_status = 'submitted' then
      raise exception 'CALIBRATION_ANNOTATION_SET_SUBMITTED'
        using errcode = 'restrict_violation';
    end if;
    return old;
  end if;

  if tg_op = 'UPDATE'
     and (new.organization_id is distinct from old.organization_id
       or new.body_moment_id is distinct from old.body_moment_id
       or new.annotation_set_id is distinct from old.annotation_set_id
       or new.calibration_clip_id is distinct from old.calibration_clip_id
       or new.event_id is distinct from old.event_id
       or new.moment_slot is distinct from old.moment_slot)
  then
    raise exception 'CALIBRATION_BODY_MOMENT_IDENTITY_FIXED'
      using errcode = 'restrict_violation';
  end if;

  select status, ontology_version into parent_status, parent_version
    from pilot.calibration_annotation_sets
   where organization_id = new.organization_id
     and annotation_set_id = new.annotation_set_id;

  if parent_status = 'submitted' then
    raise exception 'CALIBRATION_ANNOTATION_SET_SUBMITTED'
      using errcode = 'restrict_violation';
  end if;

  if parent_version is null
     or parent_version not in ('boxing-ontology-0.2')
  then
    raise exception 'CALIBRATION_BODY_POINTS_NOT_IN_THIS_VERSION'
      using errcode = 'check_violation';
  end if;

  select event_class, contact_ms
    into ev_class, ev_contact_ms
    from pilot.calibration_annotation_events
   where organization_id = new.organization_id
     and annotation_set_id = new.annotation_set_id
     and event_id = new.event_id;

  -- The middle moment is decided by the event. Contact whenever the event has
  -- a contact time, and exactly on it; with no contact time, full extension
  -- for a punch and furthest point for a defence.
  if (new.moment_kind = 'contact'
        and (ev_contact_ms is null or new.observation_ms <> ev_contact_ms))
     or (new.moment_kind = 'full_extension'
        and (ev_class is distinct from 'punch' or ev_contact_ms is not null))
     or (new.moment_kind = 'furthest_point'
        and (ev_class is distinct from 'defense' or ev_contact_ms is not null))
  then
    raise exception 'CALIBRATION_BODY_MOMENT_KIND_NOT_THIS_EVENT'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$pilot_calibration_body_moments_guard$;

drop trigger if exists pilot_calibration_body_moments_guard
  on pilot.calibration_body_moments;
create trigger pilot_calibration_body_moments_guard
  before insert or update or delete on pilot.calibration_body_moments
  for each row
  execute function pilot.calibration_body_moments_guard();

-- Points: freeze and fixed identity.
--
-- No version gate of its own: a point's set is its moment's set (composite
-- foreign key), the moment's set passed the gate, and the set's version cannot
-- change while it holds moments (next guard). A gate here could never fire.
create or replace function pilot.calibration_body_points_guard()
returns trigger
language plpgsql
as $pilot_calibration_body_points_guard$
declare
  parent_status text;
begin
  if tg_op = 'UPDATE'
     and (new.organization_id is distinct from old.organization_id
       or new.body_point_id is distinct from old.body_point_id
       or new.annotation_set_id is distinct from old.annotation_set_id
       or new.body_moment_id is distinct from old.body_moment_id
       or new.point_code is distinct from old.point_code)
  then
    raise exception 'CALIBRATION_BODY_POINT_IDENTITY_FIXED'
      using errcode = 'restrict_violation';
  end if;

  if tg_op = 'DELETE' then
    select status into parent_status
      from pilot.calibration_annotation_sets
     where organization_id = old.organization_id
       and annotation_set_id = old.annotation_set_id;
  else
    select status into parent_status
      from pilot.calibration_annotation_sets
     where organization_id = new.organization_id
       and annotation_set_id = new.annotation_set_id;
  end if;

  if parent_status = 'submitted' then
    raise exception 'CALIBRATION_ANNOTATION_SET_SUBMITTED'
      using errcode = 'restrict_violation';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$pilot_calibration_body_points_guard$;

drop trigger if exists pilot_calibration_body_points_guard
  on pilot.calibration_body_points;
create trigger pilot_calibration_body_points_guard
  before insert or update or delete on pilot.calibration_body_points
  for each row
  execute function pilot.calibration_body_points_guard();

-- Events: the facts a moment was checked against cannot change under it.
--
-- start_ms and end_ms are already held by the moments' foreign key. This
-- holds the other two: contact time (decides the middle kind and where a
-- contact moment sits) and class (decides full extension or furthest point).
-- A new function on purpose; the events freeze is not edited.
create or replace function pilot.calibration_annotation_events_body_moment_guard()
returns trigger
language plpgsql
as $pilot_calibration_events_body_moment_guard$
begin
  if (new.contact_ms is distinct from old.contact_ms
      or new.event_class is distinct from old.event_class)
     and exists (
       select 1 from pilot.calibration_body_moments
        where organization_id = old.organization_id
          and event_id = old.event_id
     )
  then
    raise exception 'CALIBRATION_EVENT_HAS_BODY_MOMENTS'
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$pilot_calibration_events_body_moment_guard$;

drop trigger if exists pilot_calibration_events_body_moment_guard
  on pilot.calibration_annotation_events;
create trigger pilot_calibration_events_body_moment_guard
  before update on pilot.calibration_annotation_events
  for each row
  execute function pilot.calibration_annotation_events_body_moment_guard();

-- Sets: a set holding body points cannot change vocabulary. The sets freeze
-- already holds this after submission; this holds it while in progress, when
-- relabelling a 0.2 set as 0.1 would leave a 0.1 set holding body points.
create or replace function pilot.calibration_annotation_sets_body_moment_guard()
returns trigger
language plpgsql
as $pilot_calibration_sets_body_moment_guard$
begin
  if new.ontology_version is distinct from old.ontology_version
     and exists (
       select 1 from pilot.calibration_body_moments
        where organization_id = old.organization_id
          and annotation_set_id = old.annotation_set_id
     )
  then
    raise exception 'CALIBRATION_SET_HAS_BODY_MOMENTS'
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$pilot_calibration_sets_body_moment_guard$;

drop trigger if exists pilot_calibration_sets_body_moment_guard
  on pilot.calibration_annotation_sets;
create trigger pilot_calibration_sets_body_moment_guard
  before update on pilot.calibration_annotation_sets
  for each row
  execute function pilot.calibration_annotation_sets_body_moment_guard();
