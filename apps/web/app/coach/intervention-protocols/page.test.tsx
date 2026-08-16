/**
 * @jest-environment jsdom
 */

// Intervention protocols page. What these pin: filing posts exposure as a
// STRUCTURED dimension -> amount object (the page offers no single dose or
// difficulty field to type into); the hypothesis-discipline fields travel
// with the create; and a listed protocol shows its hypothesis and its
// "would contradict" line -- intent is displayed as intent.

import { act, fireEvent, render, screen } from '@testing-library/react';

import InterventionProtocolsPage from './page';

jest.mock('@/components/RoleSessionGate', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const PROTOCOL = {
  protocol_id: 'p-1',
  lineage_id: 'p-1',
  version: 2,
  athlete_id: 'ath-1',
  athlete_name: 'Jordan P.',
  title: 'Round-3 endurance block',
  target_problem: 'fades in round 3',
  hypothesis: 'aerobic capacity limits round-3 output',
  intervention_description: 'constrained 3-round intervals, twice weekly',
  intended_task_context: 'constrained-live',
  intended_exposure: { rounds: 6, sessions: 2 },
  expected_outcome: 'round-3 work rate holds within 10% of round 1',
  contradicting_evidence: 'output collapses identically at low RPE',
  alternative_explanations: '',
  evaluation_plan: '',
  status: 'active',
  created_at: '2026-08-16T00:00:00.000Z',
};

function mockFetch(capture: { posts: unknown[] }) {
  return jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/intervention-protocols') && init?.method === 'POST') {
      capture.posts.push(JSON.parse(String(init.body)));
      return { ok: true, json: async () => ({ item: {} }) } as Response;
    }
    if (url.includes('/intervention-protocols')) {
      return { ok: true, json: async () => ({ items: [PROTOCOL] }) } as Response;
    }
    if (url.includes('/athletes/list')) {
      return { ok: true, json: async () => ({ items: [{ athlete_id: 'ath-1', full_name: 'Jordan P.' }] }) } as Response;
    }
    return { ok: true, json: async () => ({ items: [] }) } as Response;
  }) as unknown as typeof fetch;
}

afterEach(() => {
  jest.restoreAllMocks();
});

test('a protocol renders as stated intent: hypothesis, version, and what would contradict it', async () => {
  global.fetch = mockFetch({ posts: [] });

  await act(async () => {
    render(<InterventionProtocolsPage />);
  });

  expect(await screen.findByText('Round-3 endurance block')).toBeTruthy();
  expect(screen.getByText(/aerobic capacity limits round-3 output/)).toBeTruthy();
  expect(screen.getByText(/v2 · Jordan P\./)).toBeTruthy();
  expect(screen.getByText(/output collapses identically at low RPE/)).toBeTruthy();
  expect(screen.getByText(/rounds: 6 · sessions: 2/)).toBeTruthy();
});

test('filing posts structured exposure -- dimensions in real units, never a dose scalar', async () => {
  const capture = { posts: [] as unknown[] };
  global.fetch = mockFetch(capture);

  await act(async () => {
    render(<InterventionProtocolsPage />);
  });
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Round-3 endurance block' } });
    fireEvent.change(screen.getByLabelText(/Target problem/), { target: { value: 'fades in round 3' } });
    fireEvent.change(screen.getByLabelText(/Hypothesis/), { target: { value: 'aerobic capacity limits output' } });
    fireEvent.change(screen.getByLabelText(/Intervention —/), { target: { value: 'constrained intervals' } });
    fireEvent.change(screen.getByLabelText(/Expected outcome/), { target: { value: 'round-3 rate holds' } });
    fireEvent.change(screen.getByLabelText(/What would contradict/), { target: { value: 'no change at low RPE' } });
    fireEvent.change(screen.getByLabelText('Rounds'), { target: { value: '6' } });
    fireEvent.change(screen.getByLabelText('Sessions'), { target: { value: '2' } });
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'File protocol' }));
  });

  expect(capture.posts).toHaveLength(1);
  const posted = capture.posts[0] as Record<string, unknown>;
  expect(posted).toMatchObject({
    title: 'Round-3 endurance block',
    hypothesis: 'aerobic capacity limits output',
    contradicting_evidence: 'no change at low RPE',
    intended_exposure: { rounds: 6, sessions: 2 },
  });
  // Structured dimensions only: nothing on this page can post a dose.
  expect(posted.intended_exposure).not.toHaveProperty('difficulty');
  expect(posted).not.toHaveProperty('dose');
});

test('a non-positive exposure amount never leaves the page', async () => {
  const capture = { posts: [] as unknown[] };
  global.fetch = mockFetch(capture);

  await act(async () => {
    render(<InterventionProtocolsPage />);
  });
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Rounds'), { target: { value: '-2' } });
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'File protocol' }));
  });

  expect(capture.posts).toHaveLength(0);
  expect(screen.getByText(/rounds must be a positive number/)).toBeTruthy();
});
