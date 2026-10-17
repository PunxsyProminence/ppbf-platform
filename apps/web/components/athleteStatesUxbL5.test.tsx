/**
 * @jest-environment jsdom
 */

// UXB-L5a (lane U3): athlete screens tell the truth about a failed read and
// give a way back, count goals the way the Goals tab shows them, and take one
// "I did it" per press. Every case but the Active Goals count fails on main
// 6d9910a78; that one passes there only because main also drew the own-words
// goal as a duplicate SMART card, and it guards the count once that is gone.

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import React from 'react';

jest.mock('next/link', () => ({
  __esModule: true,
  default: function MockLink({ href, children, ...rest }: { href: string; children: React.ReactNode }) {
    return React.createElement('a', { href, ...rest }, children);
  },
}));

import AthleteCheckInPanel from './AthleteCheckInPanel';
import AthleteAchievements from './AthleteAchievements';
import PersonalGoalBoard from './PersonalGoalBoard';
import AthleteWorkspace, { AthleteScheduleView } from './AthleteWorkspace';

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 500): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

jest.setTimeout(20000);

afterEach(() => {
  jest.restoreAllMocks();
});

describe('Wellness: a failed read is an alert with Try again (UXB-06)', () => {
  test('the panel shows the failure as an alert and Try again reads again', () => {
    const onRetry = jest.fn();
    render(
      <AthleteCheckInPanel today={null} recent={[]} loading={false} loadError="How you feel today did not load." onRetry={onRetry} onSaved={() => {}} />,
    );

    expect(screen.getByRole('alert').textContent).toContain('How you feel today did not load.');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  test('the form is named Wellness and saves as "Save wellness", never "Check in" (UXB-19)', () => {
    render(<AthleteCheckInPanel today={null} recent={[]} loading={false} loadError={null} onSaved={() => {}} />);

    expect(screen.getByRole('button', { name: 'Save how I feel' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /check in/i })).toBeNull();
  });
});

describe('the athlete home counts and draws goals the way the Goals tab does (UXB-18, Q2 A)', () => {
  const smart = { goal_id: 'g_smart', title: 'Jab speed', status: 'active', goal_kind: 'smart', category: null, metric: '10 in 5s', target_date: '2099-01-01' };
  const ownWords = { goal_id: 'g_own', title: 'Run a mile without stopping', status: 'active', goal_kind: 'own_words', own_words: 'Run a mile without stopping', reached_at: null };

  async function renderHome() {
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/pilot/auth/session')) return jsonResponse({ authenticated: true, athlete_id: 'ath_test' });
      if (url.includes('/api/pilot/goals/list')) return jsonResponse({ items: [smart, ownWords] });
      if (url.includes('/api/pilot/goals/personal')) return jsonResponse({ items: [ownWords] });
      return jsonResponse({ ok: true, items: [] });
    }) as unknown as typeof fetch;
    render(<AthleteWorkspace />);
    await act(async () => {
      await Promise.resolve();
    });
  }

  test('Active Goals counts the SMART goal and the own-words goal', async () => {
    await renderHome();
    await waitFor(() => expect(screen.getByText('Active Goals').parentElement?.textContent).toBe('Active Goals2'));
  });

  test('an own-words goal is not also drawn as a SMART card', async () => {
    await renderHome();
    fireEvent.click(screen.getByRole('button', { name: 'Development' }));
    const goals = screen.queryByRole('button', { name: 'Goals' });
    if (goals) fireEvent.click(goals);

    await screen.findByLabelText('Report progress for Jab speed');
    expect(screen.queryByLabelText('Report progress for Run a mile without stopping')).toBeNull();
  });

  test('with only own-words goals, the Goals tab does not also say "Nothing on the board yet"', async () => {
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/pilot/auth/session')) return jsonResponse({ authenticated: true, athlete_id: 'ath_test' });
      if (url.includes('/api/pilot/goals/list')) return jsonResponse({ items: [ownWords] });
      if (url.includes('/api/pilot/goals/personal')) return jsonResponse({ items: [ownWords] });
      return jsonResponse({ ok: true, items: [] });
    }) as unknown as typeof fetch;
    render(<AthleteWorkspace />);
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Development' }));
    const goals = screen.queryByRole('button', { name: 'Goals' });
    if (goals) fireEvent.click(goals);

    await screen.findByText('Run a mile without stopping');
    await waitFor(() => expect(screen.getByText('Active Goals').parentElement?.textContent).toBe('Active Goals1'));
    expect(screen.queryByText(/Nothing on the board yet/)).toBeNull();
  });
});

describe('"I did it" is one write per press (UXB-19)', () => {
  test('two presses before the first is answered send one PATCH', async () => {
    let release: (() => void) | null = null;
    const patches: string[] = [];
    global.fetch = jest.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PATCH') {
        patches.push(String(init.body));
        await new Promise<void>((resolve) => { release = resolve; });
        return jsonResponse({ ok: true });
      }
      return jsonResponse({ items: [{ goal_id: 'g1', own_words: 'Run a mile', title: 'Run a mile', why_it_matters: '', target_date: null, reached_at: null, created_at: '2026-10-01T12:00:00Z' }] });
    }) as unknown as typeof fetch;

    render(<PersonalGoalBoard athleteId="ath_1" />);
    const button = await screen.findByRole('button', { name: 'I did it' });
    // Both presses land before React re-renders, so the button is not yet
    // disabled for the second: only the in-flight lock can refuse it.
    act(() => {
      button.click();
      button.click();
    });

    await waitFor(() => expect(patches).toHaveLength(1));
    expect((button as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      release?.();
    });
    expect(patches).toHaveLength(1);
  });
});

describe('a failed read has a way back (UXB-13)', () => {
  test('own-words goals: Try again reads again', async () => {
    let fail = true;
    global.fetch = jest.fn(async () => (fail ? jsonResponse({ error: 'x' }, false) : jsonResponse({ items: [] }))) as unknown as typeof fetch;
    render(<PersonalGoalBoard athleteId="ath_1" />);

    await screen.findByText(/These did not load/);
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.queryByText(/These did not load/)).toBeNull());
  });

  test('achievements: Try again reads again', async () => {
    let fail = true;
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      if (fail) return jsonResponse({ error: 'x' }, false);
      return jsonResponse(String(input).includes('milestones') ? { program: 'boxing', completed_sessions: 0, items: [] } : { items: [] });
    }) as unknown as typeof fetch;
    render(<AthleteAchievements athleteId="ath_1" />);

    await screen.findByText(/This did not load/);
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.queryByText(/This did not load/)).toBeNull());
  });

  test('schedule: Try again reads the scheduler again', async () => {
    let fail = true;
    global.fetch = jest.fn(async () => (fail
      ? jsonResponse({ error: 'x' }, false)
      : jsonResponse({ ok: true, classes: [], registrations: [] }))) as unknown as typeof fetch;
    render(<AthleteScheduleView />);

    await screen.findByText('Your schedule could not be loaded.');
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.queryByText('Your schedule could not be loaded.')).toBeNull());
  });
});

describe('a coach\'s call on an attempt or a drill is not the smallest text on a kiosk (UXB-20)', () => {
  test.each([
    ['AthleteAttemptLog.tsx', /Coach (confirmed|correction|disputed)/],
    ['AthleteWorkspace.tsx', /Coach authorization required/],
  ])('%s sets no --t-xs on its coach lines', (file, coachLine) => {
    const source = readFileSync(path.join(__dirname, file), 'utf8');
    const offending = source.split('\n').filter((line) => coachLine.test(line) && /--t-xs/.test(line));
    // The line holding the words, and the line that opens its element, carry no override.
    const opening = source.split('\n').flatMap((line, index, all) => (
      coachLine.test(line) && index > 0 && /--t-xs/.test(all[index - 1]) && /<p|<span/.test(all[index - 1]) ? [all[index - 1]] : []
    ));
    expect([...offending, ...opening]).toEqual([]);
  });
});

describe('Next Session is the athlete\'s own booking, in words (UXB-17)', () => {
  test('a sign-in that did not resolve says Unavailable, not "Checking..." forever', async () => {
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/api/pilot/auth/session')) return jsonResponse({ authenticated: false });
      return jsonResponse({ ok: true, items: [] });
    }) as unknown as typeof fetch;
    render(<AthleteWorkspace />);

    const tile = (await screen.findByText('Next Session')).parentElement as HTMLElement;
    await waitFor(() => expect(within(tile).getByText('Unavailable')).toBeTruthy());
  });

  test('a failed scheduler read says Unavailable, never "Nothing posted yet."', async () => {
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/pilot/auth/session')) return jsonResponse({ authenticated: true, athlete_id: 'ath_test' });
      if (/\/api\/pilot\/scheduler$/.test(url)) return jsonResponse({ error: 'x' }, false);
      return jsonResponse({ ok: true, items: [] });
    }) as unknown as typeof fetch;
    render(<AthleteWorkspace />);

    const tile = (await screen.findByText('Next Session')).parentElement as HTMLElement;
    await waitFor(() => expect(within(tile).getByText('Unavailable')).toBeTruthy());
    expect(screen.queryByText('Nothing posted yet.')).toBeNull();
  });
});
