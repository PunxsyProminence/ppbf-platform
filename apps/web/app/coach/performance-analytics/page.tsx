'use client';

import { useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import RoleStandaloneView from '@/components/RoleStandaloneView';
import { apiBase } from '@/lib/apiBase';

// Read-only rollup over data the gym already records: session logs and RPE
// (pilot.sessions), readiness check-ins (pilot.readiness), go-forward
// training-day evidence (pilot.activity_log), and the progression loop.
// Numbers are labeled by their actual source -- "training days" is the
// activity log's evidence stream, deliberately NOT an attendance percentage,
// because attendance-source adjudication is a separately owned decision (see
// performanceAnalytics.ts).
interface PerformanceItem {
  athlete_id: string;
  full_name: string;
  sessions_total: number;
  sessions_completed: number;
  avg_rpe: number | null;
  training_days: number;
  readiness_count: number;
  avg_readiness: number | null;
  readiness_early_avg: number | null;
  readiness_late_avg: number | null;
  open_gaps: number;
  active_assignments: number;
  avg_assignment_completion: number | null;
}

const WINDOW_CHOICES = [7, 28, 90] as const;

function formatNumber(value: number | null, digits = 1): string {
  if (value == null) return '—';
  return value.toFixed(digits);
}

// The margin a direction is worth showing at. Below it the two halves of the
// window are the same reading with noise on it.
const TREND_MARGIN = 0.5;

// Direction is shown only when both halves of the window have check-ins and
// the means differ by a margin worth a coach's glance. This is a glanceable
// cue, not a statistical claim -- the SHADOW lane owns real inference.
function ReadinessTrend({ early, late }: { early: number | null; late: number | null }) {
  if (early == null || late == null) return null;
  const delta = late - early;
  if (Math.abs(delta) < TREND_MARGIN) {
    return <span className="badge badge--monitor"><i>◉</i>steady</span>;
  }
  return delta > 0 ? (
    <span className="badge badge--cleared"><i>▲</i>rising</span>
  ) : (
    <span className="badge badge--restricted"><i>▼</i>falling</span>
  );
}

/* -------------------------------------------------------------- urgency ---
 *
 * WHY THIS PAGE STOPPED BEING A TABLE.
 *
 * It was the only <table> on any gym-floor route: eight columns, one row per
 * athlete, in whatever order the API happened to return them, with nothing
 * saying which row to read first. A table is board furniture -- it is the
 * right object when the question is "what are all the numbers", which is a
 * question asked sitting down. The floor's question is "who do I go to
 * first", and the floor's answer is cards, worst at the top, the way
 * /coach/passbook-gaps and /coach/intelligence already answer it.
 *
 * NOTHING NEW IS MEASURED. Every input below is a figure that was already in
 * the payload and already in a column of the old table. What changed is that
 * the page now says out loud which figure put a card where it is, instead of
 * leaving a coach to find it by scanning eight columns.
 *
 * THE RUNGS ARE THE SIBLINGS' RUNGS, and the locked rung is deliberately not
 * among them. badge--locked is the safety gate's red -- it means a person may
 * not participate -- and no arithmetic over session counts and check-ins can
 * earn it. A roster rollup can say "look at this one first"; it cannot say
 * "this one is unsafe" (Law 2). Every rung carries a glyph and a word as well
 * as a colour, because colour is never the only channel (Law 3).
 */
const SEVERITY_BADGE: Record<'high' | 'moderate' | 'low', { className: string; glyph: string }> = {
  high: { className: 'badge--restricted', glyph: '▲' },
  moderate: { className: 'badge--monitor', glyph: '◉' },
  low: { className: 'badge--monitor', glyph: '○' },
};

type Rung = keyof typeof SEVERITY_BADGE;

/** The reason a card is where it is, in the words a coach would use. */
interface FloorSignal {
  readonly rung: Rung;
  readonly reason: string;
}

const RUNG_ORDER: Record<Rung, number> = { high: 0, moderate: 1, low: 2 };

/**
 * One reason per card -- the first one that applies, in the order a coach
 * would actually walk. A card with three reasons is a card nobody reads, and
 * the figures are all still on it either way.
 *
 * Returns null when nothing in the window asks for attention. That is not
 * "fine" and it is not a clearance; it is the honest reading that this
 * rollup has nothing to point at, and the card says so in those words.
 */
function floorSignal(item: PerformanceItem): FloorSignal | null {
  const { readiness_early_avg: early, readiness_late_avg: late } = item;
  if (early != null && late != null && late - early <= -TREND_MARGIN) {
    return { rung: 'high', reason: 'readiness falling' };
  }
  if (item.open_gaps > 0) {
    return {
      rung: 'moderate',
      reason: item.open_gaps === 1 ? '1 open gap' : `${item.open_gaps} open gaps`,
    };
  }
  if (item.active_assignments > 0 && (item.avg_assignment_completion ?? 100) < 50) {
    return { rung: 'moderate', reason: 'drills behind' };
  }
  const missed = item.sessions_total - item.sessions_completed;
  if (missed > 0) {
    return {
      rung: 'low',
      reason: missed === 1 ? '1 booked, not completed' : `${missed} booked, not completed`,
    };
  }
  return null;
}

/**
 * Worst first, and stable underneath.
 *
 * The tie-breaks are deterministic all the way down to the name, so the same
 * payload always produces the same order: a list that reshuffles between two
 * loads of the same data is a list a coach cannot trust to have read.
 */
function sortForTheFloor(items: readonly PerformanceItem[]): PerformanceItem[] {
  return [...items].sort((a, b) => {
    const sa = floorSignal(a);
    const sb = floorSignal(b);
    const ra = sa ? RUNG_ORDER[sa.rung] : 3;
    const rb = sb ? RUNG_ORDER[sb.rung] : 3;
    if (ra !== rb) return ra - rb;
    if (a.open_gaps !== b.open_gaps) return b.open_gaps - a.open_gaps;
    const da = a.readiness_early_avg != null && a.readiness_late_avg != null
      ? a.readiness_late_avg - a.readiness_early_avg : 0;
    const db = b.readiness_early_avg != null && b.readiness_late_avg != null
      ? b.readiness_late_avg - b.readiness_early_avg : 0;
    if (da !== db) return da - db;
    return a.full_name.localeCompare(b.full_name);
  });
}

/** A labelled figure on a card. The label is what the number IS, every time. */
function Figure({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="t-eyebrow">{label}</dt>
      <dd className="t-data t-data--lg mt-[var(--s1)]">{children}</dd>
    </div>
  );
}

export default function PerformanceAnalyticsPage() {
  const [windowDays, setWindowDays] = useState<number>(28);
  const [items, setItems] = useState<PerformanceItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        setLoading(true);
        setErrorMessage(null);
        const response = await fetch(
          `${apiBase()}/api/pilot/analytics/performance?window_days=${windowDays}`,
          { method: 'GET', credentials: 'include' },
        );
        if (!response.ok) throw new Error(`Failed to load performance analytics: ${response.status}`);
        const payload = (await response.json()) as { items?: PerformanceItem[] };
        setItems(payload.items ?? []);
      } catch (error) {
        setItems([]);
        setErrorMessage(error instanceof Error ? error.message : 'Failed to load performance analytics.');
      } finally {
        setLoading(false);
      }
    })();
  }, [windowDays]);

  return (
    <RoleStandaloneView roleLabel="Coach Workspace" routeLabel="/coach/performance-analytics" allowedRoles={['coach', 'admin']} room="floor" showShellHeader={false}>
      <div className="mx-auto max-w-6xl">
        <div className="mb-[var(--s5)]">
          <p className="t-eyebrow">Your floor</p>
          <h1 className="t-command mt-[var(--s3)]" style={{ fontSize: 'var(--t-xl)' }}>Who to see first</h1>
          <p className="mt-[var(--s3)] text-[length:var(--t-md)] leading-relaxed text-[color:var(--bone-300)]">
            Session logs, readiness check-ins, training days, and drill work over the window you pick, one card
            per athlete, the ones asking for you at the top. Read-only, and every number comes from records the
            gym already keeps.
          </p>
        </div>

        <nav aria-label="Window" className="mb-[var(--s5)] flex gap-[var(--s3)]">
          {WINDOW_CHOICES.map((choice) => (
            <button
              key={choice}
              type="button"
              className={choice === windowDays ? 'btn' : 'btn btn--ghost'}
              aria-pressed={choice === windowDays}
              onClick={() => setWindowDays(choice)}
            >
              {choice} days
            </button>
          ))}
        </nav>

        {errorMessage && (
          <div className="alert alert--critical" role="alert">
            <span className="alert-icon" aria-hidden="true">✕</span>
            <div className="alert-body">
              <p className="alert-title">Failed</p>
              <p className="alert-msg">{errorMessage}</p>
            </div>
          </div>
        )}

        {loading ? (
          <div className="flex justify-center py-[var(--s7)]">
            <span className="working">Loading performance rollup...</span>
          </div>
        ) : errorMessage ? (
          /* The error alert already renders above this. Without the guard the
             screen showed a failure AND a contradicting assertion at once --
             and this page exists to order athletes by who needs attention, so
             "no athletes" reads as "nobody is asking for you". */
          <div className="mat-leather rounded-[var(--r-lg)] border-2 border-[var(--restricted)]">
            <div className="empty">
              <div className="empty-title text-[var(--restricted-ink)]">The rollup could not be read</div>
              <p className="empty-msg mx-auto">
                This is not a statement that you have no athletes, or that none of them need
                attention. Nobody could look.
              </p>
            </div>
          </div>
        ) : items.length === 0 ? (
          <div className="mat-leather rounded-[var(--r-lg)]">
            <div className="empty">
              <div className="empty-glyph" aria-hidden="true">🥊</div>
              <div className="empty-title">No athletes on your roster</div>
              <p className="empty-msg mx-auto">Athletes you coach (or cover) will appear here with their rollup.</p>
            </div>
          </div>
        ) : (
          <ul className="space-y-[var(--s4)]">
            {sortForTheFloor(items).map((item) => {
              const signal = floorSignal(item);
              const badge = signal ? SEVERITY_BADGE[signal.rung] : null;
              return (
                <li key={item.athlete_id} className="mat-leather--raised rounded-[var(--r-lg)] p-[var(--s5)]">
                  <div className="flex flex-wrap items-center gap-[var(--s3)]">
                    <span className="font-semibold text-[length:var(--t-lg)] text-[color:var(--bone-100)]">{item.full_name}</span>
                    {signal && badge ? (
                      <span className={`badge ${badge.className}`}>
                        <i aria-hidden="true">{badge.glyph}</i>
                        {signal.reason}
                      </span>
                    ) : (
                      /* Not a clearance and not a green light -- just the
                         truth that this rollup has nothing to point at for
                         this athlete in this window. */
                      <span className="t-muted">Nothing in this window asking for you</span>
                    )}
                    <ReadinessTrend early={item.readiness_early_avg} late={item.readiness_late_avg} />
                  </div>

                  {/* Every column of the old table, still here, each one
                      labelled with what it is rather than sitting under a
                      header eight cells away. */}
                  <dl className="mt-[var(--s4)] flex flex-wrap gap-x-[var(--s6)] gap-y-[var(--s3)]">
                    <Figure label="Sessions">{item.sessions_completed}/{item.sessions_total}</Figure>
                    <Figure label="Avg RPE">{formatNumber(item.avg_rpe)}</Figure>
                    <Figure label="Training days">{item.training_days}</Figure>
                    <Figure label="Readiness">
                      {formatNumber(item.avg_readiness)}
                      {item.readiness_count > 0 ? (
                        <span className="ml-[var(--s2)] text-[length:var(--t-xs)] text-[color:var(--bone-300)]">
                          ({item.readiness_count} check-ins)
                        </span>
                      ) : null}
                    </Figure>
                    <Figure label="Open gaps">{item.open_gaps}</Figure>
                    <Figure label="Drill completion">
                      {item.avg_assignment_completion == null ? '—' : `${Math.round(item.avg_assignment_completion)}%`}
                      {item.active_assignments > 0 ? (
                        <span className="ml-[var(--s2)] text-[length:var(--t-xs)] text-[color:var(--bone-300)]">
                          ({item.active_assignments} active)
                        </span>
                      ) : null}
                    </Figure>
                  </dl>
                </li>
              );
            })}
          </ul>
        )}

        <div className="mt-[var(--s5)] flex flex-wrap gap-[var(--s3)]">
          <Link href="/coach/progression-intelligence" className="btn btn--ghost">
            Progression Intelligence
          </Link>
          <Link href="/coach/operations" className="btn btn--ghost">
            Coach Operations
          </Link>
        </div>
      </div>
    </RoleStandaloneView>
  );
}
