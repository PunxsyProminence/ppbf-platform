/**
 * @jest-environment jsdom
 */

import type { ReactNode } from 'react';
import '@testing-library/jest-dom';
import { fireEvent, render, screen, within } from '@testing-library/react';

import AthleteConsentAuditPage from './page';

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

/* The role the page reads to decide whether to offer the guardian add
   (advisory; the server gate decides). Null = no session read yet, which is
   what jsdom gives, and what a coach's session must behave like here. */
let sessionRole: 'admin' | 'coach' | null = null;
jest.mock('@/components/roleSession', () => {
  // Stable objects: useSyncExternalStore re-renders forever on a snapshot
  // that is a fresh object each read, as the real module's cache knows.
  const SESSIONS = {
    admin: { role: 'admin', expiresAt: Number.MAX_SAFE_INTEGER },
    coach: { role: 'coach', expiresAt: Number.MAX_SAFE_INTEGER },
  } as const;
  return {
    getRoleSessionSnapshot: () => (sessionRole ? SESSIONS[sessionRole] : null),
    subscribeRoleSession: () => () => {},
  };
});

function jsonResponse(body: unknown, ok = true) {
  return { ok, json: async () => body } as Response;
}

/* One guardian row as the route projects it (athlete-consent/route.ts GET). */
function guardian(parentId: string, name: string, overrides: Record<string, unknown> = {}) {
  return {
    parent_id: parentId,
    parent_name: name,
    has_login: true,
    status: null,
    consented: false,
    covers_video: null,
    public_use_allowed: null,
    signed_at: null,
    ...overrides,
  };
}

/* The route always sends per_guardian, empty for an athlete with no links. */
const ITEMS = [
  { athlete_id: 'ath-1', athlete_name: 'Missing Consent Athlete', consent_ok: false, guardian_count: 0, missing_guardian_count: 0, per_guardian: [] },
  {
    athlete_id: 'ath-2', athlete_name: 'Cleared Athlete', consent_ok: true, guardian_count: 1, missing_guardian_count: 0,
    per_guardian: [guardian('p-2', 'Dana Reyes', { status: 'signed', consented: true, covers_video: true, public_use_allowed: false })],
  },
  {
    athlete_id: 'ath-3', athlete_name: 'Partial Athlete', consent_ok: false, guardian_count: 2, missing_guardian_count: 1,
    per_guardian: [
      guardian('p-3a', 'Sam Okafor', { status: 'signed', consented: true, covers_video: true, public_use_allowed: false }),
      guardian('par-paper-3b', 'Lee Paper', { has_login: false }),
    ],
  },
];

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  sessionRole = null;
  jest.clearAllMocks();
});

test('defaults to the "missing" filter, showing only athletes without full consent', async () => {
  global.fetch = jest.fn().mockResolvedValue(jsonResponse({ ok: true, items: ITEMS })) as unknown as typeof fetch;

  render(<AthleteConsentAuditPage />);

  await screen.findByText('Missing Consent Athlete');
  expect(screen.getByText('Partial Athlete')).toBeInTheDocument();
  expect(screen.queryByText('Cleared Athlete')).not.toBeInTheDocument();
});

test('an athlete with zero guardians on file reads "No guardians on file", not a false 0/0 cleared', async () => {
  global.fetch = jest.fn().mockResolvedValue(jsonResponse({ ok: true, items: ITEMS })) as unknown as typeof fetch;

  render(<AthleteConsentAuditPage />);

  await screen.findByText('Missing Consent Athlete');
  expect(screen.getByText('No guardians on file')).toBeInTheDocument();
});

test('a partially-consented athlete shows the guardian fraction', async () => {
  global.fetch = jest.fn().mockResolvedValue(jsonResponse({ ok: true, items: ITEMS })) as unknown as typeof fetch;

  render(<AthleteConsentAuditPage />);

  await screen.findByText('Partial Athlete');
  expect(screen.getByText('1/2 consented')).toBeInTheDocument();
});

test('switching to "Consent on file" shows only cleared athletes', async () => {
  global.fetch = jest.fn().mockResolvedValue(jsonResponse({ ok: true, items: ITEMS })) as unknown as typeof fetch;

  render(<AthleteConsentAuditPage />);
  await screen.findByText('Missing Consent Athlete');

  fireEvent.click(screen.getByRole('button', { name: 'Consent on file' }));

  await screen.findByText('Cleared Athlete');
  expect(screen.queryByText('Missing Consent Athlete')).not.toBeInTheDocument();
});

test('switching to "All athletes" shows every row', async () => {
  global.fetch = jest.fn().mockResolvedValue(jsonResponse({ ok: true, items: ITEMS })) as unknown as typeof fetch;

  render(<AthleteConsentAuditPage />);
  await screen.findByText('Missing Consent Athlete');

  fireEvent.click(screen.getByRole('button', { name: 'All athletes' }));

  await screen.findByText('Cleared Athlete');
  expect(screen.getByText('Missing Consent Athlete')).toBeInTheDocument();
  expect(screen.getByText('Partial Athlete')).toBeInTheDocument();
});

test('an empty filtered view renders "Nothing in this view", not a loading or error state', async () => {
  global.fetch = jest.fn().mockResolvedValue(jsonResponse({ ok: true, items: [ITEMS[1]] })) as unknown as typeof fetch;

  render(<AthleteConsentAuditPage />);

  await screen.findByText('Nothing in this view');
});

test('a failed load shows the error state, never a false empty view', async () => {
  global.fetch = jest.fn().mockResolvedValue(jsonResponse({ error: 'Database unavailable' }, false)) as unknown as typeof fetch;

  render(<AthleteConsentAuditPage />);

  await screen.findByText('Database unavailable');
  expect(screen.getByText('The audit could not be loaded')).toBeInTheDocument();
  expect(screen.queryByText('Nothing in this view')).not.toBeInTheDocument();
});


test('a failed read is not stamped as a medical emergency', async () => {
  global.fetch = jest.fn().mockResolvedValue(jsonResponse({ error: 'Database unavailable' }, false)) as unknown as typeof fetch;

  render(<AthleteConsentAuditPage />);

  // Room DNA: --locked red is what this room says when a clinician or a
  // safeguarding decision has stopped something. A read that failed is a
  // network fact. Law 3 keeps the glyph and the uppercase label doing the
  // work colour must never do alone.
  const alert = await screen.findByRole('alert');
  expect(alert.className).toContain('alert--warning');
  expect(alert.className).not.toContain('alert--critical');
  expect(within(alert).getByText('Attention')).toBeTruthy();
});


/* ---- The paper-only guardian (Jason 2026-10-07, OD-2026-10-07-009) ---- */

test('a guardian with no login is named "(paper only)" in the guardians column and in the recorder picker', async () => {
  global.fetch = jest.fn().mockResolvedValue(jsonResponse({ ok: true, items: ITEMS })) as unknown as typeof fetch;

  render(<AthleteConsentAuditPage />);
  await screen.findByText('Partial Athlete');

  expect(screen.getByText('Sam Okafor')).toBeInTheDocument();
  expect(screen.getByText('Lee Paper (paper only)')).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Record' }));
  const picker = await screen.findByRole('combobox', { name: /Guardian/ });
  expect(within(picker).getByRole('option', { name: 'Lee Paper (paper only) — nothing on file' })).toBeInTheDocument();
  expect(within(picker).getByRole('option', { name: 'Sam Okafor — signed' })).toBeInTheDocument();
});

test('"Add paper-only guardian" is offered to an admin session and not to a coach or an unknown session', async () => {
  global.fetch = jest.fn().mockResolvedValue(jsonResponse({ ok: true, items: ITEMS })) as unknown as typeof fetch;

  sessionRole = 'coach';
  const coachView = render(<AthleteConsentAuditPage />);
  await screen.findByText('Missing Consent Athlete');
  expect(screen.queryByRole('button', { name: 'Add paper-only guardian' })).not.toBeInTheDocument();
  coachView.unmount();

  sessionRole = 'admin';
  render(<AthleteConsentAuditPage />);
  await screen.findByText('Missing Consent Athlete');
  // One per visible row: the zero-guardian athlete and the partial one.
  expect(screen.getAllByRole('button', { name: 'Add paper-only guardian' })).toHaveLength(2);
});

test('adding a paper-only guardian posts guardian_link to domain-upsert, re-reads, and opens the recorder on the new guardian', async () => {
  sessionRole = 'admin';
  // The re-read answers with the guardian under the id the page minted,
  // which only the add request knows.
  const sentParentId = () => (JSON.parse(String((fetchMock.mock.calls[1] as [string, RequestInit])[1].body)) as {
    payload: { parent_id: string };
  }).payload.parent_id;
  const fetchMock: jest.Mock = jest.fn()
    .mockResolvedValueOnce(jsonResponse({ ok: true, items: ITEMS })) // first load
    .mockResolvedValueOnce(jsonResponse({ ok: true, entity_type: 'guardian_link' })) // the add
    .mockImplementationOnce(async () => jsonResponse({ // re-read
      ok: true,
      items: [
        {
          ...ITEMS[0],
          guardian_count: 1,
          missing_guardian_count: 1,
          per_guardian: [guardian(sentParentId(), 'Jo Paper', { has_login: false })],
        },
        ITEMS[1],
        ITEMS[2],
      ],
    }));
  global.fetch = fetchMock as unknown as typeof fetch;

  render(<AthleteConsentAuditPage />);
  await screen.findByText('Missing Consent Athlete');

  fireEvent.click(screen.getAllByRole('button', { name: 'Add paper-only guardian' })[0]);
  fireEvent.change(screen.getByLabelText(/full name/), { target: { value: '  Jo Paper ' } });
  fireEvent.change(screen.getByLabelText(/Relationship to Missing Consent Athlete/), { target: { value: 'father' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add guardian' }));

  await screen.findByText('Guardians updated');

  const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
  expect(url).toMatch(/\/api\/pilot\/intake\/domain-upsert$/);
  expect(init.method).toBe('POST');
  expect(init.credentials).toBe('include');
  const body = JSON.parse(String(init.body)) as {
    entity_type: string;
    athlete_id: string;
    payload: { parent_id: string; full_name: string; relationship_to_athlete: string };
  };
  expect(body.entity_type).toBe('guardian_link');
  expect(body.athlete_id).toBe('ath-1');
  // Trimmed name, chosen relationship, and an id kept out of the par-<account> space.
  expect(body.payload).toMatchObject({ full_name: 'Jo Paper', relationship_to_athlete: 'father' });
  expect(body.payload.parent_id).toMatch(/^par-paper-[0-9a-f-]{36}$/);
  // No account, no email: nothing in the payload can mint a login.
  expect(Object.keys(body.payload).sort()).toEqual(['full_name', 'parent_id', 'relationship_to_athlete']);

  // The recorder is open on the athlete, with the new guardian selected.
  const picker = await screen.findByRole('combobox', { name: /Guardian/ });
  expect((picker as HTMLSelectElement).value).toBe(sentParentId());
  expect(within(picker).getByRole('option', { name: 'Jo Paper (paper only) \u2014 nothing on file' })).toBeInTheDocument();
  expect(screen.getByText(/Jo Paper is now a paper-only guardian of Missing Consent Athlete/)).toBeInTheDocument();
});

test('a guardian already linked under the typed name is shown and needs a second press; nothing is sent on the first', async () => {
  sessionRole = 'admin';
  const fetchMock = jest.fn().mockResolvedValue(jsonResponse({ ok: true, items: ITEMS }));
  global.fetch = fetchMock as unknown as typeof fetch;

  render(<AthleteConsentAuditPage />);
  await screen.findByText('Partial Athlete');

  fireEvent.click(screen.getAllByRole('button', { name: 'Add paper-only guardian' })[1]);
  fireEvent.change(screen.getByLabelText(/full name/), { target: { value: 'lee paper' } });

  expect(await screen.findByText('Already linked')).toBeInTheDocument();
  expect(screen.getByText(/Lee Paper \(paper only\) is already a guardian of Partial Athlete/)).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Add guardian' }));
  // Armed, not sent: still only the one load on the wire.
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('button', { name: 'Add anyway' })).toBeInTheDocument();

  // Changing the name disarms it.
  fireEvent.change(screen.getByLabelText(/full name/), { target: { value: 'Lee Papers' } });
  expect(screen.queryByText('Already linked')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Add guardian' })).toBeInTheDocument();
});

test("a refused add shows the server's own words and sends nothing else", async () => {
  sessionRole = 'admin';
  const fetchMock = jest.fn()
    .mockResolvedValueOnce(jsonResponse({ ok: true, items: ITEMS }))
    .mockResolvedValueOnce(jsonResponse({ error: 'Forbidden: this athlete is 18 or over' }, false));
  global.fetch = fetchMock as unknown as typeof fetch;

  render(<AthleteConsentAuditPage />);
  await screen.findByText('Missing Consent Athlete');

  fireEvent.click(screen.getAllByRole('button', { name: 'Add paper-only guardian' })[0]);
  fireEvent.change(screen.getByLabelText(/full name/), { target: { value: 'Jo Paper' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add guardian' }));

  expect(await screen.findByText('Forbidden: this athlete is 18 or over')).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(screen.queryByText('Guardians updated')).not.toBeInTheDocument();
});

/* ---- Removing a paper-only guardian: the undo for a wrong-row add ---- */

test('"Remove" is offered beside a paper-only guardian to an admin, and beside nobody else', async () => {
  global.fetch = jest.fn().mockResolvedValue(jsonResponse({ ok: true, items: ITEMS })) as unknown as typeof fetch;

  sessionRole = 'coach';
  const coachView = render(<AthleteConsentAuditPage />);
  await screen.findByText('Partial Athlete');
  expect(screen.queryByRole('button', { name: /^Remove / })).not.toBeInTheDocument();
  coachView.unmount();

  sessionRole = 'admin';
  render(<AthleteConsentAuditPage />);
  await screen.findByText('Partial Athlete');
  // Lee Paper has no login; Sam Okafor has one and is unlinked on People.
  expect(screen.getByRole('button', { name: 'Remove Lee Paper as a guardian of Partial Athlete' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Remove Sam Okafor/ })).not.toBeInTheDocument();
});

test('removing is a two-press act that sends DELETE with parent_id and athlete_id, then re-reads', async () => {
  sessionRole = 'admin';
  const fetchMock = jest.fn()
    .mockResolvedValueOnce(jsonResponse({ ok: true, items: ITEMS }))
    .mockResolvedValueOnce(jsonResponse({ ok: true, parent_id: 'par-paper-3b', athlete_id: 'ath-3' }))
    .mockResolvedValueOnce(jsonResponse({
      ok: true,
      items: [ITEMS[0], ITEMS[1], { ...ITEMS[2], guardian_count: 1, missing_guardian_count: 0, consent_ok: true, per_guardian: [ITEMS[2].per_guardian[0]] }],
    }));
  global.fetch = fetchMock as unknown as typeof fetch;

  render(<AthleteConsentAuditPage />);
  await screen.findByText('Partial Athlete');

  fireEvent.click(screen.getByRole('button', { name: 'Remove Lee Paper as a guardian of Partial Athlete' }));
  // Armed, not sent.
  expect(fetchMock).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Confirm remove Lee Paper' }));

  await screen.findByText('Lee Paper is no longer a guardian of Partial Athlete.');
  const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
  expect(url).toMatch(/\/api\/pilot\/admin\/staff$/);
  expect(init.method).toBe('DELETE');
  expect(JSON.parse(String(init.body))).toEqual({ parent_id: 'par-paper-3b', athlete_id: 'ath-3' });
  expect(fetchMock).toHaveBeenCalledTimes(3);
});

test('a refused removal (a standing withdrawal) is shown in the server\'s words and the guardian stays listed', async () => {
  sessionRole = 'admin';
  const fetchMock = jest.fn()
    .mockResolvedValueOnce(jsonResponse({ ok: true, items: ITEMS }))
    .mockResolvedValueOnce(jsonResponse({ error: 'Forbidden: this guardian has withdrawn media consent for this athlete.' }, false));
  global.fetch = fetchMock as unknown as typeof fetch;

  render(<AthleteConsentAuditPage />);
  await screen.findByText('Partial Athlete');
  fireEvent.click(screen.getByRole('button', { name: 'Remove Lee Paper as a guardian of Partial Athlete' }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm remove Lee Paper' }));

  expect(await screen.findByText('Forbidden: this guardian has withdrawn media consent for this athlete.')).toBeInTheDocument();
  expect(screen.getByText('Not removed')).toBeInTheDocument();
  expect(screen.getByText('Lee Paper (paper only)')).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledTimes(2);
});
