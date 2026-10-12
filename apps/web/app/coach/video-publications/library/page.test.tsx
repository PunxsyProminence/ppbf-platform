/**
 * @jest-environment jsdom
 */

/*
 * The published video library (work order N7-02). What is pinned here: a card
 * shows title, description, tags and date and nothing else the route returns
 * (no ids, no view count, no playback link); paging asks for one extra row and
 * offers Next only when it came back; an empty shelf, a filtered-empty shelf, a
 * refusal and a failed load each read as what they are; a tag filter is sent
 * to the route; a slow page the reader has moved past is never shown; the page
 * renders only what the route returned, so an entry the server withholds
 * (retracted, consent-suppressed, archived) cannot appear.
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

import VideoLibraryPage from './page';

jest.mock('@/components/RoleStandaloneView', () => ({
  __esModule: true,
  default: ({ children }: { readonly children: ReactNode }) => <div>{children}</div>,
}));

// Shaped like a getResearchLibrary row (src/server/pilot/publication.ts).
function row(n: number, tags: string[] = ['footwork']) {
  return {
    library_id: `lib-${n}`,
    publication_id: `pub-${n}`,
    video_session_id: `vid-${n}`,
    title: `Clip ${n}`,
    description: `About clip ${n}`,
    tags,
    view_count: 0,
    published_at: '2026-10-01T15:00:00.000Z',
  };
}

let respond: (url: string) => Promise<{ status: number; body: unknown }>;
let fetchMock: jest.Mock;

beforeEach(() => {
  respond = async () => ({ status: 200, body: { items: [row(1, ['footwork', 'jab']), row(2, ['defence'])] } });
  fetchMock = jest.fn(async (input: RequestInfo | URL) => {
    const r = await respond(String(input));
    return { ok: r.status < 400, status: r.status, json: async () => r.body } as Response;
  });
  global.fetch = fetchMock as unknown as typeof fetch;
});

function urls(): URL[] {
  return fetchMock.mock.calls.map(([u]) => new URL(String(u), 'http://x'));
}

async function mount() {
  render(<VideoLibraryPage />);
  await act(async () => {});
}

test('a card shows title, description, tags and date, and nothing else from the row', async () => {
  await mount();
  const text = document.body.textContent ?? '';
  expect(screen.getByRole('heading', { name: 'Clip 1' })).toBeTruthy();
  expect(text).toContain('About clip 1');
  expect(text).toContain('footwork, jab');
  expect(text).toContain('Published October 1, 2026');
  for (const hidden of ['pub-1', 'vid-1', 'lib-1', 'view']) expect(text).not.toContain(hidden);
  expect(document.querySelector('video, a[href*="vid-"], a[href*="media"]')).toBeNull();
});

test('the first page asks the route for one row more than it shows, from offset 0', async () => {
  await mount();
  expect(urls()).toHaveLength(1);
  expect(urls()[0].pathname).toBe('/api/pilot/publications/library');
  expect(urls()[0].searchParams.get('limit')).toBe('21');
  expect(urls()[0].searchParams.get('offset')).toBe('0');
  expect(urls()[0].searchParams.has('tags')).toBe(false);
});

test('Next appears only when the extra row came back, and pages by 20', async () => {
  respond = async (url) => {
    const offset = Number(new URL(url, 'http://x').searchParams.get('offset'));
    const items = offset === 0
      ? Array.from({ length: 21 }, (_, i) => row(i + 1))
      : [row(21), row(22)];
    return { status: 200, body: { items } };
  };
  await mount();
  expect(screen.getAllByRole('listitem')).toHaveLength(20);
  expect(screen.queryByRole('heading', { name: 'Clip 21' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Previous' })).toBeNull();

  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Next' })); });
  expect(urls()[1].searchParams.get('offset')).toBe('20');
  expect(screen.getAllByRole('listitem')).toHaveLength(2);
  expect(screen.queryByRole('button', { name: 'Next' })).toBeNull();

  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Previous' })); });
  expect(urls()[2].searchParams.get('offset')).toBe('0');
});

test('an empty shelf says so', async () => {
  respond = async () => ({ status: 200, body: { items: [] } });
  await mount();
  expect(document.body.textContent).toContain('No published clips yet.');
  expect(screen.queryByRole('button', { name: 'Next' })).toBeNull();
});

test('a tag filter is sent to the route, starts again at offset 0, and an empty result names the filter', async () => {
  await mount();
  respond = async () => ({ status: 200, body: { items: [] } });
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Tag'), { target: { value: 'jab' } });
  });
  const last = urls()[urls().length - 1];
  expect(last.searchParams.get('tags')).toBe('jab');
  expect(last.searchParams.get('offset')).toBe('0');
  expect(document.body.textContent).toContain('No published clips with this tag.');
});

test('the tag list is built from the clips loaded, without inventing any', async () => {
  await mount();
  const options = Array.from((screen.getByLabelText('Tag') as HTMLSelectElement).options).map((o) => o.value);
  expect(options).toEqual(['', 'defence', 'footwork', 'jab']);
});

test('a refusal shows the refusal and no cards', async () => {
  respond = async () => ({ status: 403, body: { error: 'Forbidden' } });
  await mount();
  expect(screen.getByRole('alert').textContent).toContain('not available to your account');
  expect(screen.queryAllByRole('listitem')).toHaveLength(0);
  expect(document.body.textContent).not.toContain('No published clips');
});

test('a failed load reads as unavailable, never as an empty shelf', async () => {
  respond = async () => ({ status: 500, body: { error: 'boom' } });
  await mount();
  expect(screen.getByRole('alert').textContent).toContain('could not be loaded');
  expect(document.body.textContent).not.toContain('No published clips');
});

test('only what the route returned is shown: an entry it withholds cannot appear', async () => {
  // The server drops retracted and consent-suppressed entries
  // (suppressed_at is null) before answering; the page adds nothing back.
  respond = async () => ({ status: 200, body: { items: [row(1)] } });
  await mount();
  expect(screen.getAllByRole('listitem')).toHaveLength(1);
  expect(screen.queryByRole('heading', { name: 'Clip 2' })).toBeNull();
});

test('a slow page the reader has moved past is never shown', async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  respond = async (url) => {
    const tags = new URL(url, 'http://x').searchParams.get('tags');
    if (!tags) {
      await held;
      return { status: 200, body: { items: [row(1, ['jab'])] } };
    }
    return { status: 200, body: { items: [row(9, ['jab'])] } };
  };
  render(<VideoLibraryPage />);
  await act(async () => {});
  // The tag list is empty until a page loads, so add the option the reader picks.
  const select = screen.getByLabelText('Tag') as HTMLSelectElement;
  const option = document.createElement('option');
  option.value = 'jab';
  select.appendChild(option);
  await act(async () => { fireEvent.change(select, { target: { value: 'jab' } }); });
  await act(async () => { release(); });
  expect(screen.getByRole('heading', { name: 'Clip 9' })).toBeTruthy();
  expect(screen.queryByRole('heading', { name: 'Clip 1' })).toBeNull();
});
