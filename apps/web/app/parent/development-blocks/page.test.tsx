/**
 * @jest-environment jsdom
 */

/*
 * A guardian reading their child's plan.
 *
 * The PLAN's rendering is proven once in the athlete page's own test file --
 * both pages render DevelopmentBlockPlanView, so re-asserting verbatim text,
 * the body-composition domain and the absence of a roll-up here would be a
 * second copy of the same claim that could drift out of step with the first.
 *
 * What this file covers is only what is different about the guardian's
 * version:
 *
 *   1. it names which child, and that id is the one the read is made with;
 *   2. an answer for the child a guardian just navigated away from never
 *      lands under the one they navigated to. The block cards carry no
 *      child's name, so nothing on screen would disagree;
 *   3. a guardian with no linked children, and a failed read of that list,
 *      are told apart.
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

import ParentDevelopmentBlocksPage from './page';

jest.mock('@/components/RoleStandaloneView', () => ({
  __esModule: true,
  default: ({ children }: { readonly children: ReactNode }) => <div>{children}</div>,
}));

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href }: { readonly children: ReactNode; readonly href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

const CHILDREN = [
  { athlete_id: 'ath-1', full_name: 'Rosa Delgado' },
  { athlete_id: 'ath-2', full_name: 'Marcus Webb' },
];

function planBlock(overrides: Record<string, unknown> = {}) {
  return {
    block_id: 'blk-1',
    title: 'Winter technical block',
    training_emphasis: 'Guard recovery off the jab.',
    starts_on: '2026-09-01',
    ends_on: '2026-10-13',
    status: 'draft',
    objectives: [],
    ...overrides,
  };
}

interface Stubs {
  childrenOk?: boolean;
  children?: typeof CHILDREN;
  blocksOk?: boolean;
  /** Per-athlete failure, so a stale FAILURE can be told from a live one. */
  blocksFailFor?: string[];
  /** Per-athlete block payloads, so a test can tell the two children apart. */
  blocksByAthlete?: Record<string, Array<Record<string, unknown>>>;
  /** Holds the read for a named athlete, so a later one can overtake it. */
  hold?: Record<string, Promise<void>>;
}

const blockReads: string[] = [];

function installFetch(stubs: Stubs = {}): jest.Mock {
  blockReads.length = 0;
  const fetchMock = jest.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/pilot/athletes/list')) {
      return {
        ok: stubs.childrenOk ?? true,
        status: stubs.childrenOk === false ? 503 : 200,
        json: async () => ({ ok: true, items: stubs.children ?? CHILDREN }),
      } as Response;
    }
    if (url.includes('/api/pilot/athlete/development-blocks')) {
      const athleteId = new URL(url, 'http://localhost').searchParams.get('athlete_id') ?? '';
      blockReads.push(athleteId);
      if (stubs.hold?.[athleteId]) {
        await stubs.hold[athleteId];
      }
      const failed = stubs.blocksOk === false || (stubs.blocksFailFor ?? []).includes(athleteId);
      return {
        ok: !failed,
        status: failed ? 503 : 200,
        json: async () => ({
          ok: true,
          blocks: stubs.blocksByAthlete?.[athleteId] ?? [planBlock()],
        }),
      } as Response;
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

async function renderPage(stubs: Stubs = {}) {
  const fetchMock = installFetch(stubs);
  await act(async () => {
    render(<ParentDevelopmentBlocksPage />);
  });
  return fetchMock;
}

async function pickChild(id: string) {
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Which child'), { target: { value: id } });
  });
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('choosing which child', () => {
  test('the picker offers exactly the children the guardian gate returned', async () => {
    await renderPage();

    const picker = screen.getByLabelText('Which child') as HTMLSelectElement;
    expect(Array.from(picker.options).map((o) => o.value).filter(Boolean))
      .toEqual(['ath-1', 'ath-2']);
  });

  test('the child list comes from the guardian-gated route, not a roster read', async () => {
    const fetchMock = await renderPage();

    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(urls.some((url) => url.includes('/api/pilot/athletes/list'))).toBe(true);
    expect(urls.some((url) => url.includes('/api/pilot/coach/athletes'))).toBe(false);
  });

  test('nothing is read until a child is chosen', async () => {
    // A guardian of two children has no default child, and picking one for
    // them would be inventing an answer.
    await renderPage();

    expect(blockReads).toEqual([]);
  });

  test('the chosen child is the one the read names', async () => {
    await renderPage();
    await pickChild('ath-2');

    expect(blockReads).toEqual(['ath-2']);
  });

  test('a failed child list is not rendered as "you have no children linked"', async () => {
    await renderPage({ childrenOk: false });

    expect(screen.getByText(/could not be loaded/i)).toBeTruthy();
    expect(screen.queryByText(/No child is linked to this account/i)).toBeNull();
  });

  test('a guardian with genuinely none is told that, distinctly', async () => {
    await renderPage({ children: [] });

    expect(screen.getByText(/No child is linked to this account/i)).toBeTruthy();
    expect(screen.queryByText(/could not be loaded/i)).toBeNull();
  });
});

describe('a plan never lands under the wrong child', () => {
  test('a late answer for the previous child does not render under the current one', async () => {
    /* The block cards carry no child's name, so a stale answer landing here
       would show one child's plan under the other's name with nothing on
       screen disagreeing. A guardian of two children is exactly who hits it. */
    let releaseFirst: () => void = () => {};
    const firstRead = new Promise<void>((resolve) => { releaseFirst = resolve; });

    await renderPage({
      hold: { 'ath-1': firstRead },
      blocksByAthlete: {
        'ath-1': [planBlock({ block_id: 'blk-rosa', title: 'Rosa block' })],
        'ath-2': [planBlock({ block_id: 'blk-marcus', title: 'Marcus block' })],
      },
    });

    // Ask for Rosa, then move to Marcus before Rosa's answer arrives.
    await pickChild('ath-1');
    await pickChild('ath-2');

    await act(async () => {
      releaseFirst();
      await firstRead;
    });

    expect(screen.queryByText('Rosa block')).toBeNull();
    expect(screen.getByText('Marcus block')).toBeTruthy();
  });

  test('a late FAILURE for the previous child does not blank the current one', async () => {
    /* The nastier half. A stale SUCCESS shows the wrong plan; a stale FAILURE
       replaces a plan that loaded fine with "this could not be loaded", which
       a guardian reads as a fault in their own child's record. Only the first
       child's read fails, so the two answers are distinguishable. */
    let releaseFirst: () => void = () => {};
    const firstRead = new Promise<void>((resolve) => { releaseFirst = resolve; });

    await renderPage({
      blocksFailFor: ['ath-1'],
      hold: { 'ath-1': firstRead },
      blocksByAthlete: {
        'ath-2': [planBlock({ block_id: 'blk-marcus', title: 'Marcus block' })],
      },
    });

    await pickChild('ath-1');
    await pickChild('ath-2');

    // Marcus's plan is on screen before the stale failure arrives.
    expect(screen.getByText('Marcus block')).toBeTruthy();

    await act(async () => {
      releaseFirst();
      await firstRead;
    });

    // And still is: Rosa's failure did not blank it.
    expect(screen.getByText('Marcus block')).toBeTruthy();
    expect(screen.queryByText(/could not be loaded just now/i)).toBeNull();
  });
});
