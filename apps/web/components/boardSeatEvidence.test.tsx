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
  // The register counts; it does not quote. A notice body is free text a coach
  // typed -- the write path trims it and rejects empty, and checks nothing else
  // -- and the author is a named individual. Both used to render verbatim on a
  // page that says three sections higher that board access is
  // "organization-level and aggregate-only".
  const NOTICES = [
    {
      announcement_id: 'a1',
      message: 'Congratulations to Maya R. on her first bout.',
      author_name: 'Coach Jason',
      author_role: 'coach',
      created_at: '2026-07-30T12:00:00.000Z',
    },
    {
      announcement_id: 'a2',
      message: 'Gym closed Monday for the holiday.',
      author_name: 'Dana Whitfield',
      author_role: 'admin',
      created_at: '2026-07-28T12:00:00.000Z',
    },
    {
      announcement_id: 'a3',
      message: 'Sparring moved to the back room.',
      author_name: 'Coach Jason',
      author_role: 'coach',
      created_at: '2026-07-26T12:00:00.000Z',
    },
  ];

  function mockNotices() {
    const fetchMock = jest.fn(async (_url: string, init?: RequestInit) => {
      if (typeof init?.body === 'string') {
        expect(JSON.parse(init.body)).toMatchObject({ view: 'authoring', limit: 25 });
      }
      return jsonResponse({ ok: true, announcements: NOTICES });
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    return fetchMock;
  }

  test('counts notices by author role, and is not claimed to be minutes', async () => {
    mockNotices();

    render(<BoardSeatEvidence seat="secretary" />);

    expect(await screen.findByText('Notices Published')).toBeTruthy();
    expect(screen.getByText('Published By coach')).toBeTruthy();
    expect(screen.getByText('Published By admin')).toBeTruthy();
    // Three notices: two from a coach, one from an admin.
    expect(screen.getAllByText('2')).toHaveLength(1);
    expect(screen.getAllByText('3')).toHaveLength(1);
    expect(screen.getByText(/it is notices, not minutes/i)).toBeTruthy();
  });

  test('no notice body and no author name reaches the board page', async () => {
    // The mutation this catches is the obvious one: somebody putting the list
    // back because a count is less useful than the text. On this surface that
    // is the whole point -- the aggregate boundary is the feature.
    mockNotices();

    render(<BoardSeatEvidence seat="secretary" />);
    await screen.findByText('Notices Published');

    for (const notice of NOTICES) {
      expect(screen.queryByText(notice.message)).toBeNull();
      expect(screen.queryByText(new RegExp(notice.author_name))).toBeNull();
    }
    expect(document.body.textContent).not.toMatch(/Maya|Jason|Dana/);
  });

  test('the cadence is stated from the records read, not asserted', async () => {
    mockNotices();

    render(<BoardSeatEvidence seat="secretary" />);

    // Earliest and latest of the three, so a board reads the span the count
    // covers rather than assuming it is current.
    expect(await screen.findByText(/7\/26\/2026 to 7\/30\/2026/)).toBeTruthy();
    expect(screen.getByText(/reads the 25 most recent notices/i)).toBeTruthy();
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
