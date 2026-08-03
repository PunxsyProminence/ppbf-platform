/**
 * @jest-environment jsdom
 */

// Two seats hold real records; six hold none. The tests that matter are the
// ones proving this stays true of both groups -- a panel that appeared empty
// for the six would imply a register exists and happens to be empty, and on a
// safeguarding surface an empty register and a failed read must never look the
// same.

import { render, screen, waitFor } from '@testing-library/react';

import BoardSeatEvidence from './BoardSeatEvidence';

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 403, json: async () => body } as Response;
}

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  jest.restoreAllMocks();
});

function mockFetch(impl: (url: string) => Promise<Response>): jest.Mock {
  const fetchMock = jest.fn((url: string) => impl(url));
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

describe('seats with no records of their own', () => {
  test.each(['president', 'chair', 'vice-chair', 'treasurer', 'community-director', 'at-large'] as const)(
    '%s renders nothing and asks the server for nothing',
    async (seat) => {
      const fetchMock = mockFetch(async () => jsonResponse({}));

      const { container } = render(<BoardSeatEvidence seat={seat} />);

      expect(container.textContent).toBe('');
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});

describe('the safety director sees the written standard', () => {
  test('rules render worst-severity first and are labelled as policy, not enforcement', async () => {
    mockFetch(async () => jsonResponse({
      ok: true,
      rules: [
        { rule_id: 'r2', rule_name: 'Code of Conduct', rule_category: 'behavioral', severity: 'medium', escalation_level: 'coach' },
        { rule_id: 'r1', rule_name: 'Physical Injury Prevention', rule_category: 'safety', severity: 'critical', escalation_level: 'admin' },
      ],
    }));

    render(<BoardSeatEvidence seat="safety-director" />);

    expect(await screen.findByText('Physical Injury Prevention')).toBeTruthy();
    const names = screen.getAllByText(/Physical Injury Prevention|Code of Conduct/).map((n) => n.textContent);
    expect(names[0]).toBe('Physical Injury Prevention');

    // The distinction a director must not miss: these are commitments, not
    // measurements. Nothing evaluates them automatically.
    expect(screen.getByText(/Nothing evaluates them automatically/)).toBeTruthy();
  });

  test('a gym with no rules says so, rather than rendering an empty list', async () => {
    mockFetch(async () => jsonResponse({ ok: true, rules: [] }));

    render(<BoardSeatEvidence seat="safety-director" />);

    expect(await screen.findByText(/no active compliance rules/i)).toBeTruthy();
  });
});

describe('the secretary sees the communications register', () => {
  test('notices render with their author, and are not claimed to be minutes', async () => {
    const fetchMock = jest.fn(async (_url: string, init?: RequestInit) => {
      if (typeof init?.body === 'string') {
        expect(JSON.parse(init.body)).toMatchObject({ view: 'authoring', limit: 25 });
      }
      return jsonResponse({
        ok: true,
        announcements: [
          {
            announcement_id: 'a1',
            message: 'Gym closed Monday for the holiday.',
            author_name: 'Coach Jason',
            author_role: 'coach',
            created_at: '2026-07-30T12:00:00.000Z',
          },
        ],
      });
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<BoardSeatEvidence seat="secretary" />);

    expect(await screen.findByText('Gym closed Monday for the holiday.')).toBeTruthy();
    expect(screen.getByText(/Coach Jason/)).toBeTruthy();
    expect(screen.getByText(/it is notices, not minutes/i)).toBeTruthy();
  });

  test('requests the authoring view rather than only live notices', async () => {
    const fetchMock = jest.fn(async (_url: string, init?: RequestInit) => {
      if (typeof init?.body === 'string') {
        expect(JSON.parse(init.body)).toMatchObject({ view: 'authoring', limit: 25 });
      }
      return jsonResponse({ ok: true, announcements: [] });
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<BoardSeatEvidence seat="secretary" />);

    expect(await screen.findByText(/No notices have been published/i)).toBeTruthy();
  });
});

describe('a failed read never passes for an empty register', () => {
  test.each(['safety-director', 'secretary'] as const)('%s says the read failed', async (seat) => {
    mockFetch(async () => jsonResponse({ error: 'Forbidden' }, false));

    render(<BoardSeatEvidence seat={seat} />);

    expect(await screen.findByText(/could not be read/i)).toBeTruthy();
    expect(screen.getByText(/not an empty register/i)).toBeTruthy();
  });

  test('a thrown request is reported the same way', async () => {
    mockFetch(async () => { throw new Error('offline'); });

    render(<BoardSeatEvidence seat="secretary" />);

    await waitFor(() => expect(screen.getByText(/could not be read/i)).toBeTruthy());
  });
});
