/**
 * @jest-environment jsdom
 */

/**
 * PARENT PORTAL WALK 2026-10-19, ITEM 11: the child tabs started about a screen
 * and a half down a phone, below the family line and five summary tiles.
 *
 * jsdom has no layout, so this holds the ORDER the page is built in, which is
 * what decides where the tabs land on a phone: the child selector and the tab
 * row come first, the family line and the summary tiles follow them, and the
 * tab's own content follows those. Nothing was removed: every tile and the
 * family line are still on the page, on every tab.
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
  const found = screen.getAllByText(label).find((element) => element.tagName === 'P');
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

test('the child selector and the tab row come before the family line and the summary tiles', async () => {
  await renderHub();

  const child = screen.getByRole('button', { name: 'First Child' });
  const firstTab = screen.getByRole('button', { name: 'Overview' });
  const lastTab = screen.getByRole('button', { name: 'SHADOW Intel' });
  const family = screen.getByText('Family Commitment');

  expect(before(child, firstTab)).toBe(true);
  for (const label of ['Progress', 'Parent Floor tasks', 'Upcoming', 'Class attendance', 'New messages']) {
    expect(before(lastTab, tile(label))).toBe(true);
  }
  expect(before(lastTab, family)).toBe(true);
});

test('the tab content follows the summary tiles, and nothing was dropped', async () => {
  await renderHub();

  // Overview's own content starts after the tiles.
  expect(before(tile('New messages'), screen.getByText('Quick Actions'))).toBe(true);
  expect(screen.getByText('Family Commitment')).toBeInTheDocument();
});

test('the tiles are still on the page on a tab other than Overview', async () => {
  await renderHub();

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Messages' }));
  });

  expect(tile('Class attendance')).toBeInTheDocument();
  expect(tile('New messages')).toBeInTheDocument();
  expect(screen.getByText('Family Commitment')).toBeInTheDocument();
});
