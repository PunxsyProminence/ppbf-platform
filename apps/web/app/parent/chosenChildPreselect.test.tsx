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

import { act, render, screen } from '@testing-library/react';
import type { ComponentType, ReactNode } from 'react';

import { rememberChosenChild } from '@/src/lib/chosenChild';
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

const PAGES: Array<{ name: string; Page: ComponentType; read: string; fallback: string | null }> = [
  { name: '/parent/progression-visibility', Page: ParentProgressionVisibilityPage, read: '/progression/gaps', fallback: 'kid-a' },
  { name: '/parent/video', Page: ParentVideoPage, read: '/video/list', fallback: 'kid-a' },
  { name: '/parent/development-blocks', Page: ParentDevelopmentBlocksPage, read: '/athlete/development-blocks', fallback: null },
  { name: '/parent/mental-skills', Page: ParentMentalSkillsPage, read: '/athlete/mental-skills', fallback: null },
];

describe.each(PAGES)('$name', ({ Page, read, fallback }) => {
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
});
