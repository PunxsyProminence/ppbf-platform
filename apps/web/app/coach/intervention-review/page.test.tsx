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
      source_admissible: true,
    },
    // A pre-gate film-study link whose proposal is not accepted: the API
    // annotates it and the page must stamp it, not hide it.
    {
      link_id: 'l-2', evidence_role: 'immediate_post', source_kind: 'film_study',
      source_id: 'prop-7', note: '', status: 'active', removed_reason: '',
      source_admissible: false,
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

  // The inadmissible film-study row is stamped in refusal ink, and STILL
  // rendered -- annotation, never a hidden row; the admissible row wears no
  // such stamp.
  const stamp = screen.getByText('inadmissible — no accepted proposal');
  expect(stamp.className).toContain('badge--locked');
  expect(screen.getByText(/film study prop-7/)).toBeTruthy();
  expect(screen.getByText(/training attempt att-9/)).toBeTruthy();
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

// Lane N3-02: unlinking evidence. The stand-in below answers the way the
// route does -- a removal stamps the link and the next GET returns it stamped
// -- so "what the coach sees next" is read off a reload, not off the click.

type ChainFixture = Omit<typeof CHAIN_ITEM, 'evidence'> & { evidence: Array<(typeof CHAIN_ITEM)['evidence'][number]> };

function unlinkServer(options: { refuse?: { status: number; error?: string }; start?: ChainFixture } = {}) {
  const patches: Array<Record<string, unknown>> = [];
  let current: ChainFixture = options.start ?? CHAIN_ITEM;
  const fetchMock = jest.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'PATCH') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      patches.push(body);
      if (options.refuse) {
        const { status, error } = options.refuse;
        return { ok: false, status, json: async () => (error ? { error } : {}) } as Response;
      }
      current = {
        ...current,
        evidence: current.evidence.map((link) => (link.link_id === body.link_id
          ? { ...link, status: 'removed', removed_reason: String(body.removed_reason) }
          : link)),
      };
      return { ok: true, json: async () => ({ item: {} }) } as Response;
    }
    return { ok: true, json: async () => ({ items: [current] }) } as Response;
  }) as unknown as typeof fetch;
  return { fetchMock, patches };
}

async function openPage(): Promise<void> {
  await act(async () => {
    render(<InterventionReviewPage />);
  });
  await screen.findByText('Decision');
}

async function click(name: string, index = 0): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getAllByRole('button', { name })[index]);
  });
}

async function typeReason(value: string): Promise<void> {
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Why does this no longer count? (required)'), { target: { value } });
  });
}

describe('unlinking evidence', () => {
  test('each active link can be removed; a link is not removed without a reason, and nothing is sent', async () => {
    const server = unlinkServer();
    global.fetch = server.fetchMock;
    await openPage();

    expect(screen.getAllByRole('button', { name: 'Remove link' })).toHaveLength(2);

    await click('Remove link');
    await click('Remove it');
    expect(server.patches).toHaveLength(0);
    expect(screen.getByRole('alert').textContent).toContain('Say why this link no longer counts before removing it.');

    await typeReason('   ');
    await click('Remove it');
    expect(server.patches).toHaveLength(0);
  });

  test('removing sends the link and the reason, and the reloaded row is stamped removed with no control left on it', async () => {
    const server = unlinkServer();
    global.fetch = server.fetchMock;
    await openPage();

    await click('Remove link');
    await typeReason("  that was another athlete's round  ");
    await click('Remove it');

    expect(server.patches).toEqual([
      { action: 'remove_evidence', link_id: 'l-1', removed_reason: "that was another athlete's round" },
    ]);
    // The row is still on the record, saying why it no longer counts...
    expect(screen.getByText(/training attempt att-9/).textContent)
      .toContain("(removed: that was another athlete's round)");
    // ...the form is gone, and only the other link can still be removed.
    expect(screen.queryByRole('button', { name: 'Remove it' })).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Remove link' })).toHaveLength(1);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('a link that arrives already removed shows its reason and offers nothing', async () => {
    const [first, second] = CHAIN_ITEM.evidence;
    const server = unlinkServer({
      start: { ...CHAIN_ITEM, evidence: [{ ...first, status: 'removed', removed_reason: 'linked twice' }, second] },
    });
    global.fetch = server.fetchMock;
    await openPage();

    expect(screen.getByText(/training attempt att-9/).textContent).toContain('(removed: linked twice)');
    expect(screen.getAllByRole('button', { name: 'Remove link' })).toHaveLength(1);
  });

  test('a link whose source is inadmissible keeps its stamp, and can be removed like any other', async () => {
    const server = unlinkServer();
    global.fetch = server.fetchMock;
    await openPage();

    // The second active link is the film-study one with no accepted proposal.
    await click('Remove link', 1);
    await typeReason('proposal was never accepted');
    await click('Remove it');

    expect(server.patches).toEqual([
      { action: 'remove_evidence', link_id: 'l-2', removed_reason: 'proposal was never accepted' },
    ]);
    const row = screen.getByText(/film study prop-7/);
    expect(row.textContent).toContain('inadmissible — no accepted proposal');
    expect(row.textContent).toContain('(removed: proposal was never accepted)');
  });

  test.each<[number, string | undefined, string]>([
    [403, 'Forbidden: coach is not assigned to athlete', 'Forbidden: coach is not assigned to athlete'],
    [404, undefined, 'Unable to remove the link. (404)'],
  ])('a removal the server refuses (%i) says so and leaves the link as it was', async (status, error, shown) => {
    const server = unlinkServer({ refuse: { status, error } });
    global.fetch = server.fetchMock;
    await openPage();

    await click('Remove link');
    await typeReason('not mine to remove');
    await click('Remove it');

    expect(server.patches).toHaveLength(1);
    expect(screen.getByRole('alert').textContent).toContain(shown);
    expect(screen.getByRole('alert').textContent).toContain('Failed');
    expect(screen.getByText(/training attempt att-9/).textContent).not.toContain('(removed');
    // Still open with what was typed, so nothing has to be re-entered.
    expect((screen.getByLabelText('Why does this no longer count? (required)') as HTMLInputElement).value)
      .toBe('not mine to remove');
  });

  test('a removal that is saved while the reload fails is shown as saved: form closed and the link stamped removed', async () => {
    const patches: unknown[] = [];
    let saved = false;
    global.fetch = jest.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PATCH') {
        patches.push(JSON.parse(String(init.body)));
        saved = true;
        return { ok: true, json: async () => ({ item: {} }) } as Response;
      }
      if (saved) return { ok: false, status: 500, json: async () => ({}) } as Response;
      return { ok: true, json: async () => ({ items: [CHAIN_ITEM] }) } as Response;
    }) as unknown as typeof fetch;
    await openPage();

    await click('Remove link');
    await typeReason('linked the wrong attempt');
    await click('Remove it');

    expect(patches).toHaveLength(1);
    const alert = screen.getByRole('alert').textContent ?? '';
    expect(alert).toContain('Saved');
    expect(alert).toContain('The list could not be refreshed. Reload the page to see the latest.');
    expect(alert).not.toContain('Failed');
    // No open form inviting a second removal, which the server would answer 404...
    expect(screen.queryByRole('button', { name: 'Remove it' })).toBeNull();
    // ...and the link reads as the server left it, though the reload never came back.
    expect(screen.getByText(/training attempt att-9/).textContent).toContain('(removed: linked the wrong attempt)');
    expect(screen.getAllByRole('button', { name: 'Remove link' })).toHaveLength(1);
    // The other link is untouched.
    expect(screen.getByText(/film study prop-7/).textContent).not.toContain('(removed');
  });

  test('linking evidence shares that handling: saved while the reload fails closes the form and says saved', async () => {
    let saved = false;
    global.fetch = jest.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        saved = true;
        return { ok: true, json: async () => ({ item: {} }) } as Response;
      }
      if (saved) return { ok: false, status: 500, json: async () => ({}) } as Response;
      return { ok: true, json: async () => ({ items: [CHAIN_ITEM] }) } as Response;
    }) as unknown as typeof fetch;
    await openPage();

    await click('Link evidence');
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Source record id'), { target: { value: 'att-12' } });
    });
    await click('Link it');

    expect(screen.getByRole('alert').textContent).toContain('Saved');
    expect(screen.queryByRole('button', { name: 'Link it' })).toBeNull();
  });

  test('Cancel closes the form and sends nothing', async () => {
    const server = unlinkServer();
    global.fetch = server.fetchMock;
    await openPage();

    await click('Remove link');
    await typeReason('changed my mind');
    await click('Cancel');

    expect(server.patches).toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'Remove it' })).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Remove link' })).toHaveLength(2);

    // Reopened, the reason typed before is not waiting to be sent by accident.
    await click('Remove link');
    expect((screen.getByLabelText('Why does this no longer count? (required)') as HTMLInputElement).value).toBe('');
  });

  test('an execution with no evidence says so and offers nothing to remove', async () => {
    const server = unlinkServer({ start: { ...CHAIN_ITEM, evidence: [] } });
    global.fetch = server.fetchMock;
    await openPage();

    expect(screen.getByText('No evidence linked yet.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Remove link' })).toBeNull();
  });
});

// Issue #1481 (Jason, 2026-10-12: "6B"): a reopened record shows no standing
// verdict, and its earlier verdict appears as history, labelled as retired
// when the record was reopened. Plain text: no alert, no warning.
test('a reopened record shows no standing verdict and its earlier verdicts as history', async () => {
  const reopened = {
    ...CHAIN_ITEM,
    execution: { ...CHAIN_ITEM.execution, status: 'in_progress' },
    review: null,
    review_history: [
      {
        review_id: 'rev-2', performance_result: 'improved', performance_notes: 'held through four rounds',
        hypothesis_result: 'supported', learning_signal: 'prior_belief_strengthened', learning_notes: '',
        retired_on_reopen: true, retired_at: '2026-10-12T15:00:00.000Z', reviewed_at: '2026-10-10T15:00:00.000Z',
      },
      {
        review_id: 'rev-1', performance_result: 'unchanged', performance_notes: 'too early to tell',
        hypothesis_result: 'unresolved', learning_signal: 'unresolved', learning_notes: '',
        retired_on_reopen: false, retired_at: '2026-10-10T15:00:00.000Z', reviewed_at: '2026-10-08T15:00:00.000Z',
      },
    ],
  };
  global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ items: [reopened] }) }) as Response) as unknown as typeof fetch;

  await act(async () => {
    render(<InterventionReviewPage />);
  });

  expect(await screen.findByText('Not yet reviewed by a human.')).toBeTruthy();
  expect(screen.getByText('Earlier verdicts')).toBeTruthy();
  const items = screen.getAllByRole('listitem').map((li) => li.textContent ?? '');
  const retired = items.filter((text) => text.includes('held through four rounds')).pop();
  const replaced = items.filter((text) => text.includes('too early to tell')).pop();
  expect(retired).toMatch(/^Retired when the record was reopened, October 12, 2026: improved/);
  expect(replaced).toMatch(/^Replaced by a later review, October 10, 2026: unchanged/);
  expect(screen.queryByRole('alert')).toBeNull();
});

test('a record with no history shows no "Earlier verdicts" section', async () => {
  global.fetch = mockFetch({ posts: [] });
  await act(async () => {
    render(<InterventionReviewPage />);
  });
  await screen.findByText('Decision');
  expect(screen.queryByText('Earlier verdicts')).toBeNull();
});
