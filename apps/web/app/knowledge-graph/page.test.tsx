/**
 * @jest-environment jsdom
 */

// The status plaque on this page reported a figure it could not have.
//
// It read `NODE COUNT: {nodes.length}`, and the plaque row renders ABOVE the
// loading and error sections, so it printed a measured-looking NODE COUNT: 0
// while the projection request was still open and again after it failed. Even
// on a good read the figure is not a node count: the projection reads the
// newest PROJECTION_READ_LIMIT shadow_events and then drops every event that
// is not SHADOW/INTAKE/AUDIT, so what comes back is the nodes among a capped
// window of events.
//
// The fix is /audit's, on the same plaque row of the same pipeline: name the
// figure for what it is (Events Shown / Nodes Shown) and withhold it as '--'
// until the read has answered.
//
// WATCHED TO FAIL, 2026-08-25: put `{ label: 'Node Count', value:
// String(nodes.length) }` back and the first three tests go red, the first two
// naming the fabricated `NODE COUNT: 0` they found on the row; delete the
// window line under the streams and the fourth goes red on the missing
// sentence. A guard nobody has watched fail is a hypothesis.

import type { ReactNode } from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';

import KnowledgeGraphPage from './page';

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href }: { readonly children: ReactNode; readonly href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  jest.clearAllMocks();
});

function node(overrides: Record<string, unknown> = {}) {
  return {
    type: 'Observation',
    title: 'SHADOW_OBSERVATION_RECORDED',
    source_event_name: 'SHADOW_OBSERVATION_RECORDED',
    entity_type: 'athlete',
    entity_id: 'ath-1',
    review_state: 'pending_review',
    created_at: '2026-08-01T12:00:00.000Z',
    ...overrides,
  };
}

/** The plaque's value, read off the rendered span rather than by text match:
 *  label and value are two text nodes inside one element. */
function plaqueValue(container: HTMLElement, label: string): string | null {
  for (const element of Array.from(container.querySelectorAll('.plaque'))) {
    const text = element.textContent ?? '';
    if (text.startsWith(`${label.toUpperCase()}: `)) {
      return text.slice(label.length + 2);
    }
  }
  return null;
}

/** Every plaque on the status row whose value is a bare figure, whatever it
 *  calls itself. Asserted rather than a single label so a fabricated count
 *  fails on the STRING IT PRINTS -- renaming the plaque cannot hide it. */
function countingPlaques(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('.plaque'))
    .map((element) => element.textContent ?? '')
    .filter((text) => /:\s\d+$/.test(text));
}

function installFetch(projection: () => Promise<Response>): jest.Mock {
  const fetchMock = jest.fn(async (url: unknown) => {
    if (String(url).includes('/api/pilot/shadow/knowledge-projection')) {
      return projection();
    }
    if (String(url).includes('/api/pilot/auth/session')) {
      return { ok: true, json: async () => ({ authenticated: true, role: 'admin' }) } as Response;
    }
    throw new Error(`Unexpected fetch: ${String(url)}`);
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

test('a read still in flight shows no figure at all, never a zero', async () => {
  let release: (() => void) | null = null;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  installFetch(async () => {
    await held;
    return { ok: true, json: async () => ({ ok: true, items: [] }) } as Response;
  });

  const { container } = render(<KnowledgeGraphPage />);

  // The request has not answered, so no plaque on the row may state a figure.
  expect(countingPlaques(container)).toEqual([]);
  expect(plaqueValue(container, 'Nodes Shown')).toBe('--');
  expect(screen.getByText('Loading knowledge projection...')).toBeTruthy();

  await act(async () => {
    (release as unknown as () => void)();
    await held;
  });
});

test('a failed read shows no figure either -- it is not a graph with nothing in it', async () => {
  installFetch(async () => ({ ok: false, json: async () => ({}) }) as Response);

  const { container } = render(<KnowledgeGraphPage />);

  await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
  expect(countingPlaques(container)).toEqual([]);
  expect(plaqueValue(container, 'Nodes Shown')).toBe('--');
});

test('a read that answered states what it is showing, not a node count', async () => {
  installFetch(async () => ({
    ok: true,
    json: async () => ({ ok: true, items: [node(), node({ entity_id: 'ath-2', type: 'Pattern' })] }),
  }) as Response);

  const { container } = render(<KnowledgeGraphPage />);

  await waitFor(() => expect(plaqueValue(container, 'Nodes Shown')).toBe('2'));
  // The old label claimed a property of the organization; the new one claims a
  // property of this screen, which is the only one the read supports.
  expect(countingPlaques(container)).toEqual(['NODES SHOWN: 2']);
});

test('the streams say the window they were projected from', async () => {
  installFetch(async () => ({
    ok: true,
    json: async () => ({ ok: true, items: [node()] }),
  }) as Response);

  render(<KnowledgeGraphPage />);

  expect(
    await screen.findByText(/projected from the 120 most recent SHADOW events/i),
  ).toBeTruthy();
});

// The window line is a statement about rows, so it belongs to rows. The empty
// state already says the projection holds nothing; a "120 most recent" caveat
// on top of it would be furniture explaining an absence.
test('an empty projection states the absence without the window line', async () => {
  installFetch(async () => ({ ok: true, json: async () => ({ ok: true, items: [] }) }) as Response);

  render(<KnowledgeGraphPage />);

  expect(
    await screen.findByText('No SHADOW knowledge projection data exists for this organization yet.'),
  ).toBeTruthy();
  expect(screen.queryByText(/most recent SHADOW events/i)).toBeNull();
});
