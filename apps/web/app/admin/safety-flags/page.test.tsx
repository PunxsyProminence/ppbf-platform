/**
 * @jest-environment jsdom
 */

// The safety-flags board (register module 170): the first consumer of the
// open-flag queue. What these pin: worst-first ordering with severity
// counts; a resolution never leaves without a note; the client never offers
// 'bypassed' on an external-rule flag (mirroring the server's refusal); a
// failed read admits flags may exist; an empty healthy read says a flag
// would appear here.

import { act, fireEvent, render, screen } from '@testing-library/react';

import SafetyFlagsBoardPage from './page';

jest.mock('@/components/RoleSessionGate', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

function flag(overrides: Record<string, unknown> = {}) {
  return {
    flag_id: 'flag-1',
    athlete_id: 'ath-1',
    flag_class: 'system_guidance',
    flag_code: 'overtraining_pattern',
    severity: 'attention',
    triggered_by: 'human_entry',
    trigger_detail: 'Three RED readiness days in a row.',
    evidence_basis: '',
    created_at: '2026-08-15T12:00:00.000Z',
    ...overrides,
  };
}

function mockFetch(options: {
  flags?: unknown[];
  ok?: boolean;
  capture?: { patches: unknown[] };
}) {
  return jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'PATCH') {
      options.capture?.patches.push(JSON.parse(String(init.body)));
      return { ok: true, json: async () => ({ flag: {} }) } as Response;
    }
    return {
      ok: options.ok ?? true,
      status: options.ok === false ? 500 : 200,
      json: async () => ({ flags: options.flags ?? [] }),
    } as Response;
  }) as unknown as typeof fetch;
}

afterEach(() => {
  jest.restoreAllMocks();
});

test('open flags render worst first with severity counts', async () => {
  global.fetch = mockFetch({
    flags: [
      flag({ flag_id: 'f-adv', severity: 'advisory', flag_code: 'minor_note' }),
      flag({ flag_id: 'f-block', severity: 'blocking_display', flag_code: 'no_contact_hold' }),
    ],
  });

  await act(async () => {
    render(<SafetyFlagsBoardPage />);
  });

  const codes = screen.getAllByText(/no_contact_hold|minor_note/).map((el) => el.textContent);
  expect(codes[0]).toBe('no_contact_hold');
  // 'blocking' appears both as the count tile's label and the card badge.
  expect(screen.getAllByText('blocking').length).toBeGreaterThan(0);
});

test('a resolution never leaves without a note', async () => {
  const capture = { patches: [] as unknown[] };
  global.fetch = mockFetch({ flags: [flag()], capture });

  await act(async () => {
    render(<SafetyFlagsBoardPage />);
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Resolve…' }));
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Resolve flag' }));
  });

  expect(capture.patches).toHaveLength(0);
  expect(screen.getByText(/A note is required on every resolution/)).toBeTruthy();

  await act(async () => {
    fireEvent.change(screen.getByLabelText('Note (required)'), { target: { value: 'Spoke with the athlete; plan adjusted.' } });
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Resolve flag' }));
  });

  expect(capture.patches).toEqual([{
    flag_id: 'flag-1',
    status: 'acknowledged',
    resolution: 'acted_on',
    coach_note: 'Spoke with the athlete; plan adjusted.',
  }]);
});

test("the client never offers 'bypassed' on an external-rule flag", async () => {
  global.fetch = mockFetch({ flags: [flag({ flag_class: 'external_rule' })] });

  await act(async () => {
    render(<SafetyFlagsBoardPage />);
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Resolve…' }));
  });

  const options = Array.from((screen.getByLabelText('Outcome') as HTMLSelectElement).options).map((o) => o.value);
  expect(options).toEqual(['acknowledged', 'upheld', 'withdrawn']);
});

test('a failed read admits flags may exist, never rendering as clear', async () => {
  global.fetch = mockFetch({ ok: false });

  await act(async () => {
    render(<SafetyFlagsBoardPage />);
  });

  expect(screen.getByText(/Flags may exist that are not shown here/)).toBeTruthy();
  expect(screen.queryByText('No open safety flags')).toBeNull();
});

test('an empty healthy read says a flag would appear here', async () => {
  global.fetch = mockFetch({ flags: [] });

  await act(async () => {
    render(<SafetyFlagsBoardPage />);
  });

  expect(screen.getByText('No open safety flags')).toBeTruthy();
  expect(screen.getByText(/A raised flag would appear here/)).toBeTruthy();
});
