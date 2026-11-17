import { query } from './db';

// The two behavioural KPI lists (lane CAT-d; OD-2026-11-16-003; assessment_
// catalog migration, pilot.behavior_kpi_lists and pilot.behavior_kpis), as the
// coach drill page shows them side by side: DOC-041's drill KPIs for
// drill-level scorecards and DOC-027's core behavioural KPIs for room and
// session monitoring.
//
// READ ONLY, and it reads only the caller's organization. Each list keeps its
// own order and its own scoring line; nothing pairs one list's KPI with the
// other's. A drafted scoring kind or set of level anchors (field_labels status
// INFERRED with a draft marker, OD-2026-11-16-003 ruling 3) is returned with
// `draft: true`, so the page can say so. Nothing here scores, places or limits
// anyone.

/** Who may read the lists: the coach drill page's roles (its RoleSessionGate 'admin' covers organization_admin and admin). */
export const BEHAVIOR_KPI_READER_ROLES = ['coach', 'organization_admin', 'admin'] as const;

export type KpiScoringKind = 'count' | 'yes_no' | 'three_level';

export interface BehaviorKpi {
  ordinal: number;
  name: string;
  scoringKind: KpiScoringKind | null;
  levelAnchors: Record<string, string> | null;
  /** The scoring kind or the level anchors are an AI draft awaiting a coach's review. */
  draft: boolean;
}

export interface BehaviorKpiList {
  listKey: 'drill' | 'room';
  title: string;
  sourceDoc: string;
  scoringRuleText: string | null;
  kpis: BehaviorKpi[];
}

interface ListRow {
  list_key: 'drill' | 'room';
  title: string;
  source_doc: string;
  scoring_rule_text: string | null;
}

interface KpiRow {
  list_key: 'drill' | 'room';
  ordinal: number;
  name: string;
  scoring_kind: KpiScoringKind | null;
  level_anchors: Record<string, string> | null;
  field_labels: Record<string, unknown> | null;
}

function isDraft(labels: Record<string, unknown> | null): boolean {
  if (!labels) return false;
  return ['scoring_kind', 'level_anchors'].some((field) => {
    const label = labels[field];
    return Boolean(label) && typeof label === 'object' && 'draft' in (label as object);
  });
}

/** The organization's active lists, drill first then room, each with its active KPIs in order. Empty before the migration or the seed. */
export async function listBehaviorKpis(organizationId: string): Promise<BehaviorKpiList[]> {
  let lists: ListRow[];
  let kpis: KpiRow[];
  try {
    lists = await query<ListRow>(
      `select list_key, title, source_doc, scoring_rule_text
         from pilot.behavior_kpi_lists
        where organization_id = $1 and active_flag
        order by case list_key when 'drill' then 0 else 1 end`,
      [organizationId],
    );
    kpis = await query<KpiRow>(
      `select list_key, ordinal, name, scoring_kind, level_anchors, field_labels
         from pilot.behavior_kpis
        where organization_id = $1 and active_flag
        order by list_key, ordinal`,
      [organizationId],
    );
  } catch (error) {
    // Before the assessment-catalog migration there is nothing to show; any other failure is real.
    if ((error as { code?: unknown }).code === '42P01') return [];
    throw error;
  }
  return lists.map((list) => ({
    listKey: list.list_key,
    title: list.title,
    sourceDoc: list.source_doc,
    scoringRuleText: list.scoring_rule_text,
    kpis: kpis
      .filter((kpi) => kpi.list_key === list.list_key)
      .map((kpi) => ({
        ordinal: kpi.ordinal,
        name: kpi.name,
        scoringKind: kpi.scoring_kind,
        levelAnchors: kpi.level_anchors,
        draft: isDraft(kpi.field_labels),
      })),
  }));
}
