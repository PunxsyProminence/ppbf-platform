-- Drill library v3 schema -- same-lesson scaling, per-drill stop rules, multi-discipline.
--
-- Rebuilds the drill concept around the structure already in use at PPBF
-- (Punxsy_Drill_Library_Source_v3), a richer model than pilot.drills'
-- four-field catalog. This is a NEW, SEPARATE table (pilot.drill_library),
-- not an alteration of pilot.drills -- the two hold different content and
-- neither migrates into the other here. Whether/when pilot.drills content
-- moves to this library is a product decision outside this migration's
-- scope.
--
-- TWO INDEPENDENT AXES. difficulty and scale_level are NOT the same thing
-- and neither replaces the other.
--
--   difficulty  = what the drill REQUIRES to be attempted at all. An
--                 angle-cutting drill presupposes a pivot; that
--                 prerequisite does not disappear at low demand. A property
--                 of the drill, fixed at authoring, mapping to the skill
--                 graph.
--   scale_level = how much demand is applied WITHIN the drill right now. A
--                 property of this running of it, chosen by the coach in
--                 the moment.
--
-- An advanced drill run at A is still an advanced drill -- it is the
-- advanced lesson at reduced demand so the athlete can feel the target
-- behaviour. A beginner drill run at C is still a beginner drill, under
-- added stress. Collapsing the two axes would either bar advanced athletes
-- from controlled work or hand a beginner a drill whose prerequisites they
-- do not have.
--
-- B IS THE STARTING POINT. Every drill is authored at B -- the drill as
-- designed, standard system level. A and C are modifications OF that
-- anchor, not separate drills. The scaling manual lists "treating A like
-- beginner work only and therefore beneath better athletes" as a COMMON
-- ERROR, which is precisely why A must remain available at every
-- difficulty.
--
-- A/B/C definitions, verbatim from the scaling manual:
--   A = simplified picture, controlled success; the target behaviour is
--       felt and repeated cleanly
--   B = fight level / standard system level; the intended real demand, no
--       decoration
--   C = harder than fight; stress, delay, variation or disruption, SAME
--       lesson preserved
-- A difficulty ladder would encode "A = beneath better athletes" directly
-- into the schema. A/B/C does not, and it is what lets a mixed room --
-- adaptive athlete and competitor -- run one lesson together.
--
-- The governing progression rule, carried as data rather than left in a
-- manual: "Harder is only better if the target behavior still appears. If
-- a higher version removes the intended behavior, it is the wrong
-- version." That is what target_behavior exists for.
--
-- STOP RULES ARE PER DRILL, NOT PER SESSION. Every drill in the source
-- library carries its own stop conditions -- "stop when exits become late
-- on consecutive reps", "stop when fatigue makes balance recovery
-- unreliable". A session-level safety policy cannot express those. Live
-- work starts early in this system, so the safety condition has to live
-- inside the drill.
--
-- DISCIPLINE IS A COLUMN. Wrestling and an adapted combatives course are
-- planned. Session structure, assessment protocols, clearances and the
-- coach-review loop are discipline-independent; the skill graph and the
-- drills are not. One discriminator keeps one library rather than parallel
-- systems -- the same principle the scaling manual applies to demand
-- levels.
--
-- VERSIONING, matching the same lineage_id/version/supersedes_drill_id
-- shape drillVersioning.ts already established for pilot.drills, for the
-- same reason: the first coach correction to a generated draft must not
-- overwrite it silently. Every generated field here is DRAFT content --
-- see field_provenance and content_class -- so preserving the pre-edit
-- state is not optional. Deliberately does NOT reuse
-- pilot.drill_change_proposals: that review lifecycle is scoped to
-- pilot.drills specifically, and this table's own supersedes/version
-- columns are enough for a first cut. A shared change-proposal review
-- lifecycle across both libraries is a reasonable future consolidation,
-- not attempted here.
--
-- DEPENDS ON pilot.organizations. No begin;/commit; here on purpose,
-- matching this repo's runner-opens-the-transaction convention (the runner
-- is apps/web/scripts/pilot-apply-drill-library-v3-migration.mjs).

create table if not exists pilot.drill_library (
  organization_id   text not null references pilot.organizations(organization_id) on delete cascade,
  drill_id          text not null,
  lineage_id        text not null,
  version           integer not null default 1,
  supersedes_drill_id text null,
  superseded_at     timestamptz null,

  name              text not null,
  discipline        text not null default 'boxing',
  category          text not null,
  difficulty        text not null default 'intermediate',  -- prerequisite level; independent of scale
  skill_id          text null,              -- links to the 67-skill prerequisite graph
  target_behavior   text not null,          -- the lesson every scale level must still produce

  purpose           text not null,
  standard_setup    text not null,
  execution         text not null,
  what_good_looks_like text not null,
  what_bad_looks_like  text not null,
  common_errors     text not null default '',
  corrections       text not null default '',
  transfer          text not null default '',

  contact_level     text not null default 'none',
  equipment_needed  text not null default '',
  requires_coach_authorization boolean not null default false,
  content_class     text not null default 'COACHING CRAFT - informed by evidence, not individually validated',
  source_ref        text null,              -- provenance: source manual, lineage, or registry claim

  -- ADDED BEYOND THE LITERAL PROPOSED SCHEMA: the seed content this
  -- migration exists to carry names both of these on every drill (see
  -- README_DRILL_LIBRARY_V3.md), and the whole citation-traceability
  -- point of the literature-grounded fill -- "any statement can be traced
  -- back to a verified source" -- depends on grounding_claim_ids surviving
  -- the load, not being silently dropped at the schema boundary.
  -- field_provenance is the three-tier vocabulary the README defines and
  -- the supplied seed CSV actually carries verbatim: a human-authored row
  -- (PPBF source manual v3), an AI-generated row citing registry claims
  -- (LITERATURE-GROUNDED DRAFT, requires floor validation), or an
  -- AI-generated row with no directly relevant claims retrieved
  -- (COACHING-CRAFT DRAFT, also requires floor validation). Every value
  -- here is DRAFT until a coach validates it on the floor -- this column
  -- records how it got here, not whether it is trusted. The CHECK below
  -- matches the CSV's strings exactly, not a shortened paraphrase -- the
  -- seed loader has no normalization step, so anything else here would
  -- reject every literature-grounded and coaching-craft row on load.
  grounding_claim_ids text[] not null default '{}'::text[],
  field_provenance  text not null default 'PPBF source manual v3',

  active            boolean not null default true,
  created_by_account_id text null,
  created_by_role   text null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint pilot_drill_library_pkey primary key (organization_id, drill_id)
);

-- One drill, three demand levels. A row per level, all sharing the drill.
create table if not exists pilot.drill_scale_levels (
  organization_id   text not null references pilot.organizations(organization_id) on delete cascade,
  scale_id          text not null,
  drill_id          text not null,
  scale_level       text not null check (scale_level in ('A','B','C')),
  -- true on B only: the drill as designed. Not in the literal spec text as
  -- its own constraint, but the spec's own description of
  -- pilot_drill_scale_one_start ("exactly one is_starting_point row ... and
  -- it must be B") is two claims, and the partial unique index alone only
  -- enforces the first ("at most one"). This CHECK is what enforces the
  -- second.
  is_starting_point boolean not null default false check (not is_starting_point or scale_level = 'B'),
  demand_description text not null,
  constraint_applied text not null default '',
  contact_level     text not null default 'none',
  coach_watch_point text not null default '',
  authoring_state   text not null default 'authored'
                    check (authoring_state in ('authored','scaffold_needs_coach_review')),
  constraint pilot_drill_scale_pkey primary key (organization_id, scale_id),
  constraint pilot_drill_scale_drill_fk foreign key (organization_id, drill_id)
    references pilot.drill_library(organization_id, drill_id) on delete cascade,
  constraint pilot_drill_scale_level_uq unique (organization_id, drill_id, scale_level)
);

-- Stop conditions, one row each, so a coach-facing UI can render them as a
-- checklist and a triggered stop can be recorded against the specific
-- condition that fired.
create table if not exists pilot.drill_stop_rules (
  organization_id   text not null references pilot.organizations(organization_id) on delete cascade,
  stop_rule_id      text not null,
  drill_id          text not null,
  ordinal           integer not null check (ordinal > 0),
  condition_text    text not null,
  scope             text not null default 'drill_specific'
                    check (scope in ('universal','drill_specific')),
  rule_kind         text not null check (rule_kind in
                      ('technique_degradation','fatigue','safety','intent_drift','coach_judgment')),
  constraint pilot_drill_stop_pkey primary key (organization_id, stop_rule_id),
  constraint pilot_drill_stop_drill_fk foreign key (organization_id, drill_id)
    references pilot.drill_library(organization_id, drill_id) on delete cascade,
  constraint pilot_drill_stop_ordinal_uq unique (organization_id, drill_id, ordinal)
);

-- Cues belong to a drill AND to a cue family, because the scaling manual
-- requires all three levels to "use the same cue family". Cue wording is
-- coaching craft; the evidence attaches to the cue CLASS (external /
-- analogy / constraint), never to the exact words.
create table if not exists pilot.drill_cues (
  organization_id   text not null references pilot.organizations(organization_id) on delete cascade,
  cue_id            text not null,
  drill_id          text not null,
  cue_text          text not null,
  cue_family        text not null default '',
  focus_type        text not null default 'unspecified'
                    check (focus_type in ('external','internal','analogy','constraint','unspecified')),
  evidence_note     text not null default '',
  source_ref        text null,
  constraint pilot_drill_cues_pkey primary key (organization_id, cue_id),
  constraint pilot_drill_cues_drill_fk foreign key (organization_id, drill_id)
    references pilot.drill_library(organization_id, drill_id) on delete cascade
);

do $$
begin
  -- THE DISCIPLINE CHECK IS RETIRED, BUT ONLY ONCE THE REGISTRY HAS TAKEN OVER.
  --
  -- Owner decision, 2026-08-28, verbatim: "drop the check and let the registry
  -- govern." pilot_drill_library_discipline_check is dropped by the
  -- drill-library-check-drop migration, which runs at the end of the `all` list
  -- and refuses to run unless pilot_drill_library_discipline_fk -- the
  -- (organization_id, discipline) key into pilot.disciplines -- is installed.
  --
  -- The `all` chain re-runs EVERY migration on every dispatch, so an
  -- unconditional `if not exists` here would put the constraint straight back
  -- on the next dispatch. Two things follow, and the second is why this is not
  -- a tidiness question:
  --
  --   * the drop would be undone and redone forever, so no environment's state
  --     between migrations would mean what it says;
  --   * `alter table ... add constraint ... check` VALIDATES the existing rows.
  --     Once any gym files a drill under a discipline outside these five
  --     literals -- a bjj drill, which is the entire point of the owner's
  --     decision -- this statement fails with 23514 and takes the whole
  --     dispatch down. Measured, not predicted: see the
  --     'does not fail against a row the dropped CHECK would have refused'
  --     case in drillLibraryCheckDrop.pg.test.ts, which was watched to fail
  --     with exactly that error before this condition was added.
  --
  -- So the literal CHECK is installed only while the registry key is NOT yet
  -- present. On a fresh rebuild that reproduces the historical sequence exactly
  -- -- this migration sits at 49 and creates the CHECK, the registry arrives at
  -- 62, the FK later still, and the drop migration last -- and on an
  -- already-migrated environment it is a no-op. The column is never ungoverned
  -- in either direction: whichever of the two constraints is not yet installed,
  -- the other one is.
  if not exists (select 1 from pg_constraint where conname='pilot_drill_library_discipline_check'
                 and conrelid='pilot.drill_library'::regclass)
     and not exists (select 1 from pg_constraint where conname='pilot_drill_library_discipline_fk'
                     and conrelid='pilot.drill_library'::regclass and contype='f') then
    alter table pilot.drill_library add constraint pilot_drill_library_discipline_check
      check (discipline in ('boxing','wrestling','combatives','conditioning','general'));
  end if;
  if not exists (select 1 from pg_constraint where conname='pilot_drill_library_contact_check'
                 and conrelid='pilot.drill_library'::regclass) then
    alter table pilot.drill_library add constraint pilot_drill_library_contact_check
      check (contact_level in ('none','light_technical','conditioned','controlled_sparring','open_sparring'));
  end if;
  if not exists (select 1 from pg_constraint where conname='pilot_drill_library_version_check'
                 and conrelid='pilot.drill_library'::regclass) then
    alter table pilot.drill_library add constraint pilot_drill_library_version_check check (version > 0);
  end if;
  if not exists (select 1 from pg_constraint where conname='pilot_drill_library_difficulty_check'
                 and conrelid='pilot.drill_library'::regclass) then
    alter table pilot.drill_library add constraint pilot_drill_library_difficulty_check
      check (difficulty in ('beginner','intermediate','advanced','elite'));
  end if;
  -- Not in the literal spec text, but the same guard drillVersioning.ts's
  -- pilot_drills_supersedes_not_self_check applies for the identical
  -- reason: a drill cannot supersede itself.
  if not exists (select 1 from pg_constraint where conname='pilot_drill_library_supersedes_not_self_check'
                 and conrelid='pilot.drill_library'::regclass) then
    alter table pilot.drill_library add constraint pilot_drill_library_supersedes_not_self_check
      check (supersedes_drill_id is null or supersedes_drill_id <> drill_id);
  end if;
  if not exists (select 1 from pg_constraint where conname='pilot_drill_library_field_provenance_check'
                 and conrelid='pilot.drill_library'::regclass) then
    alter table pilot.drill_library add constraint pilot_drill_library_field_provenance_check
      check (field_provenance in (
        'PPBF source manual v3',
        'LITERATURE-GROUNDED DRAFT — generated from cited registry claims; REQUIRES FLOOR VALIDATION',
        'COACHING-CRAFT DRAFT — no directly relevant research retrieved; REQUIRES FLOOR VALIDATION'
      ));
  end if;
end
$$;

-- Composite self-reference, matching drillVersioning.ts's own reasoning: a
-- scalar key on supersedes_drill_id alone would let one gym's version
-- chain point at another gym's drill.
do $$
begin
  if not exists (select 1 from pg_constraint where conname='pilot_drill_library_supersedes_fk'
                 and conrelid='pilot.drill_library'::regclass) then
    alter table pilot.drill_library add constraint pilot_drill_library_supersedes_fk
      foreign key (organization_id, supersedes_drill_id)
      references pilot.drill_library(organization_id, drill_id);
  end if;
end
$$;

-- Exactly one starting point per drill, and it is B.
create unique index if not exists pilot_drill_scale_one_start
  on pilot.drill_scale_levels(organization_id, drill_id) where is_starting_point;

-- Partial: a superseded v1 and an active v2 legitimately share a name
-- within a discipline.
create unique index if not exists pilot_drill_library_one_active_name
  on pilot.drill_library(organization_id, discipline, name) where active;
create unique index if not exists pilot_drill_library_lineage_version
  on pilot.drill_library(organization_id, lineage_id, version);
create index if not exists pilot_drill_library_browse
  on pilot.drill_library(organization_id, discipline, category) where active;
create index if not exists pilot_drill_library_skill
  on pilot.drill_library(organization_id, skill_id) where active;

comment on table pilot.drill_library is
  'Literature-grounded drill library (source: Punxsy_Drill_Library_Source_v3). Every generated field is DRAFT content -- see field_provenance and content_class -- requiring floor validation before it reaches athletes.';

comment on table pilot.drill_scale_levels is
  'A/B/C demand scaling per drill. B is the authored starting point (exactly one per drill, enforced by pilot_drill_scale_one_start); A and C are modifications of B, not separate drills.';

comment on table pilot.drill_stop_rules is
  'Per-drill stop conditions. scope=universal rows are the five Universal Stop Rules attached to every drill; scope=drill_specific rows are unique to one drill.';
