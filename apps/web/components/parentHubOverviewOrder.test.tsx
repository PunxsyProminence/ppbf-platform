/**
 * @jest-environment jsdom
 */

/**
 * AS-9 step AS9-1 (app scrub FAM-02, -04, -05, -07, -08, -12, -13, -20, -27).
 *
 * - The Overview opens on Safety & Consent (FAM-02; Q5 = A). The order itself
 *   is held in parentHubPhoneLayout.test.tsx.
 * - Quick Actions keeps one action, Open Scheduler. The four buttons that only
 *   switched to a tab, and "SHADOW Chat", are gone (FAM-04, FAM-05; Q3 = A).
 * - The film link leaves the Safety & Consent card, and it, Their Development
 *   Plan and Mental Skills sit at the top of the Progress tab (FAM-07, FAM-08).
 * - The two tiles that count every child name each child beside its own count
 *   (FAM-12; Q4 = A).
 * - A children read that failed wears the restricted rung, not the
 *   medical-stop mark (FAM-13).
 * - A hub with no linked child says what to do next (FAM-27).
 * - Current Status keeps only what is shown nowhere else (FAM-20).
 */

import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import ParentHub from './ParentHub';

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 500, json: async () => body } as unknown as Response;
}

type Roster = Array<{ athlete_id: string; full_name: string | null }>;

const TWO_CHILDREN: Roster = [
  { athlete_id: 'ath_1', full_name: 'First Child' },
  { athlete_id: 'ath_2', full_name: 'Second Child' },
];

function message(overrides: Record<string, unknown>) {
  return {
    note_id: 'n1',
    athlete_id: 'ath_1',
    athlete_name: 'First Child',
    sender_role: 'coach',
    note_text: 'A note.',
    created_at: '2026-10-01T12:00:00.000Z',
    task: null,
    ...overrides,
  };
}

function installFetch(options: { roster?: Roster | 'fail'; messages?: unknown[] } = {}): void {
  global.fetch = jest.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes('/api/pilot/athletes/list')) {
      if (options.roster === 'fail') return jsonResponse({ error: 'The roster could not be read.' }, false);
      return jsonResponse({ items: options.roster ?? TWO_CHILDREN });
    }
    if (url.includes('/api/pilot/profile/card')) return jsonResponse({ error: 'not in this test' }, false);
    if (url.includes('/api/pilot/parent/messages')) return jsonResponse({ ok: true, items: options.messages ?? [] });
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
  }) as unknown as typeof fetch;
}

function tileValue(label: string): string {
  const labelElement = screen.getAllByText(label).find((element) => element.tagName === 'P');
  return labelElement?.parentElement?.textContent?.replace(label, '').trim() ?? '';
}

afterEach(() => {
  jest.restoreAllMocks();
  window.sessionStorage.clear();
  window.localStorage.clear();
});

async function renderHub() {
  await act(async () => {
    render(<ParentHub />);
  });
  await act(async () => {});
}

describe('Quick Actions (FAM-04, FAM-05)', () => {
  test('keeps Open Scheduler and drops the tab switches and the second SHADOW button', async () => {
    installFetch();
    await renderHub();

    const quick = screen.getByText('Quick Actions').closest('section') as HTMLElement;
    expect(within(quick).getByRole('link', { name: 'Open Scheduler' })).toHaveAttribute('href', '/schedule');
    expect(within(quick).getAllByRole('link')).toHaveLength(1);
    expect(within(quick).queryAllByRole('button')).toHaveLength(0);
    for (const gone of ['Open Assignments', 'Check Attendance', 'View Messages from the Coaches', 'Open SHADOW Intel', 'SHADOW Chat']) {
      expect(screen.queryByRole('button', { name: gone })).toBeNull();
    }
    // The SHADOW Intel tab is still in the tab row (AS9-3 decides the one entry).
    expect(screen.getByRole('button', { name: 'SHADOW Intel' })).toBeInTheDocument();
  });
});

describe('the record pages (FAM-07, FAM-08)', () => {
  test('the Safety & Consent card no longer holds the film link', async () => {
    installFetch();
    await renderHub();

    const safety = screen.getByTestId('parent-safety-card');
    expect(within(safety).getByRole('link', { name: 'View Safety Status' })).toHaveAttribute('href', '/parent/safety');
    expect(within(safety).getByRole('link', { name: 'Manage Consent' })).toHaveAttribute('href', '/parent/consent');
    expect(within(safety).queryByRole('link', { name: /film/i })).toBeNull();
  });

  test('film, plan and mental skills sit at the top of Progress, before the achievements, and carry the child', async () => {
    installFetch();
    await renderHub();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Second Child' }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Progress' }));
    });

    const pages = screen.getByRole('navigation', { name: "Your child's progress pages" });
    const links = within(pages).getAllByRole('link');
    expect(links.map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
      ["Your athlete's film", '/parent/video'],
      ['Their Development Plan', '/parent/development-blocks'],
      ['Mental Skills', '/parent/mental-skills'],
    ]);
    // Each appears once on the tab: the old foot-of-tab copies are gone.
    expect(screen.getAllByRole('link', { name: 'Their Development Plan' })).toHaveLength(1);
    expect(screen.getAllByRole('link', { name: 'Mental Skills' })).toHaveLength(1);

    // First thing after the tab's heading and intro line.
    const panel = pages.parentElement as HTMLElement;
    const children = Array.from(panel.children);
    expect(children.indexOf(pages)).toBe(2);

    window.sessionStorage.clear();
    fireEvent.click(links[0]);
    expect(window.sessionStorage.getItem('ppbf.parent.chosenChild')).toBe('ath_2');
  });
});

describe('each count names its child (FAM-12)', () => {
  test('one figure per child, a zero included, on both all-children tiles', async () => {
    installFetch({
      messages: [
        message({ note_id: 'a', athlete_id: 'ath_2', athlete_name: 'Second Child', task: { due_date: '2026-10-20', completed_at: null } }),
        message({ note_id: 'b', athlete_id: 'ath_2', athlete_name: 'Second Child', task: { due_date: '2026-10-21', completed_at: null } }),
      ],
    });
    await renderHub();

    expect(tileValue('Parent Floor tasks')).toBe('First 0 · Second 2');
  });

  test('a one-child family sees the name with the figure', async () => {
    installFetch({
      roster: [{ athlete_id: 'ath_1', full_name: 'Ada Lovelace' }],
      messages: [message({ athlete_name: 'Ada Lovelace', task: { due_date: '2026-10-20', completed_at: null } })],
    });
    await renderHub();

    expect(tileValue('Parent Floor tasks')).toBe('Ada 1');
  });

  test('two children with the same first name keep their full names', async () => {
    installFetch({
      roster: [
        { athlete_id: 'ath_1', full_name: 'Sam Lee' },
        { athlete_id: 'ath_2', full_name: 'Sam Ortiz' },
      ],
      messages: [message({ athlete_id: 'ath_2', athlete_name: 'Sam Ortiz', task: { due_date: '2026-10-20', completed_at: null } })],
    });
    await renderHub();

    expect(tileValue('Parent Floor tasks')).toBe('Sam Lee 0 · Sam Ortiz 1');
  });

  test('a child with no name on file reads "Your child", never an id', async () => {
    installFetch({
      roster: [{ athlete_id: 'ath_9', full_name: null }],
      messages: [message({ athlete_id: 'ath_9', athlete_name: null, task: { due_date: '2026-10-20', completed_at: null } })],
    });
    await renderHub();

    expect(tileValue('Parent Floor tasks')).toBe('Your child 1');
    expect(document.body.textContent).not.toContain('ath_9');
  });

  test('a message for a child the roster did not return is still counted, under its own name', async () => {
    installFetch({
      roster: [{ athlete_id: 'ath_1', full_name: 'First Child' }],
      messages: [message({ athlete_id: 'ath_7', athlete_name: 'Other Kid', task: { due_date: '2026-10-20', completed_at: null } })],
    });
    await renderHub();

    expect(tileValue('Parent Floor tasks')).toBe('First 0 · Other 1');
  });
});

describe('a failed children read (FAM-13)', () => {
  test('wears the restricted rung with its glyph, not the medical-stop mark, and keeps its words and Retry', async () => {
    installFetch({ roster: 'fail' });
    await renderHub();

    const alert = await waitFor(() => {
      const found = screen.getAllByRole('alert').find((element) => element.textContent?.includes('Error loading children'));
      if (!found) throw new Error('no children alert');
      return found;
    });
    expect(alert).toHaveClass('alert--warning');
    expect(alert).not.toHaveClass('alert--critical');
    const badge = within(alert).getByText('Failed');
    expect(badge).toHaveClass('badge--restricted');
    expect(badge).not.toHaveClass('badge--locked');
    expect(badge.textContent).toContain('▲');
    expect(within(alert).getByRole('button', { name: 'Retry loading children' })).toBeInTheDocument();
  });
});

describe('a hub with no linked child (FAM-27)', () => {
  test('says who sets the link up, in the film page\'s words', async () => {
    installFetch({ roster: [] });
    await renderHub();

    expect(screen.getByText('No children found')).toBeInTheDocument();
    expect(
      screen.getByText('Your account is not linked to an athlete yet. Ask the front desk to connect your family.'),
    ).toBeInTheDocument();
  });
});

describe('Current Status keeps only what is shown nowhere else (FAM-20)', () => {
  test('membership, scholarship and support stay; the repeats and the fixed cards are gone', async () => {
    installFetch();
    await renderHub();

    const status = screen.getByText('Current Status').parentElement as HTMLElement;
    for (const kept of ['Membership Status', 'Scholarship Status', 'Community Service Support Status']) {
      expect(within(status).getByText(kept)).toBeInTheDocument();
    }
    for (const gone of ['Child Name', 'Progress', 'Class attendance']) {
      expect(within(status).queryByText(gone)).toBeNull();
    }
    expect(screen.queryByText('How to Support')).toBeNull();
    expect(screen.queryByText('Family Commitment')).toBeNull();
  });
});
