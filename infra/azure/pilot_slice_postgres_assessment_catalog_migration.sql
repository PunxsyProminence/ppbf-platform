-- ASSESSMENT CATALOG: the backbone's gates and their criteria, the scorecard
-- items, the anchor-clip specs, the two 1-5 scales and the non-contact cap,
-- and the two behavioural KPI lists (lane CAT-a; OD-2026-11-15-006 ruling 1,
-- OD-2026-11-16-001, OD-2026-11-16-003; SCHEMA_PROPOSAL P5 and P6, SP-1, SP-2).
--
-- ADDITIVE. Eight new tables, and ONE change to an existing one:
-- pilot.assessment_protocols gains seven NULLABLE columns with NO default
-- (protocol_group, status, sources, decision, field_labels, evidence,
-- backbone_version), so the backbone's 46 protocols keep their labels and
-- evidence. Every existing protocol row reads NULL in each of them, and
-- nothing existing changes meaning. pilot.assessments, pilot.calibration_clips
-- and every athlete table are untouched. Ratings, two-coach scoring, the
-- anchor-clip link to a calibration clip (P6 scorecard_anchor_clips) and the
-- gate-override workflow (P5 progression_decision_requests) are later lanes.
--
-- WHAT THE CATALOG IS FOR. It describes and informs. A gate is shown as met,
-- not met or not scored; nothing reads it to move, place or restrict anyone
-- (Backbone RULES section 1; P5 "It never moves anyone"), and every gate row
-- says so in informs_only, which may only be true. The non-contact cap of 3
-- (D-Q11) is held as data for the later rating path; nothing here enforces it.
--
-- THE DATA OVER THE PROPOSAL TEXT (the lane brief, as P7's status note). The
-- frozen design_catalogs.json has a gate kind P5 does not name
-- (checkpoint_90_days, T1, D-OQ194) and two criterion kinds beyond P5's three
-- (bout_count, gate_met); min_score takes halves (4.5); a scorecard minimum
-- combines its items by all or any (Y2 contact_readiness). The checks below
-- admit exactly what the frozen data holds.
--
-- ORGANIZATION-SCOPED: every row carries organization_id, cascading from its
-- organization; the content-import engine seeds them for the organization an
-- organization admin loads into (punxsy_prominence for the gym).
--
-- LABELS, NATIVELY (SP-1): field_labels jsonb (per field) and evidence jsonb
-- (the backbone's evidence entries, excerpts removed by the exporter), plus the
-- record's status, sources and decision.
--
-- HISTORY, as the pathway catalog: a changed row is updated in place and
-- recorded as a new version in pilot.reference_content_revisions; a row a
-- later snapshot leaves out is RETIRED (active_flag false) and kept. Deletes
-- are refused by the pathway catalog's own trigger function, except the owning
-- organization's cascade.
--
-- No begin;/commit; here, matching this repo's runner-opens-the-transaction
-- convention; the runner is apps/web/scripts/pilot-apply-assessment-catalog-migration.mjs
-- and it asserts every guarantee above before it commits. Idempotent.
--
-- ONCE APPLIED ANYWHERE, CHANGE THESE TABLES BY A NEW MIGRATION. `create table
-- if not exists` skips a table that exists, so an edit to a table body here
-- would never reach an environment that already ran this file.

do $$
begin
  if to_regclass('pilot.organizations') is null then
    raise exception 'ASSESSMENT_CATALOG_NOT_READY: pilot.organizations does not exist -- apply the multi-organization migration first';
  end if;
  if to_regclass('pilot.pathway_stages') is null
     or to_regprocedure('pilot.pathway_catalog_no_delete()') is null then
    raise exception 'ASSESSMENT_CATALOG_NOT_READY: pilot.pathway_stages does not exist -- apply the pathway-catalog migration first';
  end if;
  if to_regclass('pilot.assessment_protocols') is null then
    raise exception 'ASSESSMENT_CATALOG_NOT_READY: pilot.assessment_protocols does not exist -- apply the assessment-protocols migration first';
  end if;
end;
$$;

-- (1) The protocols' backbone labels ---------------------------------------------
-- Nullable, no default: an existing row gets NULL and keeps every value it had.
alter table pilot.assessment_protocols add column if not exists protocol_group text;
alter table pilot.assessment_protocols add column if not exists status text;
alter table pilot.assessment_protocols add column if not exists sources text[];
alter table pilot.assessment_protocols add column if not exists decision text;
alter table pilot.assessment_protocols add column if not exists field_labels jsonb;
alter table pilot.assessment_protocols add column if not exists evidence jsonb;
alter table pilot.assessment_protocols add column if not exists backbone_version text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'pilot_assessment_protocols_status_check'
                 and conrelid = 'pilot.assessment_protocols'::regclass) then
    alter table pilot.assessment_protocols add constraint pilot_assessment_protocols_status_check
      check (status is null or status in ('OBSERVED', 'REPORTED', 'INFERRED', 'UNVERIFIED'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'pilot_assessment_protocols_field_labels_check'
                 and conrelid = 'pilot.assessment_protocols'::regclass) then
    alter table pilot.assessment_protocols add constraint pilot_assessment_protocols_field_labels_check
      check (field_labels is null or jsonb_typeof(field_labels) = 'object');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'pilot_assessment_protocols_evidence_check'
                 and conrelid = 'pilot.assessment_protocols'::regclass) then
    alter table pilot.assessment_protocols add constraint pilot_assessment_protocols_evidence_check
      check (evidence is null or jsonb_typeof(evidence) in ('object', 'array'));
  end if;
end;
$$;

-- (2) P5 gates --------------------------------------------------------------------
-- One row per stage and kind (2 per stage; 3 for Y2 and T1 in the frozen set).
create table if not exists pilot.pathway_gates (
  organization_id          text not null references pilot.organizations(organization_id) on delete cascade,
  gate_id                  text not null,
  stage_key                text not null,
  gate_kind                text not null,
  informs_only             boolean not null default true,
  override_process         text,
  override_presets_status  text,
  status                   text not null,
  sources                  text[],
  decision                 text,
  field_labels             jsonb,
  evidence                 jsonb,
  backbone_version         text,
  active_flag              boolean not null default true,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  constraint pilot_pathway_gates_pkey primary key (organization_id, gate_id),
  constraint pilot_pathway_gates_stage_kind_key unique (organization_id, stage_key, gate_kind),
  -- The target of a gate_met criterion's three-part key (below).
  constraint pilot_pathway_gates_id_stage_kind_key unique (organization_id, gate_id, stage_key, gate_kind),
  constraint pilot_pathway_gates_stage_fkey
    foreign key (organization_id, stage_key) references pilot.pathway_stages(organization_id, stage_key),
  constraint pilot_pathway_gates_id_check check (gate_id ~ '^pgt_[0-9a-f]{14}$'),
  constraint pilot_pathway_gates_kind_check
    check (gate_kind in ('entry', 'exit', 'contact_readiness', 'checkpoint_90_days')),
  -- A gate informs; it never moves anyone (RULES section 1).
  constraint pilot_pathway_gates_informs_only_check check (informs_only),
  constraint pilot_pathway_gates_status_check
    check (status in ('OBSERVED', 'REPORTED', 'INFERRED', 'UNVERIFIED')),
  constraint pilot_pathway_gates_field_labels_check
    check (field_labels is null or jsonb_typeof(field_labels) = 'object'),
  constraint pilot_pathway_gates_evidence_check
    check (evidence is null or jsonb_typeof(evidence) in ('object', 'array'))
);

comment on table pilot.pathway_gates is
  'Backbone pathway gates (SCHEMA_PROPOSAL P5), per organization. Shown as met, not met or not scored; nothing reads a gate to move, place or restrict anyone (informs_only is always true). Retired, never deleted; versions in reference_content_revisions (dataset pathway_gates).';

-- (3) P5 gate criteria -------------------------------------------------------------
-- The frozen criterion's key is kept as written where a column can hold it;
-- three are renamed for clarity and the field label records the frozen name:
-- text -> criterion_text, stage_key -> ref_stage_key, gate_kind/gate_id ->
-- ref_gate_kind/ref_gate_id, min/max/scope (bout_count) -> bout_min/bout_max/bout_scope.
create table if not exists pilot.pathway_gate_criteria (
  organization_id     text not null references pilot.organizations(organization_id) on delete cascade,
  criterion_id        text not null,
  gate_id             text not null,
  ordinal             integer not null,
  kind                text not null,
  criterion_text      text,
  polarity            text,
  scorecard_item_ids  text[],
  item_numbers        integer[],
  protocol_id         text,
  min_score           numeric,
  contexts            text[],
  combine             text,
  ref_stage_key       text,
  ref_gate_kind       text,
  ref_gate_id         text,
  bout_min            integer,
  bout_max            integer,
  bout_scope          text,
  note                text,
  conflict_resolved   text,
  source_cell         text,
  status              text,
  sources             text[],
  decision            text,
  field_labels        jsonb,
  evidence            jsonb,
  backbone_version    text,
  active_flag         boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint pilot_pathway_gate_criteria_pkey primary key (organization_id, criterion_id),
  constraint pilot_pathway_gate_criteria_gate_fkey
    foreign key (organization_id, gate_id) references pilot.pathway_gates(organization_id, gate_id),
  constraint pilot_pathway_gate_criteria_ref_stage_fkey
    foreign key (organization_id, ref_stage_key) references pilot.pathway_stages(organization_id, stage_key),
  constraint pilot_pathway_gate_criteria_ref_gate_fkey
    foreign key (organization_id, ref_gate_id) references pilot.pathway_gates(organization_id, gate_id),
  -- A gate_met criterion names its gate three ways (stage, kind, id); all three
  -- must be the same gate, so the stage and kind shown are the gate checked.
  constraint pilot_pathway_gate_criteria_ref_gate_match_fkey
    foreign key (organization_id, ref_gate_id, ref_stage_key, ref_gate_kind)
    references pilot.pathway_gates(organization_id, gate_id, stage_key, gate_kind),
  constraint pilot_pathway_gate_criteria_id_check check (criterion_id ~ '^pgc_[0-9a-f]{14}$'),
  constraint pilot_pathway_gate_criteria_ordinal_check check (ordinal > 0),
  constraint pilot_pathway_gate_criteria_kind_check
    check (kind in ('text', 'scorecard_min', 'stage_completed', 'gate_met', 'bout_count')),
  -- Each kind carries what it needs to be shown as met or not met.
  constraint pilot_pathway_gate_criteria_kind_shape_check check (
    (kind <> 'text' or criterion_text is not null)
    and (kind <> 'scorecard_min' or (coalesce(cardinality(scorecard_item_ids), 0) > 0 and min_score is not null and coalesce(cardinality(contexts), 0) > 0))
    and (kind <> 'stage_completed' or ref_stage_key is not null)
    and (kind <> 'gate_met' or (ref_gate_id is not null and ref_stage_key is not null and ref_gate_kind is not null))
    and (kind <> 'bout_count' or bout_min is not null or bout_max is not null)
  ),
  constraint pilot_pathway_gate_criteria_polarity_check
    check (polarity is null or polarity in ('should_have', 'should_not_have')),
  constraint pilot_pathway_gate_criteria_min_score_check check (min_score is null or min_score > 0),
  constraint pilot_pathway_gate_criteria_contexts_check
    check (contexts is null or contexts <@ array['drill', 'shadow', 'partner', 'constrained_live', 'live']::text[]),
  constraint pilot_pathway_gate_criteria_combine_check check (combine is null or combine in ('all', 'any')),
  constraint pilot_pathway_gate_criteria_ref_gate_kind_check
    check (ref_gate_kind is null or ref_gate_kind in ('entry', 'exit', 'contact_readiness', 'checkpoint_90_days')),
  constraint pilot_pathway_gate_criteria_bout_range_check
    check ((bout_min is null or bout_min >= 0) and (bout_max is null or bout_max >= 0)
           and (bout_min is null or bout_max is null or bout_min <= bout_max)),
  constraint pilot_pathway_gate_criteria_status_check
    check (status is null or status in ('OBSERVED', 'REPORTED', 'INFERRED', 'UNVERIFIED')),
  constraint pilot_pathway_gate_criteria_field_labels_check
    check (field_labels is null or jsonb_typeof(field_labels) = 'object'),
  constraint pilot_pathway_gate_criteria_evidence_check
    check (evidence is null or jsonb_typeof(evidence) in ('object', 'array'))
);

-- One active criterion per place in a gate; a retired one keeps its ordinal.
create unique index if not exists pilot_pathway_gate_criteria_one_active_ordinal
  on pilot.pathway_gate_criteria(organization_id, gate_id, ordinal) where active_flag;

comment on table pilot.pathway_gate_criteria is
  'Backbone gate criteria (SCHEMA_PROPOSAL P5), per organization: text a coach confirms, a scorecard minimum, a stage or gate completed, or a bout count. Each informs; none moves anyone. scorecard_item_ids are checked by the content import, not by a foreign key (an array). Retired, never deleted; versions in reference_content_revisions (dataset pathway_gate_criteria).';

-- (4) P6 scales and the non-contact cap --------------------------------------------
create table if not exists pilot.scorecard_scales (
  organization_id   text not null references pilot.organizations(organization_id) on delete cascade,
  scale_key         text not null,
  min_level         integer not null,
  max_level         integer not null,
  level_anchors     jsonb not null,
  status            text not null,
  note              text,
  sources           text[],
  field_labels      jsonb,
  evidence          jsonb,
  backbone_version  text,
  active_flag       boolean not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint pilot_scorecard_scales_pkey primary key (organization_id, scale_key),
  constraint pilot_scorecard_scales_key_check check (scale_key ~ '^[a-z][a-z0-9_]*$'),
  constraint pilot_scorecard_scales_levels_check check (min_level >= 0 and min_level < max_level),
  constraint pilot_scorecard_scales_anchors_check check (jsonb_typeof(level_anchors) = 'object'),
  constraint pilot_scorecard_scales_status_check
    check (status in ('OBSERVED', 'REPORTED', 'INFERRED', 'UNVERIFIED')),
  constraint pilot_scorecard_scales_field_labels_check
    check (field_labels is null or jsonb_typeof(field_labels) = 'object'),
  constraint pilot_scorecard_scales_evidence_check
    check (evidence is null or jsonb_typeof(evidence) in ('object', 'array'))
);

comment on table pilot.scorecard_scales is
  'Backbone scorecard scales (design_catalogs scale_definitions; OD-2026-11-16-001), per organization: what each score means. Retired, never deleted; versions in reference_content_revisions (dataset scorecard_scales).';

-- The cap's scope is held both as the frozen wording (applies_to) and as
-- structured columns (protocol, contexts), so the later rating path need not
-- parse prose.
create table if not exists pilot.scorecard_score_caps (
  organization_id         text not null references pilot.organizations(organization_id) on delete cascade,
  cap_key                 text not null,
  scale_key               text not null,
  max_score               numeric not null,
  applies_to              text not null,
  applies_to_protocol_id  text,
  applies_to_contexts     text[],
  wording                 text,
  decision                text,
  note                    text,
  status                  text not null,
  sources                 text[],
  field_labels            jsonb,
  evidence                jsonb,
  backbone_version        text,
  active_flag             boolean not null default true,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  constraint pilot_scorecard_score_caps_pkey primary key (organization_id, cap_key),
  constraint pilot_scorecard_score_caps_scale_fkey
    foreign key (organization_id, scale_key) references pilot.scorecard_scales(organization_id, scale_key),
  constraint pilot_scorecard_score_caps_key_check check (cap_key ~ '^[a-z][a-z0-9_]*$'),
  constraint pilot_scorecard_score_caps_max_check check (max_score > 0),
  constraint pilot_scorecard_score_caps_contexts_check
    check (applies_to_contexts is null or applies_to_contexts <@ array['drill', 'shadow', 'partner', 'constrained_live', 'live']::text[]),
  constraint pilot_scorecard_score_caps_status_check
    check (status in ('OBSERVED', 'REPORTED', 'INFERRED', 'UNVERIFIED')),
  constraint pilot_scorecard_score_caps_field_labels_check
    check (field_labels is null or jsonb_typeof(field_labels) = 'object'),
  constraint pilot_scorecard_score_caps_evidence_check
    check (evidence is null or jsonb_typeof(evidence) in ('object', 'array'))
);

comment on table pilot.scorecard_score_caps is
  'Score caps on a scale (design_catalogs scale_definitions.non_contact_rule, D-Q11), per organization. Data for the later rating path; nothing in this migration enforces a cap. Retired, never deleted; versions in reference_content_revisions (dataset scorecard_score_caps).';

-- (5) P6 scorecard items -----------------------------------------------------------
-- protocol_id names the protocol's identity, not a version, so it is checked by
-- the content import rather than by the version-keyed foreign key. scale holds
-- the frozen scale text as written; scale_key is the scale it names (null for
-- the item with no scale in its source).
create table if not exists pilot.scorecard_items (
  organization_id    text not null references pilot.organizations(organization_id) on delete cascade,
  scorecard_item_id  text not null,
  protocol_id        text,
  item_number        integer,
  item_group         text,
  name               text not null,
  definition         text not null,
  scale              text not null,
  scale_key          text,
  scorable_contexts  text[],
  gaps               text[],
  status             text not null,
  sources            text[],
  decision           text,
  field_labels       jsonb,
  evidence           jsonb,
  backbone_version   text,
  active_flag        boolean not null default true,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint pilot_scorecard_items_pkey primary key (organization_id, scorecard_item_id),
  constraint pilot_scorecard_items_scale_fkey
    foreign key (organization_id, scale_key) references pilot.scorecard_scales(organization_id, scale_key),
  constraint pilot_scorecard_items_id_check check (scorecard_item_id ~ '^sci_[0-9a-f]{14}$'),
  constraint pilot_scorecard_items_item_number_check check (item_number is null or item_number > 0),
  constraint pilot_scorecard_items_name_check check (length(btrim(name, E' \t\n\r')) > 0),
  constraint pilot_scorecard_items_contexts_check
    check (scorable_contexts is null or scorable_contexts <@ array['drill', 'shadow', 'partner', 'constrained_live', 'live']::text[]),
  constraint pilot_scorecard_items_status_check
    check (status in ('OBSERVED', 'REPORTED', 'INFERRED', 'UNVERIFIED')),
  constraint pilot_scorecard_items_field_labels_check
    check (field_labels is null or jsonb_typeof(field_labels) = 'object'),
  constraint pilot_scorecard_items_evidence_check
    check (evidence is null or jsonb_typeof(evidence) in ('object', 'array'))
);

create unique index if not exists pilot_scorecard_items_one_active_number
  on pilot.scorecard_items(organization_id, protocol_id, item_number)
  where active_flag and protocol_id is not null and item_number is not null;

comment on table pilot.scorecard_items is
  'Backbone scorecard items (SCHEMA_PROPOSAL P6; the Long Road 27-item technical scorecard and the others the frozen catalog holds), per organization. No ratings here (a later lane). Retired, never deleted; versions in reference_content_revisions (dataset scorecard_items).';

-- (6) P6 anchor-clip specs ---------------------------------------------------------
-- What anchor footage is wanted: an item, a level, a context. No clip exists
-- yet; the link to a calibration clip is P6's scorecard_anchor_clips, a later
-- lane. used_by_stage_keys is the frozen used_by_gates (it names stage keys),
-- checked against pilot.pathway_stages by the content import.
create table if not exists pilot.scorecard_anchor_clip_specs (
  organization_id     text not null references pilot.organizations(organization_id) on delete cascade,
  anchor_spec_id      text not null,
  scorecard_item_id   text not null,
  item_number         integer,
  level               integer not null,
  context_class       text not null,
  used_by_stage_keys  text[],
  priority            integer,
  status              text not null,
  sources             text[],
  field_labels        jsonb,
  evidence            jsonb,
  backbone_version    text,
  active_flag         boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint pilot_scorecard_anchor_clip_specs_pkey primary key (organization_id, anchor_spec_id),
  constraint pilot_scorecard_anchor_clip_specs_item_fkey
    foreign key (organization_id, scorecard_item_id) references pilot.scorecard_items(organization_id, scorecard_item_id),
  constraint pilot_scorecard_anchor_clip_specs_id_check check (anchor_spec_id ~ '^acs_[0-9a-f]{14}$'),
  constraint pilot_scorecard_anchor_clip_specs_level_check check (level between 1 and 5),
  constraint pilot_scorecard_anchor_clip_specs_context_check check (context_class in ('live', 'non_contact')),
  constraint pilot_scorecard_anchor_clip_specs_priority_check check (priority is null or priority > 0),
  constraint pilot_scorecard_anchor_clip_specs_status_check
    check (status in ('OBSERVED', 'REPORTED', 'INFERRED', 'UNVERIFIED')),
  constraint pilot_scorecard_anchor_clip_specs_field_labels_check
    check (field_labels is null or jsonb_typeof(field_labels) = 'object'),
  constraint pilot_scorecard_anchor_clip_specs_evidence_check
    check (evidence is null or jsonb_typeof(evidence) in ('object', 'array'))
);

create unique index if not exists pilot_scorecard_anchor_clip_specs_one_active_slot
  on pilot.scorecard_anchor_clip_specs(organization_id, scorecard_item_id, level, context_class) where active_flag;

comment on table pilot.scorecard_anchor_clip_specs is
  'Backbone anchor-clip specs (SCHEMA_PROPOSAL P6), per organization: the reference footage wanted for an item at a level in a context. Specs only; the clip link (scorecard_anchor_clips) is a later lane. Retired, never deleted; versions in reference_content_revisions (dataset scorecard_anchor_clip_specs).';

-- (7) The two behavioural KPI lists (OD-2026-11-16-003) -----------------------------
-- drill = DOC-041's 7 drill KPIs (drill-level scorecards); room = DOC-027's 6
-- core behavioural KPIs (room and session monitoring, D-PK77-1). Shown side by
-- side, each in its own order; no row pairs one list with the other.
create table if not exists pilot.behavior_kpi_lists (
  organization_id    text not null references pilot.organizations(organization_id) on delete cascade,
  list_key           text not null,
  title              text not null,
  source_doc         text not null,
  scope_text         text,
  scoring_rule_text  text,
  status             text not null,
  sources            text[],
  field_labels       jsonb,
  evidence           jsonb,
  backbone_version   text,
  active_flag        boolean not null default true,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint pilot_behavior_kpi_lists_pkey primary key (organization_id, list_key),
  constraint pilot_behavior_kpi_lists_key_check check (list_key in ('drill', 'room')),
  constraint pilot_behavior_kpi_lists_title_check check (length(btrim(title, E' \t\n\r')) > 0),
  constraint pilot_behavior_kpi_lists_status_check
    check (status in ('OBSERVED', 'REPORTED', 'INFERRED', 'UNVERIFIED')),
  constraint pilot_behavior_kpi_lists_field_labels_check
    check (field_labels is null or jsonb_typeof(field_labels) = 'object'),
  constraint pilot_behavior_kpi_lists_evidence_check
    check (evidence is null or jsonb_typeof(evidence) in ('object', 'array'))
);

comment on table pilot.behavior_kpi_lists is
  'The two behavioural KPI lists (OD-2026-11-16-003): drill (DOC-041) and room (DOC-027), each with its own scoring line. Retired, never deleted; versions in reference_content_revisions (dataset behavior_kpi_lists).';

-- scoring_kind is DOC-041's rule (counts, yes-no marks, three levels); a
-- three-level KPI may carry its level anchors (drafted, labelled INFERRED in
-- field_labels). A room KPI leaves scoring_kind blank (DOC-027 states only its
-- list-level rule).
create table if not exists pilot.behavior_kpis (
  organization_id   text not null references pilot.organizations(organization_id) on delete cascade,
  kpi_id            text not null,
  list_key          text not null,
  ordinal           integer not null,
  name              text not null,
  scoring_kind      text,
  level_anchors     jsonb,
  status            text not null,
  sources           text[],
  field_labels      jsonb,
  evidence          jsonb,
  backbone_version  text,
  active_flag       boolean not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint pilot_behavior_kpis_pkey primary key (organization_id, kpi_id),
  constraint pilot_behavior_kpis_list_fkey
    foreign key (organization_id, list_key) references pilot.behavior_kpi_lists(organization_id, list_key),
  constraint pilot_behavior_kpis_id_check check (kpi_id ~ '^kpi_[0-9a-f]{14}$'),
  constraint pilot_behavior_kpis_ordinal_check check (ordinal > 0),
  constraint pilot_behavior_kpis_name_check check (length(btrim(name, E' \t\n\r')) > 0),
  constraint pilot_behavior_kpis_scoring_kind_check
    check (scoring_kind is null or scoring_kind in ('count', 'yes_no', 'three_level')),
  constraint pilot_behavior_kpis_anchors_check
    check (level_anchors is null or (jsonb_typeof(level_anchors) = 'object' and coalesce(scoring_kind, '') = 'three_level')),
  constraint pilot_behavior_kpis_status_check
    check (status in ('OBSERVED', 'REPORTED', 'INFERRED', 'UNVERIFIED')),
  constraint pilot_behavior_kpis_field_labels_check
    check (field_labels is null or jsonb_typeof(field_labels) = 'object'),
  constraint pilot_behavior_kpis_evidence_check
    check (evidence is null or jsonb_typeof(evidence) in ('object', 'array'))
);

create unique index if not exists pilot_behavior_kpis_one_active_ordinal
  on pilot.behavior_kpis(organization_id, list_key, ordinal) where active_flag;

comment on table pilot.behavior_kpis is
  'Behavioural KPIs (OD-2026-11-16-003), per organization, in their list''s own order. Retired, never deleted; versions in reference_content_revisions (dataset behavior_kpis).';

-- (8) Retire, never delete ---------------------------------------------------------
-- The pathway catalog's trigger function (pathway_catalog migration): refuses a
-- delete unless the owning organization is itself being removed.
drop trigger if exists pilot_pathway_gates_no_delete on pilot.pathway_gates;
create trigger pilot_pathway_gates_no_delete
  before delete on pilot.pathway_gates
  for each row execute function pilot.pathway_catalog_no_delete();

drop trigger if exists pilot_pathway_gate_criteria_no_delete on pilot.pathway_gate_criteria;
create trigger pilot_pathway_gate_criteria_no_delete
  before delete on pilot.pathway_gate_criteria
  for each row execute function pilot.pathway_catalog_no_delete();

drop trigger if exists pilot_scorecard_scales_no_delete on pilot.scorecard_scales;
create trigger pilot_scorecard_scales_no_delete
  before delete on pilot.scorecard_scales
  for each row execute function pilot.pathway_catalog_no_delete();

drop trigger if exists pilot_scorecard_score_caps_no_delete on pilot.scorecard_score_caps;
create trigger pilot_scorecard_score_caps_no_delete
  before delete on pilot.scorecard_score_caps
  for each row execute function pilot.pathway_catalog_no_delete();

drop trigger if exists pilot_scorecard_items_no_delete on pilot.scorecard_items;
create trigger pilot_scorecard_items_no_delete
  before delete on pilot.scorecard_items
  for each row execute function pilot.pathway_catalog_no_delete();

drop trigger if exists pilot_scorecard_anchor_clip_specs_no_delete on pilot.scorecard_anchor_clip_specs;
create trigger pilot_scorecard_anchor_clip_specs_no_delete
  before delete on pilot.scorecard_anchor_clip_specs
  for each row execute function pilot.pathway_catalog_no_delete();

drop trigger if exists pilot_behavior_kpi_lists_no_delete on pilot.behavior_kpi_lists;
create trigger pilot_behavior_kpi_lists_no_delete
  before delete on pilot.behavior_kpi_lists
  for each row execute function pilot.pathway_catalog_no_delete();

drop trigger if exists pilot_behavior_kpis_no_delete on pilot.behavior_kpis;
create trigger pilot_behavior_kpis_no_delete
  before delete on pilot.behavior_kpis
  for each row execute function pilot.pathway_catalog_no_delete();
