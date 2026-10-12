/**
 * @jest-environment jsdom
 */
// Lane N8-05 (F-047): an athlete's goals, read-only, for their coach and their
// guardian. The family audience never draws the "why it matters" line, even if
// a payload carried one; a read that did not answer is Unavailable, never "no
// goals"; a sibling's late answer never shows; nothing on the panel writes.

import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';

import AthleteGoalsReadOnly from './AthleteGoalsReadOnly';

const WHY = 'Because my dad never got to finish his.';

function ownRows(athleteId: string, withWhy: boolean) {
  return [
    {
      goal_id: `${athleteId}-own-1`,
      title: `${athleteId}: run a mile without stopping`,
      ...(withWhy ? { why_it_matters: WHY } : {}),
      target_date: null,
      reached_at: '2026-10-10T15:00:00.000Z',
      created_at: '2026-10-01T15:00:00.000Z',
    },
    {
      goal_id: `${athleteId}-own-2`,
      title: `${athleteId}: show up on the days I don't want to`,
      target_date: '2026-12-01',
      reached_at: null,
      created_at: '2026-10-02T15:00:00.000Z',
    },
  ];
}

function smartRows(athleteId: string) {
  return [
    { goal_id: `${athleteId}-s1`, title: `${athleteId}: jump rope 3 rounds`, target_date: '2026-11-01', metric: 'rounds', progress_percent: 40, status: 'Active' },
    { goal_id: `${athleteId}-s2`, title: `${athleteId}: hold a plank 2 minutes`, target_date: '2026-11-15', metric: 'seconds', progress_percent: null, status: 'Active' },
    // The coach's select * answer also carries the own-words row; it is not listed twice.
    { goal_id: `${athleteId}-own-1`, title: `${athleteId}: run a mile without stopping`, goal_kind: 'own_words', target_date: '2026-11-01', metric: '', progress_percent: null, status: 'completed' },
  ];
}

type Handler = (url: string, init?: RequestInit) => Promise<Response>;
let handler: Handler;
const calls: string[] = [];

function ok(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

function failed(): Response {
  return { ok: false, status: 500, json: async () => ({}) } as Response;
}

function answers({ withWhy = false } = {}): Handler {
  return async (url) => {
    const athleteId = decodeURIComponent(url.split('athlete_id=')[1] ?? '');
    if (url.includes('/goals/personal')) return ok({ ok: true, items: ownRows(athleteId, withWhy) });
    if (url.includes('/goals/list')) return ok({ items: smartRows(athleteId) });
    throw new Error(`unexpected ${url}`);
  };
}

beforeEach(() => {
  calls.length = 0;
  handler = answers();
  global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    return handler(url, init);
  }) as unknown as typeof fetch;
});

test('the family sees the goals, "I did it", the target dates and the reported progress, read-only', async () => {
  render(<AthleteGoalsReadOnly athleteId="ath_1" audience="family" />);
  expect(await screen.findByText('ath_1: run a mile without stopping')).toBeTruthy();
  expect(screen.getByText('✓ Did it · October 10, 2026')).toBeTruthy();
  expect(screen.getByText('○ Still working on it · Aiming for Dec 1, 2026')).toBeTruthy();
  expect(screen.getByText('ath_1: jump rope 3 rounds')).toBeTruthy();
  expect(screen.getByText('Reported progress: 40%')).toBeTruthy();
  expect(screen.getByText('No progress reported yet')).toBeTruthy();
  expect(screen.getAllByText('ath_1: run a mile without stopping')).toHaveLength(1);
  // Nothing here writes.
  expect(screen.queryByRole('button')).toBeNull();
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(screen.queryByRole('checkbox')).toBeNull();
  expect(calls).toHaveLength(2);
  expect(calls[0]).toContain('/api/pilot/goals/personal?athlete_id=ath_1');
  expect(calls[1]).toContain('/api/pilot/goals/list?athlete_id=ath_1');
});

test('the family audience never draws the reason line, even if a payload carried one', async () => {
  handler = answers({ withWhy: true });
  render(<AthleteGoalsReadOnly athleteId="ath_1" audience="family" />);
  await screen.findByText('ath_1: run a mile without stopping');
  expect(screen.queryByText(new RegExp(WHY.slice(0, 20)))).toBeNull();
  expect(screen.queryByText(/Why it matters/)).toBeNull();
});

test('the coach sees the reason line', async () => {
  handler = answers({ withWhy: true });
  render(<AthleteGoalsReadOnly athleteId="ath_1" audience="coach" />);
  expect(await screen.findByText(`Why it matters to them: ${WHY}`)).toBeTruthy();
});

test('a read that did not answer says Unavailable, and the other read still shows', async () => {
  handler = async (url) => (url.includes('/goals/personal') ? failed() : answers()(url));
  render(<AthleteGoalsReadOnly athleteId="ath_1" audience="family" />);
  expect(await screen.findByText('ath_1: jump rope 3 rounds')).toBeTruthy();
  expect(screen.getByText('Unavailable - these goals could not be read.')).toBeTruthy();
  expect(screen.queryByText('No goals set yet.')).toBeNull();
});

test('a malformed answer is Unavailable, not an empty list', async () => {
  handler = async (url) => (url.includes('/goals/list') ? ok({ items: [{ nope: true }] }) : answers()(url));
  render(<AthleteGoalsReadOnly athleteId="ath_1" audience="family" />);
  expect(await screen.findByText('Unavailable - these goals could not be read.')).toBeTruthy();
  expect(screen.queryByText('None set yet.')).toBeNull();
});

test('a child with no goals says so plainly', async () => {
  handler = async (url) => (url.includes('/goals/personal') ? ok({ ok: true, items: [] }) : ok({ items: [] }));
  render(<AthleteGoalsReadOnly athleteId="ath_1" audience="family" />);
  expect(await screen.findByText('No goals set yet.')).toBeTruthy();
});

test('switching child: the previous child\'s goals never show, and a late answer for them is dropped', async () => {
  const held: Array<{ url: string; resolve: (r: Response) => void; signal?: AbortSignal | null }> = [];
  handler = (url, init) => new Promise<Response>((resolve) => { held.push({ url, resolve, signal: init?.signal }); });
  const { rerender } = render(<AthleteGoalsReadOnly athleteId="ath_1" audience="family" />);
  expect(held).toHaveLength(2);

  rerender(<AthleteGoalsReadOnly athleteId="ath_2" audience="family" />);
  expect(held).toHaveLength(4);
  expect(held[0].signal?.aborted).toBe(true);
  expect(held[1].signal?.aborted).toBe(true);

  // ath_2 answers, then ath_1's late answers land.
  await act(async () => {
    held[2].resolve(ok({ ok: true, items: ownRows('ath_2', false) }));
    held[3].resolve(ok({ items: smartRows('ath_2') }));
  });
  expect(await screen.findByText('ath_2: run a mile without stopping')).toBeTruthy();
  await act(async () => {
    held[0].resolve(ok({ ok: true, items: ownRows('ath_1', false) }));
    held[1].resolve(ok({ items: smartRows('ath_1') }));
  });
  await waitFor(() => expect(screen.queryByText(/^ath_1:/)).toBeNull());
  expect(screen.getByText('ath_2: jump rope 3 rounds')).toBeTruthy();
});
