/**
 * @jest-environment jsdom
 */

// The cue library (register module 114): read-only browse over cues that
// already live in drill records. What these pin: cues render grouped by
// family with drill attribution; the search and focus filter drive the
// query string (server-side filtering, not client slicing); there is no
// authoring control anywhere; an empty library says nobody has written cues
// yet; a failed read admits cues may exist.

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import CueLibraryPage from './page';

jest.mock('@/components/RoleSessionGate', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const CUE = {
  cue_id: 'cue-1',
  cue_text: 'Push the floor away',
  cue_family: 'ground-force',
  focus_type: 'external',
  evidence_note: 'External focus beats internal for power tasks.',
  drill_id: 'drill-1',
  drill_name: 'Heavy Bag Drive',
  discipline: 'boxing',
  category: 'power',
};

function mockFetch(options: { items?: unknown[]; ok?: boolean; seenUrls?: string[] }) {
  return jest.fn(async (input: RequestInfo | URL) => {
    options.seenUrls?.push(String(input));
    return {
      ok: options.ok ?? true,
      status: options.ok === false ? 500 : 200,
      json: async () => ({ items: options.items ?? [] }),
    } as Response;
  }) as unknown as typeof fetch;
}

afterEach(() => {
  jest.restoreAllMocks();
});

test('cues render grouped by family with drill attribution, and nothing offers authoring', async () => {
  global.fetch = mockFetch({ items: [CUE] });

  await act(async () => {
    render(<CueLibraryPage />);
  });

  expect(screen.getByText('ground-force')).toBeTruthy();
  expect(screen.getByText(/Push the floor away/)).toBeTruthy();
  expect(screen.getByText(/from/).textContent).toContain('Heavy Bag Drive');
  expect(screen.getByText(/External focus beats internal/)).toBeTruthy();
  // Read-only: no add/edit/delete/save control exists on this page.
  expect(screen.queryByRole('button', { name: /add|edit|delete|save/i })).toBeNull();
});

test('search and focus filter reach the server as query params', async () => {
  const seenUrls: string[] = [];
  global.fetch = mockFetch({ items: [CUE], seenUrls });

  await act(async () => {
    render(<CueLibraryPage />);
  });
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Focus type'), { target: { value: 'external' } });
  });
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'floor' } });
  });

  await waitFor(() => {
    expect(seenUrls.some((url) => url.includes('focus_type=external') && url.includes('search=floor'))).toBe(true);
  });
});

test('an empty unfiltered library says nobody has written cues yet', async () => {
  global.fetch = mockFetch({ items: [] });

  await act(async () => {
    render(<CueLibraryPage />);
  });

  expect(screen.getByText(/nobody has written any yet/)).toBeTruthy();
});

test('a failed read admits cues may exist, never rendering as an empty library', async () => {
  global.fetch = mockFetch({ ok: false });

  await act(async () => {
    render(<CueLibraryPage />);
  });

  expect(screen.getByText(/Cues may exist that are not shown here/)).toBeTruthy();
  expect(screen.queryByText(/nobody has written any yet/)).toBeNull();
});
