/**
 * @jest-environment jsdom
 */

import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import type { AnnouncementItem } from './AnnouncementBanner';
import ParentHub from './ParentHub';

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 400,
    json: async () => body,
  } as unknown as Response;
}

function announcement(overrides: Partial<AnnouncementItem> = {}): AnnouncementItem {
  return {
    announcement_id: 'ann_1',
    message: 'Gym closed Monday for the holiday.',
    author_name: 'Coach J.',
    author_role: 'coach',
    created_at: '2026-07-30T12:00:00.000Z',
    placement: 'everywhere',
    kind: 'notice',
    active: true,
    starts_at: null,
    ends_at: null,
    ...overrides,
  };
}

function installFetch(
  announcements: () => Promise<Response> = async () => jsonResponse({ ok: true, announcements: [] }),
  safety: () => Promise<Response> = async () => jsonResponse({ ok: true, items: [] }),
  barrierReport: (init?: RequestInit) => Promise<Response> = async () => jsonResponse({ ok: true, note_id: 'note-1' }),
): jest.Mock {
  const fetchMock = jest.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);

    if (url.includes('/api/pilot/auth/session')) {
      return jsonResponse({ authenticated: true, account_id: 'acct_parent_1' });
    }
    if (url.includes('/api/pilot/athletes/list')) {
      return jsonResponse({
        items: [
          { athlete_id: 'ath_1', full_name: 'First Child' },
          { athlete_id: 'ath_2', full_name: 'Second Child' },
        ],
      });
    }
    if (url.includes('/api/pilot/announcements/get')) {
      return announcements();
    }
    if (url.includes('/api/pilot/parent/safety')) {
      return safety();
    }
    if (url.includes('/api/pilot/parent/barrier-report')) {
      return barrierReport(init);
    }

    throw new Error(`Unexpected fetch: ${url}`);
  });

  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('parent hub child selector', () => {
  test('switching child does not refetch the roster or re-show the loading spinner', async () => {
    const fetchMock = installFetch();
    await act(async () => {
      render(<ParentHub />);
    });

    const rosterCalls = () =>
      fetchMock.mock.calls.filter((call) => String(call[0]).includes('/api/pilot/athletes/list')).length;
    expect(rosterCalls()).toBe(1);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Second Child' }));
    });

    // The roster is the same list either way; refetching it made every child
    // switch flash the spinner and blank the selector.
    expect(rosterCalls()).toBe(1);
    expect(screen.queryByText(/Loading your children/i)).toBeNull();
    expect(screen.queryByRole('button', { name: 'First Child' })).not.toBeNull();
  });

  test('the first child is selected by default and switching moves the overview to the other child', async () => {
    installFetch();
    await act(async () => {
      render(<ParentHub />);
    });

    expect(screen.queryByText('First Child', { selector: 'p' })).not.toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Second Child' }));
    });

    expect(screen.queryByText('Second Child', { selector: 'p' })).not.toBeNull();
    expect(screen.queryByText('First Child', { selector: 'p' })).toBeNull();
  });
});

// The placement vocabulary has no parent surface, so 'everywhere' is the only
// thing this hub can honestly ask for. Asking for anything else would be a
// placement no author can choose and no migration defines.
describe('authored announcements on the parent hub', () => {
  function announcementRequests(fetchMock: jest.Mock): Array<Record<string, unknown>> {
    return fetchMock.mock.calls
      .filter((call) => String(call[0]).includes('/api/pilot/announcements/get'))
      .map((call) => JSON.parse(String((call[1] as RequestInit | undefined)?.body ?? '{}')) as Record<string, unknown>);
  }

  test('the hub asks only for gym-wide items', async () => {
    const fetchMock = installFetch();
    await act(async () => {
      render(<ParentHub />);
    });

    const requests = announcementRequests(fetchMock);
    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests) {
      expect(request.placement).toBe('everywhere');
    }
    expect(requests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'notice' }),
        expect.objectContaining({ kind: 'motivation' }),
      ]),
    );
  });

  test('a live gym-wide notice reaches the parent', async () => {
    installFetch(async () => jsonResponse({ ok: true, announcements: [announcement()] }));
    await act(async () => {
      render(<ParentHub />);
    });

    expect(screen.queryByText('Gym closed Monday for the holiday.')).not.toBeNull();
  });

  test('nothing live leaves no heading and no empty box behind', async () => {
    installFetch();
    await act(async () => {
      render(<ParentHub />);
    });

    expect(screen.queryByText('Gym Notices')).toBeNull();
    expect(screen.queryByText('From the Gym')).toBeNull();
  });

  test('a failed announcements read leaves the rest of the hub working', async () => {
    installFetch(async () => {
      throw new Error('announcements offline');
    });
    await act(async () => {
      render(<ParentHub />);
    });

    expect(screen.queryByText('Gym Notices')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Second Child' })).not.toBeNull();
  });
});

// Capabilities #93/#167: the hub previously never linked to /parent/safety
// or /parent/consent (both already built, #84/T-008) even though those
// pages link back to it -- a pure aggregation gap, no new schema.
describe('Safety & Consent card on the parent hub', () => {
  test('links to both surfaces are always present', async () => {
    installFetch();
    await act(async () => {
      render(<ParentHub />);
    });

    expect(screen.getByRole('link', { name: 'View Safety Status' })).toHaveAttribute('href', '/parent/safety');
    expect(screen.getByRole('link', { name: 'Manage Consent' })).toHaveAttribute('href', '/parent/consent');
  });

  test('nothing to flag reads as a plain, non-alarming prompt', async () => {
    installFetch(undefined, async () => jsonResponse({ ok: true, items: [{ athlete_id: 'ath_1', hold: null, gates: [] }] }));
    await act(async () => {
      render(<ParentHub />);
    });

    expect(screen.getByText(/Check your child.s active training-hold and safety-gate status/)).toBeDefined();
    expect(screen.queryByText(/active training hold/)).toBeNull();
  });

  test('an active hold and a flagged gate are summarized without staff detail', async () => {
    installFetch(
      undefined,
      async () =>
        jsonResponse({
          ok: true,
          items: [
            {
              athlete_id: 'ath_1',
              hold: { scope: 'full', athlete_explanation: 'Taking a short break.', lift_condition_text: '', placed_at: '2026-08-01T00:00:00Z', expires_at: null },
              gates: [{ gate_key: 'contact_medical_clearance', name: 'Contact Requires Medical Clearance', category: 'medical', outcome: 'flagged', evaluated_at: '2026-08-01T00:00:00Z' }],
            },
          ],
        }),
    );
    await act(async () => {
      render(<ParentHub />);
    });

    expect(screen.getByText(/1 active training hold\(s\) and 1 gate\(s\) awaiting clearance/)).toBeDefined();
    expect(screen.getByText(/This is not a punishment/)).toBeDefined();
    // Never staff detail -- reason_text/reason_category never leave the server.
    expect(screen.queryByText('Taking a short break.')).toBeNull();
  });

  test('a failed safety read leaves the rest of the hub working, card falls back to plain links', async () => {
    installFetch(undefined, async () => {
      throw new Error('safety summary offline');
    });
    await act(async () => {
      render(<ParentHub />);
    });

    expect(screen.getByRole('link', { name: 'View Safety Status' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Second Child' })).not.toBeNull();
  });
});

// Capabilities #95/#96: no parent-facing write path existed for a
// guardian-reported home or transportation barrier -- this is the new one,
// on the Parent Floor tab.
describe('Report a Barrier (#95/#96)', () => {
  async function openParentFloor() {
    await act(async () => {
      render(<ParentHub />);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Parent Floor' }));
    });
  }

  test('defaults to Home and posts athleteId/barrierType/description', async () => {
    const fetchMock = installFetch();
    await openParentFloor();

    fireEvent.change(screen.getByLabelText("What's going on"), { target: { value: 'No ride most weeknights.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send to Coach' }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => String(c[0]).includes('/api/pilot/parent/barrier-report'));
      expect(call).toBeDefined();
    });

    const call = fetchMock.mock.calls.find((c) => String(c[0]).includes('/api/pilot/parent/barrier-report'));
    const body = JSON.parse(String((call?.[1] as RequestInit).body));
    expect(body).toEqual({ athleteId: 'ath_1', barrierType: 'home', description: 'No ride most weeknights.' });

    await screen.findByText("Sent to your child's coach.");
  });

  test('switching to Transportation changes the posted barrierType', async () => {
    const fetchMock = installFetch();
    await openParentFloor();

    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'transportation' } });
    fireEvent.change(screen.getByLabelText("What's going on"), { target: { value: 'Car broke down.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send to Coach' }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => String(c[0]).includes('/api/pilot/parent/barrier-report'));
      expect(call).toBeDefined();
    });

    const call = fetchMock.mock.calls.find((c) => String(c[0]).includes('/api/pilot/parent/barrier-report'));
    const body = JSON.parse(String((call?.[1] as RequestInit).body));
    expect(body.barrierType).toBe('transportation');
  });

  test('the description clears after a successful send', async () => {
    installFetch();
    await openParentFloor();

    const textarea = screen.getByLabelText("What's going on") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'Something.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send to Coach' }));

    await waitFor(() => expect(textarea.value).toBe(''));
  });

  test('an empty description does not submit', async () => {
    const fetchMock = installFetch();
    await openParentFloor();

    fireEvent.click(screen.getByRole('button', { name: 'Send to Coach' }));

    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/api/pilot/parent/barrier-report'))).toBe(false);
  });

  test('a failed send shows the error, not a false success message', async () => {
    installFetch(undefined, undefined, async () => jsonResponse({ error: 'Forbidden' }, false));
    await openParentFloor();

    fireEvent.change(screen.getByLabelText("What's going on"), { target: { value: 'Something.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send to Coach' }));

    await screen.findByText('Forbidden');
    expect(screen.queryByText("Sent to your child's coach.")).toBeNull();
  });
});
