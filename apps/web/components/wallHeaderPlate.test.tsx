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

describe('the header plate', () => {
  it('carries both of Jason\'s lines, in his order, before any data has arrived', () => {
    const { container } = render(<WallDisplay />);
    const text = plateText(container);
    expect(text).toContain('ADAPT AND OVERCOME');
    expect(text).toContain('OBSERVE. DECIDE. EXECUTE. REPEAT.');
    expect(text.indexOf('ADAPT AND OVERCOME')).toBeLessThan(text.indexOf('OBSERVE. DECIDE. EXECUTE. REPEAT.'));
  });

  it('stays up once a paired board is on the wall', async () => {
    const { container } = render(<WallDisplay />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText('A.B.')).toBeTruthy();
    expect(plateText(container)).toContain('ADAPT AND OVERCOME');
    expect(container.querySelectorAll('.wall-motto')).toHaveLength(1);
  });

  it('carries only lines on the approved list', () => {
    const approved = GYM_SAYINGS.map((saying) => saying.line);
    expect(WALL_MOTTO).toHaveLength(2);
    for (const line of WALL_MOTTO) expect(approved).toContain(line);
  });

  it('puts the board in the wall-board kit\'s scope, so its materials apply', () => {
    const { container } = render(<WallDisplay />);
    expect(container.querySelector('.wall-board')?.classList.contains('ge-wallboard')).toBe(true);
  });
});
