import {
  groupClassPlanWeeks,
  type ClassPlanBlockRow,
  type ClassPlanDayTemplate,
  type ClassPlanSessionRow,
  type ClassPlanTrackDetail,
  type ClassPlanTrackSummary,
} from './classPlanShapes';
import { query, queryOne } from './db';
import { getWorkoutTemplateWithItems, planTemplateIssue } from './workoutTemplates';

// Read-only view of a gym's training tracks ("Class plans", OD-2026-11-12-005).
// Reads pilot.training_tracks, track_blocks, track_block_sessions and the
// workout templates and drills they name; it writes nothing and reads no
// athlete table. Every read takes the caller's organization and no other.

interface TrackRow {
  track_id: string;
  name: string;
  lane: string;
  track: string | null;
  duration_weeks: number | null;
  age_band: string;
  sources: string[];
  details: Record<string, unknown>;
  block_count: string;
  day_count: string;
}

// The current version of each lineage (superseded_at is null), still running.
const TRACK_SELECT = `
  select t.track_id, t.name, t.lane, t.track, t.duration_weeks, t.age_band, t.sources, t.details,
         (select count(*) from pilot.track_blocks b
           where b.organization_id = t.organization_id and b.track_id = t.track_id) as block_count,
         (select count(*) from pilot.track_block_sessions s
           where s.organization_id = t.organization_id and s.track_id = t.track_id) as day_count
  from pilot.training_tracks t
  where t.organization_id = $1 and t.superseded_at is null and t.active`;

function summaryOf(row: TrackRow): ClassPlanTrackSummary {
  return {
    track_id: row.track_id,
    name: row.name,
    lane: row.lane,
    track: row.track,
    duration_weeks: row.duration_weeks,
    age_band: row.age_band,
    block_count: Number(row.block_count),
    day_count: Number(row.day_count),
  };
}

export async function listClassPlanTracks(organizationId: string): Promise<ClassPlanTrackSummary[]> {
  const rows = await query<TrackRow>(`${TRACK_SELECT} order by t.name, t.track_id`, [organizationId]);
  return rows.map(summaryOf);
}

interface TemplateHead {
  lineage_id: string;
  template_id: string;
  name: string;
  active: boolean;
}

/** One template's readiness, asked the way an issue asks it (planTemplateIssue), nothing written. */
async function readinessOf(organizationId: string, head: TemplateHead): Promise<ClassPlanDayTemplate> {
  const base = { template_id: head.template_id, name: head.name };
  if (!head.active) {
    return { state: 'withdrawn', ...base, drill_count: null, drills_to_complete: null };
  }
  const detail = await getWorkoutTemplateWithItems(organizationId, head.template_id);
  if (!detail || detail.items.length === 0) {
    return { state: 'empty', ...base, drill_count: 0, drills_to_complete: 0 };
  }
  const plan = await planTemplateIssue(organizationId, detail.items);
  const drillCount = new Set(detail.items.filter((item) => item.drill_id !== null).map((item) => item.drill_id)).size
    + detail.items.filter((item) => item.drill_id === null).length;
  return {
    state: plan.refused.length === 0 ? 'ready' : 'not_ready',
    ...base,
    drill_count: drillCount,
    drills_to_complete: plan.refused.length,
  };
}

export async function getClassPlanTrack(
  organizationId: string,
  trackId: string,
): Promise<ClassPlanTrackDetail | null> {
  const track = await queryOne<TrackRow>(`${TRACK_SELECT} and t.track_id = $2`, [organizationId, trackId]);
  if (!track) return null;

  const blocks = await query<ClassPlanBlockRow>(
    `select block_order, title from pilot.track_blocks
     where organization_id = $1 and track_id = $2 order by block_order`,
    [organizationId, trackId],
  );
  const sessions = await query<ClassPlanSessionRow>(
    `select block_session_id, block_order, ordinal, week, day, template_lineage_id
     from pilot.track_block_sessions
     where organization_id = $1 and track_id = $2 order by block_order, ordinal`,
    [organizationId, trackId],
  );

  // Each day's template is the lineage's current version. No foreign key joins
  // them (checked at import), so a lineage with no current row is "missing" and
  // a withdrawn one (active = false) is "withdrawn": both stay on the page.
  const lineageIds = [...new Set(sessions.map((session) => session.template_lineage_id))];
  const heads = lineageIds.length === 0
    ? []
    : await query<TemplateHead>(
        `select lineage_id, template_id, name, active from pilot.workout_templates
         where organization_id = $1 and superseded_at is null and lineage_id = any($2::text[])`,
        [organizationId, lineageIds],
      );
  const headByLineage = new Map(heads.map((head) => [head.lineage_id, head]));
  const resolved = new Map<string, ClassPlanDayTemplate>();
  await Promise.all(lineageIds.map(async (lineageId) => {
    const head = headByLineage.get(lineageId);
    resolved.set(lineageId, head
      ? await readinessOf(organizationId, head)
      : { state: 'missing', template_id: null, name: null, drill_count: null, drills_to_complete: null });
  }));

  return {
    ...summaryOf(track),
    details: track.details,
    sources: track.sources,
    weeks: groupClassPlanWeeks(blocks, sessions, (lineageId) => resolved.get(lineageId)!),
  };
}
