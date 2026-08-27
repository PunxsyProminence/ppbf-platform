/**
 * @jest-environment jsdom
 */

// Two failure modes this page shipped with, both invisible to the admin using
// it: a second click while the create request was still open wrote a second
// volunteer row, and a PATCH that matched no row still reported success.

import type { ReactNode } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import VolunteerManagementPage from './page';

jest.mock('@/components/RoleSessionGate', () => ({
  __esModule: true,
  default: ({ children }: { readonly children: ReactNode }) => children,
}));

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href }: { readonly children: ReactNode; readonly href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

function jsonResponse(body: unknown, ok = true) {
  return { ok, json: async () => body } as Response;
}

function postCalls(fetchMock: jest.Mock) {
  return fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST');
}

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  jest.clearAllMocks();
});

async function renderPage(fetchMock: jest.Mock) {
  global.fetch = fetchMock as unknown as typeof fetch;
  render(<VolunteerManagementPage />);
  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
}

it('does not send a second create while the first one is still in flight', async () => {
  let releasePost: (value: Response) => void = () => {};
  const postSettled = new Promise<Response>((resolve) => {
    releasePost = resolve;
  });

  const fetchMock = jest.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      return postSettled;
    }
    return jsonResponse({ items: [] });
  });

  await renderPage(fetchMock);

  fireEvent.change(screen.getByPlaceholderText('Full name'), { target: { value: 'Dana Ruiz' } });

  const createButton = screen.getByRole('button', { name: /create/i });
  fireEvent.click(createButton);
  fireEvent.click(createButton);

  expect(postCalls(fetchMock)).toHaveLength(1);

  await act(async () => {
    releasePost(jsonResponse({ ok: true, volunteer_id: 'vol-1' }));
    await postSettled;
  });

  await screen.findByText('Volunteer created.');
  expect(postCalls(fetchMock)).toHaveLength(1);
});

it('requires a full name before creating', async () => {
  const fetchMock = jest.fn(async () => jsonResponse({ items: [] }));

  await renderPage(fetchMock);

  fireEvent.change(screen.getByPlaceholderText('Full name'), { target: { value: '   ' } });

  const createButton = screen.getByRole('button', { name: /create/i }) as HTMLButtonElement;
  expect(createButton.disabled).toBe(true);

  fireEvent.click(createButton);
  expect(postCalls(fetchMock)).toHaveLength(0);
});

it('reports a failure when the server updated no volunteer row', async () => {
  const roster = [
    {
      volunteer_id: 'vol-1',
      full_name: 'Dana Ruiz',
      role_focus: 'General Support',
      availability: 'Weekdays',
      certification_status: 'Pending',
      background_check_status: 'Pending',
      status: 'pending',
      notes: null,
    },
  ];

  const fetchMock = jest.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'PATCH') {
      return jsonResponse({ ok: true, updated: false });
    }
    return jsonResponse({ items: roster });
  });

  await renderPage(fetchMock);

  await screen.findByText('Dana Ruiz');
  fireEvent.click(screen.getByRole('button', { name: 'active' }));

  await screen.findByText(/no longer on this roster/i);
  expect(screen.queryByText('Volunteer status updated to active.')).toBeNull();
  expect(screen.getAllByText('pending').length).toBeGreaterThan(0);
});

// READ HONESTY (shape 6: "none" indistinguishable from "not loaded" / "not
// permitted"). This roster carries background_check_status for the adults who
// work with children, so an absence on it is a safeguarding claim.
//
// GET /api/admin/volunteers throws for BOTH a failed read and a refused one
// (requireRole rejects anything outside organization_admin/admin/
// platform_owner, and an expired session fails requirePrincipal). The page's
// catch set the roster to [] while the empty state and the three stat tiles
// read straight off that []. So a read that never happened rendered as
// "No volunteers on record yet" with Active 0 / Pending 0 / Inactive 0 --
// measured-looking zeros over no measurement -- under a header that says
// "Everything on this page is kept on file".
//
// An admin checking who still owes a background check before a Saturday
// session reads "no volunteers" and stands the session up. The gym may have
// twelve volunteers and three outstanding checks.
//
// The sibling console already holds this line: /admin/compliance-center says
// "metrics are unavailable and intentionally not shown as zero".
//
// WATCHED TO FAIL: revert the null-roster state in page.tsx and the first two
// tests go red -- the first on the empty-state wording, the second on the
// tiles reading '0' instead of a withheld marker.

it('a failed roster read does not render as an empty roster', async () => {
  const fetchMock = jest.fn(async () => jsonResponse({ error: 'Unable to load volunteer roster.' }, false));

  await renderPage(fetchMock);

  // The failure is stated.
  await screen.findByText('Unable to load volunteer roster.');

  // ...and never dressed as an absence of volunteers.
  expect(screen.queryByText('No volunteers on record yet')).toBeNull();
  expect(screen.queryByText(/Add the first volunteer above/i)).toBeNull();
});

it('a failed roster read shows no counts rather than zeroes', async () => {
  const fetchMock = jest.fn(async () => jsonResponse({ error: 'Unable to load volunteer roster.' }, false));

  await renderPage(fetchMock);

  await screen.findByText('Unable to load volunteer roster.');

  const labels = ['Active', 'Pending', 'Inactive'];
  // Not vacuous: the loop really runs over three tiles that are on the page.
  expect(labels.length).toBe(3);
  let asserted = 0;
  for (const label of labels) {
    const tile = screen.getByText(label).closest('article') as HTMLElement;
    expect(tile).toBeTruthy();
    // The tile's VALUE paragraph, not the whole tile: "Active0" contains no
    // word boundary before the digit, so asserting on tile.textContent would
    // pass against the very zero this test exists to forbid.
    const value = tile.querySelectorAll('p')[1];
    expect(value).toBeTruthy();
    expect((value.textContent ?? '').trim()).not.toBe('0');
    asserted += 1;
  }
  expect(asserted).toBe(3);
});

it('a genuinely empty roster still says so', async () => {
  const fetchMock = jest.fn(async () => jsonResponse({ items: [] }));

  await renderPage(fetchMock);

  await screen.findByText('No volunteers on record yet');
  expect(screen.queryByText('Unable to load volunteer roster.')).toBeNull();
});
