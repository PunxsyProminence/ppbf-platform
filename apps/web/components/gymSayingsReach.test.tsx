/**
 * @jest-environment jsdom
 */

/**
 * DO THE EGGS ACTUALLY REACH A SCREEN?
 *
 * Nothing asked this before, which is exactly why the answer collapsed without
 * anybody noticing. wordsOnTheWall.test.tsx pins the module: given lines, it
 * picks one, deterministically, and paints it. Every one of those tests passed
 * while the shipped result was that five of the owner's twelve lines could
 * render, on one route, five times in an athlete's entire career -- and the
 * platform's own tagline could not render anywhere at all.
 *
 * The gap was between the module and its CALL SITES, so that is what these
 * tests hold. They do not call pickSaying and check the answer; they render the
 * real components with the real source and the real seed domains those
 * components are handed in production, and then look at the DOM.
 *
 * WHAT WOULD BREAK THEM, deliberately:
 *   - deleting the after-hard-session call site on the training card;
 *   - seeding it from anything with a small domain again (the milestone ladder
 *     is five values, so the hash can only ever choose five lines);
 *   - dropping the saying from the wall's idle band;
 *   - making the wall's line depend on anything but the gym's day.
 *
 * The DNA calls the gym floor the eggs' PRIMARY HOME. This is the file that
 * says whether that is true of the software or only of the document.
 */

import { act, render } from '@testing-library/react';

import { resetCeremonyMemory } from './milestoneCeremony';
import TrainingCard, { HARD_SESSION_RPE, MILESTONES, type TrainingSession } from './TrainingCard';
import WallDisplay from './WallDisplay';
import { GYM_SAYINGS, pickSaying } from './gymSayings';
import type { WallBoard } from '@/src/server/pilot/wallDisplay';

jest.mock('./useGymSound', () => ({
  __esModule: true,
  default: () => ({
    enabled: false,
    ready: false,
    status: 'off' as const,
    play: () => false,
    setEnabled: async () => false,
  }),
}));

/* ------------------------------------------------------- the real seeds ---
 *
 * Each list below is the domain the matching production call site draws from.
 * They are not test conveniences: a session id is whatever the ledger issued,
 * a milestone is a member of MILESTONES, and a gym day is the YYYY-MM-DD the
 * wall payload carries. */

const SESSION_IDS = Array.from({ length: 200 }, (_, i) => `sess_${i}`);
const GYM_DAYS = Array.from({ length: 200 }, (_, i) => {
  const day = new Date(Date.UTC(2026, 0, 1 + i));
  return day.toISOString().slice(0, 10);
});

const ALL_LINES = GYM_SAYINGS.map((saying) => saying.line);

function sessionIdShowing(line: string): string | null {
  return SESSION_IDS.find((id) => pickSaying('after-hard-session', id)?.line === line) ?? null;
}

function milestoneShowing(line: string): number | null {
  return MILESTONES.find((m) => pickSaying('at-a-milestone', m)?.line === line) ?? null;
}

function gymDayShowing(line: string): string | null {
  return GYM_DAYS.find((day) => pickSaying('anywhere', day)?.line === line) ?? null;
}

/* --------------------------------------------------------- the surfaces --- */

function ledger(count: number, rpe = 6): TrainingSession[] {
  return Array.from({ length: count }, (_, i) => ({
    session_id: `ledger_${i}`,
    // Dates ascend, so the last element really is the newest row.
    date: `2026-0${Math.floor(i / 28) + 1}-${String((i % 28) + 1).padStart(2, '0')}`,
    rpe,
    completed_flag: true,
  }));
}

/** The card as an athlete sees it the evening they logged a hard session. */
function paintedAfterHardSession(sessionId: string): string | null {
  const { container } = render(
    <TrainingCard
      sessions={[
        { session_id: 'earlier', date: '2026-01-01', rpe: 5, completed_flag: true },
        { session_id: sessionId, date: '2026-01-02', rpe: HARD_SESSION_RPE, completed_flag: true },
      ]}
    />,
  );
  return container.querySelector('.wallwords-line')?.textContent ?? null;
}

/**
 * The card at the instant a seal comes down. The ceremony fires on the
 * CROSSING, so the card has to be shown one session below the milestone first;
 * and the record it keeps only ever grows, so each call gets an athlete of its
 * own rather than one who has already crossed something higher up.
 */
let reachAthlete = 0;
function paintedAtMilestone(milestone: number): string | null {
  reachAthlete += 1;
  const athleteId = `ath_reach_${reachAthlete}`;
  const view = render(<TrainingCard sessions={ledger(milestone - 1)} athleteId={athleteId} />);
  view.rerender(<TrainingCard sessions={ledger(milestone)} athleteId={athleteId} />);
  return view.container.querySelector('.wallwords-line')?.textContent ?? null;
}

function wallBoard(over: Partial<WallBoard> = {}): WallBoard {
  return {
    generated_at: '2026-08-03T18:30:00.000Z',
    gym_day: '2026-08-03',
    time_zone: 'America/New_York',
    name_mode: 'initials',
    sessions: [],
    on_floor: [],
    on_floor_total: 0,
    marquee: [],
    notice: null,
    ...over,
  };
}

/** The gym's television on a given day, with nobody having crossed anything. */
async function paintedOnTheWall(gymDay: string): Promise<string | null> {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ ok: true, board: wallBoard({ gym_day: gymDay }) }),
  } as unknown as Response) as unknown as typeof fetch;

  const view = render(<WallDisplay />);
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  const text = view.container.querySelector('.marquee-idle-line')?.textContent ?? null;
  view.unmount();
  return text;
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-08-03T18:30:00.000Z'));
  window.localStorage.clear();
  resetCeremonyMemory();
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

/* ============================================================== coverage === */

describe('every line the owner wrote reaches a real screen', () => {
  it('paints all twelve, each on a surface that really renders it', async () => {
    const painted = new Set<string>();

    for (const line of ALL_LINES) {
      const sessionId = sessionIdShowing(line);
      if (sessionId) {
        expect(paintedAfterHardSession(sessionId)).toBe(line);
        painted.add(line);
        continue;
      }

      const milestone = milestoneShowing(line);
      if (milestone) {
        expect(paintedAtMilestone(milestone)).toBe(line);
        painted.add(line);
        continue;
      }

      const day = gymDayShowing(line);
      if (day) {
        expect(await paintedOnTheWall(day)).toContain(line);
        painted.add(line);
      }
    }

    // Named individually rather than by count, so a line that stops reaching
    // anywhere says which one it was.
    expect([...painted].sort()).toEqual([...ALL_LINES].sort());
  });

  it('puts the platform\'s own tagline on the gym\'s television', async () => {
    // OBSERVE. DECIDE. EXECUTE. REPEAT. is the tagline in the room DNA
    // document and on the SHADOW shell, and it rendered in exactly nought
    // places in the application: the only call site asked for 'at-a-milestone'
    // seeded from a five-element ladder, and the tagline was not one of the
    // five the hash could reach.
    const tagline = 'OBSERVE. DECIDE. EXECUTE. REPEAT.';
    expect(ALL_LINES).toContain(tagline);

    const day = gymDayShowing(tagline);
    expect(day).not.toBeNull();
    expect(await paintedOnTheWall(day as string)).toContain(tagline);
  });

  it('renders the three after-hard-session lines, which no other surface can', () => {
    // These three are tagged for one moment only. Until the card learned to
    // ask for that moment, no caller anywhere in the application passed
    // 'after-hard-session', so they were unreachable by construction -- the
    // most invisible way for a feature to be missing.
    const exclusive = GYM_SAYINGS
      .filter((saying) => saying.shown.length === 1 && saying.shown[0] === 'after-hard-session')
      .map((saying) => saying.line);
    expect(exclusive).toHaveLength(3);

    for (const line of exclusive) {
      expect(milestoneShowing(line)).toBeNull();
      expect(gymDayShowing(line)).toBeNull();

      const sessionId = sessionIdShowing(line);
      expect(sessionId).not.toBeNull();
      expect(paintedAfterHardSession(sessionId as string)).toBe(line);
    }
  });

  it('says something more than five times in a career', () => {
    // The old seed was a member of MILESTONES: five values, so five moments
    // and at most five distinct lines in an athlete's whole time at the gym. A
    // hard session is seeded by its own id, and an athlete has as many of
    // those as they have hard nights.
    const painted = SESSION_IDS.slice(0, 20).map((id) => paintedAfterHardSession(id));

    expect(painted.filter(Boolean)).toHaveLength(20);
    expect(new Set(painted).size).toBeGreaterThan(MILESTONES.length);
  });
});

/* ================================================================ moments === */

describe('it is still a moment, not wallpaper', () => {
  it('says nothing when the newest session was not a hard one', () => {
    const { container } = render(<TrainingCard sessions={ledger(6, HARD_SESSION_RPE - 1)} />);
    expect(container.querySelector('.wallwords-line')).toBeNull();
  });

  it('takes the line back down as soon as an ordinary session lands on top', () => {
    // The whole argument for this component is that a sign which is always
    // there is invisible within a week. The next easy night removes it with no
    // dismissal, no timer and nothing to remember.
    const hard: TrainingSession[] = [
      { session_id: 'a', date: '2026-01-01', rpe: HARD_SESSION_RPE, completed_flag: true },
    ];
    const view = render(<TrainingCard sessions={hard} />);
    expect(view.container.querySelector('.wallwords-line')).not.toBeNull();

    view.rerender(
      <TrainingCard
        sessions={[...hard, { session_id: 'b', date: '2026-01-02', rpe: 4, completed_flag: true }]}
      />,
    );
    expect(view.container.querySelector('.wallwords-line')).toBeNull();
  });

  it('says nothing for a hard session that was booked and never completed', () => {
    // An RPE on an uncompleted row is not a session anybody did.
    const { container } = render(
      <TrainingCard
        sessions={[
          { session_id: 'a', date: '2026-01-01', rpe: 6, completed_flag: true },
          { session_id: 'b', date: '2026-01-02', rpe: HARD_SESSION_RPE, completed_flag: false },
        ]}
      />,
    );
    expect(container.querySelector('.wallwords-line')).toBeNull();
  });

  it('shows one sign, not two, when a seal comes down on a hard night', () => {
    const view = render(<TrainingCard sessions={ledger(4, HARD_SESSION_RPE)} athleteId="ath_two" />);
    view.rerender(<TrainingCard sessions={ledger(5, HARD_SESSION_RPE)} athleteId="ath_two" />);

    expect(view.container.querySelectorAll('.wallwords-line')).toHaveLength(1);
  });

  it('shows the same session the same line, however often it is looked at', () => {
    // Deterministic per session: the screen, a screen reader and a printout
    // have to agree with one another, today and next month.
    const first = paintedAfterHardSession('sess_42');
    expect(first).not.toBeNull();
    for (let i = 0; i < 5; i += 1) {
      expect(paintedAfterHardSession('sess_42')).toBe(first);
    }
  });
});
