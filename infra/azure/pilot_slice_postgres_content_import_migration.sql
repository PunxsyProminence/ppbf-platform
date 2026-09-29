-- Content import schema -- versioned reference content, stop rules stored once,
-- and an append-only history ledger.
--
-- Owner rulings, 2026-09-29, verbatim:
--   R2 "1 an d new stuff gets added if there is nothing to update"
--      -- a changed item gets a NEW version and the old one is kept as
--      history; a new item is inserted; an unchanged item is skipped.
--   R3 "every drill is different so the rules would vary, obviously injury of
--      some sort would require stoppage universally"
--      -- stop rules are per drill; a small universal set (injury and the
--      like) is stored ONCE and applies to every drill.
--
-- This is the schema those two rulings need and nothing more. It writes no
-- row. The importer that fills it is separate work.
--
-- (1) A SUPERSEDED DRILL VERSION STAYS LIVE, SO IT MUST NOT HOLD THE NAME.
--     A revision under R2 inserts v2 and sets superseded_at on v1, and v1
--     keeps active = true. It has to: promotion pins the exact reference
--     version a gym adopted (drill_reference_provenance_migration.sql:79-84),
--     and the athlete and restore reads require that pinned row to be active
--     (drillLibraryV3.ts:726, :746, :818; drills.ts:360-367). The code already
--     treats superseded as "a newer version exists", not as withdrawn
--     (drillAdoptionReadiness.ts:51-53; promote/route.test.ts:404-406).
--     The v3 index pilot_drill_library_one_active_name is partial on `active`
--     alone (drill_library_v3_migration.sql:298-299), so while v1 stays active
--     it refuses a v2 that keeps the drill's name -- the ordinary revision.
--     It becomes partial on `active and superseded_at is null`: still one
--     CURRENT drill per name per discipline, and a superseded version no
--     longer occupies the name. Nothing stored today is refused by the new
--     shape, because it is strictly looser than the old one.
--
--     SAME NAME, DROPPED AND RECREATED, guarded on the index's own definition
--     -- the pattern drill_reference_provenance_migration.sql:111-134 used.
--     The v3 migration re-runs on every `all` dispatch and its `create unique
--     index if not exists` is then a no-op against this name, so it cannot put
--     the old shape back. pilot-verify-schema.mjs compares index NAMES only
--     (its own header, "a widened check constraint keeps its name"), so it
--     cannot see this change; the runner's readiness query checks the shape.
--
--     THE SEED LOADER HAD TO CHANGE WITH IT. seed-drill-library.mjs names this
--     index as its ON CONFLICT arbiter by predicate. Postgres infers an arbiter
--     only when the statement's predicate IMPLIES the index's, so `where
--     active` stops matching the new index and the insert fails outright. The
--     loader now says `where active and superseded_at is null`, which implies
--     both shapes, so it works before and after this migration.
--
-- (2) ONE HEAD PER LINEAGE, as an index rather than a promise. A version write
--     supersedes the old head and inserts the new one; if a writer ever does
--     only the second half, a lineage has two current versions and every
--     reader that asks "which is current" gets two answers. Partial on
--     superseded_at is null, NOT on active: a withdrawn head is still the head.
--     The writer order this forces is supersede first, then insert.
--     Applied to pilot.drill_library and pilot.workout_templates, the two
--     tables that carry lineage_id and superseded_at (drill_library_v3 :86-89,
--     workout_templates_v2 :45-49).
--
-- (3) pilot.universal_stop_rules. pilot.drill_stop_rules.drill_id is NOT NULL
--     (drill_library_v3_migration.sql:172), so a rule can only be stored by
--     copying it onto every drill -- which is how five generic lines came to
--     be labelled 'universal' on all 119 drills, lines R3 says are NOT
--     universal. This table holds the stored-once set. It carries the same
--     lineage/version/supersedes shape as pilot.drill_library, so R2 applies
--     to it unchanged.
--     applies_to_contact_levels NULL means every drill. A list narrows the
--     rule to drills at those contact levels (the seeded warm-up line, for
--     example, sits on exactly the 63 drills whose contact_level is not
--     'none'), and the list may only name the drill contact_level vocabulary
--     (drill_library_v3_migration.sql:247).
--     rule_kind is the SAME six-value vocabulary drill_stop_rules has after
--     the widening (drill_vocabulary_widening_migration.sql:89-92), in the
--     same order, so the two constraint definitions deparse identically and
--     the runner asserts they do. A kind added to one and not the other fails
--     the next dispatch instead of drifting.
--
-- (4) pilot.reference_content_revisions. Disciplines, competence levels and
--     cohort definitions cannot hold versions: the first two are keys other
--     tables point at, the last has no version columns. Their history under R2
--     is therefore a ledger: one row per item per version, with the content
--     as recorded. Append-only by trigger -- UPDATE and DELETE are refused --
--     except that removing an ORGANIZATION still removes its history, by the
--     same parent-gone test calibration_annotations_migration.sql:360-367
--     uses, so this table can never block its organization's deletion.
--
-- (5) The pilot.drill_stop_rules table comment said its scope=universal rows
--     "are the five Universal Stop Rules attached to every drill"
--     (drill_library_v3_migration.sql:313-314). R3 says the opposite. The v3
--     migration re-applies its comment whenever it runs, so this migration
--     sits after it in the `all` list and restates the corrected one.
--
-- NOT HERE: field_provenance is untouched (awaiting the owner's label), and
-- no table is named pilot.skills (dead_schema_removal_migration.sql:53 drops
-- that name on every `all` run).
--
-- DEPENDS ON drill-library-v3, drill-vocabulary-widening and
-- workout-templates-v2, all earlier in the workflow's `all` list; the first
-- block below refuses to run without them. No begin;/commit; here, matching
-- this repo's runner-opens-the-transaction convention; the runner is
-- apps/web/scripts/pilot-apply-content-import-migration.mjs and it asserts
-- every guarantee above before it commits.

do $$
begin
  if to_regclass('pilot.drill_library') is null
     or to_regclass('pilot.drill_stop_rules') is null then
    raise exception 'CONTENT_IMPORT_NOT_READY: pilot.drill_library does not exist -- apply the drill library v3 migration first';
  end if;
  if to_regclass('pilot.workout_templates') is null then
    raise exception 'CONTENT_IMPORT_NOT_READY: pilot.workout_templates does not exist -- apply the workout templates v2 migration first';
  end if;
  -- The universal rule_kind vocabulary is defined to equal the WIDENED one.
  -- Created before the widening, the two would start out different.
  if not exists (
    select 1 from pg_constraint
    where conname = 'pilot_drill_stop_rule_kind_check'
      and conrelid = 'pilot.drill_stop_rules'::regclass
  ) then
    raise exception 'CONTENT_IMPORT_NOT_READY: pilot_drill_stop_rule_kind_check is missing -- apply the drill vocabulary widening migration first';
  end if;
end
$$;

-- (1) --------------------------------------------------------------------------
-- Dropped unless it is already exactly the new shape: unique, on the three
-- columns, partial on both conditions. A missing or non-partial predicate is
-- coalesced to '' so it counts as the wrong shape rather than as unknown.
do $$
begin
  if exists (
    select 1
    from pg_index i
    join pg_class c on c.oid = i.indexrelid
    where i.indrelid = 'pilot.drill_library'::regclass
      and c.relname = 'pilot_drill_library_one_active_name'
      and not (
        i.indisunique
        and pg_get_indexdef(i.indexrelid) like '%(organization_id, discipline, name)%'
        and coalesce(pg_get_expr(i.indpred, i.indrelid), '') like '%active%'
        and coalesce(pg_get_expr(i.indpred, i.indrelid), '') like '%superseded_at IS NULL%'
      )
  ) then
    drop index pilot.pilot_drill_library_one_active_name;
  end if;
end
$$;

create unique index if not exists pilot_drill_library_one_active_name
  on pilot.drill_library(organization_id, discipline, name)
  where active and superseded_at is null;

comment on index pilot.pilot_drill_library_one_active_name is
  'One CURRENT drill per name per discipline. A superseded version stays active for the gyms that adopted it, so it must not hold the name its successor keeps. Redefined by the content-import migration.';

-- (2) --------------------------------------------------------------------------
create unique index if not exists pilot_drill_library_one_head_per_lineage
  on pilot.drill_library(organization_id, lineage_id)
  where superseded_at is null;

create unique index if not exists pilot_workout_templates_one_head_per_lineage
  on pilot.workout_templates(organization_id, lineage_id)
  where superseded_at is null;

-- (3) --------------------------------------------------------------------------
create table if not exists pilot.universal_stop_rules (
  organization_id       text not null references pilot.organizations(organization_id) on delete cascade,
  universal_rule_id     text not null,
  lineage_id            text not null,
  version               integer not null default 1,
  supersedes_rule_id    text null,
  superseded_at         timestamptz null,
  active                boolean not null default true,
  ordinal               integer not null,
  condition_text        text not null,
  rule_kind             text not null,
  applies_to_contact_levels text[] null,
  created_by_account_id text null,
  created_by_role       text null,
  created_at            timestamptz not null default now(),
  constraint pilot_universal_stop_rules_pkey primary key (organization_id, universal_rule_id),
  constraint pilot_universal_stop_rules_lineage_version_uq unique (organization_id, lineage_id, version),
  -- Composite for the reason drill_library_v3 :278-280 gives: a scalar key
  -- would let one gym's version chain point at another gym's rule.
  constraint pilot_universal_stop_rules_supersedes_fk foreign key (organization_id, supersedes_rule_id)
    references pilot.universal_stop_rules(organization_id, universal_rule_id),
  constraint pilot_universal_stop_rules_id_check
    check (universal_rule_id ~ '^ust_[^[:space:]]+$'),
  constraint pilot_universal_stop_rules_version_check check (version > 0),
  constraint pilot_universal_stop_rules_supersedes_not_self_check
    check (supersedes_rule_id is null or supersedes_rule_id <> universal_rule_id),
  constraint pilot_universal_stop_rules_ordinal_check check (ordinal > 0),
  constraint pilot_universal_stop_rules_condition_check
    check (length(btrim(condition_text, E' \t\n\r')) > 0),
  constraint pilot_universal_stop_rules_rule_kind_check
    check (rule_kind in
      ('technique_degradation', 'fatigue', 'safety', 'intent_drift', 'coach_judgment', 'warmup_decay')),
  -- An empty list would mean "applies to no drill", which is a withdrawn rule
  -- spelled ambiguously; `active = false` already says that. <@ is false for a
  -- NULL element, so a list cannot smuggle one in.
  constraint pilot_universal_stop_rules_contact_levels_check
    check (
      applies_to_contact_levels is null
      or (
        cardinality(applies_to_contact_levels) > 0
        and applies_to_contact_levels
          <@ array['none', 'light_technical', 'conditioned', 'controlled_sparring', 'open_sparring']::text[]
      )
    )
);

-- The rules render as an ordered checklist, so two current rules at one
-- position would be an ambiguous list. A superseded or withdrawn rule frees
-- its position.
create unique index if not exists pilot_universal_stop_rules_one_current_per_ordinal
  on pilot.universal_stop_rules(organization_id, ordinal)
  where superseded_at is null and active;

create unique index if not exists pilot_universal_stop_rules_one_head_per_lineage
  on pilot.universal_stop_rules(organization_id, lineage_id)
  where superseded_at is null;

comment on table pilot.universal_stop_rules is
  'Stop rules stored ONCE per gym that apply to every drill (owner ruling 2026-09-29: "obviously injury of some sort would require stoppage universally"). applies_to_contact_levels NULL = every drill; a list narrows the rule to drills at those contact levels. Versioned like pilot.drill_library: a revision inserts a new version and sets superseded_at on the old one.';

-- (4) --------------------------------------------------------------------------
create table if not exists pilot.reference_content_revisions (
  organization_id        text not null references pilot.organizations(organization_id) on delete cascade,
  dataset                text not null,
  item_key               text not null,
  version                integer not null,
  content                jsonb not null,
  content_sha256         text not null,
  import_id              text not null,
  recorded_by_account_id text not null,
  recorded_by_role       text not null,
  recorded_at            timestamptz not null default now(),
  constraint pilot_reference_content_revisions_pkey
    primary key (organization_id, dataset, item_key, version),
  -- A lowercase slug, so 'Disciplines' and 'disciplines' cannot split one
  -- item's history across two datasets that each look complete.
  constraint pilot_reference_content_revisions_dataset_check
    check (dataset ~ '^[a-z][a-z0-9_]*$'),
  constraint pilot_reference_content_revisions_item_key_check
    check (length(btrim(item_key, E' \t\n\r')) > 0),
  constraint pilot_reference_content_revisions_version_check check (version > 0),
  constraint pilot_reference_content_revisions_content_check
    check (jsonb_typeof(content) = 'object'),
  constraint pilot_reference_content_revisions_sha256_check
    check (content_sha256 ~ '^[0-9a-f]{64}$'),
  constraint pilot_reference_content_revisions_import_id_check
    check (length(btrim(import_id, E' \t\n\r')) > 0)
);

-- APPEND-ONLY BY TRIGGER. A history row records what an item said at one
-- version; editing or removing it rewrites the history R2 asks to keep.
-- The one delete allowed is its organization's own cascade: by the time the
-- cascade reaches this table the organization row is already gone, so the
-- lookup finds nothing -- the same parent-gone test
-- calibration_annotations_migration.sql:360-367 relies on. A direct DELETE
-- while the organization exists is refused.
create or replace function pilot.reference_content_revisions_append_only()
returns trigger
language plpgsql
as $pilot_reference_revisions_append_only$
begin
  if tg_op = 'DELETE' and not exists (
    select 1 from pilot.organizations where organization_id = old.organization_id
  ) then
    return old;
  end if;
  raise exception 'REFERENCE_CONTENT_REVISION_IMMUTABLE'
    using errcode = 'restrict_violation';
end;
$pilot_reference_revisions_append_only$;

drop trigger if exists pilot_reference_content_revisions_append_only
  on pilot.reference_content_revisions;
create trigger pilot_reference_content_revisions_append_only
  before update or delete on pilot.reference_content_revisions
  for each row
  execute function pilot.reference_content_revisions_append_only();

comment on table pilot.reference_content_revisions is
  'Append-only history for keyed reference datasets that cannot hold versions themselves (disciplines and competence levels are foreign-key targets; cohort definitions have no version columns). One row per item per version, as recorded by an import. UPDATE and DELETE are refused by trigger; only the owning organization''s deletion removes rows.';

-- (5) --------------------------------------------------------------------------
comment on table pilot.drill_stop_rules is
  'Stop conditions belonging to ONE drill each (drill_id is NOT NULL). scope is a legacy label: under the owner ruling of 2026-09-29 ("every drill is different so the rules would vary") the five generic lines seeded with scope=universal on every drill are NOT universal rules. Rules that apply to every drill are stored once in pilot.universal_stop_rules.';
