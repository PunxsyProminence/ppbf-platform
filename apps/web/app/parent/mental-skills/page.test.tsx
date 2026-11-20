/**
 * @jest-environment jsdom
 */

/*
 * The guardian's mental skills page, and through it MentalSkillsSubjectPanel
 * (the coach page's own file covers only its different sources). Worth a test:
 *   1. every read names the chosen child, and only that child;
 *   2. a slow answer for the previous child never lands under the next one;
 *   3. read only: the page never writes;
 *   4. a failed roster or read is never shown as "nothing".
 */

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';

import ParentMentalSkillsPage from './page';

const mockShellProps: Array<{ allowedRoles?: string[] }> = [];
jest.mock('@/components/RoleStandaloneView', () => ({
  __esModule: true,
  default: ({ children, allowedRoles }: { readonly children: ReactNode; readonly allowedRoles?: string[] }) => {
    mockShellProps.push({ allowedRoles });
    return <div>{children}</div>;
  },
}));
jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href }: { readonly children: ReactNode; readonly href: string }) => <a href={href}>{children}</a>,
}));

let KIDS = [
  { athlete_id: 'ath-a', full_name: 'Avery' },
  { athlete_id: 'ath-b', full_name: 'Blake' },
];

const entriesFor = (id: string) => ({
  current_cue: { entry_id: `cue-${id}`, cue_text: `cue of ${id}`, cue_kind: 'motivational', logged_on: '2026-10-03' },
  imagery_sessions: [{ entry_id: `s-${id}`, minutes: id === 'ath-a' ? 3 : 9, content_key: null, logged_on: '2026-10-03' }],
});

const blocksFor = (id: string) => [{
  block_id: `b-${id}`,
  status: 'active',
  objectives: [
    { objective_id: `o-${id}`, domain: 'mental', objective: `mental goal of ${id}`, status: 'active' },
    { objective_id: `d-${id}`, domain: 'mental', objective: `draft goal of ${id}`, status: 'draft' },
  ],
}];

interface Stubs {
  rosterOk?: boolean;
  entriesOk?: boolean;
  /** No mental goal is set, so the view's "No mental goals in ..." line shows. */
  noGoals?: boolean;
  hold?: Record<string, Promise<void>>;
}

function installFetch(stubs: Stubs = {}): jest.Mock {
  const fetchMock = jest.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/pilot/athletes/list')) {
      const ok = stubs.rosterOk ?? true;
      return { ok, status: ok ? 200 : 503, json: async () => ({ items: KIDS }) } as Response;
    }
    const id = new URL(url, 'http://x').searchParams.get('athlete_id') ?? '';
    if (stubs.hold?.[id]) await stubs.hold[id];
    if (url.includes('/api/pilot/athlete/mental-skills')) {
      const ok = stubs.entriesOk ?? true;
      return { ok, status: ok ? 200 : 503, json: async () => entriesFor(id) } as Response;
    }
    if (url.includes('/api/pilot/athlete/development-blocks')) {
      return { ok: true, status: 200, json: async () => ({ blocks: stubs.noGoals ? [] : blocksFor(id) }) } as Response;
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

async function renderPage(stubs: Stubs = {}) {
  const fetchMock = installFetch(stubs);
  await act(async () => {
    render(<ParentMentalSkillsPage />);
  });
  return fetchMock;
}

async function choose(id: string) {
  // The family pages' one picker (FAM-11): a button per child, by name.
  const name = KIDS.find((kid) => kid.athlete_id === id)?.full_name ?? id;
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }));
  });
}

afterEach(() => {
  jest.restoreAllMocks();
  // A pick is remembered (src/lib/chosenChild.ts); one test's pick must not
  // choose the next test's opening child.
  window.sessionStorage.clear();
  window.localStorage.clear();
});

test('only the parent role is admitted, and the approved guardian line shows', async () => {
  await renderPage();
  expect(mockShellProps.at(-1)?.allowedRoles).toEqual(['parent']);
  expect(screen.getByText(
    'You see what your child saved, in their words. Their coach sees it too. Nothing here can be changed from this page.',
  )).toBeTruthy();
});

test('reads name the chosen child only, and show that child\'s cue, sessions and current goals', async () => {
  const fetchMock = await renderPage();
  await choose('ath-b');
  const reads = fetchMock.mock.calls.map(([input]) => String(input)).filter((u) => u.includes('athlete_id='));
  expect(reads.length).toBe(2);
  for (const url of reads) expect(url).toMatch(/athlete_id=ath-b$/);
  expect(screen.getByText('cue of ath-b')).toBeTruthy();
  expect(screen.getByText(/9 min/)).toBeTruthy();
  expect(screen.getByText('mental goal of ath-b')).toBeTruthy();
  expect(screen.queryByText('draft goal of ath-b')).toBeNull();
  expect(screen.queryByText('cue of ath-a')).toBeNull();
});

test('a slow answer for the previous child never lands under the next one', async () => {
  let releaseA: () => void = () => {};
  const holdA = new Promise<void>((resolve) => { releaseA = resolve; });
  await renderPage({ hold: { 'ath-a': holdA } });
  await choose('ath-a');
  await choose('ath-b');
  expect(screen.getByText('cue of ath-b')).toBeTruthy();
  await act(async () => {
    releaseA();
  });
  expect(screen.getByText('cue of ath-b')).toBeTruthy();
  expect(screen.queryByText('cue of ath-a')).toBeNull();
  expect(screen.queryByText('mental goal of ath-a')).toBeNull();
});

test('read only: no write is ever sent and there is no form', async () => {
  const fetchMock = await renderPage();
  await choose('ath-a');
  for (const [, init] of fetchMock.mock.calls) {
    expect((init as RequestInit | undefined)?.method ?? 'GET').toBe('GET');
  }
  // The only buttons are the child picker's, and they only choose whose
  // record to read (the GET-only check above covers what they send).
  const picker = screen.getByRole('group', { name: 'Which child' });
  const buttons = screen.getAllByRole('button');
  expect(buttons.length).toBe(KIDS.length);
  for (const button of buttons) expect(picker.contains(button)).toBe(true);
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(document.querySelector('form')).toBeNull();
});

test('two children with the same name are told apart', async () => {
  const saved = KIDS;
  KIDS = [{ athlete_id: 'ath-twin-1111', full_name: 'Sam' }, { athlete_id: 'ath-twin-2222', full_name: 'Sam' }];
  try {
    await renderPage();
    const picker = screen.getByRole('group', { name: 'Which child' });
    const labels = within(picker).getAllByRole('button').map((button) => button.textContent);
    expect(labels).toEqual(['Sam (1111)', 'Sam (2222)']);
  } finally {
    KIDS = saved;
  }
});

test('a failed roster is not shown as "no children"', async () => {
  await renderPage({ rosterOk: false });
  expect(screen.getByRole('alert').textContent).toMatch(/could not be loaded/);
  expect(screen.queryByText(/No child is linked/)).toBeNull();
});

test('a failed read is not shown as nothing logged', async () => {
  await renderPage({ entriesOk: false });
  await choose('ath-a');
  expect(screen.getByRole('alert').textContent).toMatch(/could not be read/);
  expect(screen.queryByText('No imagery sessions logged yet.')).toBeNull();
});

describe('the family picker (FAM-11) and the one back link (FAM-18)', () => {
  test('two children and none remembered: it asks, and reads nothing', async () => {
    const fetchMock = await renderPage();
    expect(screen.getByText('Choose a child')).toBeTruthy();
    expect(fetchMock.mock.calls.map(([input]) => String(input)).filter((u) => u.includes('athlete_id='))).toEqual([]);
  });

  test('a one-child family is shown no picker and their record opens at once', async () => {
    const saved = KIDS;
    KIDS = [{ athlete_id: 'ath-a', full_name: 'Avery' }];
    try {
      const fetchMock = await renderPage();
      expect(screen.queryByRole('group', { name: 'Which child' })).toBeNull();
      expect(screen.queryByText('Choose a child')).toBeNull();
      const reads = fetchMock.mock.calls.map(([input]) => String(input)).filter((u) => u.includes('athlete_id='));
      expect(reads.length).toBe(2);
      for (const url of reads) expect(url).toMatch(/athlete_id=ath-a$/);
      expect(screen.getByText('cue of ath-a')).toBeTruthy();
    } finally {
      KIDS = saved;
    }
  });

  test('the remembered child opens, among two, and a pick is remembered', async () => {
    window.sessionStorage.setItem('ppbf.parent.chosenChild', 'ath-b');
    await renderPage();
    expect(screen.getByText('cue of ath-b')).toBeTruthy();
    await choose('ath-a');
    expect(window.sessionStorage.getItem('ppbf.parent.chosenChild')).toBe('ath-a');
  });

  test('a child with no name on file is "their" mid-sentence and "Your child" on the button, never an id', async () => {
    const saved = KIDS;
    KIDS = [{ athlete_id: 'ath-a', full_name: 'Avery' }, { athlete_id: 'ath-b' } as (typeof KIDS)[number]];
    try {
      await renderPage({ noGoals: true });
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Your child' }));
      });
      expect(screen.getByRole('region', { name: 'Mental skills for Your child' })).toBeTruthy();
      // The one sentence that puts the subject mid-line.
      expect(screen.getByText('No mental goals in their development plan yet.')).toBeTruthy();
      expect(document.body.textContent).not.toContain("Your child's");
      const shown = (document.body.textContent ?? '').replace('cue of ath-b', '');
      expect(shown).not.toContain('ath-b');
    } finally {
      KIDS = saved;
    }
  });

  test('the back link is the shared one', async () => {
    await renderPage();
    expect(screen.queryByText('Back to the Parent Hub')).toBeNull();
    // No session is cached in this test, so BackHome names no role's home.
    expect(screen.getByRole('link', { name: 'Back to your home page' }).getAttribute('href')).toBe('/dashboard');
  });
});
