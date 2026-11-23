/**
 * @jest-environment jsdom
 */

/**
 * PARENT PORTAL WALK 2026-10-19, ITEM 11: the child tabs started about a screen
 * and a half down a phone, below the family line and five summary tiles.
 *
 * jsdom has no layout, so this holds the ORDER the page is built in, which is
 * what decides where things land on a phone: the child selector and the tab
 * row come first, the summary tiles follow them on every tab, and the tab's
 * own content follows those.
 *
 * AS-9 (scrub FAM-02, FAM-20; Q5 = A): the Safety & Consent card is the first
 * block of the Overview, above the coach's digest and Quick Actions, and the
 * fixed "Family Commitment" card that sat above every tab is gone.
 */

import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import ParentHub from './ParentHub';

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 500, json: async () => body } as unknown as Response;
}

function installFetch(): void {
  global.fetch = jest.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes('/api/pilot/athletes/list')) {
      return jsonResponse({
        items: [
          { athlete_id: 'ath_1', full_name: 'First Child' },
          { athlete_id: 'ath_2', full_name: 'Second Child' },
        ],
      });
    }
    if (url.includes('/api/pilot/profile/card')) return jsonResponse({ error: 'not in this test' }, false);
    return jsonResponse({ ok: true, items: [], announcements: [], card: null });
  }) as unknown as typeof fetch;
}

/** True when `a` comes before `b` in the document. */
function before(a: Element, b: Element): boolean {
  return Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
}

function tile(label: string): Element {
  // A tile that counts the selected child alone names the child after its label (FAM-12).
  const found = screen
    .getAllByText((_, element) => element?.tagName === 'P' && (element.textContent === label || (element.textContent ?? '').startsWith(`${label} · `)))
    .find((element) => element.tagName === 'P');
  if (!found) throw new Error(`no ${label} tile`);
  return found;
}

afterEach(() => {
  jest.restoreAllMocks();
  window.sessionStorage.clear();
  window.localStorage.clear();
});

async function renderHub() {
  installFetch();
  await act(async () => {
    render(<ParentHub />);
  });
  await waitFor(() => expect(screen.getByRole('button', { name: 'First Child' })).toBeInTheDocument());
}

test('the child selector and the tab row come before the summary tiles', async () => {
  await renderHub();

  const child = screen.getByRole('button', { name: 'First Child' });
  const firstTab = screen.getByRole('button', { name: 'Overview' });
  const lastTab = screen.getByRole('button', { name: 'SHADOW Intel' });

  expect(before(child, firstTab)).toBe(true);
  for (const label of ['Progress', 'Parent Floor tasks', 'Upcoming', 'Class attendance', 'New messages']) {
    expect(before(lastTab, tile(label))).toBe(true);
  }
});

test('the Overview opens on Safety & Consent, after the tiles and before the digest and Quick Actions', async () => {
  await renderHub();

  const safety = screen.getByTestId('parent-safety-card');
  expect(before(tile('New messages'), safety)).toBe(true);
  expect(before(safety, screen.getByText('Quick Actions'))).toBe(true);
  // Nothing else of the Overview's own content comes before it.
  const overview = safety.parentElement as HTMLElement;
  expect(overview.firstElementChild).toBe(safety);
});

test('the fixed Family Commitment card is gone from every tab', async () => {
  await renderHub();
  expect(screen.queryByText('Family Commitment')).toBeNull();

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Messages' }));
  });
  expect(screen.queryByText('Family Commitment')).toBeNull();
});

test('the tiles are still on the page on a tab other than Overview', async () => {
  await renderHub();

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Messages' }));
  });

  expect(tile('Class attendance')).toBeInTheDocument();
  expect(tile('New messages')).toBeInTheDocument();
});

// useTabParam keeps the open tab in the address (lane AS4-4D4E, AS-4 part 4e),
// and jsdom keeps the address from one test to the next, so each test starts
// from a clean one.
afterEach(() => {
  window.history.replaceState(null, '', '/');
});
