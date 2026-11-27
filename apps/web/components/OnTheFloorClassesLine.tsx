'use client';

import { useEffect, useState } from 'react';

import { useBoardSession } from './BoardRoleGate';
import { apiBase } from '@/lib/apiBase';
import { formatGymTimeOfDay } from '@/src/lib/gymTime';

/**
 * WHAT IS RUNNING ON THE FLOOR NOW, AND HOW MANY ARE HERE (lane W4-3, FN-4b; GO on #2192, 7206014991).
 * It reads GET /api/pilot/on-the-floor/classes (FN-4a) once, when the page opens; nothing polls (FN0-Q2 A,
 * QF A). The server cuts the answer by role, and this renders only what it is given:
 *   - the board: the classes, the rounds, and one total floored at 5 ("Suppressed" for 0 to 4, flag 3);
 *   - staff-role and volunteer accounts: the classes with each one's count, and the rounds;
 *   - coaches and gym admins, inside OnTheFloorStaffLine: the classes and the rounds above the names.
 * THE WORDS are QH's, as proposed in section 9.6 and approved in the GO. A round is shown as read, with
 * the time it was read (QF A). A failed, unfinished or malformed read never reads as a number or a zero
 * (FN-0 F15): the whole line says it could not be checked. No name, id or initials reach this line, and
 * nothing is kept in device storage (F10). A neutral line at the floor size, with no warning colour.
 */

export const CLASSES_LINE_WORDS = {
  checking: 'Checking who is on the floor...',
  failed: 'Who is on the floor could not be checked.',
  none: 'No class is running now.',
  running: 'Running now: ',
  total: 'On the floor now: ',
  suppressed: 'Suppressed',
} as const;

const BOARD_FLOOR = 5;

interface ClassShown {
  readonly title: string;
  readonly start: string;
  readonly end: string;
  readonly room: string;
  readonly count: number | null;
}

interface RoundShown {
  readonly tvName: string;
  readonly round: number;
  readonly roundsTotal: number;
}

export interface ClassesRead {
  readonly at: string;
  readonly classes: readonly ClassShown[];
  readonly rounds: readonly RoundShown[];
  readonly total: string | null;
}

export type ClassesState = { readonly state: 'loading' } | { readonly state: 'failed' } | { readonly state: 'read'; readonly read: ClassesRead };

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const whole = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0;
const named = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';
const time = (value: unknown): string | null => (typeof value === 'string' ? formatGymTimeOfDay(value) : null);

function parseClass(value: unknown): ClassShown | null {
  const row = record(value);
  if (!row || !named(row.title) || typeof row.room !== 'string') return null;
  const start = time(row.start_at);
  const end = time(row.end_at);
  if (!start || !end || ('count' in row && !whole(row.count))) return null;
  return { title: row.title, start, end, room: row.room.trim(), count: 'count' in row ? (row.count as number) : null };
}

function parseRound(value: unknown): RoundShown | null {
  const row = record(value);
  if (!row || !named(row.tv_name) || !whole(row.round) || !whole(row.rounds_total)) return null;
  return { tvName: row.tv_name, round: row.round, roundsTotal: row.rounds_total };
}

/** The board's total: a number only from 5 up, "Suppressed" only for the suppressed shape; else malformed. */
function parseTotal(value: unknown): string | null {
  const total = record(value);
  if (total?.status === 'insufficient_data' && total.count === null) return CLASSES_LINE_WORDS.suppressed;
  if (total?.status === 'available' && whole(total.count) && total.count >= BOARD_FLOOR) return String(total.count);
  return null;
}

/**
 * `board`: the board's answer has its shape checked here too, not only on the server (flags 3 and 4):
 * a per-class count, or no total, is a malformed answer, so the board never reads a count per class.
 */
export function parseClassesRead(payload: unknown, board = false): ClassesRead | null {
  const body = record(payload);
  const at = body ? time(body.read_at) : null;
  if (!body || body.ok !== true || !at || !Array.isArray(body.classes) || !Array.isArray(body.rounds)) return null;
  const classes = body.classes.map(parseClass);
  const rounds = body.rounds.map(parseRound);
  const total = 'total' in body ? parseTotal(body.total) : null;
  if (classes.some((item) => !item) || rounds.some((item) => !item) || ('total' in body && !total)) return null;
  if (board && (!total || classes.some((item) => item?.count !== null))) return null;
  return { at, classes: classes as ClassShown[], rounds: rounds as RoundShown[], total };
}

/** Reads the classes line once, when the component mounts; a cancelled read never lands. */
export function useOnTheFloorClasses(board = false): ClassesState {
  const [state, setState] = useState<ClassesState>({ state: 'loading' });
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`${apiBase()}/api/pilot/on-the-floor/classes`, {
          credentials: 'include',
          cache: 'no-store',
          signal: controller.signal,
        });
        const payload: unknown = await response.json().catch(() => null);
        if (controller.signal.aborted) return;
        const read = response.ok ? parseClassesRead(payload, board) : null;
        setState(read ? { state: 'read', read } : { state: 'failed' });
      } catch (error) {
        if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) return;
        setState({ state: 'failed' });
      }
    })();
    return () => controller.abort();
  }, [board]);
  return state;
}

/** The line's sentences for one read. A round clock not started or already ended (round 0) is left out. */
export function classesLineSentences(read: ClassesRead): string[] {
  const classes = read.classes.length === 0
    ? [CLASSES_LINE_WORDS.none]
    : read.classes.map((item) =>
      [`${CLASSES_LINE_WORDS.running}${item.title}`, `${item.start} to ${item.end}`, item.room, item.count === null ? '' : `${item.count} here`]
        .filter(Boolean)
        .join(', '));
  const rounds = read.rounds
    .filter((item) => item.round >= 1)
    .map((item) => `${item.tvName}: round ${item.round} of ${item.roundsTotal} (at ${read.at})`);
  return [...classes, ...rounds, ...(read.total ? [`${CLASSES_LINE_WORDS.total}${read.total}`] : [])];
}

export function FloorLines({ lines, busy }: { readonly lines: readonly string[]; readonly busy: boolean }) {
  return (
    <div aria-live="polite" aria-busy={busy}>
      {lines.map((line, index) => (
        <p key={index} className="t-body" style={{ fontSize: 'var(--t-md)' }}>{line}</p>
      ))}
    </div>
  );
}

/** The line on the staff-role and volunteer home, and inside the board's wrapper below. */
export default function OnTheFloorClassesLine({ className = '', board = false }: { readonly className?: string; readonly board?: boolean }) {
  const classes = useOnTheFloorClasses(board);
  const lines = classes.state === 'loading'
    ? [CLASSES_LINE_WORDS.checking]
    : classes.state === 'failed' ? [CLASSES_LINE_WORDS.failed] : classesLineSentences(classes.read);
  return (
    <section aria-label="What is running on the floor" className={`mat-leather rounded-[var(--r-lg)] p-[var(--s4)] ${className}`.trim()}>
      <FloorLines lines={lines} busy={classes.state === 'loading'} />
    </section>
  );
}

/** The board's mount: a board reader only. A platform owner on /board does not get it (GO 7206014991). */
export function BoardOnTheFloorLine({ className }: { readonly className?: string }) {
  const session = useBoardSession();
  return session?.role === 'board' ? <OnTheFloorClassesLine className={className} board /> : null;
}
