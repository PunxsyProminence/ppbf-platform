/**
 * @jest-environment jsdom
 */

// The athlete workspace is the one surface a minor sees as "their" data, so the
// two failure modes covered here are the ones that mislead hardest: a tile or a
// tab that states something the backend never said, and a control that looks
// like it did something it did not.

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

jest.mock('next/link', () => ({
  __esModule: true,
  default: function MockLink({ href, children, ...rest }: { href: string; children: React.ReactNode }) {
    return React.createElement('a', { href, ...rest }, children);
  },
}));

import AthleteWorkspace from './AthleteWorkspace';

type FetchCall = { url: string; method: string };

const fetchCalls: FetchCall[] = [];
let authenticated = true;
let resolveGoalPost: ((value: unknown) => void) | null = null;

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    json: async () => body,
  } as unknown as Response;
}

beforeEach(() => {
  fetchCalls.length = 0;
  authenticated = true;
  resolveGoalPost = null;

  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    fetchCalls.push({ url, method: init?.method ?? 'GET' });

    if (url.includes('/api/pilot/auth/session')) {
      return jsonResponse(authenticated ? { authenticated: true, athlete_id: 'ath_test' } : { authenticated: false });
    }
    if (url.includes('/api/pilot/goals/list')) {
      return jsonResponse({ items: [] });
    }
    if (url.includes('/api/pilot/floor-plans')) {
      return jsonResponse({ items: [] });
    }
    if (url.includes('/api/pilot/shadow/observation-projection')) {
      return jsonResponse({ items: [] });
    }
    if (url.includes('/api/pilot/goals')) {
      // Held open so a second click lands while the first request is in flight.
      return new Promise((resolve) => {
        resolveGoalPost = () => resolve(jsonResponse({ ok: true }));
      });
    }
    return jsonResponse({});
  }) as unknown as typeof fetch;
});

async function renderWorkspace() {
  render(<AthleteWorkspace />);
  await act(async () => {
    await Promise.resolve();
  });
}

function openTab(label: string) {
  fireEvent.click(screen.getByRole('button', { name: label }));
}

describe('athlete workspace honesty', () => {
  test('the Next Session tile does not name a class the backend never returned', async () => {
    await renderWorkspace();

    expect(screen.queryByText(/Youth Class 4:00 PM/)).toBeNull();
    expect(screen.getByText('Unavailable - not yet tracked')).toBeTruthy();
  });

  test('the Schedule tab offers the real scheduler instead of unbookable class rows', async () => {
    await renderWorkspace();
    openTab('Schedule');

    expect(screen.queryByRole('button', { name: 'Book' })).toBeNull();
    expect(screen.queryByText(/Mon-Thu 4:00 PM Youth Class/)).toBeNull();
    expect(screen.getByRole('link', { name: 'Open Unified Scheduler' })).toBeTruthy();
  });

  test('the Assessments tab does not present a start control that cannot start anything', async () => {
    await renderWorkspace();
    openTab('Assessments');

    const start = screen.getByRole('button', { name: 'Start Assessment' }) as HTMLButtonElement;
    expect(start.disabled).toBe(true);
  });

  test('double-clicking Create Goal posts the goal once', async () => {
    await renderWorkspace();
    openTab('Goals');
    fireEvent.click(screen.getByRole('button', { name: '+ New SMART Goal' }));

    fireEvent.change(screen.getByPlaceholderText('Goal title'), { target: { value: 'Land 100 clean jabs' } });
    fireEvent.change(screen.getByPlaceholderText('Success metric'), { target: { value: '100 reps logged' } });
    const targetDate = document.querySelector('input[type="date"]') as HTMLInputElement;
    fireEvent.change(targetDate, { target: { value: '2026-09-01' } });

    const createGoal = screen.getByRole('button', { name: 'Create Goal' });
    fireEvent.click(createGoal);
    fireEvent.click(createGoal);

    await act(async () => {
      resolveGoalPost?.(null);
      await Promise.resolve();
    });

    const goalPosts = fetchCalls.filter((call) => call.method === 'POST' && call.url.endsWith('/api/pilot/goals'));
    expect(goalPosts).toHaveLength(1);
  });

  test('with no backend session, Create Goal says the goal was not saved', async () => {
    authenticated = false;
    await renderWorkspace();
    openTab('Goals');
    fireEvent.click(screen.getByRole('button', { name: '+ New SMART Goal' }));

    fireEvent.change(screen.getByPlaceholderText('Goal title'), { target: { value: 'Land 100 clean jabs' } });
    fireEvent.change(screen.getByPlaceholderText('Success metric'), { target: { value: '100 reps logged' } });
    const targetDate = document.querySelector('input[type="date"]') as HTMLInputElement;
    fireEvent.change(targetDate, { target: { value: '2026-09-01' } });

    fireEvent.click(screen.getByRole('button', { name: 'Create Goal' }));

    // Nothing is written anywhere without a session, so the message must not
    // imply the goal survived.
    await waitFor(() => expect(screen.getByText(/Goal was not saved/)).toBeTruthy());
    expect(screen.queryByText(/saved locally/i)).toBeNull();
    expect(fetchCalls.some((call) => call.url.endsWith('/api/pilot/goals'))).toBe(false);
  });
});
