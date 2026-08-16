/**
 * @jest-environment jsdom
 */

// What We Learned (loop-closing) page. What these pin: the full chain
// renders in order (decision, planned, actual, evidence, learned) with an
// unreviewed execution honestly labeled; recording a review posts the
// three SEPARATE answers with no score field anywhere; and counterevidence
// renders as evidence, not hidden.

import { act, fireEvent, render, screen } from '@testing-library/react';

import InterventionReviewPage from './page';

jest.mock('@/components/RoleSessionGate', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const CHAIN_ITEM = {
  execution: {
    execution_id: 'ex-1',
    athlete_name: 'Jordan P.',
    athlete_id: 'ath-1',
    protocol_title: 'Round-3 endurance block',
    protocol_id: 'p-1',
    protocol_version: 1,
    status: 'completed',
    planned_exposure: { rounds: 6 },
    actual_exposure: { rounds: 3 },
    adherence: 'under_delivered',
    deviations: 'cut to 3 rounds',
    stop_change_reason: '',
    created_at: '2026-08-16T00:00:00.000Z',
  },
  decision_text: 'run the endurance block twice weekly',
  evidence: [
    {
      link_id: 'l-1', evidence_role: 'counterevidence', source_kind: 'training_attempt',
      source_id: 'att-9', note: 'round-3 output fell again', status: 'active', removed_reason: '',
    },
  ],
  review: null,
};

function mockFetch(capture: { posts: unknown[] }) {
  return jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/intervention-review') && init?.method === 'POST') {
      capture.posts.push(JSON.parse(String(init.body)));
      return { ok: true, json: async () => ({ item: {} }) } as Response;
    }
    if (url.includes('/intervention-review')) {
      return { ok: true, json: async () => ({ items: [CHAIN_ITEM] }) } as Response;
    }
    return { ok: true, json: async () => ({ items: [] }) } as Response;
  }) as unknown as typeof fetch;
}

afterEach(() => {
  jest.restoreAllMocks();
});

test('the chain renders in order with counterevidence visible and the unreviewed state honest', async () => {
  global.fetch = mockFetch({ posts: [] });

  await act(async () => {
    render(<InterventionReviewPage />);
  });

  expect(await screen.findByText('Decision')).toBeTruthy();
  expect(screen.getByText('run the endurance block twice weekly')).toBeTruthy();
  expect(screen.getByText(/rounds: 6/)).toBeTruthy();
  expect(screen.getByText(/rounds: 3 — adherence under delivered/)).toBeTruthy();
  expect(screen.getByText('counterevidence')).toBeTruthy();
  expect(screen.getByText(/round-3 output fell again/)).toBeTruthy();
  expect(screen.getByText('Not yet reviewed by a human.')).toBeTruthy();
});

test('recording a review posts three separate answers -- no score field exists to post', async () => {
  const capture = { posts: [] as unknown[] };
  global.fetch = mockFetch(capture);

  await act(async () => {
    render(<InterventionReviewPage />);
  });
  await act(async () => {
    fireEvent.click(await screen.findByRole('button', { name: 'Review outcome' }));
  });
  await act(async () => {
    fireEvent.change(screen.getByLabelText('What happened'), { target: { value: 'declined' } });
    fireEvent.change(screen.getByLabelText('The belief we tested'), { target: { value: 'contradicted' } });
    fireEvent.change(screen.getByLabelText('What it revealed'), { target: { value: 'intervention_non_response' } });
    fireEvent.change(screen.getByLabelText('What happened, in your words (required)'), {
      target: { value: 'output fell further despite full delivery' },
    });
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Record review' }));
  });

  expect(capture.posts).toHaveLength(1);
  const posted = capture.posts[0] as Record<string, unknown>;
  expect(posted).toMatchObject({
    action: 'review_outcome',
    execution_id: 'ex-1',
    performance_result: 'declined',
    hypothesis_result: 'contradicted',
    learning_signal: 'intervention_non_response',
    performance_notes: 'output fell further despite full delivery',
  });
  expect(posted).not.toHaveProperty('score');
  expect(posted).not.toHaveProperty('effectiveness');
  expect(posted).not.toHaveProperty('information_gain');
});

test('linking evidence posts a semantic role and typed source', async () => {
  const capture = { posts: [] as unknown[] };
  global.fetch = mockFetch(capture);

  await act(async () => {
    render(<InterventionReviewPage />);
  });
  await act(async () => {
    fireEvent.click(await screen.findByRole('button', { name: 'Link evidence' }));
  });
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Evidence role'), { target: { value: 'retention' } });
    fireEvent.change(screen.getByLabelText('Source kind'), { target: { value: 'assessment' } });
    fireEvent.change(screen.getByLabelText('Source record id'), { target: { value: 'assess-4' } });
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Link it' }));
  });

  expect(capture.posts).toHaveLength(1);
  expect(capture.posts[0]).toMatchObject({
    action: 'link_evidence',
    execution_id: 'ex-1',
    evidence_role: 'retention',
    source_kind: 'assessment',
    source_id: 'assess-4',
  });
});
