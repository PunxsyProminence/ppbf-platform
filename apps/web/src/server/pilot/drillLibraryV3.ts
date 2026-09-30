import { INLINE_CLAIM_TAG_PATTERN } from './contentImport/ids';
import { query, queryOne } from './db';
import { memberCodesForFamily } from './skillFamilies';

// pilot.drill_library, pilot.drill_scale_levels, pilot.drill_stop_rules and
// pilot.drill_cues are owned by
// infra/azure/pilot_slice_postgres_drill_library_v3_migration.sql, and
// pilot.universal_stop_rules (read with every drill detail) by
// infra/azure/pilot_slice_postgres_content_import_migration.sql -- both applied
// through the apply-migrations workflow like every other table. Nothing here
// issues DDL.
//
// READ-ONLY MODULE. The migration's own header notes that a change-proposal
// review lifecycle for this library (mirroring drillVersioning.ts for
// pilot.drills) is a reasonable future consolidation, not attempted in this
// pass -- so there is no write path here beyond what the content-import core
// does when it loads the drill library (contentImport/datasets/drills.ts). Every field is draft content (see field_provenance and
// content_class below) until a coach validates it on the floor; this module
// exists to surface that content for review, not to mutate it.

export type DrillScaleLevel = 'A' | 'B' | 'C';

export interface DrillLibraryRow {
  organization_id: string;
  drill_id: string;
  lineage_id: string;
  version: number;
  supersedes_drill_id: string | null;
  superseded_at: string | null;
  name: string;
  discipline: string;
  category: string;
  difficulty: string;
  skill_id: string | null;
  target_behavior: string;
  purpose: string;
  standard_setup: string;
  execution: string;
  what_good_looks_like: string;
  what_bad_looks_like: string;
  common_errors: string;
  corrections: string;
  transfer: string;
  contact_level: string;
  equipment_needed: string;
  requires_coach_authorization: boolean;
  content_class: string;
  source_ref: string | null;
  grounding_claim_ids: string[];
  field_provenance: string;
  active: boolean;
  created_by_account_id: string | null;
  created_by_role: string | null;
  created_at: string;
  updated_at: string;
}

export interface DrillScaleLevelRow {
  organization_id: string;
  scale_id: string;
  drill_id: string;
  scale_level: DrillScaleLevel;
  is_starting_point: boolean;
  demand_description: string;
  constraint_applied: string;
  contact_level: string;
  coach_watch_point: string;
  authoring_state: string;
}

/**
 * Where a stop rule a reader returns came from (owner ruling R3, 2026-09-29:
 * "every drill is different so the rules would vary, obviously injury of some
 * sort would require stoppage universally").
 *
 *   drill      a pilot.drill_stop_rules row of THIS drill version -- the
 *              drill's own rule, whatever its legacy `scope` says. The five
 *              generic lines seeded with scope='universal' on every drill are
 *              NOT universal under R3 (content-import migration, section (5)),
 *              so `scope` never decides this.
 *   universal  a pilot.universal_stop_rules row: stored ONCE for the gym and
 *              applying to every drill (or every drill at the contact levels
 *              it names).
 *
 * The two sets are returned in separate arrays AND each rule carries this
 * marker, so a consumer that merges them -- a printed sheet, an assistant
 * context, a future view -- cannot lose which is which.
 */
export type StopRuleOrigin = 'drill' | 'universal';

export interface DrillStopRuleRow {
  organization_id: string;
  stop_rule_id: string;
  drill_id: string;
  ordinal: number;
  condition_text: string;
  /** Legacy authoring label. Not where the rule came from: see `origin`. */
  scope: 'universal' | 'drill_specific';
  rule_kind: string;
  origin: 'drill';
}

/**
 * One of the gym's stored-once stop rules (pilot.universal_stop_rules), as a
 * coach reads it with a drill. Only the CURRENT version of each rule is ever
 * returned (active, superseded_at null), and only when it applies to the drill:
 * applies_to_contact_levels is null (every drill) or names the drill's
 * contact_level.
 */
export interface UniversalStopRuleRow {
  organization_id: string;
  universal_rule_id: string;
  lineage_id: string;
  version: number;
  ordinal: number;
  condition_text: string;
  rule_kind: string;
  applies_to_contact_levels: string[] | null;
  origin: 'universal';
}

export interface DrillCueRow {
  organization_id: string;
  cue_id: string;
  drill_id: string;
  cue_text: string;
  cue_family: string;
  focus_type: string;
  evidence_note: string;
  /**
   * OPTIONAL AUTHORING-LINEAGE METADATA. Owner ruling OD-2026-09-15-001.
   *
   * It records where a cue row, authoring batch, source library or manual came
   * from. It is NOT a claim that the exact cue wording appears in the named
   * source, and it is NOT the evidence authority for the wording or for the cue
   * class/focus -- cue wording is coaching craft, and the evidence for a cue's
   * class lives in `evidence_note` and the grounding model. The migration says
   * the same thing above the table: evidence attaches to the cue CLASS, "never
   * to the exact words".
   *
   * NULL is permitted.
   *
   * The referenced artifact need not remain retrievable -- an authoring batch
   * can be real and its artifact gone. What the value must be is truthful:
   * lineage is never fabricated.
   *
   * This describes what the field MEANS, and nothing about how that meaning
   * should be enforced.
   */
  source_ref: string | null;
}

/**
 * A secondary skill relationship, owned by
 * infra/azure/pilot_slice_postgres_drill_secondary_skills_migration.sql.
 *
 * Three columns and no more: the relation IS its own key, so there is no
 * surrogate id, and every row means the same thing, so there is no type
 * discriminator. drill_library.skill_id remains the single PRIMARY owner and
 * never appears here.
 */
export interface DrillSecondarySkillRow {
  organization_id: string;
  drill_id: string;
  skill_id: string;
}

export interface DrillWithDetail extends DrillLibraryRow {
  scale_levels: DrillScaleLevelRow[];
  /** The drill's OWN stop rules: every pilot.drill_stop_rules row of this version. */
  stop_rules: DrillStopRuleRow[];
  /** The gym's stored-once rules that apply to this drill. Never counted as the drill's own. */
  universal_stop_rules: UniversalStopRuleRow[];
  cues: DrillCueRow[];
  secondary_skills: DrillSecondarySkillRow[];
}

const DRILL_FIELDS =
  'organization_id, drill_id, lineage_id, version, supersedes_drill_id, superseded_at, name, '
  + 'discipline, category, difficulty, skill_id, target_behavior, purpose, standard_setup, execution, '
  + 'what_good_looks_like, what_bad_looks_like, common_errors, corrections, transfer, contact_level, '
  + 'equipment_needed, requires_coach_authorization, content_class, source_ref, grounding_claim_ids, '
  + 'field_provenance, active, created_by_account_id, created_by_role, created_at, updated_at';

const SCALE_FIELDS =
  'organization_id, scale_id, drill_id, scale_level, is_starting_point, demand_description, '
  + 'constraint_applied, contact_level, coach_watch_point, authoring_state';

const STOP_RULE_FIELDS = 'organization_id, stop_rule_id, drill_id, ordinal, condition_text, scope, rule_kind';

const UNIVERSAL_STOP_RULE_FIELDS =
  'organization_id, universal_rule_id, lineage_id, version, ordinal, condition_text, rule_kind, applies_to_contact_levels';

/**
 * The gym's CURRENT stored-once stop rules that apply to a drill at
 * `contactLevel`, in checklist order. One query shared by the coach and athlete
 * detail reads, so the two audiences can never be told a different set.
 *
 *   active and superseded_at is null
 *     The current version only. A revision supersedes the old version first
 *     and inserts the new one (content-import migration, section (3)), so a
 *     superseded row is history and a withdrawn head (active = false) applies
 *     to nothing.
 *   applies_to_contact_levels is null or $2 = any(...)
 *     NULL means every drill; a list narrows the rule to drills at those
 *     contact levels (the migration's CHECK keeps the list non-empty and
 *     inside the drill contact_level vocabulary).
 *
 * The organization term is the tenant boundary, as everywhere in this module.
 */
async function readUniversalStopRules(organizationId: string, contactLevel: string): Promise<UniversalStopRuleRow[]> {
  const rows = await query<Omit<UniversalStopRuleRow, 'origin'>>(
    `select ${UNIVERSAL_STOP_RULE_FIELDS}
     from pilot.universal_stop_rules
     where organization_id = $1
       and active
       and superseded_at is null
       and (applies_to_contact_levels is null or $2::text = any(applies_to_contact_levels))
     order by ordinal`,
    [organizationId, contactLevel],
  );
  return rows.map((row) => ({ ...row, origin: 'universal' as const }));
}

const CUE_FIELDS = 'organization_id, cue_id, drill_id, cue_text, cue_family, focus_type, evidence_note, source_ref';

const SECONDARY_SKILL_FIELDS = 'organization_id, drill_id, skill_id';

/**
 * The coach-facing browse list: CURRENT versions only (active, and not
 * superseded), filterable by the axes a coach actually plans around.
 *
 * WHY superseded_at IS A SECOND TERM BESIDE active. Under owner ruling R2 a
 * revised drill becomes v(n+1) and the old head gets superseded_at but stays
 * active = true, because gyms that adopted it keep reading that exact version
 * (the athlete reads below require the pinned row to be active). `active`
 * alone would therefore list v1 and v2 side by side. A gym that runs v1 still
 * reaches it: its operational drill opens the pinned reference by id through
 * getDrillWithDetail, which has no such filter, and the head reports
 * 'newer_version_available' in listReferenceLifecycles. A gym that RETIRED its
 * v1 drill has no operational card for it (retired drills are left out of that
 * list), so the head reports 'newer_version_retired' instead and the coach page
 * offers Restore there.
 *
 * difficulty here is the authoring-time prerequisite band (see the
 * migration's two-axes note) -- it is NOT a scale filter. Scale level is a
 * per-running choice, not a library-browse filter, so it has no parameter
 * here.
 *
 * TWO SKILL FILTERS, AND THE DIFFERENCE BETWEEN THEM IS THE POINT.
 *
 *   skillId        matches the PRIMARY owner only -- drill_library.skill_id.
 *                  Its meaning is UNCHANGED, deliberately. A caller already
 *                  asking this question is asking who OWNS the drill, and
 *                  widening it in place would silently convert every existing
 *                  primary-owner query into a related-to query without one of
 *                  them being edited.
 *   relatedSkillId matches the primary owner OR any secondary relationship.
 *                  This is the path that discovers a drill THROUGH a secondary
 *                  skill without that skill becoming its owner.
 *   familyId       matches at the FAMILY level -- SKILL-01..SKILL-12 -- by
 *                  expanding the family to the SK-* codes it owns and matching
 *                  the primary owner OR any secondary relationship against
 *                  that set. See below for why it is a third parameter.
 *
 * The secondary half is an EXISTS subquery and not a join, because a join to
 * pilot.drill_secondary_skills returns one parent row per matching relation --
 * so a drill carrying two secondaries would appear twice in a list OF DRILLS.
 * EXISTS answers the same question and cannot duplicate the parent.
 *
 * WHY familyId IS A THIRD PARAMETER AND NOT A WIDER relatedSkillId.
 *
 * The same reasoning that kept skillId intact when relatedSkillId arrived. A
 * family id is a DIFFERENT KIND OF VALUE from a skill code (owner decision
 * D2-B): SKILL-01 names a family, SK-STANCE-01 names one of the six codes
 * inside it. Letting relatedSkillId accept either would make one parameter
 * answer two questions, and every existing caller passing a code would be
 * indistinguishable from a caller passing a family. So SKILL-01 is never
 * compared against a skill column -- it is expanded first, here, and only
 * codes reach the query.
 *
 * memberCodesForFamily throws for a family with no approved crosswalk rather
 * than expanding to an empty set, so an unreconciled family surfaces as a
 * refusal instead of an empty drill list that reads as "no such drills".
 */
export async function listDrillLibrary(
  organizationId: string,
  filter: {
    discipline?: string;
    category?: string;
    difficulty?: string;
    skillId?: string;
    relatedSkillId?: string;
    familyId?: string;
  } = {},
): Promise<DrillLibraryRow[]> {
  // Expanded BEFORE the query runs: a refusal for an unreconciled family must
  // not depend on the database being reachable.
  const familyCodes = filter.familyId ? [...memberCodesForFamily(filter.familyId)] : null;

  return query<DrillLibraryRow>(
    `select ${DRILL_FIELDS}
     from pilot.drill_library d
     where d.organization_id = $1
       and d.active
       and d.superseded_at is null
       and ($2::text is null or d.discipline = $2)
       and ($3::text is null or d.category = $3)
       and ($4::text is null or d.difficulty = $4)
       and ($5::text is null or d.skill_id = $5)
       and (
         $6::text is null
         or d.skill_id = $6
         or exists (
           select 1
           from pilot.drill_secondary_skills s
           where s.organization_id = d.organization_id
             and s.drill_id = d.drill_id
             and s.skill_id = $6
         )
       )
       and (
         $7::text[] is null
         or d.skill_id = any($7::text[])
         or exists (
           select 1
           from pilot.drill_secondary_skills s
           where s.organization_id = d.organization_id
             and s.drill_id = d.drill_id
             and s.skill_id = any($7::text[])
         )
       )
     order by d.discipline, d.category, d.name`,
    [
      organizationId,
      filter.discipline ?? null,
      filter.category ?? null,
      filter.difficulty ?? null,
      filter.skillId ?? null,
      filter.relatedSkillId ?? null,
      familyCodes,
    ],
  );
}

/**
 * One drill plus its A/B/C scale rows, stop rules, cues, and secondary skill
 * relationships -- the full detail a coach needs to run it.
 *
 * secondary_skills is PURELY ADDITIVE. drill.skill_id is returned exactly as it
 * was and is still the primary owner; a drill with no secondary relationships
 * returns an empty array, so the shape every existing consumer reads is
 * unchanged.
 *
 * TWO STOP-RULE SETS, KEPT APART (R3). stop_rules is every pilot.drill_stop_rules
 * row of THIS version -- the drill's own rules, the legacy scope='universal'
 * lines included. universal_stop_rules is the gym's current stored-once set that
 * applies to this drill's contact level. They are separate arrays because
 * adoption readiness counts only the first (drillAdoptionReadiness.ts), and a
 * merged list would let one gym-wide rule make every drill look ready.
 */
export async function getDrillWithDetail(organizationId: string, drillId: string): Promise<DrillWithDetail | null> {
  const drill = await queryOne<DrillLibraryRow>(
    `select ${DRILL_FIELDS} from pilot.drill_library where organization_id = $1 and drill_id = $2`,
    [organizationId, drillId],
  );
  if (!drill) {
    return null;
  }

  const [scaleLevels, stopRules, universalStopRules, cues, secondarySkills] = await Promise.all([
    query<DrillScaleLevelRow>(
      `select ${SCALE_FIELDS} from pilot.drill_scale_levels
       where organization_id = $1 and drill_id = $2
       order by scale_level`,
      [organizationId, drillId],
    ),
    query<Omit<DrillStopRuleRow, 'origin'>>(
      `select ${STOP_RULE_FIELDS} from pilot.drill_stop_rules
       where organization_id = $1 and drill_id = $2
       order by ordinal`,
      [organizationId, drillId],
    ),
    readUniversalStopRules(organizationId, drill.contact_level),
    query<DrillCueRow>(
      `select ${CUE_FIELDS} from pilot.drill_cues where organization_id = $1 and drill_id = $2`,
      [organizationId, drillId],
    ),
    query<DrillSecondarySkillRow>(
      `select ${SECONDARY_SKILL_FIELDS} from pilot.drill_secondary_skills
       where organization_id = $1 and drill_id = $2
       order by skill_id`,
      [organizationId, drillId],
    ),
  ]);

  return {
    ...drill,
    scale_levels: scaleLevels,
    stop_rules: stopRules.map((rule) => ({ ...rule, origin: 'drill' as const })),
    universal_stop_rules: universalStopRules,
    cues,
    secondary_skills: secondarySkills,
  };
}

/**
 * Where a reference drill stands in ONE gym (OD-2026-09-19-001 LIFECYCLE, W-D4C).
 *
 *   operational  the gym adopted it and runs it: an active pilot.drills row
 *                points at this exact reference version.
 *   retired      the gym adopted it and retired it: rows point at it, none is
 *                active. Restore brings back the same identity; promoting again
 *                is refused (pilot_drills_one_reference_per_org is not partial
 *                on active, so a retired adoption still holds the reference).
 *   superseded   not adopted here, and a newer version of the reference exists
 *                (superseded_at, W-D4A's rule).
 *   unavailable  not adopted here, and the reference is withdrawn (inactive).
 *   newer_version_available
 *                not adopted here, current and active -- and the gym HAS
 *                adopted another version of the same reference lineage (owner
 *                ruling R2: a revised drill is v(n+1), the old head is kept).
 *                This is how a gym running v1 learns v2 exists: the coach
 *                browse lists heads only, so v2 is the row it sees. It is not
 *                'available', because promoting v2 beside the gym's v1 would
 *                give one gym two operational drills of one reference lineage,
 *                and moving the gym's drill to v2 is not built yet (IMP-15, an
 *                owner decision); the promote route refuses it in the same words.
 *   newer_version_retired
 *                the same, except that the gym RETIRED its drill for the other
 *                version and Restore can bring it back: no version of it is
 *                active, and the reference version it pins is still active (the
 *                restore guard's terms, drills.ts updateDrill). Split from
 *                'newer_version_available' because the head's card is the ONLY
 *                place a coach can reach that drill once a revision lands: the
 *                browse hides the superseded version it pins, and the operational
 *                list leaves retired drills out. Before the browse listed heads
 *                only, the pinned version's own card carried 'retired' and
 *                Restore; this state keeps that way back. A retired drill whose
 *                pinned version was withdrawn stays 'newer_version_available':
 *                the server refuses that restore, so no state offers it.
 *   available    not adopted here, and adoptable.
 *
 * Adoption comes first: for a gym that adopted a reference, what matters is
 * what it did with it. Every term is a durable column or an EXISTS over one --
 * nothing here reads prose, and nothing is stored: the state is derived on
 * every read, so it cannot drift from the rows it describes.
 *
 * operational_drill_id is the operational identity the next lifecycle action
 * acts on. While the gym runs the drill it is the ACTIVE row pointing at this
 * reference -- the one Retire takes out, even in the rare lineage where an
 * earlier version is the active one. Once retired it is the adopted lineage's
 * HEAD (highest version) -- the one Restore brings back -- found through the
 * lineage root, which pilot_drills_one_reference_per_org makes unique per
 * reference. For the two newer-version states it is the gym's drill for the
 * OTHER version (OTHER_VERSION_ADOPTION below): the link from the gym's drill to
 * the newer head, and the drill a Restore offered on the head brings back.
 * Null when the gym never adopted any version of it.
 *
 * Authors only (coach, organization_admin, admin -- the roles that promote,
 * retire and restore). Athlete and other reader reads never call this:
 * lifecycle and adoption are how the gym's library is governed, not
 * instruction.
 */
export type ReferenceLifecycleState =
  | 'available'
  | 'operational'
  | 'retired'
  | 'superseded'
  | 'unavailable'
  | 'newer_version_available'
  | 'newer_version_retired';

export interface ReferenceLifecycle {
  state: ReferenceLifecycleState;
  operational_drill_id: string | null;
}

/**
 * "The gym's drill for ANOTHER version of this reference's lineage", as a
 * LATERAL subquery correlated on `d` (the reference row). One row or none:
 * the operational drill id, the reference version it pins, whether that drill
 * is active, and whether the version it pins is still active.
 *
 * Which drill, when there could be several: an ACTIVE one first (the gym runs
 * it), then the newest reference version, then the newest operational version
 * -- the same "live row, else the lineage head" rule the adopted-state
 * operational_drill_id follows. Every operational version of one gym lineage
 * carries the same reference_drill_id (a refinement inherits it,
 * drillVersioning.ts), so the newest operational version IS that lineage's head.
 * The same ordering is why the row's `active` answers for the whole set: an
 * inactive first row means the gym runs no version of the lineage, which is
 * what the restore guard asks (with the pinned version's `active`) before it
 * lets that head come back.
 *
 * Shared by listReferenceLifecycles and getOtherVersionAdoption so the coach
 * page's label and the promote route's refusal cannot disagree about which
 * references this gym already has a version of. Both organization terms are the
 * tenant boundary: lineage ids and drill ids are per-organization keys, and
 * another gym may hold the very same strings.
 */
const OTHER_VERSION_ADOPTION = `
       select od.drill_id, od.reference_drill_id, od.active, v.active as reference_active
       from pilot.drills od
       join pilot.drill_library v
         on v.organization_id = od.organization_id
        and v.drill_id = od.reference_drill_id
       where od.organization_id = d.organization_id
         and v.lineage_id = d.lineage_id
         and v.drill_id <> d.drill_id
       order by od.active desc, v.version desc, od.version desc
       limit 1`;

export async function listReferenceLifecycles(
  organizationId: string,
  drillIds?: string[],
): Promise<Record<string, ReferenceLifecycle>> {
  const rows = await query<{ drill_id: string; state: ReferenceLifecycleState; operational_drill_id: string | null }>(
    `select d.drill_id,
            case
              when exists (
                select 1 from pilot.drills od
                where od.organization_id = d.organization_id
                  and od.reference_drill_id = d.drill_id
                  and od.active
              ) then 'operational'
              when exists (
                select 1 from pilot.drills od
                where od.organization_id = d.organization_id
                  and od.reference_drill_id = d.drill_id
              ) then 'retired'
              when not d.active then 'unavailable'
              when d.superseded_at is not null then 'superseded'
              when other_version.drill_id is not null
                   and not other_version.active
                   and other_version.reference_active then 'newer_version_retired'
              when other_version.drill_id is not null then 'newer_version_available'
              else 'available'
            end as state,
            coalesce(
              (
                select live.drill_id
                from pilot.drills live
                where live.organization_id = d.organization_id
                  and live.reference_drill_id = d.drill_id
                  and live.active
                order by live.version desc
                limit 1
              ),
              (
                select head.drill_id
                from pilot.drills root
                join pilot.drills head
                  on head.organization_id = root.organization_id
                 and head.lineage_id = root.lineage_id
                where root.organization_id = d.organization_id
                  and root.reference_drill_id = d.drill_id
                  and root.supersedes_drill_id is null
                order by head.version desc
                limit 1
              ),
              -- Only for the two newer-version states (the CASE above reaches
              -- them only for an active, unsuperseded, unadopted row). Guarded
              -- so a superseded or withdrawn row keeps answering null, as before.
              case when d.active and d.superseded_at is null then other_version.drill_id end
            ) as operational_drill_id
     from pilot.drill_library d
     left join lateral (${OTHER_VERSION_ADOPTION}
     ) other_version on true
     where d.organization_id = $1
       and ($2::text[] is null or d.drill_id = any($2::text[]))`,
    [organizationId, drillIds ?? null],
  );
  const lifecycles: Record<string, ReferenceLifecycle> = {};
  for (const row of rows) {
    lifecycles[row.drill_id] = { state: row.state, operational_drill_id: row.operational_drill_id };
  }
  return lifecycles;
}

export interface OtherVersionAdoption {
  /** The gym's operational drill (pilot.drills) for the other version. */
  operational_drill_id: string;
  /** The reference version that operational drill pins. */
  adopted_reference_drill_id: string;
}

/**
 * Whether this gym already has an operational drill -- running or retired --
 * for ANOTHER version of this reference's lineage, and which one. Null when it
 * has none, or when the reference is not this gym's.
 *
 * The promote route's question, asked on its own rather than through
 * listReferenceLifecycles: that read answers for a reference as a whole
 * (adopted, withdrawn, superseded come first), while the route has already
 * judged those and needs only this one fact before it writes. The subquery is
 * the one the lifecycle state uses, so the two cannot drift.
 */
export async function getOtherVersionAdoption(
  organizationId: string,
  referenceDrillId: string,
): Promise<OtherVersionAdoption | null> {
  return queryOne<OtherVersionAdoption>(
    `select other_version.drill_id as operational_drill_id,
            other_version.reference_drill_id as adopted_reference_drill_id
     from pilot.drill_library d
     join lateral (${OTHER_VERSION_ADOPTION}
     ) other_version on true
     where d.organization_id = $1
       and d.drill_id = $2`,
    [organizationId, referenceDrillId],
  );
}

/** Every version of one drill lineage, oldest first -- mirrors drillVersioning.ts's getDrillLineage. */
export async function getDrillLibraryLineage(organizationId: string, lineageId: string): Promise<DrillLibraryRow[]> {
  return query<DrillLibraryRow>(
    `select ${DRILL_FIELDS}
     from pilot.drill_library
     where organization_id = $1 and lineage_id = $2
     order by version asc`,
    [organizationId, lineageId],
  );
}

// ---------------------------------------------------------------------------
// The cue library (register module 114, owner decision 2026-08-16): a
// read-only browse over the cues coaches already wrote into drill records.
// No invented content and no separate store -- pilot.drill_cues remains
// owned by its drills; this is the library view of that craft, searchable
// across the whole current library instead of locked inside one drill at a
// time. Only cues on the CURRENT version of each drill are listed (active and
// superseded_at is null), so a reworded cue never appears twice. `active`
// alone no longer says that: under owner ruling R2 a superseded version stays
// active for the gyms that adopted it (see listDrillLibrary), and a revision
// re-mints every cue onto the new version.
// ---------------------------------------------------------------------------

export interface CueLibraryRow {
  cue_id: string;
  cue_text: string;
  cue_family: string;
  focus_type: string;
  evidence_note: string;
  drill_id: string;
  drill_name: string;
  discipline: string;
  category: string;
}

export async function listCueLibrary(
  organizationId: string,
  filter: { focusType?: string; search?: string } = {},
): Promise<CueLibraryRow[]> {
  return query<CueLibraryRow>(
    `select c.cue_id, c.cue_text, c.cue_family, c.focus_type, c.evidence_note,
            d.drill_id, d.name as drill_name, d.discipline, d.category
     from pilot.drill_cues c
     join pilot.drill_library d
       on d.organization_id = c.organization_id and d.drill_id = c.drill_id
     where c.organization_id = $1
       and d.active = true
       and d.superseded_at is null
       and ($2::text is null or c.focus_type = $2)
       and ($3::text is null or c.cue_text ilike '%' || $3 || '%' or c.cue_family ilike '%' || $3 || '%' or d.name ilike '%' || $3 || '%')
     order by c.cue_family asc, c.cue_text asc`,
    [organizationId, filter.focusType ?? null, filter.search?.trim() || null],
  );
}

// ---------------------------------------------------------------------------
// ATHLETE REFERENCE / LEARNING (W-D2, owner rule of 2026-09-17 under
// OD-2026-09-16-001).
//
// Everything above this line serves COACHES and the roles that plan alongside
// them: the whole active reference corpus, every authored field, unfiltered.
// Everything below serves ATHLETES, and it is narrower on two independent axes
// at once. Both narrowings are required, and neither substitutes for the other:
//
//   WHICH DRILLS  an athlete may see only reference drills the gym has adopted.
//   WHICH FIELDS  an athlete may see only instructional and safety material.
//
// These are separate functions rather than a `forAthlete` flag on the coach
// reads for the reason the repo already learned from skill_id/relatedSkillId: a
// flag makes one query answer two questions, and the day someone adds a column
// to DRILL_FIELDS the athlete answer changes with it, silently. Here the athlete
// select lists name their own columns, so a new column on pilot.drill_library
// reaches an athlete only when somebody writes it into ATHLETE_* by hand.
// ---------------------------------------------------------------------------

/**
 * "This gym has adopted this reference drill, and the adoption is live."
 *
 * Correlated on `d`, the reference row, so it composes into any query over
 * pilot.drill_library.
 *
 * THREE TERMS, AND EACH ONE IS LOAD-BEARING:
 *
 *   od.organization_id = d.organization_id
 *     There is NO row-level security in this database -- a grep for
 *     `create policy` across infra/azure returns nothing. The organization
 *     predicate IS the tenant boundary, and an EXISTS subquery that forgot it
 *     would let one gym's promotion unlock another gym's reference row while
 *     every surrounding query still looked correctly scoped.
 *
 *   od.reference_drill_id = d.drill_id
 *     The pointer is to an exact reference VERSION, because pilot.drill_library
 *     is keyed (organization_id, drill_id) per version. That is what makes
 *     supersession unable to change what an athlete sees without a coach
 *     acting: a newer version is a different drill_id and nothing points at it
 *     yet.
 *
 *   od.active
 *     Retiring the gym's operational drill withdraws current athlete access.
 *
 * AND ONE TERM THAT IS DELIBERATELY ABSENT: `od.supersedes_drill_id is null`.
 * Adopting a change proposal DEACTIVATES the lineage root and inserts an active
 * SUCCESSOR carrying supersedes_drill_id and the same reference_drill_id
 * (drillVersioning.ts). So after any refinement the only active operational row
 * is a non-root, and a root-scoped predicate would match nothing -- the drill
 * would silently vanish from Learning the moment a coach improved it. Root
 * scoping is what pilot_drills_one_reference_per_org needs to keep promotion
 * unique; it is the wrong shape for asking whether a promotion is live.
 *
 * EXISTS rather than a join, for the same reason listDrillLibrary uses EXISTS
 * for secondary skills: a join against a multi-version lineage returns one
 * reference row per operational version, and this asks a yes/no question.
 */
const ATHLETE_PROMOTED_AND_LIVE = `
       exists (
         select 1
         from pilot.drills od
         where od.organization_id = d.organization_id
           and od.reference_drill_id = d.drill_id
           and od.active
       )`;

/**
 * The athlete select list, written out rather than derived from DRILL_FIELDS.
 *
 * Nothing forbidden is even FETCHED. The projection functions below are the
 * contract, but a select list that never loads source_ref, grounding_claim_ids,
 * field_provenance, content_class, created_by_account_id, created_by_role,
 * lineage_id, version, supersedes_drill_id, superseded_at, skill_id or
 * target_behavior cannot leak them through a logging line, an error dump, or a
 * future consumer that spreads the row.
 *
 * `active` is absent too, and that is not an oversight: it is authoring state,
 * and the query already guarantees the answer is true.
 */
const ATHLETE_DRILL_FIELDS =
  'd.drill_id, d.name, d.purpose, d.standard_setup, d.execution, d.contact_level, '
  + 'd.requires_coach_authorization';

interface AthleteDrillScalarRow {
  drill_id: string;
  name: string;
  purpose: string;
  standard_setup: string;
  execution: string;
  contact_level: string;
  requires_coach_authorization: boolean;
}

interface AthleteCueTextRow {
  drill_id: string;
  cue_text: string;
}

interface AthleteScaleRow {
  drill_id: string;
  scale_level: DrillScaleLevel;
  is_starting_point: boolean;
  demand_description: string;
  constraint_applied: string;
  contact_level: string;
  coach_watch_point: string;
}

interface AthleteStopRuleRow {
  drill_id: string;
  ordinal: number;
  condition_text: string;
  scope: 'universal' | 'drill_specific';
  rule_kind: string;
}

/** Scale guidance as an athlete reads it: what the level demands, not who authored it. */
export interface AthleteScaleGuidance {
  scale_level: DrillScaleLevel;
  is_starting_point: boolean;
  demand_description: string;
  constraint_applied: string;
  contact_level: string;
  coach_watch_point: string;
}

/**
 * One of the drill's OWN stop rules as an athlete reads it: when to stop. The
 * legacy `scope` label is kept for the shape's existing readers; `origin` is
 * what says where the rule came from (StopRuleOrigin).
 */
export interface AthleteStopRule {
  ordinal: number;
  condition_text: string;
  scope: 'universal' | 'drill_specific';
  rule_kind: string;
  origin: 'drill';
}

/**
 * One of the gym's stored-once stop rules as an athlete reads it: when to stop,
 * and that it came from the gym-wide set. No id, lineage, version, active flag
 * or contact-level targeting -- those are how the set is governed, not
 * instruction, and several are on the athlete deny-lists by name.
 */
export interface AthleteUniversalStopRule {
  ordinal: number;
  condition_text: string;
  rule_kind: string;
  origin: 'universal';
}

/**
 * The browse shape. Carries cues because that is what the athlete's Learn
 * surface has always shown, and a library of drill names with no coaching cues
 * would be a worse surface than the one it replaces.
 */
export interface AthleteDrillSummary {
  drill_id: string;
  name: string;
  purpose: string;
  setup: string;
  execution: string;
  contact_level: string;
  requires_coach_authorization: boolean;
  cues: string[];
}

/**
 * The detail shape: the browse shape, the two child sets that only matter when
 * running the drill, and -- since OD-2026-09-19-001 -- the practical
 * instruction an athlete checks themselves against: what good and bad look
 * like, the common errors, and the corrections. Detail only; the browse list
 * does not carry them.
 */
export interface AthleteDrillDetail extends AthleteDrillSummary {
  what_good_looks_like: string;
  what_bad_looks_like: string;
  common_errors: string;
  corrections: string;
  /**
   * Practical: what to bring. It is here so the screen can say "Equipment"
   * rather than print an equipment word under "Setup" -- in 114 of the 119
   * seeded drills standard_setup holds the same word as equipment_needed, so
   * the athlete was already reading it, mislabelled.
   */
  equipment_needed: string;
  scale_levels: AthleteScaleGuidance[];
  /** The drill's own stop rules (every row of this version, legacy scope included). */
  stop_rules: AthleteStopRule[];
  /** The gym's stored-once stop rules that apply to this drill (R3). */
  universal_stop_rules: AthleteUniversalStopRule[];
}

/**
 * The practical-instruction columns an athlete's DETAIL may carry
 * (OD-2026-09-19-001). Written out, like ATHLETE_DRILL_FIELDS, so nothing else
 * is fetched on this path.
 */
const ATHLETE_INSTRUCTION_FIELDS =
  'd.what_good_looks_like, d.what_bad_looks_like, d.common_errors, d.corrections, d.equipment_needed';

interface AthleteInstructionRow {
  what_good_looks_like: string;
  what_bad_looks_like: string;
  common_errors: string;
  corrections: string;
  equipment_needed: string;
}

/**
 * Inline grounding-claim tags -- `[A2-070]`, `[B4-027]`, `[PS-012]`,
 * `[CB-003]` -- are the evidence model's citations. In the seeded corpus they
 * sit in what_good_looks_like, what_bad_looks_like and corrections among the
 * fields above (and in transfer, which athletes do not get); every field here
 * is stripped regardless, so a tag added to another one later cannot leak.
 * They are provenance, and OD-2026-09-17-001 clause 8 keeps grounding claim ids
 * off an athlete's screen, so they are removed before the text leaves the
 * server rather than left for a renderer to remember.
 *
 * THE SHAPE IS contentImport/ids.ts's, not a copy of it. This regex used to be
 * its own `\[[A-Z]\d+-\d+\]`, which accepts only letter-digit tracks -- so a
 * PS- or CB- claim, which the registry also holds and which the content
 * validator accepts in drill prose, reached athletes verbatim. Every tag in
 * the committed drill CSVs matches the imported shape (291 of 291 checked when
 * this changed), so nothing the old pattern stripped is now left behind. The
 * pattern is the claim-id shape only, so ordinary bracketed prose is untouched;
 * the leading spaces or tabs are taken with the tag so no gap is left before
 * the punctuation that follows it.
 */
const GROUNDING_CLAIM_TAG = new RegExp(`[ \\t]*${INLINE_CLAIM_TAG_PATTERN.source}`, 'g');

export function stripGroundingClaimTags(text: string): string {
  return text.replace(GROUNDING_CLAIM_TAG, '');
}

/** Constructive, like the other projections: every key named, tags stripped. */
export function toAthleteInstruction(row: AthleteInstructionRow): AthleteInstructionRow {
  return {
    what_good_looks_like: stripGroundingClaimTags(row.what_good_looks_like ?? ''),
    what_bad_looks_like: stripGroundingClaimTags(row.what_bad_looks_like ?? ''),
    common_errors: stripGroundingClaimTags(row.common_errors ?? ''),
    corrections: stripGroundingClaimTags(row.corrections ?? ''),
    equipment_needed: stripGroundingClaimTags(row.equipment_needed ?? ''),
  };
}

/**
 * The projections. PURE, EXPORTED, AND CONSTRUCTIVE.
 *
 * Constructive is the whole point: each returns a NEW object naming every key
 * it emits, so a column added to pilot.drill_library tomorrow is absent from an
 * athlete's screen by default. The alternative -- spread the row and delete the
 * bad keys -- fails open, because the next forbidden column is one nobody
 * remembers to add to the delete list. `standard_setup` is renamed to `setup`
 * here and nowhere else, so the athlete vocabulary is decided in one place.
 */
export function toAthleteDrillSummary(row: AthleteDrillScalarRow, cues: string[]): AthleteDrillSummary {
  return {
    drill_id: row.drill_id,
    name: row.name,
    purpose: row.purpose,
    setup: row.standard_setup,
    execution: row.execution,
    contact_level: row.contact_level,
    requires_coach_authorization: row.requires_coach_authorization,
    cues,
  };
}

export function toAthleteScaleGuidance(row: AthleteScaleRow): AthleteScaleGuidance {
  return {
    scale_level: row.scale_level,
    is_starting_point: row.is_starting_point,
    demand_description: row.demand_description,
    constraint_applied: row.constraint_applied,
    contact_level: row.contact_level,
    coach_watch_point: row.coach_watch_point,
  };
}

// Stop-rule text is stripped like the instruction fields above. Both
// condition_text columns are free prose to the content validator
// (contentImport/specs/drills.ts and specs/universalStopRules.ts declare them
// with text(), role 'content'), and validate.ts accepts an inline claim tag in
// such a column as a citation -- so a validated import can carry
// "Stop on any sign of injury [PS-012]" to this projection. The coach reads
// keep the tag; athletes never see it (OD-2026-09-17-001 clause 8).
export function toAthleteStopRule(row: AthleteStopRuleRow): AthleteStopRule {
  return {
    ordinal: row.ordinal,
    condition_text: stripGroundingClaimTags(row.condition_text),
    scope: row.scope,
    rule_kind: row.rule_kind,
    origin: 'drill',
  };
}

export function toAthleteUniversalStopRule(row: UniversalStopRuleRow): AthleteUniversalStopRule {
  return {
    ordinal: row.ordinal,
    condition_text: stripGroundingClaimTags(row.condition_text),
    rule_kind: row.rule_kind,
    origin: 'universal',
  };
}

/**
 * Every reference drill this gym has adopted and still runs, athlete-safe.
 *
 * Takes no filters. The coach browse filters on discipline, category,
 * difficulty and the three skill axes -- every one of those is a planning axis
 * expressed in internal taxonomy that the athlete projection deliberately does
 * not carry, so offering them here would mean filtering by values the caller
 * can never see. The promoted set is small by construction: it is what one gym
 * adopted, not the 119-drill corpus.
 */
export async function listAthleteDrillLibrary(organizationId: string): Promise<AthleteDrillSummary[]> {
  const drills = await query<AthleteDrillScalarRow>(
    `select ${ATHLETE_DRILL_FIELDS}
     from pilot.drill_library d
     where d.organization_id = $1
       and d.active
       and${ATHLETE_PROMOTED_AND_LIVE}
     order by d.name`,
    [organizationId],
  );

  if (drills.length === 0) {
    return [];
  }

  // One cue read for the whole page rather than one per drill. The same
  // promoted-and-live predicate is repeated rather than passing the drill ids
  // back in: the ids came from a trusted query here, but a predicate that
  // travels with the data cannot be separated from it by a later refactor.
  const cues = await query<AthleteCueTextRow>(
    `select c.drill_id, c.cue_text
     from pilot.drill_cues c
     join pilot.drill_library d
       on d.organization_id = c.organization_id and d.drill_id = c.drill_id
     where c.organization_id = $1
       and d.active
       and${ATHLETE_PROMOTED_AND_LIVE}
     order by c.cue_family asc, c.cue_text asc`,
    [organizationId],
  );

  const cuesByDrill = new Map<string, string[]>();
  for (const cue of cues) {
    const existing = cuesByDrill.get(cue.drill_id);
    if (existing) existing.push(cue.cue_text);
    else cuesByDrill.set(cue.drill_id, [cue.cue_text]);
  }

  return drills.map((drill) => toAthleteDrillSummary(drill, cuesByDrill.get(drill.drill_id) ?? []));
}

/**
 * One adopted reference drill in full, athlete-safe.
 *
 * Returns null for a reference this gym has not adopted, for one whose adoption
 * is retired, for an inactive reference, and for a drill_id belonging to another
 * gym -- all four answer the same way on purpose, so the caller has nothing to
 * distinguish "not yours" from "not promoted" with.
 *
 * NOTE the `d.active` term: the coach detail read deliberately has no such
 * filter, because a coach reviewing a retracted drill is a legitimate act. For
 * an athlete it is not, so this path does not inherit that behaviour.
 */
export async function getAthleteDrillDetail(
  organizationId: string,
  drillId: string,
): Promise<AthleteDrillDetail | null> {
  return readAthleteDrillDetail(organizationId, drillId, ATHLETE_PROMOTED_AND_LIVE);
}

/**
 * The same athlete-safe detail for the one case OD-2026-09-19-002 carves out
 * of the promoted-and-live rule: an athlete's OPEN assigned work (assigned or
 * in progress) keeps the exact instruction it was issued against even after
 * the gym retires the drill, because the athlete is still expected to do the
 * work -- safety and stop rules included.
 *
 * ONLY the adoption term is dropped. The reference row must still be active
 * (a retracted reference stays withheld, per the same ruling), the tenant
 * boundary is unchanged, and the projection is the same constructive one.
 *
 * NOT A BROWSE READ. Its only caller is assignmentDrillInstruction.ts, which
 * hands it a reference id resolved from an assignment the actor may see,
 * through that assignment's own operational row. The athlete path uses it only
 * when that work is open; the staff path also runs it, for any status, but
 * only to answer which work an athlete could open -- its content never reaches
 * an athlete from there. Nothing else may call it: handed an arbitrary id it
 * would reveal any active reference in the gym, which is exactly what the
 * Learn rule exists to stop.
 */
export async function getAthleteDrillDetailForOpenWork(
  organizationId: string,
  drillId: string,
): Promise<AthleteDrillDetail | null> {
  return readAthleteDrillDetail(organizationId, drillId, null);
}

async function readAthleteDrillDetail(
  organizationId: string,
  drillId: string,
  adoptionPredicate: string | null,
): Promise<AthleteDrillDetail | null> {
  const drill = await queryOne<AthleteDrillScalarRow & AthleteInstructionRow>(
    `select ${ATHLETE_DRILL_FIELDS}, ${ATHLETE_INSTRUCTION_FIELDS}
     from pilot.drill_library d
     where d.organization_id = $1
       and d.drill_id = $2
       and d.active${adoptionPredicate ? `
       and${adoptionPredicate}` : ''}`,
    [organizationId, drillId],
  );
  if (!drill) {
    return null;
  }

  // The stored-once rules are read only once the drill is known to be one this
  // athlete may see (the null return above), and through the same query the
  // coach read uses -- see readUniversalStopRules.
  const [scaleLevels, stopRules, universalStopRules, cues] = await Promise.all([
    query<AthleteScaleRow>(
      `select drill_id, scale_level, is_starting_point, demand_description, constraint_applied,
              contact_level, coach_watch_point
       from pilot.drill_scale_levels
       where organization_id = $1 and drill_id = $2
       order by scale_level`,
      [organizationId, drillId],
    ),
    query<AthleteStopRuleRow>(
      `select drill_id, ordinal, condition_text, scope, rule_kind
       from pilot.drill_stop_rules
       where organization_id = $1 and drill_id = $2
       order by ordinal`,
      [organizationId, drillId],
    ),
    readUniversalStopRules(organizationId, drill.contact_level),
    // ORDERED, unlike the coach cue read this mirrors. That read has no ORDER BY
    // at all, so its row order is whatever Postgres returns; for a screen an
    // athlete reads while training, cue order changing between loads is a
    // defect, so this path pins it to the same ordering the cue library uses.
    query<AthleteCueTextRow>(
      `select drill_id, cue_text
       from pilot.drill_cues
       where organization_id = $1 and drill_id = $2
       order by cue_family asc, cue_text asc`,
      [organizationId, drillId],
    ),
  ]);

  return {
    ...toAthleteDrillSummary(drill, cues.map((cue) => cue.cue_text)),
    ...toAthleteInstruction(drill),
    scale_levels: scaleLevels.map(toAthleteScaleGuidance),
    stop_rules: stopRules.map(toAthleteStopRule),
    universal_stop_rules: universalStopRules.map(toAthleteUniversalStopRule),
  };
}

/** A cue as an athlete reads it: the words and where they came from, never why they are believed. */
export interface AthleteCueRow {
  cue_id: string;
  cue_text: string;
  cue_family: string;
  focus_type: string;
  drill_id: string;
  drill_name: string;
}

/**
 * The cue library, narrowed the same two ways.
 *
 * evidence_note and source_ref are absent from the select list entirely. They
 * are the cue's grounding and authoring lineage -- the evidence model, not the
 * coaching instruction -- and OD-2026-09-16-001 keeps both off an athlete's
 * screen. discipline and category are dropped as well, to stay consistent with
 * the drill projection, which carries no planning taxonomy either.
 */
export async function listAthleteCueLibrary(
  organizationId: string,
  filter: { focusType?: string; search?: string } = {},
): Promise<AthleteCueRow[]> {
  return query<AthleteCueRow>(
    `select c.cue_id, c.cue_text, c.cue_family, c.focus_type, c.drill_id, d.name as drill_name
     from pilot.drill_cues c
     join pilot.drill_library d
       on d.organization_id = c.organization_id and d.drill_id = c.drill_id
     where c.organization_id = $1
       and d.active
       and${ATHLETE_PROMOTED_AND_LIVE}
       and ($2::text is null or c.focus_type = $2)
       and ($3::text is null or c.cue_text ilike '%' || $3 || '%' or c.cue_family ilike '%' || $3 || '%' or d.name ilike '%' || $3 || '%')
     order by c.cue_family asc, c.cue_text asc`,
    [organizationId, filter.focusType ?? null, filter.search?.trim() || null],
  );
}
