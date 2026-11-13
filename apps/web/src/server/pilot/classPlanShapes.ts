// Class plans: the shapes and the pure grouping behind GET /api/pilot/training-tracks
// and /coach/class-plans. No server imports, so the page can import it.

export type ClassPlanTemplateState = 'ready' | 'not_ready' | 'empty' | 'withdrawn' | 'missing';

/** What a day's template is to this gym right now. Never absent: a missing or withdrawn template says so. */
export interface ClassPlanDayTemplate {
  state: ClassPlanTemplateState;
  /** Null only when no current template exists for the lineage (state 'missing'). */
  template_id: string | null;
  name: string | null;
  /** Reference drills (and typed steps) the template names; null when not asked (missing, withdrawn). */
  drill_count: number | null;
  /** How many of them the issue refuses today; null when not asked. */
  drills_to_complete: number | null;
}

export interface ClassPlanDay {
  block_session_id: string;
  ordinal: number;
  day: string;
  template_lineage_id: string;
  template: ClassPlanDayTemplate;
}

export interface ClassPlanWeek {
  week: number;
  block_order: number;
  title: string | null;
  days: ClassPlanDay[];
}

export interface ClassPlanBlockRow {
  block_order: number;
  title: string | null;
}

export interface ClassPlanSessionRow {
  block_session_id: string;
  block_order: number;
  ordinal: number;
  week: number;
  day: string;
  template_lineage_id: string;
}

/**
 * Weeks in block order then week number, days in the order the block lists them.
 * A block's title is its weeks' title. `templateFor` resolves a day's template.
 */
export function groupClassPlanWeeks(
  blocks: readonly ClassPlanBlockRow[],
  sessions: readonly ClassPlanSessionRow[],
  templateFor: (lineageId: string) => ClassPlanDayTemplate,
): ClassPlanWeek[] {
  const titles = new Map(blocks.map((block) => [block.block_order, block.title]));
  const weeks = new Map<string, ClassPlanWeek>();
  const ordered = [...sessions].sort((a, b) => a.block_order - b.block_order || a.ordinal - b.ordinal);
  for (const session of ordered) {
    const key = `${session.block_order}:${session.week}`;
    let week = weeks.get(key);
    if (!week) {
      week = { week: session.week, block_order: session.block_order, title: titles.get(session.block_order) ?? null, days: [] };
      weeks.set(key, week);
    }
    week.days.push({
      block_session_id: session.block_session_id,
      ordinal: session.ordinal,
      day: session.day,
      template_lineage_id: session.template_lineage_id,
      template: templateFor(session.template_lineage_id),
    });
  }
  // A block with no sessions still shows, with no days, rather than vanishing.
  for (const block of blocks) {
    if (![...weeks.values()].some((week) => week.block_order === block.block_order)) {
      weeks.set(`${block.block_order}:0`, { week: 0, block_order: block.block_order, title: block.title, days: [] });
    }
  }
  return [...weeks.values()].sort((a, b) => a.block_order - b.block_order || a.week - b.week);
}

/** The line a day shows about readiness; null when readiness was not asked. */
export function readinessLine(template: ClassPlanDayTemplate): string | null {
  if (template.state === 'ready') return 'Ready to issue';
  if (template.state === 'empty') return 'No steps in this template';
  if (template.state === 'not_ready' && template.drill_count !== null && template.drills_to_complete !== null) {
    return `Not ready: ${template.drills_to_complete} of ${template.drill_count} drills need completing`;
  }
  return null;
}

export interface ClassPlanTrackSummary {
  track_id: string;
  name: string;
  lane: string;
  track: string | null;
  duration_weeks: number | null;
  age_band: string;
  block_count: number;
  day_count: number;
}

export interface ClassPlanTrackDetail extends ClassPlanTrackSummary {
  /** The track's detail fields as stored (strings, lists, or key/value maps). */
  details: Record<string, unknown>;
  sources: string[];
  weeks: ClassPlanWeek[];
}
