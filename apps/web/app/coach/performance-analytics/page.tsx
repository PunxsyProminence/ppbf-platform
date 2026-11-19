'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import RoleStandaloneView from '@/components/RoleStandaloneView';
import { apiBase } from '@/lib/apiBase';
import {
  type AttendanceWindowView,
  attendanceRateWords,
  attendanceWindowWords,
  daysSinceWords,
  isAttendanceWindow,
} from '@/src/lib/attendanceWords';
import ClusterNav from '@/components/ClusterNav';
import { formatGymDayShort } from '@/src/lib/gymTime';

// Read-only rollup over data the gym already records: session logs and RPE
// (pilot.sessions), readiness check-ins (pilot.readiness), go-forward
// training-day evidence (the reconciled class register,
// pilot.attendance_reconciled), and the progression loop.
// Numbers are labeled by their actual source -- "training days" counts
// present days in that register, deliberately NOT an attendance percentage.
// The attendance figure beside it (OD-2026-10-17-026 (c)) is a percentage of
// the days the register MARKED in the last 28 days, said with its counts.
interface PerformanceItem {
  athlete_id: string;
  full_name: string;
  sessions_total: number;
  sessions_completed: number;
  avg_rpe: number | null;
  avg_session_load: number | null;
  session_load_count: number;
  training_days: number;
  // Days with any mark in the window; 0 means no register, not a zero.
  training_days_recorded?: number;
  readiness_count: number;
  avg_readiness: number | null;
  readiness_early_avg: number | null;
  readiness_late_avg: number | null;
  open_gaps: number;
  active_assignments: number;
  avg_assignment_completion: number | null;
  /** Always the last 28 days from the register (OD-2026-10-17-026 (c)), whatever the window. */
  attendance_28d?: AttendanceWindowView | null;
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

/* ------------------------------------------------------- rest and away ---
 *
 * Lane R6-b1 (OD-2026-11-17-004): "a recorded rest or away mark (no health
 * reason asked for minors)". One tap marks one of Rule 6's 7-day load weeks
 * as rest or away; Undo takes the mark back. There is no reason field, and
 * none is ever sent. Nothing here shows a load number: a marked week is a
 * word, never a zero.
 *
 * Lane R6-b2: each week also says how complete it is -- logged, partly logged
 * ("2 of 4 rated"), rest (marked) or not logged -- in a word and a glyph,
 * never colour alone. A week with no sessions says "no sessions", never "0 of
 * 0" and never a load figure. Rule 6's load-jump ratio speaks only on logged
 * weeks (weeklySessionLoad.ts).
 */
interface LoadWeek {
  week_index: number;
  first_day: string;
  last_day: string;
}
interface RestMark {
  mark_id: string;
  athlete_id: string;
  kind: 'rest' | 'away';
  first_day: string;
  last_day: string;
}
type LoadWeekStatus = 'logged' | 'partly_logged' | 'rest_marked' | 'not_logged';
interface WeekCoverage {
  athlete_id: string;
  week_index: number;
  attended: number;
  rated: number;
  marked_days: number;
  status: LoadWeekStatus;
}
type RestMarksState =
  | { status: 'loading' }
  | { status: 'unavailable' }
  | { status: 'loaded'; today: string; weeks: LoadWeek[]; marks: RestMark[]; coverage: WeekCoverage[] };

const STATUS_WORDS: Record<LoadWeekStatus, { word: string; glyph: string }> = {
  logged: { word: 'Logged', glyph: '✓' },
  partly_logged: { word: 'Partly logged', glyph: '◐' },
  rest_marked: { word: 'Rest (marked)', glyph: '—' },
  not_logged: { word: 'Not logged', glyph: '?' },
};

/** "3 of 4 rated", or "no sessions": never "0 of 0", never a load figure. */
function shareWords(week: WeekCoverage): string {
  return week.attended > 0 ? `${week.rated} of ${week.attended} rated` : 'no sessions';
}

const KIND_WORDS: Record<RestMark['kind'], { word: string; glyph: string }> = {
  rest: { word: 'Rest', glyph: '—' },
  away: { word: 'Away', glyph: '↗' },
};

function weekLabel(index: number): string {
  if (index === 0) return 'Last 7 days';
  return index === 1 ? '1 week before' : `${index} weeks before`;
}

function dayRange(first: string, last: string): string {
  const a = formatGymDayShort(first) ?? first;
  const b = formatGymDayShort(last) ?? last;
  return first === last ? a : `${a} – ${b}`;
}

/** One read of the marks. Returns the state to show; never "no marks" on a failure. */
async function readRestMarks(): Promise<RestMarksState> {
  try {
    const response = await fetch(`${apiBase()}/api/pilot/coach/rest-marks`, { method: 'GET', credentials: 'include' });
    if (!response.ok) throw new Error(String(response.status));
    const payload = (await response.json()) as {
      today?: string; weeks?: LoadWeek[]; marks?: RestMark[]; coverage?: WeekCoverage[] | null;
    };
    // coverage null = the server could not read the week statuses: the marks
    // still work and every week says "Status not read". Absent = not this API.
    const coverageOk = Array.isArray(payload.coverage) || payload.coverage === null;
    if (!payload.today || !Array.isArray(payload.weeks) || !Array.isArray(payload.marks) || !coverageOk) {
      throw new Error('shape');
    }
    return {
      status: 'loaded', today: payload.today, weeks: payload.weeks, marks: payload.marks, coverage: payload.coverage ?? [],
    };
  } catch {
    return { status: 'unavailable' };
  }
}

function RestAwayWeeks({
  athleteId,
  state,
  onChanged,
}: {
  athleteId: string;
  state: RestMarksState;
  /** Reads the marks again; resolves once the strip shows the new state. */
  onChanged: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [fromDay, setFromDay] = useState('');
  const [toDay, setToDay] = useState('');

  if (state.status === 'loading') return <p className="t-muted mt-[var(--s4)]">Loading rest and away marks...</p>;
  if (state.status === 'unavailable') {
    return (
      <p className="t-muted mt-[var(--s4)]">
        Rest and away marks could not be loaded. This is not a statement that none are recorded.
      </p>
    );
  }

  async function send(method: 'POST' | 'DELETE', init: { body?: Record<string, string>; query?: string }) {
    setBusy(true);
    setFailure(null);
    try {
      const response = await fetch(`${apiBase()}/api/pilot/coach/rest-marks${init.query ?? ''}`, {
        method,
        credentials: 'include',
        ...(init.body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(init.body) } : {}),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? `Not saved (${response.status}).`);
      }
    } catch (error) {
      setFailure(error instanceof Error ? error.message : 'Not saved.');
      setBusy(false);
      return;
    }
    // The buttons stay off until the strip shows what was just recorded, so a
    // second tap cannot land on a week that already carries a mark.
    try {
      await onChanged();
    } finally {
      setBusy(false);
    }
  }

  const mark = (kind: RestMark['kind'], first: string, last: string) =>
    send('POST', { body: { athlete_id: athleteId, kind, first_day: first, last_day: last } });
  const undo = (markId: string) =>
    send('DELETE', { query: `?athlete_id=${encodeURIComponent(athleteId)}&mark_id=${encodeURIComponent(markId)}` });
  const mine = state.marks.filter((m) => m.athlete_id === athleteId);
  // Marked ahead of time (a planned holiday): starts after today, so no load week holds it yet.
  const ahead = mine.filter((m) => m.first_day > state.today);

  return (
    <section className="mt-[var(--s4)]" aria-label="Rest or away, by load week">
      <p className="t-eyebrow">Rest or away (no reason recorded)</p>
      <ul className="mt-[var(--s2)] space-y-[var(--s2)]">
        {state.weeks.map((week) => {
          const onWeek = mine.filter((m) => m.first_day <= week.last_day && m.last_day >= week.first_day);
          const cover = state.coverage.find((c) => c.athlete_id === athleteId && c.week_index === week.week_index);
          return (
            <li key={week.week_index} className="flex flex-wrap items-center gap-[var(--s3)]">
              <span className="min-w-[10rem] text-[color:var(--bone-200)]">
                {weekLabel(week.week_index)}{' '}
                <span className="text-[length:var(--t-xs)] text-[color:var(--bone-300)]">
                  ({dayRange(week.first_day, week.last_day)})
                </span>
              </span>
              {cover ? (
                <span className="text-[color:var(--bone-200)]" data-week-status={cover.status}>
                  <i aria-hidden="true">{STATUS_WORDS[cover.status].glyph}</i>{' '}
                  {STATUS_WORDS[cover.status].word} · {shareWords(cover)}
                </span>
              ) : (
                <span className="t-muted" data-week-status="unread">Status not read</span>
              )}
              {onWeek.map((m) => (
                <span key={m.mark_id} className="flex items-center gap-[var(--s2)]">
                  <span className="badge badge--monitor">
                    <i aria-hidden="true">{KIND_WORDS[m.kind].glyph}</i>
                    {KIND_WORDS[m.kind].word} marked, {dayRange(m.first_day, m.last_day)}
                  </span>
                  <button type="button" className="btn btn--ghost" disabled={busy} onClick={() => void undo(m.mark_id)}>
                    Undo
                  </button>
                </span>
              ))}
              {onWeek.length === 0 ? (
                <>
                  <button type="button" className="btn btn--ghost" disabled={busy} onClick={() => void mark('rest', week.first_day, week.last_day)}>
                    Rest
                  </button>
                  <button type="button" className="btn btn--ghost" disabled={busy} onClick={() => void mark('away', week.first_day, week.last_day)}>
                    Away
                  </button>
                </>
              ) : null}
            </li>
          );
        })}
        {ahead.length > 0 ? (
          <li className="flex flex-wrap items-center gap-[var(--s3)]">
            <span className="min-w-[10rem] text-[color:var(--bone-200)]">Marked ahead</span>
            {ahead.map((m) => (
              <span key={m.mark_id} className="flex items-center gap-[var(--s2)]">
                <span className="badge badge--monitor">
                  <i aria-hidden="true">{KIND_WORDS[m.kind].glyph}</i>
                  {KIND_WORDS[m.kind].word} marked, {dayRange(m.first_day, m.last_day)}
                </span>
                <button type="button" className="btn btn--ghost" disabled={busy} onClick={() => void undo(m.mark_id)}>
                  Undo
                </button>
              </span>
            ))}
          </li>
        ) : null}
      </ul>
      <details className="mt-[var(--s3)]">
        <summary className="cursor-pointer text-[color:var(--bone-300)]">Mark days</summary>
        <div className="mt-[var(--s2)] flex flex-wrap items-end gap-[var(--s3)]">
          <label className="flex flex-col">
            <span className="t-eyebrow">From</span>
            <input type="date" className="input" value={fromDay} onChange={(event) => setFromDay(event.target.value)} />
          </label>
          <label className="flex flex-col">
            <span className="t-eyebrow">To</span>
            <input type="date" className="input" value={toDay} onChange={(event) => setToDay(event.target.value)} />
          </label>
          <button type="button" className="btn btn--ghost" disabled={busy || !fromDay || !toDay} onClick={() => void mark('rest', fromDay, toDay)}>
            Rest
          </button>
          <button type="button" className="btn btn--ghost" disabled={busy || !fromDay || !toDay} onClick={() => void mark('away', fromDay, toDay)}>
            Away
          </button>
        </div>
      </details>
      {failure ? <p className="mt-[var(--s2)] text-[color:var(--restricted-ink)]" role="alert">{failure}</p> : null}
    </section>
  );
}

export default function PerformanceAnalyticsPage() {
  const [windowDays, setWindowDays] = useState<number>(28);
  const [items, setItems] = useState<PerformanceItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [restMarks, setRestMarks] = useState<RestMarksState>({ status: 'loading' });

  // Marks are their own read: a failure here leaves the rollup on screen and
  // says the marks could not be read, never that there are none. Only the
  // NEWEST read is shown: a slower, older reply (taps on two athletes in a
  // row) is dropped, so it cannot hide a mark the newer read already holds.
  // A tap waits for the NEWEST read, not just its own: if a later tap started
  // another read, this one's buttons stay off until that one lands too.
  const marksRead = useRef(0);
  const latestRead = useRef<Promise<void> | null>(null);
  const refreshRestMarks = useCallback(async () => {
    const read = ++marksRead.current;
    let waiting: Promise<void> = (async () => {
      const next = await readRestMarks();
      if (read === marksRead.current) setRestMarks(next);
    })();
    latestRead.current = waiting;
    await waiting;
    while (latestRead.current && latestRead.current !== waiting) {
      waiting = latestRead.current;
      await waiting;
    }
  }, []);

  useEffect(() => {
    void (async () => {
      const read = ++marksRead.current;
      const next = await readRestMarks();
      if (read === marksRead.current) setRestMarks(next);
    })();
  }, []);

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
          <h1 className="t-command mt-[var(--s3)]" style={{ fontSize: 'var(--t-xl)' }}>Who to See First</h1>
          <ClusterNav cluster="who-needs-me" />
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
          <div className="alert alert--warning" role="alert">
            <span className="alert-icon" aria-hidden="true">▲</span>
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
                    {/* RPE x minutes, computed by the read and never stored.
                        Not validated for boxing, so the label says so; no
                        flag or threshold is drawn from it here. */}
                    <Figure label="Avg session load (RPE × min, unvalidated)">
                      {formatNumber(item.avg_session_load, 0)}
                      {item.session_load_count > 0 ? (
                        <span className="ml-[var(--s2)] text-[length:var(--t-xs)] text-[color:var(--bone-300)]">
                          ({item.session_load_count} {item.session_load_count === 1 ? 'session' : 'sessions'})
                        </span>
                      ) : null}
                    </Figure>
                    <Figure label="Training days">
                      {item.training_days_recorded === 0 ? '—' : item.training_days}
                    </Figure>
                    {/* Present / (present + absent) days the register marked,
                        with the counts beside it; always the last 28 days. */}
                    <Figure label="Attendance, last 28 days">
                      {isAttendanceWindow(item.attendance_28d) ? (
                        <>
                          {attendanceRateWords(item.attendance_28d)}
                          {/* Its own dates, said out loud: they are not the window Training days uses. */}
                          <span className="ml-[var(--s2)] text-[length:var(--t-xs)] text-[color:var(--bone-300)]">
                            ({attendanceWindowWords(item.attendance_28d)})
                          </span>
                        </>
                      ) : '—'}
                    </Figure>
                    <Figure label="Last marked present">
                      {isAttendanceWindow(item.attendance_28d) ? daysSinceWords(item.attendance_28d) : '—'}
                    </Figure>
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
                  <RestAwayWeeks athleteId={item.athlete_id} state={restMarks} onChanged={refreshRestMarks} />
                </li>
              );
            })}
          </ul>
        )}

        <div className="mt-[var(--s5)] flex flex-wrap gap-[var(--s3)]">
          <Link href="/coach/progression-intelligence" className="btn btn--ghost">
            Progression Intelligence
          </Link>
        </div>
      </div>
    </RoleStandaloneView>
  );
}
