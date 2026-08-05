/**
 * @jest-environment jsdom
 */

/**
 * The coach's half of the non-fight path.
 *
 * Two thirds of the catalogue is coach-marked, so without this panel a
 * "complete progression for everyone" would be a promise the platform could not
 * keep. What is pinned here is that marking somebody does not turn the coach's
 * screen into the ranking the athlete's screen refuses to be, and that a
 * milestone cannot be taken back off somebody.
 */

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import CoachMilestoneMarker from './CoachMilestoneMarker';

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as unknown as Response;
}

const ROSTER = [
  { athlete_id: 'ath_1', full_name: 'Ada Rivera' },
  { athlete_id: 'ath_2', full_name: 'Marcus Bell' },
];

let calls: Array<{ url: string; method: string; body: Record<string, unknown> }> = [];
let program = 'fitness';
let awards: Array<{ milestone_key: string; awarded_at: string }> = [];

beforeEach(() => {
  calls = [];
  program = 'fitness';
  awards = [];

  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    calls.push({ url, method, body });

    if (url.includes('/achievements/milestones')) {
      if (method === 'GET') {
        return jsonResponse({ ok: true, program, completed_sessions: 6, items: awards });
      }
      return jsonResponse({ ok: true });
    }
    return jsonResponse({});
  }) as unknown as typeof fetch;
});

async function pick(name: string) {
  render(<CoachMilestoneMarker roster={ROSTER} />);
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Who'), {
      target: { value: ROSTER.find((a) => a.full_name === name)!.athlete_id },
    });
  });
  await waitFor(() => {
    expect(calls.some((call) => call.method === 'GET')).toBe(true);
  });
}

it('marks a milestone in one tap once an athlete is picked', async () => {
  await pick('Ada Rivera');

  await act(async () => {
    fireEvent.click(await screen.findByRole('button', { name: 'A full round without stopping' }));
  });

  const posted = calls.find((call) => call.method === 'POST');
  expect(posted?.body).toEqual({
    athlete_id: 'ath_1',
    milestone_key: 'conditioning.first_full_round',
  });
  // The role is decided server-side from who is signed in -- an athlete cannot
  // claim a coach witnessed something, and a coach cannot post as an athlete.
  expect(posted?.body).not.toHaveProperty('awarded_by_role');
});

it('offers no way to take one back', async () => {
  awards = [{ milestone_key: 'conditioning.first_full_round', awarded_at: '2026-05-01' }];
  await pick('Ada Rivera');

  await waitFor(() => {
    expect(screen.getAllByText(/already has/i).length).toBeGreaterThan(0);
  });
  // A milestone that can be withdrawn is a milestone that can be used as a
  // threat, so there is no control for it and no DELETE behind one.
  for (const label of [/unmark/i, /remove/i, /undo/i, /revoke/i, /take back/i, /delete/i]) {
    expect(screen.queryByRole('button', { name: label })).toBeNull();
  }
});

it('shows what somebody already has as names, never as a total', async () => {
  awards = [
    { milestone_key: 'conditioning.first_full_round', awarded_at: '2026-05-01' },
    { milestone_key: 'conditioning.mile_unbroken', awarded_at: '2026-05-08' },
  ];
  const { container } = render(<CoachMilestoneMarker roster={ROSTER} />);
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Who'), { target: { value: 'ath_1' } });
  });

  const engine = await waitFor(() => {
    const found = screen.getAllByText(/already has/i)
      .find((node) => node.textContent?.includes('A full round without stopping'));
    expect(found).toBeTruthy();
    return found!;
  });

  expect(engine.textContent).toContain('Ran a mile without stopping');

  // A per-athlete TOTAL is the one figure on a coach's screen that could be
  // held up against another athlete's, so there is none anywhere on the panel.
  // (Numbers inside a milestone's own name -- "5 sessions logged" -- are the
  // name of a thing, not a tally of things.)
  expect(container.textContent).not.toMatch(/\d+\s+of\s+\d+/);
  expect(container.textContent).not.toMatch(/\b\d+\s+(earned|milestones?|awards?|total)/i);
});

it('never shows a fitness member a competition rung a coach could mark', async () => {
  const { container } = render(<CoachMilestoneMarker roster={ROSTER} />);
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Who'), { target: { value: 'ath_1' } });
  });
  await waitFor(() => {
    expect(screen.getByRole('button', { name: 'A full round without stopping' })).toBeTruthy();
  });

  expect(container.textContent).not.toContain('First bout');
  expect(container.textContent).not.toContain('First round of sparring');
  expect(screen.queryByText('Competition')).toBeNull();
});

it('offers no button beside a milestone the ledger awards on its own', async () => {
  await pick('Ada Rivera');
  await screen.findByRole('button', { name: 'A full round without stopping' });

  // Session-count milestones land when the count lands. A button beside one
  // would imply a coach can grant attendance.
  for (const label of ['5 sessions logged', '13 sessions logged', 'Walked in']) {
    expect(screen.queryByRole('button', { name: label })).toBeNull();
  }
});

it('shows a competitive athlete the competition track too', async () => {
  program = 'competitive';
  await pick('Marcus Bell');

  expect(await screen.findByRole('button', { name: 'First round of sparring' })).toBeTruthy();
  expect(screen.getByText('Competition')).toBeTruthy();
});

it('shows one athlete at a time and never two side by side', async () => {
  await pick('Ada Rivera');
  await screen.findByRole('button', { name: 'A full round without stopping' });

  // Every read is for the athlete currently picked. There is no request shape
  // here that returns two athletes' records, so there is nothing to line up.
  const reads = calls.filter((call) => call.method === 'GET');
  expect(reads).toHaveLength(1);
  expect(reads[0].url).toContain('athlete_id=ath_1');
});
