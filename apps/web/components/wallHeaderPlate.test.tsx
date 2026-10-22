/**
 * @jest-environment jsdom
 */

import { act, render, screen } from '@testing-library/react';

import WallDisplay, { WALL_MOTTO } from './WallDisplay';
import { GYM_SAYINGS } from './gymSayings';

/**
 * THE HEADER PLATE (lane L39). Jason 2026-10-17, on the TV's motto: "1 and add it to the approved
 * list" = the plate carries BOTH lines, ADAPT AND OVERCOME and OBSERVE. DECIDE. EXECUTE. REPEAT.,
 * and the first is now on the approved list. The plate is fixed text in the largest sign on the
 * screen, so it may carry only approved lines.
 */

function respondWith(payload: unknown) {
  return jest.fn().mockResolvedValue({ ok: true, json: async () => payload } as unknown as Response);
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-08-03T18:30:00.000Z'));
  global.fetch = respondWith({
    session: null,
    board: {
      generated_at: '2026-08-03T18:30:00.000Z',
      gym_day: '2026-08-03',
      time_zone: 'America/New_York',
      name_mode: 'initials',
      sessions: [],
      on_floor: [{ key: 'p1', name: 'A.B.', visibility: 'initials' }],
      on_floor_total: 1,
      marquee: [],
      notice: null,
    },
    quotes: [],
  }) as unknown as typeof fetch;
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

function plateText(container: HTMLElement): string {
  return container.querySelector('.wall-motto')?.textContent ?? '';
}

/** The plate's lines as the room reads them: every span that is not decoration. */
function plateLines(container: HTMLElement): string[] {
  return [...container.querySelectorAll('.wall-motto > span:not([aria-hidden="true"])')].map((span) => span.textContent ?? '');
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('the header plate', () => {
  it('carries both of Jason\'s lines, in his order, and nothing else, before any data has arrived', async () => {
    const { container } = render(<WallDisplay />);
    expect(plateLines(container)).toEqual(['ADAPT AND OVERCOME', 'OBSERVE. DECIDE. EXECUTE. REPEAT.']);
    await settle();
  });

  it('stays up once a paired board is on the wall', async () => {
    const { container } = render(<WallDisplay />);
    await settle();
    expect(screen.getByText('A.B.')).toBeTruthy();
    expect(plateText(container)).toContain('ADAPT AND OVERCOME');
    expect(container.querySelectorAll('.wall-motto')).toHaveLength(1);
  });

  it('carries only lines on the approved list', async () => {
    const approved = GYM_SAYINGS.map((saying) => saying.line);
    const { container } = render(<WallDisplay />);
    expect(plateLines(container)).toEqual([...WALL_MOTTO]);
    for (const line of plateLines(container)) expect(approved).toContain(line);
    await settle();
  });

  it('carries cream enamel only on the boards\' sign bands and the clock plate (burn-in)', async () => {
    const { container } = render(<WallDisplay />);
    await settle();
    const enamelled = [...container.querySelectorAll('.ge-enamel')].map((el) => `${el.tagName.toLowerCase()}.${el.classList[0]}`);
    // A paired TV with nothing sent is the workout-ready board (issue 1792): three boards, as with
    // a session up -- the round clock, on the floor, today.
    expect(enamelled.sort()).toEqual(['h2.wall-heading', 'h2.wall-heading', 'h2.wall-heading', 'p.wall-clock']);
  });

  it('puts the board in the wall-board kit\'s scope, so its materials apply', async () => {
    const { container } = render(<WallDisplay />);
    expect(container.querySelector('.wall-board')?.classList.contains('ge-wallboard')).toBe(true);
    await settle();
  });
});
