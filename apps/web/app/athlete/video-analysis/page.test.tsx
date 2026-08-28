/**
 * @jest-environment jsdom
 */

/**
 * The athlete's own film screen, and specifically the one thing this file
 * exists to pin: WHAT THIS SCREEN SAYS WHEN IT REFUSES.
 *
 * GET /api/pilot/video/[videoId] can now answer 409 for a guardian consent
 * condition -- a photo-only consent, or a standing withdrawal. This page's
 * generic failure text is "That round would not open. Try it again.", which is
 * the right thing to say about a hiccup and the wrong thing to say about a
 * consent refusal: retrying will refuse every time until a guardian signs, and
 * a kid told to try again will sit there trying.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

import AthleteVideoAnalysisPage from './page';

jest.mock('@/components/RoleStandaloneView', () => ({
  __esModule: true,
  default: ({ children }: { readonly children: ReactNode }) => <div>{children}</div>,
}));

const video = (overrides: Record<string, unknown> = {}) => ({
  video_session_id: 'vid-1',
  title: 'Sparring round 3',
  notes: '',
  file_name: 'round3.mp4',
  file_size_bytes: 2_000_000,
  status: 'ready',
  uploaded_by_account_id: 'coach-1',
  created_at: '2026-07-30T00:00:00.000Z',
  ...overrides,
});

function mockFetch(options: { openVideo?: () => Response } = {}) {
  return jest.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/pilot/video/list')) {
      return { ok: true, json: async () => ({ items: [video()] }) } as Response;
    }
    if (url.includes('/api/pilot/shadow/observation-projection')) {
      return { ok: true, json: async () => ({ items: [] }) } as Response;
    }
    // The Play path. '/list' is handled above, so a bare id is all that is
    // left under this prefix.
    if (/\/api\/pilot\/video\/[^/]+$/.test(url)) {
      return options.openVideo
        ? options.openVideo()
        : ({ ok: true, json: async () => ({ stream_url: 'https://example.invalid/stream', title: 'Sparring round 3' }) } as Response);
    }
    return { ok: true, json: async () => ({ items: [] }) } as Response;
  });
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe("what the athlete's film screen says when it refuses", () => {
  test("a consent refusal is shown in the server's own words, not as 'try again'", async () => {
    global.fetch = mockFetch({
      openVideo: () => ({
        ok: false,
        status: 409,
        json: async () => ({
          error: "Blocked: 1 of this athlete's guardians has withdrawn media consent.",
          code: 'GUARDIAN_CONSENT_WITHDRAWN',
        }),
      }) as Response,
    }) as unknown as typeof fetch;

    render(<AthleteVideoAnalysisPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'Play' }));

    await screen.findByText("Blocked: 1 of this athlete's guardians has withdrawn media consent.");
    expect(screen.queryByText('That round would not open. Try it again.')).toBeNull();
  });

  test('a 404 keeps the retry text -- the page does not echo every status', async () => {
    // The route answers the same 404 for "not there" and "there but not
    // yours" on purpose, so there is nothing in that body worth repeating.
    // This is the test that fails if the 409 condition is ever dropped and
    // the page starts echoing whatever the server said.
    global.fetch = mockFetch({
      openVideo: () => ({
        ok: false,
        status: 404,
        json: async () => ({ error: 'Not found' }),
      }) as Response,
    }) as unknown as typeof fetch;

    render(<AthleteVideoAnalysisPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'Play' }));

    await screen.findByText('That round would not open. Try it again.');
    expect(screen.queryByText('Not found')).toBeNull();
  });

  test('a 409 with no readable body falls back to the retry text rather than showing nothing', async () => {
    global.fetch = mockFetch({
      openVideo: () => ({
        ok: false,
        status: 409,
        json: async () => { throw new Error('not json'); },
      }) as unknown as Response,
    }) as unknown as typeof fetch;

    render(<AthleteVideoAnalysisPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'Play' }));

    await screen.findByText('That round would not open. Try it again.');
  });

  test('a video that opens plays, and no refusal text is shown', async () => {
    global.fetch = mockFetch() as unknown as typeof fetch;

    render(<AthleteVideoAnalysisPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'Play' }));

    await screen.findByText('Sparring round 3', { selector: 'h2, h3, p' });
    expect(screen.queryByText('That round would not open. Try it again.')).toBeNull();
  });
});
