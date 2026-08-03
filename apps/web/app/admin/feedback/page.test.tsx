/**
 * @jest-environment jsdom
 */

// The surface where a child's disclosure either gets picked up or gets lost in
// a list of feature requests. Three things are held here: safeguarding renders
// first and loudly, the platform owner's view carries no controls and no
// identity, and a triage that changed no row is reported as a failure rather
// than a tick.

import type { ReactNode } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import FeedbackTriagePage from './page';

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

const DISCLOSURE = 'someone at the gym keeps hurting me and im scared to come back';
const BUG = 'the attendance page loses my selection when i scroll';

function organizationItems() {
  return [
    {
      submission_id: 'sub-safeguarding',
      organization_id: 'org-1',
      submitted_by_role: 'athlete',
      submitter_name: 'Maya Alvarez',
      kind: 'other',
      body: DISCLOSURE,
      route: 'safeguarding',
      triage_status: 'new',
      triage_note: null,
      created_at: '2026-08-01T12:00:00.000Z',
    },
    {
      submission_id: 'sub-bug',
      organization_id: 'org-1',
      submitted_by_role: 'coach',
      submitter_name: 'coach@punxsyprominence.org',
      kind: 'bug',
      body: BUG,
      route: 'product',
      triage_status: 'new',
      triage_note: null,
      created_at: '2026-08-01T13:00:00.000Z',
    },
  ];
}

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  jest.clearAllMocks();
});

async function renderPage(fetchMock: jest.Mock) {
  global.fetch = fetchMock as unknown as typeof fetch;
  render(<FeedbackTriagePage />);
  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
}

function listOnly(payload: unknown) {
  return jest.fn(async () => jsonResponse(payload));
}

it('puts safeguarding above everything else and says how many need a person', async () => {
  await renderPage(listOnly({ ok: true, scope: 'organization', items: organizationItems() }));

  await screen.findByText(DISCLOSURE);
  expect(screen.getByText('1 submission needs a person today')).toBeTruthy();
  expect(screen.getByText(/a person must read this/i)).toBeTruthy();

  const bodies = Array.from(document.querySelectorAll('article')).map((article) => article.textContent ?? '');
  expect(bodies[0]).toContain(DISCLOSURE);
  expect(bodies[1]).toContain(BUG);
});

// An empty safeguarding banner would be an empty state dressed as a finding,
// and after a week of seeing "0" nobody reads it at all.
it('shows no safeguarding banner at all when nothing is in that lane', async () => {
  const items = organizationItems().filter((item) => item.route === 'product');
  await renderPage(listOnly({ ok: true, scope: 'organization', items }));

  await screen.findByText(BUG);
  expect(screen.queryByText(/needs a person today/i)).toBeNull();
  expect(screen.queryByText(/need a person today/i)).toBeNull();
  expect(screen.queryByText(/a person must read this/i)).toBeNull();
});

it('renders no queue sections when nothing has been submitted', async () => {
  await renderPage(listOnly({ ok: true, scope: 'organization', items: [] }));

  await screen.findByText('Nobody has sent anything yet.');
  expect(document.querySelectorAll('article')).toHaveLength(0);
  expect(screen.queryByText(/bugs, frustrations and ideas/i)).toBeNull();
});

it('names the submitter for the gym that received it', async () => {
  await renderPage(listOnly({ ok: true, scope: 'organization', items: organizationItems() }));

  await screen.findByText('Maya Alvarez');
  expect(screen.getByText('coach@punxsyprominence.org')).toBeTruthy();
});

// The platform payload has no name in it, because the query never selected
// one. What this asserts is that the page offers no action the owner could not
// honestly take, and shows the gym instead of the person.
it('gives the platform owner the gym and the role, and no triage controls', async () => {
  const items = [
    {
      submission_id: 'sub-1',
      organization_id: 'org-7',
      organization_name: 'Northside Boxing',
      submitted_by_role: 'athlete',
      kind: 'other',
      body: DISCLOSURE,
      route: 'safeguarding',
      triage_status: 'new',
      created_at: '2026-08-01T12:00:00.000Z',
    },
  ];

  await renderPage(listOnly({ ok: true, scope: 'platform', items }));

  await screen.findByText(DISCLOSURE);
  expect(screen.getByText('Northside Boxing')).toBeTruthy();
  expect(screen.getByText('athlete')).toBeTruthy();
  expect(screen.queryByRole('button', { name: /save triage/i })).toBeNull();
  expect(screen.queryByRole('combobox')).toBeNull();
});

it('sends the chosen status and note, and shows the stored result', async () => {
  const fetchMock = jest.fn(async (_url: string, init?: RequestInit) => {
    if (String(_url).includes('/triage')) {
      return jsonResponse({
        ok: true,
        updated: true,
        submission: {
          submission_id: 'sub-safeguarding',
          triage_status: 'triaged',
          triage_note: 'Spoke with her and her guardian the same afternoon.',
          triaged_at: '2026-08-01T14:00:00.000Z',
        },
      });
    }
    return jsonResponse({ ok: true, scope: 'organization', items: organizationItems() });
  });

  await renderPage(fetchMock);
  await screen.findByText(DISCLOSURE);

  const card = document.querySelectorAll('article')[0] as HTMLElement;
  fireEvent.change(within(card).getByLabelText(/^status for submission sub-safeguarding$/i), {
    target: { value: 'triaged' },
  });
  fireEvent.change(within(card).getByLabelText(/^note for submission sub-safeguarding$/i), {
    target: { value: 'Spoke with her and her guardian the same afternoon.' },
  });
  fireEvent.click(within(card).getByRole('button', { name: /save triage/i }));

  await screen.findByText('Marked triaged.');
  expect(screen.getByText('Spoke with her and her guardian the same afternoon.')).toBeTruthy();

  const triageCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/triage'));
  expect(JSON.parse(String((triageCall?.[1] as RequestInit).body))).toEqual({
    submission_id: 'sub-safeguarding',
    triage_status: 'triaged',
    triage_note: 'Spoke with her and her guardian the same afternoon.',
  });
});

it('refuses to report a disclosure as handled when the server changed no row', async () => {
  const fetchMock = jest.fn(async (_url: string) => {
    if (String(_url).includes('/triage')) {
      return jsonResponse({ ok: true, updated: false });
    }
    return jsonResponse({ ok: true, scope: 'organization', items: organizationItems() });
  });

  await renderPage(fetchMock);
  await screen.findByText(DISCLOSURE);

  const card = document.querySelectorAll('article')[0] as HTMLElement;
  fireEvent.click(within(card).getByRole('button', { name: /save triage/i }));

  await screen.findByText(/no longer in this gym/i);
  expect(screen.queryByText(/^Marked /)).toBeNull();
});

it('reports a failed load instead of rendering an empty queue as good news', async () => {
  const fetchMock = jest.fn(async () => jsonResponse({ error: 'Internal server error' }, false));

  await renderPage(fetchMock);

  await screen.findByText('Internal server error');
  expect(screen.queryByText('Nobody has sent anything yet.')).toBeNull();
});
