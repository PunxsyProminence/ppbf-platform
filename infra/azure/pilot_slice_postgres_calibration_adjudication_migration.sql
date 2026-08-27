-- Calibration adjudication (pilot.calibration_adjudications,
-- pilot.calibration_adjudicated_fields) -- a human deciding what two
-- annotators' disagreement actually was.
--
-- STACKED ON the calibration annotations migration.
--
-- THE ORIGINALS ARE NEVER TOUCHED. An adjudication is a NEW row that
-- REFERENCES the two source events; nothing here updates, supersedes, or
-- soft-deletes an annotation. That is not a stylistic preference. The two
-- readings are the measurement -- the thing the whole study exists to
-- collect -- and an adjudicator who could edit them would be destroying the
-- data in the act of interpreting it. The annotations tables are already
-- frozen by trigger after submission; this migration adds nothing that could
-- unfreeze them, and holds no write path back into them.
--
-- ADJUDICATED GROUND TRUTH IS NOT A THIRD ANNOTATION. It is a record of a
-- decision, carrying who made it, when, under which vocabulary, and from
-- which two readings. Stripped of that provenance it would be indistinguishable
-- from an annotation, and the difference is the entire point: an annotation
-- is what one person saw, an adjudication is what a reviewer concluded after
-- seeing two people disagree.
--
-- FIELD-LEVEL BY DEFAULT. Two annotators who agree about everything except the
-- target zone should not force a reviewer to declare one of them wholly
-- correct. pilot.calibration_adjudicated_fields records a decision per field,
-- each naming where the accepted value came from -- annotator A, annotator B,
-- or the adjudicator's own reading. Forcing a whole-event choice would
-- manufacture agreement on every field the reviewer never actually considered.
--
-- UNRESOLVABLE IS A RESULT, NOT A FAILURE. Some disagreements cannot be
-- settled from the footage -- the camera did not show it, or two competent
-- people read the same frames differently and both readings survive scrutiny.
-- Recording that honestly is more useful than a forced verdict, and a gold
-- dataset built from forced verdicts would carry a confidence nobody earned.
--
-- WHAT THIS DOES NOT DO. It produces no score, no accuracy figure, no
-- annotator ranking, and nothing about any athlete. It does not promote
-- anything into a gold dataset -- that is a separate, deliberate act with its
-- own governance.
--
-- Additive and idempotent. No `begin;`/`commit;` here on purpose: the runner
-- (apps/web/scripts/pilot-apply-calibration-adjudication-migration.mjs) opens
-- the transaction itself.

-- ---------------------------------------------------------------------------
-- PREREQUISITE on the events table: a key including the clip.
--
-- Lets an adjudication tie both source events to the SAME clip it names,
-- so a decision cannot be assembled from two events in different clips.
-- Cannot fail on existing data: (organization_id, event_id) is already the
-- primary key, so any superset is unique.
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('pilot.calibration_annotation_events') is not null
    and not exists (
      select 1 from pg_constraint
      where conrelid = to_regclass('pilot.calibration_annotation_events')
        and conname = 'pilot_calibration_events_clip_key'
    )
  then
    alter table pilot.calibration_annotation_events
      add constraint pilot_calibration_events_clip_key
      unique (organization_id, calibration_clip_id, annotation_set_id, event_id);
  end if;
end
$$;

create table if not exists pilot.calibration_adjudications (
  organization_id text not null
    references pilot.organizations(organization_id) on delete cascade,
  adjudication_id text not null,
  calibration_clip_id text not null,

  -- The two readings this decision was made between. Recorded even when one
  -- side contributed no event, because "B saw nothing here" is a fact about
  -- B's reading and is exactly what an EVENT_MISSED adjudication is about.
  annotation_set_id_a text not null,
  annotation_set_id_b text not null,

  -- Nullable, because an EVENT_MISSED case has an event on one side only.
  -- The CHECK below refuses a row with neither.
  source_event_id_a text null,
  source_event_id_b text null,

  -- What the reviewer concluded.
  --
  -- 'agreement' is a real outcome and not a no-op: it records that a human
  -- looked at a flagged difference and found the two readings equivalent,
  -- which is different from a difference nobody has reviewed yet.
  resolution_type text not null check (resolution_type in (
    'agreement',
    'accept_a',
    'accept_b',
    'new_adjudicated_value',
    'unresolvable'
  )),

  -- Used only where the disagreement was that one annotator recorded an event
  -- the other did not. A separate vocabulary because the question is a
  -- different one: not "whose label is right" but "did this happen at all".
  --
  -- 'both_distinct' is the case that is easy to miss and matters most -- two
  -- annotators may each have recorded a REAL event, at overlapping times,
  -- that were never the same event. Collapsing that into "one of them was
  -- wrong" would delete a true observation.
  missed_event_verdict text null check (missed_event_verdict is null or missed_event_verdict in (
    'a_event_real',
    'b_event_real',
    'both_distinct',
    'neither_valid',
    'unresolvable'
  )),

  -- Provenance. Every one of these is required: an adjudication that cannot
  -- say who made it, when, or under which vocabulary is not evidence of
  -- anything, and would be indistinguishable from a third annotation.
  adjudicator_account_id text not null references pilot.accounts(account_id),
  adjudicated_at timestamptz not null default now(),
  ontology_version text not null check (length(btrim(ontology_version)) > 0),

  notes text null,

  created_at timestamptz not null default now(),

  constraint pilot_calibration_adjudications_pkey
    primary key (organization_id, adjudication_id),

  -- A decision must be about at least one recorded event. A row referencing
  -- neither reading is a decision about nothing.
  constraint pilot_calibration_adjudications_has_source check (
    source_event_id_a is not null or source_event_id_b is not null
  ),

  -- The verdict has to be answerable from what is present. Accepting A's
  -- reading when A recorded no event is not a decision, it is a row that
  -- cannot be interpreted.
  constraint pilot_calibration_adjudications_verdict_supported check (
    (resolution_type = 'accept_a' and source_event_id_a is not null)
    or (resolution_type = 'accept_b' and source_event_id_b is not null)
    or (resolution_type = 'agreement'
        and source_event_id_a is not null and source_event_id_b is not null)
    or resolution_type in ('new_adjudicated_value', 'unresolvable')
  ),

  -- The two source columns are not interchangeable: A's event belongs to
  -- set A. Without this a reviewer could file B's event under A and the
  -- record would attribute an observation to the wrong annotator.
  constraint pilot_calibration_adjudications_source_a_fk
    foreign key (organization_id, calibration_clip_id, annotation_set_id_a, source_event_id_a)
    references pilot.calibration_annotation_events(
      organization_id, calibration_clip_id, annotation_set_id, event_id)
    on delete cascade,
  constraint pilot_calibration_adjudications_source_b_fk
    foreign key (organization_id, calibration_clip_id, annotation_set_id_b, source_event_id_b)
    references pilot.calibration_annotation_events(
      organization_id, calibration_clip_id, annotation_set_id, event_id)
    on delete cascade,

  -- Both sets must be about the clip this decision names.
  constraint pilot_calibration_adjudications_set_a_fk
    foreign key (organization_id, annotation_set_id_a, calibration_clip_id)
    references pilot.calibration_annotation_sets(
      organization_id, annotation_set_id, calibration_clip_id)
    on delete cascade,
  constraint pilot_calibration_adjudications_set_b_fk
    foreign key (organization_id, annotation_set_id_b, calibration_clip_id)
    references pilot.calibration_annotation_sets(
      organization_id, annotation_set_id, calibration_clip_id)
    on delete cascade,

  -- One reading cannot be adjudicated against itself.
  constraint pilot_calibration_adjudications_two_sets
    check (annotation_set_id_a <> annotation_set_id_b)
);

create index if not exists idx_calibration_adjudications_clip
  on pilot.calibration_adjudications(organization_id, calibration_clip_id, adjudicated_at desc);

create index if not exists idx_calibration_adjudications_resolution
  on pilot.calibration_adjudications(organization_id, resolution_type);

-- ---------------------------------------------------------------------------
-- The per-field half. What the reviewer actually decided, field by field.
-- ---------------------------------------------------------------------------
create table if not exists pilot.calibration_adjudicated_fields (
  organization_id text not null
    references pilot.organizations(organization_id) on delete cascade,
  adjudicated_field_id text not null,
  adjudication_id text not null,

  -- The column of pilot.calibration_annotation_events this decision is about,
  -- and the disagreement category it fell under. Both are stored: the field
  -- says WHERE, the category says WHAT KIND, and the QA read-out stratifies
  -- by the second.
  field_name text not null check (length(btrim(field_name)) > 0),
  disagreement_category text not null check (disagreement_category in (
    'EVENT_MISSED', 'BOUNDARY', 'PUNCH_TYPE', 'PHYSICAL_HAND', 'HAND_ROLE',
    'STANCE', 'TARGET', 'CONTACT_RESULT', 'CONTACT_ZONE', 'DEFENSE_TYPE',
    'COMBINATION', 'COUNTER', 'VISIBILITY', 'CERTAINTY', 'OTHER'
  )),

  -- Where the accepted value came from. 'adjudicator' means neither
  -- annotator's reading was accepted and the reviewer supplied their own --
  -- which must stay distinguishable from agreeing with one of them, because
  -- a gold dataset built mostly of adjudicator-supplied values is a very
  -- different artefact from one built mostly of annotator agreement.
  resolved_from text not null check (resolved_from in ('annotator_a', 'annotator_b', 'adjudicator')),

  -- Nullable, because 'unknown' is a legitimate ontology value and so is a
  -- field the reviewer declined to settle. An empty string would be neither.
  resolved_value text null,

  -- True when the reviewer could not settle this field. Kept as its own
  -- column rather than a magic resolved_value, so a genuinely null resolution
  -- and an unresolved one are never confused.
  unresolved boolean not null default false,

  created_at timestamptz not null default now(),

  constraint pilot_calibration_adjudicated_fields_pkey
    primary key (organization_id, adjudicated_field_id),

  -- One decision per field per adjudication. A second row for the same field
  -- would be two answers to one question with no way to order them.
  constraint pilot_calibration_adjudicated_fields_uq
    unique (organization_id, adjudication_id, field_name),

  -- An unresolved field carries no value, and a resolved one is attributed.
  constraint pilot_calibration_adjudicated_fields_shape check (
    (unresolved = true and resolved_value is null)
    or unresolved = false
  ),

  constraint pilot_calibration_adjudicated_fields_parent_fk
    foreign key (organization_id, adjudication_id)
    references pilot.calibration_adjudications(organization_id, adjudication_id)
    on delete cascade
);

create index if not exists idx_calibration_adjudicated_fields_parent
  on pilot.calibration_adjudicated_fields(organization_id, adjudication_id);

create index if not exists idx_calibration_adjudicated_fields_category
  on pilot.calibration_adjudicated_fields(organization_id, disagreement_category, resolved_from);
