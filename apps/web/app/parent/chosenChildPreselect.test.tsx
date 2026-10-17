/**
 * @jest-environment jsdom
 */

/*
 * UX audit A-9: a parent of two picks child B in the hub, opens another family
 * page, and that page must open on child B -- carried by src/lib/chosenChild.ts,
 * never by an id in the address. A remembered id that is not one of THIS
 * guardian's children (another family's, on a shared tablet) is ignored and
 * the page keeps its own default: the first child, or none picked.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ComponentType, ReactNode } from 'react';

import { readChosenChild, rememberChosenChild } from '@/src/lib/chosenChild';
import ParentDevelopmentBlocksPage from './development-blocks/page';
import ParentMentalSkillsPage from './mental-skills/page';
import ParentProgressionVisibilityPage from './progression-visibility/page';
import ParentVideoPage from './video/page';

jest.mock('@/components/RoleStandaloneView', () => ({
  __esModule: true,
  default: ({ children }: { readonly children: ReactNode }) => <div>{children}</div>,
}));

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href }: { readonly children: ReactNode; readonly href: string }) => <a href={href}>{children}</a>,
}));

const KIDS = [
  { athlete_id: 'kid-a', full_name: 'Avery Doe' },
  { athlete_id: 'kid-b', full_name: 'Blake Doe' },
];

let fetchMock: jest.Mock;

beforeEach(() => {
  fetchMock = jest.fn(async (input: RequestInfo | URL) => {
    const body = String(input).includes('/athletes/list')
      ? { items: KIDS }
      : { items: [], blocks: [], imagery_sessions: [], current_cue: null };
    return { ok: true, status: 200, json: async () => body } as Response;
  });
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  jest.restoreAllMocks();
  window.sessionStorage.clear();
  window.localStorage.clear();
});

/** The athlete ids this page's own child read was made for. */
function readsFor(fragment: string): string[] {
  return fetchMock.mock.calls
    .map(([input]) => new URL(String(input), 'http://localhost'))
    .filter((url) => url.pathname.includes(fragment))
    .map((url) => url.searchParams.get('athlete_id') ?? '');
}

async function renderSettled(Page: ComponentType) {
  await act(async () => {
    render(<Page />);
  });
  await screen.findAllByText(/Blake Doe/);
  await act(async () => {});
}

/** Switches by the page's own control: a row of buttons, or a select. */
const byButton = () => fireEvent.click(screen.getByRole('button', { name: 'Blake Doe' }));
const bySelect = () => fireEvent.change(screen.getByLabelText('Which child'), { target: { value: 'kid-b' } });

const PAGES: Array<{ name: string; Page: ComponentType; read: string; fallback: string | null; pickB: () => void }> = [
  { name: '/parent/progression-visibility', Page: ParentProgressionVisibilityPage, read: '/progression/gaps', fallback: 'kid-a', pickB: byButton },
  { name: '/parent/video', Page: ParentVideoPage, read: '/video/list', fallback: 'kid-a', pickB: byButton },
  { name: '/parent/development-blocks', Page: ParentDevelopmentBlocksPage, read: '/athlete/development-blocks', fallback: null, pickB: bySelect },
  { name: '/parent/mental-skills', Page: ParentMentalSkillsPage, read: '/athlete/mental-skills', fallback: null, pickB: bySelect },
];

describe.each(PAGES)('$name', ({ Page, read, fallback, pickB }) => {
  test('opens on the child chosen in the hub when it is one of the guardian\'s own', async () => {
    rememberChosenChild('kid-b');
    await renderSettled(Page);
    expect(readsFor(read)).toContain('kid-b');
    expect(readsFor(read)).not.toContain('kid-a');
  });

  test('ignores a remembered id that is not in its own list', async () => {
    rememberChosenChild('kid-other-family');
    await renderSettled(Page);
    expect(readsFor(read)).not.toContain('kid-other-family');
    expect(readsFor(read)).toEqual(fallback ? expect.arrayContaining([fallback]) : []);
  });

  test('a switch made here is remembered, and the next family page opens on it', async () => {
    rememberChosenChild('kid-a');
    await renderSettled(Page);
    await act(async () => {
      pickB();
    });
    expect(readChosenChild()).toBe('kid-b');

    // The next page: the video page reads its first child unless told otherwise.
    cleanup();
    fetchMock.mockClear();
    await renderSettled(ParentVideoPage);
    expect(readsFor('/video/list')).toContain('kid-b');
    expect(readsFor('/video/list')).not.toContain('kid-a');
  });
});
