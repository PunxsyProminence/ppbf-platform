/**
 * @jest-environment jsdom
 */

import { act, render, screen } from '@testing-library/react';

import AnnouncementBanner, {
  ANNOUNCEMENT_KINDS,
  ANNOUNCEMENT_PLACEMENTS,
  announcementLifecycle,
  type AnnouncementItem,
} from './AnnouncementBanner';
import {
  ANNOUNCEMENT_KINDS as SERVER_KINDS,
  ANNOUNCEMENT_PLACEMENTS as SERVER_PLACEMENTS,
} from '@/src/server/pilot/announcements';

// Only the two vocabularies are wanted from the server module; the driver it
// pulls in behind them has no place in a DOM test environment.
jest.mock('@/src/server/pilot/db', () => ({ query: jest.fn() }));

function item(overrides: Partial<AnnouncementItem> = {}): AnnouncementItem {
  return {
    announcement_id: 'ann-1',
    message: 'Gloves on at 5.',
    author_name: 'Coach M.',
    author_role: 'coach',
    created_at: '2026-07-30T12:00:00.000Z',
    placement: 'gym_notices',
    kind: 'notice',
    active: true,
    starts_at: null,
    ends_at: null,
    ...overrides,
  };
}

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as Response;
}

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  jest.clearAllMocks();
});

async function renderBanner(fetchMock: jest.Mock, props: Partial<Parameters<typeof AnnouncementBanner>[0]> = {}) {
  global.fetch = fetchMock as unknown as typeof fetch;
  await act(async () => {
    render(<AnnouncementBanner placement="gym_notices" {...props} />);
  });
  return fetchMock;
}

// The two lists are declared twice on purpose -- the server module reaches the
// database and cannot be bundled into a client component -- so drift between
// them would silently make a placement unreachable from the UI.
describe('the client and server vocabularies are the same closed sets', () => {
  test('placements match', () => {
    expect([...ANNOUNCEMENT_PLACEMENTS]).toEqual([...SERVER_PLACEMENTS]);
  });

  test('kinds match', () => {
    expect([...ANNOUNCEMENT_KINDS]).toEqual([...SERVER_KINDS]);
  });
});

describe('announcementLifecycle', () => {
  const now = Date.parse('2026-07-30T12:00:00.000Z');

  test('an unset bound never on its own hides an item', () => {
    expect(announcementLifecycle(item(), now)).toBe('live');
  });

  test('a start in the future is scheduled, not live', () => {
    expect(announcementLifecycle(item({ starts_at: '2026-08-01T00:00:00.000Z' }), now)).toBe('scheduled');
  });

  test('an end already passed is expired', () => {
    expect(announcementLifecycle(item({ ends_at: '2026-07-29T00:00:00.000Z' }), now)).toBe('expired');
  });

  test('active false wins over any window', () => {
    expect(announcementLifecycle(item({ active: false, starts_at: '2026-07-01T00:00:00.000Z' }), now)).toBe('retired');
  });
});

describe('AnnouncementBanner', () => {
  test('renders nothing at all when nothing is live', async () => {
    const { container } = (() => {
      global.fetch = jest.fn(async () => jsonResponse({ ok: true, announcements: [] })) as unknown as typeof fetch;
      return render(<AnnouncementBanner placement="gym_notices" heading="Gym Notice" />);
    })();

    await act(async () => {});

    expect(container.firstChild).toBeNull();
    expect(screen.queryByText('Gym Notice')).toBeNull();
  });

  test('a failed read renders nothing rather than an error over the page', async () => {
    const fetchMock = jest.fn(async () => jsonResponse({}, false));
    global.fetch = fetchMock as unknown as typeof fetch;

    const { container } = render(<AnnouncementBanner placement="gym_notices" heading="Gym Notice" />);
    await act(async () => {});

    expect(container.firstChild).toBeNull();
  });

  test('a thrown fetch is swallowed and the surface stays usable', async () => {
    const fetchMock = jest.fn(async () => {
      throw new Error('offline');
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const { container } = render(<AnnouncementBanner placement="gym_notices" />);
    await act(async () => {});

    expect(container.firstChild).toBeNull();
  });

  test('draws a live item with its byline', async () => {
    await renderBanner(
      jest.fn(async () => jsonResponse({ ok: true, announcements: [item()] })),
      { heading: 'Gym Notice' },
    );

    expect(screen.getByText('Gloves on at 5.')).toBeTruthy();
    expect(screen.getByText('Gym Notice')).toBeTruthy();
    expect(screen.getByText(/By Coach M\. \(coach\)/)).toBeTruthy();
  });

  // A response that still carries an unpublished row must not put it on screen.
  test('a scheduled or retired row in the response is still not drawn', async () => {
    const { container } = (() => {
      global.fetch = jest.fn(async () =>
        jsonResponse({
          ok: true,
          announcements: [
            item({ announcement_id: 'a-sched', message: 'Not yet.', starts_at: '2099-01-01T00:00:00.000Z' }),
            item({ announcement_id: 'a-retired', message: 'Pulled down.', active: false }),
          ],
        }),
      ) as unknown as typeof fetch;
      return render(<AnnouncementBanner placement="gym_notices" />);
    })();

    await act(async () => {});

    expect(screen.queryByText('Not yet.')).toBeNull();
    expect(screen.queryByText('Pulled down.')).toBeNull();
    expect(container.firstChild).toBeNull();
  });

  test('an item placed on another surface does not leak onto this one', async () => {
    await renderBanner(
      jest.fn(async () =>
        jsonResponse({ ok: true, announcements: [item({ placement: 'coach_workspace', message: 'Coaches only.' })] }),
      ),
      { placement: 'athlete_workspace' },
    );

    expect(screen.queryByText('Coaches only.')).toBeNull();
  });

  test('an everywhere item reaches whichever surface asks', async () => {
    await renderBanner(
      jest.fn(async () =>
        jsonResponse({ ok: true, announcements: [item({ placement: 'everywhere', message: 'Gym-wide.' })] }),
      ),
      { placement: 'athlete_workspace' },
    );

    expect(screen.getByText('Gym-wide.')).toBeTruthy();
  });

  test('motivational copy carries no byline', async () => {
    await renderBanner(
      jest.fn(async () =>
        jsonResponse({
          ok: true,
          announcements: [item({ kind: 'motivation', message: 'Hands up, chin down.' })],
        }),
      ),
      { kind: 'motivation' },
    );

    expect(screen.getByText('Hands up, chin down.')).toBeTruthy();
    expect(screen.queryByText(/By Coach M\./)).toBeNull();
  });

  test('the session read asks the server for the placement and kind it needs', async () => {
    const fetchMock = await renderBanner(
      jest.fn(async () => jsonResponse({ ok: true, announcements: [] })),
      { placement: 'coach_workspace', kind: 'motivation', limit: 2 },
    );

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/pilot/announcements/get');
    expect(JSON.parse(String(init.body))).toEqual({
      placement: 'coach_workspace',
      kind: 'motivation',
      limit: 2,
    });
  });

  test('the signed-out surface reads the public feed', async () => {
    const fetchMock = await renderBanner(
      jest.fn(async () => jsonResponse({ ok: true, announcements: [] })),
      { source: 'public', limit: 3 },
    );

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/pilot/announcements/public?limit=3');
    expect(init.method).toBe('GET');
  });
});
