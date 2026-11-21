/**
 * @jest-environment jsdom
 */

/**
 * AS-9 step AS9-3 (app scrub FAM-03, FAM-04, FAM-11, FAM-24).
 *
 * - All ten tabs stay, in one row that scrolls sideways instead of wrapping
 *   (FAM-03; Q2 = A).
 * - The child picker is the family pages' one picker, FamilyChildPicker, with
 *   its labels from familyChildLabel (FAM-11): a child is not drawn as a tab,
 *   a child with no name reads "Your child", a roster row sent twice is one
 *   child, and a one-child family has nothing to choose.
 * - Parent Floor: the coach's tasks come before "Report a Barrier"; the tab
 *   keeps its name (FAM-24; Q6 = A).
 * - One SHADOW Chat entry: the parent job bar points at /shadow, the shell
 *   button's page, so the SHADOW Intel tab loses its own "Ask SHADOW" button
 *   and keeps the tab (FAM-04; Q3 = A, Q2 = A). HelpPanel's "ASK SHADOW" stays.
 * - Retry after a failed children read goes straight to loading, never through
 *   "No children found" (carried review note on #2033).
 */

import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import ParentHub from './ParentHub';
import { JOB_BARS } from './jobBars';

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 500, json: async () => body } as unknown as Response;
}

type Roster = Array<{ athlete_id: string; full_name: string | null }>;

const TWO_CHILDREN: Roster = [
  { athlete_id: 'ath_1', full_name: 'First Child' },
  { athlete_id: 'ath_2', full_name: 'Second Child' },
];

function installFetch(roster: Roster | (() => Promise<Response>) = TWO_CHILDREN): jest.Mock {
  const mock = jest.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes('/api/pilot/athletes/list')) {
      return typeof roster === 'function' ? roster() : jsonResponse({ items: roster });
    }
    if (url.includes('/api/pilot/profile/card')) return jsonResponse({ error: 'not in this test' }, false);
    return jsonResponse({
      ok: true,
      items: [],
      announcements: [],
      classes: [],
      registrations: [],
      attendance: [],
      card: null,
      completed_sessions: 0,
    });
  });
  global.fetch = mock as unknown as typeof fetch;
  return mock;
}

afterEach(() => {
  jest.restoreAllMocks();
  window.sessionStorage.clear();
  window.localStorage.clear();
});

/** Each picker button's label: its last text, after the decorative portrait
 *  (whose plate reads the initials or a dash). */
function childLabels(group: HTMLElement): Array<string | null> {
  return within(group).getAllByRole('button').map((button) => button.lastChild?.textContent ?? null);
}

async function renderHub() {
  await act(async () => {
    render(<ParentHub />);
  });
  await act(async () => {});
}

const TEN_TABS = [
  'Overview',
  'Parent Floor',
  'Assignments',
  'Observations',
  'Family Goals',
  'Messages',
  'Attendance',
  'Progress',
  'Resources',
  'SHADOW Intel',
];

describe('the tab row (FAM-03; Q2 = A)', () => {
  test('keeps all ten tabs, in order, in one row that scrolls instead of wrapping', async () => {
    installFetch();
    await renderHub();

    const overview = screen.getByRole('button', { name: 'Overview' });
    const row = overview.parentElement as HTMLElement;
    expect(within(row).getAllByRole('button').map((button) => button.textContent)).toEqual(TEN_TABS);
    expect(row).toHaveClass('flex-nowrap', 'overflow-x-auto');
    expect(row).not.toHaveClass('flex-wrap');
    // A tab keeps its width and its label on one line rather than squeezing.
    for (const tab of within(row).getAllByRole('button')) {
      expect(tab).toHaveClass('shrink-0', 'whitespace-nowrap');
    }
  });
});

describe('the child picker (FAM-11)', () => {
  test('is the family pages\' picker: a "Which child" group of buttons, not tab-styled', async () => {
    installFetch();
    await renderHub();

    const group = screen.getByRole('group', { name: 'Which child' });
    const buttons = within(group).getAllByRole('button');
    expect(childLabels(group)).toEqual(['First Child', 'Second Child']);
    // The hub opens on the first child (as before), so the first is pressed.
    expect(buttons[0]).toHaveAttribute('aria-pressed', 'true');
    expect(buttons[0]).toHaveClass('btn');
    expect(buttons[1]).toHaveClass('btn', 'btn--ghost');
    // Not the tab style the ten tabs wear.
    const overview = screen.getByRole('button', { name: 'Overview' });
    for (const button of buttons) {
      expect(button.className).not.toContain('font-mono');
      expect(overview.parentElement?.contains(button)).toBe(false);
    }
  });

  test('a pick switches the hub and is remembered for the other family pages', async () => {
    installFetch();
    await renderHub();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Second Child' }));
    });
    expect(screen.getByRole('button', { name: 'Second Child' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'First Child' })).toHaveAttribute('aria-pressed', 'false');
    expect(window.sessionStorage.getItem('ppbf.parent.chosenChild')).toBe('ath_2');
  });

  test('a child with no name on file reads "Your child", never "Unknown" or an id', async () => {
    installFetch([
      { athlete_id: 'ath_1', full_name: 'First Child' },
      { athlete_id: 'ath_9', full_name: null },
    ]);
    await renderHub();

    const group = screen.getByRole('group', { name: 'Which child' });
    expect(childLabels(group)).toEqual(['First Child', 'Your child']);
    expect(group.textContent).not.toContain('Unknown');
    expect(group.textContent).not.toContain('ath_9');
  });

  test('a roster row sent twice is one button', async () => {
    installFetch([
      { athlete_id: 'ath_1', full_name: 'First Child' },
      { athlete_id: 'ath_1', full_name: 'First Child' },
      { athlete_id: 'ath_2', full_name: 'Second Child' },
    ]);
    await renderHub();

    const group = screen.getByRole('group', { name: 'Which child' });
    expect(childLabels(group)).toEqual(['First Child', 'Second Child']);
  });

  test('a one-child family has nothing to choose, and the hub still reads that child', async () => {
    const fetchMock = installFetch([{ athlete_id: 'ath_1', full_name: 'Only Child' }]);
    await renderHub();

    expect(screen.queryByRole('group', { name: 'Which child' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Only Child' })).toBeNull();
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes('athlete_id=ath_1'))).toBe(true),
    );
  });
});

describe('Parent Floor (FAM-24; Q6 = A)', () => {
  test('keeps its name, and the coach\'s tasks come before "Report a Barrier"', async () => {
    installFetch();
    await renderHub();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Parent Floor' }));
    });

    const tasks = screen.getByText("This Week's Parent Support Tasks");
    const barrier = screen.getByText('Report a Barrier');
    expect(tasks.compareDocumentPosition(barrier) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe('one SHADOW Chat entry on the hub (FAM-04; Q3 = A)', () => {
  test('the parent job bar points at the chat page, not at the SHADOW Intel tab', () => {
    const bar = JOB_BARS.parent;
    if (!bar) throw new Error('no parent job bar');
    const items = [...bar.sections.flatMap((section) => section.items), ...bar.more];
    expect(items.some((item) => item.href === '/shadow' && !item.tab)).toBe(true);
    expect(items.some((item) => item.tab === 'shadow')).toBe(false);
  });

  test('the SHADOW Intel tab stays, has no button of its own, and says where the chat is', async () => {
    installFetch();
    await renderHub();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'SHADOW Intel' }));
    });

    expect(screen.queryByRole('link', { name: /Ask SHADOW/i })).toBeNull();
    expect(screen.queryByText('> SHADOW (PARENT MODE)')).toBeNull();
    expect(
      screen.getByText(
        'Ask SHADOW how to support your child at home. The chat opens from the OPEN SHADOW CHAT button at the top of this page.',
      ),
    ).toBeInTheDocument();
  });

  test('a HelpPanel\'s "ASK SHADOW" stays', async () => {
    installFetch();
    await renderHub();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Parent Floor' }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /HELP: Parent Floor/ }));
    });
    expect(screen.getByRole('link', { name: /ASK SHADOW/ })).toBeInTheDocument();
  });
});

describe('Retry after a failed children read', () => {
  test('goes straight to loading, never through "No children found"', async () => {
    let calls = 0;
    let answer: (value: Response) => void = () => {};
    installFetch(() => {
      calls += 1;
      if (calls === 1) return Promise.resolve(jsonResponse({ error: 'no' }, false));
      return new Promise<Response>((resolve) => {
        answer = resolve;
      });
    });
    await renderHub();
    const retry = await screen.findByRole('button', { name: 'Retry loading children' });

    // Every node React adds from the click on, even one taken away again in
    // the next render, is seen here.
    const added: string[] = [];
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        record.addedNodes.forEach((node) => added.push(node.textContent ?? ''));
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    await act(async () => {
      fireEvent.click(retry);
    });
    await act(async () => {});
    const seen = observer.takeRecords();
    for (const record of seen) record.addedNodes.forEach((node) => added.push(node.textContent ?? ''));
    observer.disconnect();

    expect(screen.getByText('Loading your children...')).toBeInTheDocument();
    expect(added.some((text) => text.includes('No children found'))).toBe(false);

    await act(async () => {
      answer(jsonResponse({ items: TWO_CHILDREN }));
    });
    await waitFor(() => expect(screen.getByRole('group', { name: 'Which child' })).toBeInTheDocument());
  });
});

describe('the record page takes its door\'s name on the hub too', () => {
  test('the Assignments help names Progress Visibility, and the old phrase is gone from the hub', async () => {
    installFetch();
    await renderHub();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Assignments' }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /HELP: Home Assignments/ }));
    });
    expect(screen.getByText('Open Progress Visibility for the logged work')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('Open the full progression record');
  });
});
