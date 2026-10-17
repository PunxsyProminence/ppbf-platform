/**
 * @jest-environment jsdom
 */

/**
 * PH-13: the Current Status panel's Membership, Scholarship and Community
 * Service Support tiles, from /api/pilot/parent/support-status for the child
 * on screen (Q-D A): each program's standing with its dates; scholarship yes
 * or none recorded, never a percent; recorded supports with their dates,
 * newest first as the server sends them. A read that did not answer is
 * Unavailable, never "none recorded", and a slow answer for one child never
 * shows under the other's name.
 */

import '@testing-library/jest-dom';
import { act, fireEvent, render, screen } from '@testing-library/react';

import ParentHub from './ParentHub';

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 500, json: async () => body } as unknown as Response;
}

type Handler = (athleteId: string) => Promise<Response>;

function installFetch(supportStatus: Handler): jest.Mock {
  const fetchMock = jest.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes('/api/pilot/athletes/list')) {
      return jsonResponse({
        items: [
          { athlete_id: 'ath_1', full_name: 'First Child' },
          { athlete_id: 'ath_2', full_name: 'Second Child' },
        ],
      });
    }
    if (url.includes('/api/pilot/parent/support-status')) {
      return supportStatus(new URL(url, 'http://localhost').searchParams.get('athlete_id') ?? '');
    }
    if (url.includes('/api/pilot/profile/card')) return jsonResponse({}, false);
    return jsonResponse({ ok: true, items: [], announcements: [], classes: [], registrations: [], attendance: [], card: null });
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

const FULL = {
  ok: true,
  memberships: [
    { program_name: 'Youth Boxing', status: 'active', started_on: '2025-09-01', ended_on: null },
    { program_name: 'Wrestling', status: 'lapsed', started_on: '2025-01-15', ended_on: null },
    { program_name: 'Summer Camp', status: 'ended', started_on: '2024-06-01', ended_on: '2024-08-15' },
  ],
  scholarship: 'yes',
  supports: [
    { support_kind: 'Transportation to the regional tournament', provided_on: '2025-09-20' },
    { support_kind: 'Gloves and wraps', provided_on: '2025-03-01' },
  ],
};
const EMPTY = { ok: true, memberships: [], scholarship: 'none_recorded', supports: [] };

const LABELS = ['Membership Status', 'Scholarship Status', 'Community Service Support Status'] as const;

/** The tile's lines, in order, below its label. */
function tileLines(label: string): string[] {
  const labelElement = screen.getAllByText(label).find((element) => element.tagName === 'P');
  const tile = labelElement?.parentElement;
  return Array.from(tile?.querySelectorAll('p') ?? []).slice(1).map((p) => p.textContent ?? '');
}

async function renderHub() {
  await act(async () => {
    render(<ParentHub />);
  });
}

afterEach(() => jest.restoreAllMocks());

test('each program with its standing and dates, scholarship yes, supports with their dates', async () => {
  installFetch(async () => jsonResponse(FULL));
  await renderHub();

  expect(tileLines('Membership Status')).toEqual([
    'Youth Boxing: Active since September 1, 2025',
    'Wrestling: Lapsed (started January 15, 2025)',
    'Summer Camp: Ended August 15, 2024',
  ]);
  expect(tileLines('Scholarship Status')).toEqual(['Scholarship: yes']);
  expect(tileLines('Community Service Support Status')).toEqual([
    'Transportation to the regional tournament · September 20, 2025',
    'Gloves and wraps · March 1, 2025',
  ]);
  expect(screen.queryByText(/not yet tracked/i)).toBeNull();
});

test('nothing recorded reads as none recorded', async () => {
  installFetch(async () => jsonResponse(EMPTY));
  await renderHub();

  expect(tileLines('Membership Status')).toEqual(['No membership recorded']);
  expect(tileLines('Scholarship Status')).toEqual(['No scholarship recorded']);
  expect(tileLines('Community Service Support Status')).toEqual(['No support recorded']);
});

test.each([
  ['a refused read', async () => jsonResponse({ error: 'Not found: that child is not on your page.' }, false)],
  ['a payload of the wrong shape', async () => jsonResponse({ ok: true, items: [] })],
  ['a network failure', async () => {
    throw new TypeError('Failed to fetch');
  }],
])('%s is Unavailable on all three, never none recorded', async (_label, handler) => {
  installFetch(handler as Handler);
  await renderHub();

  for (const label of LABELS) expect(tileLines(label)).toEqual(['Unavailable']);
  expect(screen.queryByText(/recorded/)).toBeNull();
});

test("switching child never shows the first child's standing under the second", async () => {
  let releaseFirst!: () => void;
  const firstHeld = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  installFetch(async (athleteId) => {
    if (athleteId === 'ath_1') {
      await firstHeld;
      return jsonResponse(FULL);
    }
    return jsonResponse(EMPTY);
  });
  await renderHub();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Second Child' }));
  });
  await act(async () => {
    releaseFirst();
  });

  expect(tileLines('Membership Status')).toEqual(['No membership recorded']);
  expect(tileLines('Scholarship Status')).toEqual(['No scholarship recorded']);
  expect(tileLines('Community Service Support Status')).toEqual(['No support recorded']);
  expect(screen.queryByText(/Youth Boxing/)).toBeNull();
  expect(screen.queryByText(/Gloves and wraps/)).toBeNull();
});

test("switching back reads the first child's standing again, for that child", async () => {
  const fetchMock = installFetch(async (athleteId) => jsonResponse(athleteId === 'ath_1' ? FULL : EMPTY));
  await renderHub();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Second Child' }));
  });
  expect(tileLines('Scholarship Status')).toEqual(['No scholarship recorded']);
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'First Child' }));
  });

  expect(tileLines('Scholarship Status')).toEqual(['Scholarship: yes']);
  const reads = fetchMock.mock.calls
    .map((call) => String(call[0]))
    .filter((url) => url.includes('/api/pilot/parent/support-status'))
    .map((url) => new URL(url, 'http://localhost').searchParams.get('athlete_id'));
  expect(reads).toEqual(['ath_1', 'ath_2', 'ath_1']);
});
