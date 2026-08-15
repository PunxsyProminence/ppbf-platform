/**
 * @jest-environment jsdom
 */

// This page replaced a front-end placeholder that showed org-wide SHADOW
// projections to guardians. What it must do instead: read the linked-child
// list from the route that runs the guardian visibility gate, then read that
// child's real progression records. What it must never do: claim "no gaps"
// while requests are still in flight, or offer a guardian a way to log a
// completion (that is the athlete's or a coach's act).

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

import ParentProgressionVisibilityPage from './page';

jest.mock('@/components/RoleStandaloneView', () => ({
  __esModule: true,
  default: ({ children }: { readonly children: ReactNode }) => <div>{children}</div>,
}));

const CHILD = { athlete_id: 'athlete-001', full_name: 'Jordan Doe' };
const SECOND_CHILD = { athlete_id: 'athlete-002', full_name: 'Riley Doe' };

const GAP = {
  gap_id: 'gap-1',
  athlete_id: 'athlete-001',
  gap_type: 'technique',
  gap_description: 'Rear foot stays flat through the cross.',
  severity: 'high',
  status: 'identified',
  created_at: '2026-07-30T12:00:00.000Z',
};

const ASSIGNMENT = {
  assignment_id: 'assign-1',
  gap_id: 'gap-1',
  drill_name: 'pivot-drill',
  drill_description: 'Pivot on the ball of the rear foot.',
  drill_display_name: 'Rear-Foot Pivot Drill',
  drill_display_description: 'Pivot on the ball of the rear foot through every cross.',
  drill_difficulty: 'beginner',
  frequency_per_week: 3,
  completion_percentage: 40,
  status: 'in_progress',
  created_at: '2026-07-31T12:00:00.000Z',
};

const COMPLETION = {
  completion_id: 'comp-1',
  assignment_id: 'assign-1',
  reps_completed: 20,
  notes: '',
  verification_status: 'verified',
  completed_at: '2026-08-01T12:00:00.000Z',
  verified_at: '2026-08-02T12:00:00.000Z',
};

type JsonBody = Record<string, unknown>;

function jsonOk(body: JsonBody) {
  return { ok: true, json: async () => body } as Response;
}

function mockFetch(overrides: Record<string, () => Promise<Response>> = {}) {
  return jest.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    for (const [fragment, responder] of Object.entries(overrides)) {
      if (url.includes(fragment)) return responder();
    }
    if (url.includes('/athletes/list')) return jsonOk({ items: [CHILD] });
    if (url.includes('/progression/gaps')) return jsonOk({ items: [GAP] });
    if (url.includes('/progression/assignments')) return jsonOk({ items: [ASSIGNMENT] });
    if (url.includes('/progression/completions')) return jsonOk({ items: [COMPLETION] });
    return jsonOk({ items: [] });
  });
}

afterEach(() => {
  jest.restoreAllMocks();
});

test('the empty state is withheld while the linked-child list is still loading', async () => {
  global.fetch = mockFetch({
    '/athletes/list': () => new Promise<Response>(() => {}),
  }) as unknown as typeof fetch;

  render(<ParentProgressionVisibilityPage />);

  await screen.findByText(/Loading progression data/);
  expect(screen.queryByText('No progression gaps on record')).toBeNull();
  expect(screen.queryByText('No linked athletes')).toBeNull();
});

test('a guardian with no linked athlete is told so, not shown an empty progression', async () => {
  global.fetch = mockFetch({
    '/athletes/list': async () => jsonOk({ items: [] }),
  }) as unknown as typeof fetch;

  render(<ParentProgressionVisibilityPage />);

  await screen.findByText('No linked athletes');
  expect(screen.queryByText('No progression gaps on record')).toBeNull();
});

test('the child with no gaps reads as coached-not-yet, only after loading settles', async () => {
  global.fetch = mockFetch({
    '/progression/gaps': async () => jsonOk({ items: [] }),
    '/progression/assignments': async () => jsonOk({ items: [] }),
  }) as unknown as typeof fetch;

  render(<ParentProgressionVisibilityPage />);

  await screen.findByText('No progression gaps on record');
  await waitFor(() => expect(screen.queryByText(/Loading progression data/)).toBeNull());
});

test("the child's real gap, drill, and verified work render read-only", async () => {
  global.fetch = mockFetch() as unknown as typeof fetch;

  render(<ParentProgressionVisibilityPage />);

  await screen.findByText('Rear foot stays flat through the cross.');
  expect(screen.getByText("Jordan Doe's Progression")).toBeTruthy();
  expect(screen.getByText('Rear-Foot Pivot Drill')).toBeTruthy();
  expect(screen.getByText('40%')).toBeTruthy();
  expect(screen.getByText('20 reps')).toBeTruthy();
  expect(screen.getByText('verified')).toBeTruthy();

  // Read-only: no completion-logging affordance exists for a guardian.
  expect(screen.queryByRole('button', { name: /log/i })).toBeNull();
});

test('switching children refetches progression for the selected athlete only', async () => {
  const fetchMock = mockFetch({
    '/athletes/list': async () => jsonOk({ items: [CHILD, SECOND_CHILD] }),
  });
  global.fetch = fetchMock as unknown as typeof fetch;

  render(<ParentProgressionVisibilityPage />);

  await screen.findByText('Rear foot stays flat through the cross.');

  fireEvent.click(screen.getByRole('button', { name: 'Riley Doe' }));

  await waitFor(() => {
    const gapCalls = fetchMock.mock.calls
      .map((call) => String(call[0]))
      .filter((url) => url.includes('/progression/gaps'));
    expect(gapCalls[gapCalls.length - 1]).toContain('athlete_id=athlete-002');
  });
});
