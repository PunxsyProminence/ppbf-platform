/**
 * @jest-environment jsdom
 */

// The screen that records a guardian signed.
//
// pilot.waivers and POST /api/pilot/intake/domain-upsert both existed for
// months; what did not exist was any screen calling them, so consent could be
// recorded by an API call and by nobody standing in the gym. These tests hold
// the two things that make this screen worth having: it sends the shape the
// route actually accepts, and it never reports "nothing on file" for a child
// whose record merely failed to load.

import type { ReactNode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import ConsentPage from './page';

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

const ROSTER = [
  { athlete_id: 'ath-001', full_name: 'Sample Athlete One', active_flag: true },
  { athlete_id: 'ath-002', full_name: 'Sample Athlete Two', active_flag: false },
];

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  jest.clearAllMocks();
});

/** Roster from athletes/list, waivers from domain-get, writes to domain-upsert. */
function mockApi(options: {
  waivers?: unknown[];
  domainGetOk?: boolean;
  upsertOk?: boolean;
} = {}) {
  const { waivers = [], domainGetOk = true, upsertOk = true } = options;
  return jest.fn(async (url: string, init?: RequestInit) => {
    const target = String(url);
    if (target.includes('/athletes/list')) {
      // The route answers with `items` on every branch.
      return jsonResponse({ items: ROSTER });
    }
    if (target.includes('/domain-get')) {
      return domainGetOk
        ? jsonResponse({ ok: true, waivers })
        : jsonResponse({ error: 'Database unavailable' }, false);
    }
    if (target.includes('/domain-upsert')) {
      return upsertOk
        ? jsonResponse({ ok: true, entity_id: 'waiver-1' })
        : jsonResponse({ error: 'Forbidden: role not allowed' }, false);
    }
    void init;
    return jsonResponse({}, false);
  });
}

async function renderAndPickAthlete(fetchMock: jest.Mock) {
  global.fetch = fetchMock as unknown as typeof fetch;
  render(<ConsentPage />);
  await screen.findByText('Sample Athlete One');
  fireEvent.change(screen.getByLabelText('Athlete'), { target: { value: 'ath-001' } });
  await waitFor(() =>
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/domain-get'))).toBe(true),
  );
}

it('reads the roster from `items`, the key the route actually sends', async () => {
  const fetchMock = mockApi();
  global.fetch = fetchMock as unknown as typeof fetch;
  render(<ConsentPage />);

  // Both athletes offered, the inactive one marked rather than hidden -- a
  // consent record may need adding for someone who has stopped attending.
  expect(await screen.findByText('Sample Athlete One')).toBeTruthy();
  expect(screen.getByText('Sample Athlete Two (inactive)')).toBeTruthy();
});

it('sends the entity_type and payload domain-upsert expects', async () => {
  const fetchMock = mockApi();
  await renderAndPickAthlete(fetchMock);

  fireEvent.change(screen.getByLabelText('Who signed'), { target: { value: 'A Guardian' } });
  fireEvent.change(screen.getByLabelText('Date signed'), { target: { value: '2026-08-15' } });
  fireEvent.change(screen.getByLabelText('What was signed'), { target: { value: 'medical_release' } });
  fireEvent.click(screen.getByRole('button', { name: /record consent/i }));

  await waitFor(() =>
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/domain-upsert'))).toBe(true),
  );

  const call = fetchMock.mock.calls.find(([u]) => String(u).includes('/domain-upsert'));
  const sent = JSON.parse(String((call?.[1] as RequestInit).body));

  expect(sent.entity_type).toBe('waiver');
  expect(sent.athlete_id).toBe('ath-001');
  expect(sent.payload.signed_by_name).toBe('A Guardian');
  expect(sent.payload.waiver_type).toBe('medical_release');
  expect(sent.payload.status).toBe('signed');
});

// pilot.waivers.signed_at is timestamptz and the input gives a calendar day.
// Sending midnight would store the day before the one that was typed for every
// reader west of Greenwich -- the same off-by-one that made an athlete's drill
// due date render a day early.
it('stores the day that was typed, not the day before it', async () => {
  const fetchMock = mockApi();
  await renderAndPickAthlete(fetchMock);

  fireEvent.change(screen.getByLabelText('Who signed'), { target: { value: 'A Guardian' } });
  fireEvent.change(screen.getByLabelText('Date signed'), { target: { value: '2026-01-01' } });
  fireEvent.click(screen.getByRole('button', { name: /record consent/i }));

  await waitFor(() =>
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/domain-upsert'))).toBe(true),
  );

  const call = fetchMock.mock.calls.find(([u]) => String(u).includes('/domain-upsert'));
  const sent = JSON.parse(String((call?.[1] as RequestInit).body));

  // Midday, so the stored instant lands on 2026-01-01 in every timezone rather
  // than 2025-12-31 -- a consent dated to the wrong YEAR.
  expect(sent.payload.signed_at).toBe('2026-01-01T12:00:00.000Z');
  expect(new Date(sent.payload.signed_at).toISOString().slice(0, 10)).toBe('2026-01-01');
});

it('will not submit without a name and a date', async () => {
  const fetchMock = mockApi();
  await renderAndPickAthlete(fetchMock);

  // Name empty by default, so the control is refused rather than sending a
  // consent record attributed to nobody.
  expect(screen.getByRole('button', { name: /record consent/i }).hasAttribute('disabled')).toBe(true);
});

it('shows what is already on file', async () => {
  const fetchMock = mockApi({
    waivers: [
      {
        waiver_id: 'w-1',
        athlete_id: 'ath-001',
        waiver_type: 'general',
        signed_by_name: 'A Guardian',
        signed_by_role: 'guardian',
        signed_at: '2026-07-04T12:00:00.000Z',
        consent_version: 'v1',
        status: 'signed',
        notes: 'Paper in the blue folder',
      },
    ],
  });
  await renderAndPickAthlete(fetchMock);

  expect(await screen.findByText(/A Guardian/)).toBeTruthy();
  expect(screen.getByText('Paper in the blue folder')).toBeTruthy();
  // Rendered from the calendar day rather than through new Date().
  expect(screen.getByText('Jul 4, 2026')).toBeTruthy();
});

// The worst error this screen could make. "Nothing on file" for a child whose
// guardian did sign, because a request failed, would send somebody to ask a
// family for paperwork they already provided -- or worse, read as consent never
// having been given.
it('never reports nothing on file when the record failed to load', async () => {
  const fetchMock = mockApi({ domainGetOk: false });
  await renderAndPickAthlete(fetchMock);

  // The server's own reason, not a generic one -- the person standing at the
  // desk can tell "the database is down" from "this athlete has no record".
  expect(await screen.findByText(/Database unavailable/i)).toBeTruthy();
  expect(screen.queryByText(/Nothing recorded for this athlete yet/i)).toBeNull();
});

it('says nothing is on file only when the record loaded and was empty', async () => {
  const fetchMock = mockApi({ waivers: [] });
  await renderAndPickAthlete(fetchMock);

  expect(await screen.findByText(/Nothing recorded for this athlete yet/i)).toBeTruthy();
});

it('reports a refused write instead of claiming it saved', async () => {
  const fetchMock = mockApi({ upsertOk: false });
  await renderAndPickAthlete(fetchMock);

  fireEvent.change(screen.getByLabelText('Who signed'), { target: { value: 'A Guardian' } });
  fireEvent.click(screen.getByRole('button', { name: /record consent/i }));

  expect(await screen.findByText(/Forbidden: role not allowed/i)).toBeTruthy();
  expect(screen.queryByText('Recorded.')).toBeNull();
});
