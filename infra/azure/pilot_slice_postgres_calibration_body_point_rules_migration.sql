-- Calibration body-point rules -- the per-event stance-type label, the
-- body-point versions' rules on the event row (boxing-ontology-0.2 and 0.3,
-- BODY_POINT_ONTOLOGY_VERSIONS in ontology.ts), and the completeness check at
-- submission (TEACH-BIOMECH-01-c).
--
-- STACKED ON the calibration body points migration. It needs
-- pilot.calibration_body_moments and pilot.calibration_body_points.
--
-- WHAT IS HERE, and the rule each piece holds:
--   * pilot.calibration_event_stance_labels: the named stance type, once per
--     punch or defence (OD-2026-10-02-014), on the person whose action the
--     event is. One per event; no subject column: the other boxer is marked
--     on their own event (Jason 2026-10-03, "It should be on the individuals
--     action", then "1 and 3"; OD-2026-10-03-006). Only a 0.2 or 0.3 set may hold one; a submitted
--     set's are frozen; deleting the event, set, clip, footage or
--     organization still removes them.
--   * On a 0.2 or 0.3 event row: no 0.1 `stance` (lead side at each moment replaces
--     it), no `peak_ms` (OD-2026-10-02-008 3A), and a punch carries a contact
--     time exactly when its result made contact (CONTACT_RESULTS_WITH_CONTACT
--     in ontology.ts; OD-2026-10-02-011 3a; -016 D2 A).
--   * A set holding any event cannot change vocabulary, so neither a 0.1
--     event nor a stance label can end up under the other version's rules.
--   * A 0.2 or 0.3 set cannot be submitted incomplete: every event needs its
--     stance type, all three moments, a lead side and guard at each, and all
--     of its version's points at each -- 24 under 0.2, 25 under 0.3
--     (OD-2026-10-02-011 3a, 3b; -014; Jason 2026-10-03). The refusal names
--     what is missing.
--
-- 0.1 sets are untouched: every rule here returns early for them.
--
-- WHAT IS NOT HERE, and must not be added without owner ratification: any
-- score, quality label, good or bad stance, or overall number.
--
-- Additive and idempotent. No `begin;`/`commit;` here on purpose: the runner
-- (apps/web/scripts/pilot-apply-calibration-body-point-rules-migration.mjs)
-- opens the transaction itself.

-- ---------------------------------------------------------------------------
-- The named stance type of one event.
-- ---------------------------------------------------------------------------
create table if not exists pilot.calibration_event_stance_labels (
  organization_id text not null,
  annotation_set_id text not null,
  event_id text not null,

  stance_type text not null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint pilot_calibration_event_stance_labels_org_fk
    foreign key (organization_id)
    references pilot.organizations(organization_id) on delete cascade,

  -- One per event.
  constraint pilot_calibration_event_stance_labels_pkey
    primary key (organization_id, event_id),

  -- Exactly the output of vocabularyCheckSql in ontology.ts.
  constraint pilot_calibration_event_stance_labels_stance_type_vocab
    check (stance_type in ('usa_boxing__classic', 'aiba__weight_to_lead_leg', 'aiba__weight_to_rear_leg', 'aiba__up_right_stance', 'aiba__crouching_stance', 'aiba__frontal_stance', 'aiba__frontal_stance_with_closed_arms', 'aiba__classic', 'aiba__stance_for_long_distance', 'aiba__stance_for_medium_distance', 'aiba__stance_for_short_distance', 'aiba__stances_with_weight_shift_to_rear_leg', 'usiba__on_guard', 'other', 'unknown')),

  -- The event belongs to this set.
  constraint pilot_calibration_event_stance_labels_event_fk
    foreign key (organization_id, annotation_set_id, event_id)
    references pilot.calibration_annotation_events(organization_id, annotation_set_id, event_id)
    on delete cascade
);

create index if not exists idx_calibration_event_stance_labels_set
  on pilot.calibration_event_stance_labels(organization_id, annotation_set_id);

-- ---------------------------------------------------------------------------
-- THE GUARDS.
-- ---------------------------------------------------------------------------

-- Stance labels: freeze, fixed identity, version gate. The body points
-- migration's moments guard, line for line in what it holds:
--   * on DELETE, a row whose organization or set is already gone passes, so
--     the freeze never blocks a deletion made on behalf of a minor;
--   * the set and the event are read FOR SHARE, so a version change, a
--     submission or an actor change waits for this write to commit and then
--     sees it.
create or replace function pilot.calibration_event_stance_labels_guard()
returns trigger
language plpgsql
as $pilot_calibration_event_stance_labels_guard$
declare
  parent_status text;
  parent_version text;
begin
  if tg_op = 'DELETE' then
    if not exists (
      select 1 from pilot.organizations where organization_id = old.organization_id
    ) then
      return old;
    end if;
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
       or new.annotation_set_id is distinct from old.annotation_set_id
       or new.event_id is distinct from old.event_id)
  then
    raise exception 'CALIBRATION_EVENT_STANCE_LABEL_IDENTITY_FIXED'
      using errcode = 'restrict_violation';
  end if;

  select status, ontology_version into parent_status, parent_version
    from pilot.calibration_annotation_sets
   where organization_id = new.organization_id
     and annotation_set_id = new.annotation_set_id
     for share;

  if parent_status = 'submitted' then
    raise exception 'CALIBRATION_ANNOTATION_SET_SUBMITTED'
      using errcode = 'restrict_violation';
  end if;

  if parent_version is null
     or parent_version not in ('boxing-ontology-0.2', 'boxing-ontology-0.3')
  then
    raise exception 'CALIBRATION_BODY_POINTS_NOT_IN_THIS_VERSION'
      using errcode = 'check_violation';
  end if;

  perform 1
     from pilot.calibration_annotation_events
    where organization_id = new.organization_id
      and annotation_set_id = new.annotation_set_id
      and event_id = new.event_id
      for share;

  return new;
end;
$pilot_calibration_event_stance_labels_guard$;

drop trigger if exists pilot_calibration_event_stance_labels_guard
  on pilot.calibration_event_stance_labels;
create trigger pilot_calibration_event_stance_labels_guard
  before insert or update or delete on pilot.calibration_event_stance_labels
  for each row
  execute function pilot.calibration_event_stance_labels_guard();

-- Events: the 0.2 and 0.3 rules on the row itself, and the actor a stance label was
-- given for. A new function; the events freeze and the body-moment guard are
-- not edited.
--
-- ON UPDATE THE RULES RUN ONLY WHEN A FIELD THEY READ CHANGES, so a row
-- written before this migration is never refused an unrelated update (a
-- relationship cleared, a certainty corrected).
--
-- The set is read FOR SHARE on every insert or update, whatever its version, so a
-- version change or a submission waits for an uncommitted event and then
-- sees it.
create or replace function pilot.calibration_annotation_events_body_point_rules()
returns trigger
language plpgsql
as $pilot_calibration_events_body_point_rules$
declare
  parent_version text;
begin
  if tg_op = 'UPDATE'
     and new.actor_track is distinct from old.actor_track
     and exists (
       select 1 from pilot.calibration_event_stance_labels
        where organization_id = old.organization_id
          and event_id = old.event_id
     )
  then
    raise exception 'CALIBRATION_EVENT_HAS_STANCE_LABEL'
      using errcode = 'restrict_violation';
  end if;

  if tg_op = 'UPDATE'
     and new.annotation_set_id is not distinct from old.annotation_set_id
     and new.event_class is not distinct from old.event_class
     and new.stance is not distinct from old.stance
     and new.peak_ms is not distinct from old.peak_ms
     and new.contact_ms is not distinct from old.contact_ms
     and new.contact_result is not distinct from old.contact_result
  then
    return new;
  end if;

  select ontology_version into parent_version
    from pilot.calibration_annotation_sets
   where organization_id = new.organization_id
     and annotation_set_id = new.annotation_set_id
     for share;

  if parent_version is null
     or parent_version not in ('boxing-ontology-0.2', 'boxing-ontology-0.3')
  then
    return new;
  end if;

  if new.stance is not null then
    raise exception 'CALIBRATION_EVENT_STANCE_NOT_IN_THIS_VERSION'
      using errcode = 'check_violation';
  end if;

  if new.peak_ms is not null then
    raise exception 'CALIBRATION_EVENT_PEAK_NOT_IN_THIS_VERSION'
      using errcode = 'check_violation';
  end if;

  -- Exactly CONTACT_RESULTS_WITH_CONTACT in ontology.ts.
  if new.event_class = 'punch'
     and (new.contact_result in ('clean_target_contact', 'glancing_target_contact', 'guard_contact', 'non_target_contact'))
         is distinct from (new.contact_ms is not null)
  then
    raise exception 'CALIBRATION_EVENT_CONTACT_TIME_NOT_THIS_RESULT'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$pilot_calibration_events_body_point_rules$;

-- Rows written before this migration are judged once, here: a 0.2 or 0.3 event that
-- already breaks the rules refuses the migration instead of being frozen in.
do $$
begin
  if exists (
    select 1
      from pilot.calibration_annotation_events e
      join pilot.calibration_annotation_sets s
        on s.organization_id = e.organization_id
       and s.annotation_set_id = e.annotation_set_id
     where s.ontology_version in ('boxing-ontology-0.2', 'boxing-ontology-0.3')
       and (e.stance is not null
         or e.peak_ms is not null
         or (e.event_class = 'punch'
           and (e.contact_result in ('clean_target_contact', 'glancing_target_contact', 'guard_contact', 'non_target_contact'))
               is distinct from (e.contact_ms is not null)))
  ) then
    raise exception 'CALIBRATION_EVENTS_BREAK_0_2_RULES';
  end if;
end
$$;

drop trigger if exists pilot_calibration_events_body_point_rules
  on pilot.calibration_annotation_events;
create trigger pilot_calibration_events_body_point_rules
  before insert or update on pilot.calibration_annotation_events
  for each row
  execute function pilot.calibration_annotation_events_body_point_rules();

-- Sets: no vocabulary change while the set holds an event, and no 0.2 or 0.3
-- submission while anything is missing.
--
-- LOCKS AT SUBMISSION. Writers of events, stance labels, moments and points
-- read the set FOR SHARE, so the submission waits for them. Deleters do not;
-- so the set's stance labels and points are read FOR SHARE here first, which
-- waits for any uncommitted delete, and the count that follows sees it.
-- Deleting an event or a moment of a complete event removes its label or
-- points by cascade, so those two locks cover it (mutants M21/M23 showed
-- locking events and moments as well changes no outcome).
create or replace function pilot.calibration_annotation_sets_body_point_rules()
returns trigger
language plpgsql
as $pilot_calibration_sets_body_point_rules$
declare
  missing text;
  expected_points integer;
begin
  if new.ontology_version is distinct from old.ontology_version
     and exists (
       select 1 from pilot.calibration_annotation_events
        where organization_id = old.organization_id
          and annotation_set_id = old.annotation_set_id
     )
  then
    raise exception 'CALIBRATION_SET_HAS_EVENTS'
      using errcode = 'restrict_violation';
  end if;

  if old.status is distinct from 'in_progress'
     or new.status is distinct from 'submitted'
     or new.ontology_version not in ('boxing-ontology-0.2', 'boxing-ontology-0.3')
  then
    return new;
  end if;

  -- Each version's BODY_POINTS_BY_VERSION length. The points guard admits only
  -- the version's own points, one of each per moment, so this many is all of
  -- them.
  expected_points := case new.ontology_version
    when 'boxing-ontology-0.2' then 24
    when 'boxing-ontology-0.3' then 25
  end;

  perform 1 from pilot.calibration_event_stance_labels
    where organization_id = new.organization_id and annotation_set_id = new.annotation_set_id
    for share;
  perform 1 from pilot.calibration_body_points
    where organization_id = new.organization_id and annotation_set_id = new.annotation_set_id
    for share;

  -- Slots: exactly MOMENT_SLOTS.
  select string_agg(item, '; ' order by item) into missing
    from (
      select e.event_id || ': stance type' as item
        from pilot.calibration_annotation_events e
       where e.organization_id = new.organization_id
         and e.annotation_set_id = new.annotation_set_id
         and not exists (
           select 1 from pilot.calibration_event_stance_labels s
            where s.organization_id = e.organization_id and s.event_id = e.event_id
         )
      union all
      select e.event_id || ': ' || slot.moment_slot || ' moment'
        from pilot.calibration_annotation_events e
       cross join (values ('start'), ('middle'), ('end')) as slot(moment_slot)
       where e.organization_id = new.organization_id
         and e.annotation_set_id = new.annotation_set_id
         and not exists (
           select 1 from pilot.calibration_body_moments m
            where m.organization_id = e.organization_id
              and m.event_id = e.event_id
              and m.moment_slot = slot.moment_slot
         )
      union all
      select m.event_id || ': ' || m.moment_slot || ' lead side'
        from pilot.calibration_body_moments m
       where m.organization_id = new.organization_id
         and m.annotation_set_id = new.annotation_set_id
         and m.lead_side is null
      union all
      select m.event_id || ': ' || m.moment_slot || ' guard'
        from pilot.calibration_body_moments m
       where m.organization_id = new.organization_id
         and m.annotation_set_id = new.annotation_set_id
         and m.guard_type is null
      union all
      select m.event_id || ': ' || m.moment_slot || ' points, ' || count(p.point_code) || ' of ' || expected_points
        from pilot.calibration_body_moments m
        left join pilot.calibration_body_points p
          on p.organization_id = m.organization_id
         and p.annotation_set_id = m.annotation_set_id
         and p.body_moment_id = m.body_moment_id
       where m.organization_id = new.organization_id
         and m.annotation_set_id = new.annotation_set_id
       group by m.event_id, m.moment_slot, m.body_moment_id
      having count(p.point_code) <> expected_points
    ) as missing_items;

  if missing is not null then
    raise exception 'CALIBRATION_BODY_POINTS_INCOMPLETE'
      using errcode = 'check_violation', detail = missing;
  end if;

  return new;
end;
$pilot_calibration_sets_body_point_rules$;

drop trigger if exists pilot_calibration_sets_body_point_rules
  on pilot.calibration_annotation_sets;
create trigger pilot_calibration_sets_body_point_rules
  before update on pilot.calibration_annotation_sets
  for each row
  execute function pilot.calibration_annotation_sets_body_point_rules();
