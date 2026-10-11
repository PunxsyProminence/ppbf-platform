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

// Lane N3-02: revising a protocol. The stand-in below answers the way the
// route does -- a revision supersedes the head and the next GET lists the new
// version in its place -- so what the coach sees next is read off a reload.

function revisionServer(refuse?: { status: number; error?: string }) {
  const sent: Array<{ method: string; body: Record<string, unknown> }> = [];
  let current: typeof PROTOCOL = PROTOCOL;
  const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/intervention-protocols') && init?.method) {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      sent.push({ method: init.method, body });
      if (refuse) {
        return { ok: false, status: refuse.status, json: async () => (refuse.error ? { error: refuse.error } : {}) } as Response;
      }
      if (body.action === 'revise') {
        current = {
          ...current,
          protocol_id: 'p-2',
          version: current.version + 1,
          hypothesis: String(body.hypothesis),
          intended_exposure: body.intended_exposure as typeof PROTOCOL.intended_exposure,
        };
      }
      return { ok: true, json: async () => ({ item: {} }) } as Response;
    }
    if (url.includes('/intervention-protocols')) {
      return { ok: true, json: async () => ({ items: [current] }) } as Response;
    }
    if (url.includes('/athletes/list')) {
      return { ok: true, json: async () => ({ items: [{ athlete_id: 'ath-1', full_name: 'Jordan P.' }] }) } as Response;
    }
    return { ok: true, json: async () => ({ items: [] }) } as Response;
  }) as unknown as typeof fetch;
  return { fetchMock, sent };
}

async function openRevision(server: ReturnType<typeof revisionServer>): Promise<void> {
  global.fetch = server.fetchMock;
  await act(async () => {
    render(<InterventionProtocolsPage />);
  });
  await act(async () => {
    fireEvent.click(await screen.findByRole('button', { name: 'Revise' }));
  });
}

const fieldValue = (label: string | RegExp) =>
  (screen.getByLabelText(label) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).value;

describe('revising a protocol', () => {
  test('Revise loads the whole protocol into the form, on its own athlete, as the next version', async () => {
    await openRevision(revisionServer());

    expect(screen.getByText('Revise protocol (files version 3)')).toBeTruthy();
    expect(fieldValue('Title')).toBe('Round-3 endurance block');
    expect(fieldValue(/Target problem/)).toBe('fades in round 3');
    expect(fieldValue(/Hypothesis/)).toBe('aerobic capacity limits round-3 output');
    expect(fieldValue(/Intervention —/)).toBe('constrained 3-round intervals, twice weekly');
    expect(fieldValue(/Task context/)).toBe('constrained-live');
    expect(fieldValue(/Expected outcome/)).toBe('round-3 work rate holds within 10% of round 1');
    expect(fieldValue(/What would contradict/)).toBe('output collapses identically at low RPE');
    expect(fieldValue('Rounds')).toBe('6');
    expect(fieldValue('Sessions')).toBe('2');
    expect(fieldValue('Minutes')).toBe('');

    // A revision stays in its lineage: the athlete is shown and cannot be changed.
    const athlete = screen.getByLabelText(/^Athlete/) as HTMLSelectElement;
    expect(athlete.value).toBe('ath-1');
    expect(athlete.disabled).toBe(true);
  });

  test('filing the revision sends the full re-statement against the version it replaces, and the reload shows the new one', async () => {
    const server = revisionServer();
    await openRevision(server);

    await act(async () => {
      fireEvent.change(screen.getByLabelText(/Hypothesis/), { target: { value: 'it is pacing, not conditioning' } });
      fireEvent.change(screen.getByLabelText('Rounds'), { target: { value: '4' } });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'File revision' }));
    });

    // Exactly this: a PATCH naming the protocol, every content field, and no
    // athlete -- the server keeps the lineage's own.
    expect(server.sent).toEqual([{
      method: 'PATCH',
      body: {
        action: 'revise',
        protocol_id: 'p-1',
        title: 'Round-3 endurance block',
        target_problem: 'fades in round 3',
        hypothesis: 'it is pacing, not conditioning',
        intervention_description: 'constrained 3-round intervals, twice weekly',
        intended_task_context: 'constrained-live',
        expected_outcome: 'round-3 work rate holds within 10% of round 1',
        contradicting_evidence: 'output collapses identically at low RPE',
        alternative_explanations: '',
        evaluation_plan: '',
        intended_exposure: { rounds: 4, sessions: 2 },
      },
    }]);

    expect(screen.getByText(/v3 · Jordan P\./)).toBeTruthy();
    expect(screen.getByText(/it is pacing, not conditioning/)).toBeTruthy();
    expect(screen.getByText(/rounds: 4 · sessions: 2/)).toBeTruthy();
    // The form is back to filing a new protocol, empty.
    expect(screen.getByText('File a protocol')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'File protocol' })).toBeTruthy();
    expect(fieldValue('Title')).toBe('');
    expect((screen.getByLabelText(/^Athlete/) as HTMLSelectElement).disabled).toBe(false);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test.each<[number, string | undefined, string]>([
    [403, 'Forbidden: coach is not assigned to athlete', 'Forbidden: coach is not assigned to athlete'],
    [404, undefined, 'Revision failed (404)'],
  ])('a revision the server refuses (%i) says so and leaves the protocol as it was', async (status, error, shown) => {
    const server = revisionServer({ status, error });
    await openRevision(server);

    await act(async () => {
      fireEvent.change(screen.getByLabelText(/Hypothesis/), { target: { value: 'not mine to rewrite' } });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'File revision' }));
    });

    expect(server.sent).toHaveLength(1);
    expect(screen.getByRole('alert').textContent).toContain(shown);
    expect(screen.getByText(/v2 · Jordan P\./)).toBeTruthy();
    expect(screen.getByText(/aerobic capacity limits round-3 output/)).toBeTruthy();
    // Still revising, with what was typed.
    expect(fieldValue(/Hypothesis/)).toBe('not mine to rewrite');
    expect(screen.getByRole('button', { name: 'File revision' })).toBeTruthy();
  });

  test('a non-positive exposure in a revision never leaves the page', async () => {
    const server = revisionServer();
    await openRevision(server);

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Rounds'), { target: { value: '-1' } });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'File revision' }));
    });

    expect(server.sent).toHaveLength(0);
    expect(screen.getByText(/rounds must be a positive number/)).toBeTruthy();
  });

  test('Cancel empties the form, and the next thing filed is a new protocol, not a revision', async () => {
    const server = revisionServer();
    await openRevision(server);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    });
    expect(server.sent).toHaveLength(0);
    expect(fieldValue('Title')).toBe('');
    expect(fieldValue('Rounds')).toBe('');
    expect((screen.getByLabelText(/^Athlete/) as HTMLSelectElement).value).toBe('');

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'A different protocol' } });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'File protocol' }));
    });

    expect(server.sent).toHaveLength(1);
    expect(server.sent[0].method).toBe('POST');
    expect(server.sent[0].body).not.toHaveProperty('action');
    expect(server.sent[0].body).not.toHaveProperty('protocol_id');
    expect(server.sent[0].body).toMatchObject({ title: 'A different protocol', intended_exposure: {} });
  });

  test('a retired protocol offers no Revise', async () => {
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const items = String(input).includes('/intervention-protocols') ? [{ ...PROTOCOL, status: 'retired' }] : [];
      return { ok: true, json: async () => ({ items }) } as Response;
    }) as unknown as typeof fetch;

    await act(async () => {
      render(<InterventionProtocolsPage />);
    });

    expect(await screen.findByText('retired')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Revise' })).toBeNull();
  });
});
