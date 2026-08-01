/**
 * @jest-environment jsdom
 */

// An upload is held on arrival and nothing else in the platform moves it, so
// the release control on this page is the only thing standing between a coach
// and footage that can never be played. It belongs to the coach who uploaded
// the video and to nobody else.

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

import CoachVideoAnalysisPage from './page';

jest.mock('@/components/RoleStandaloneView', () => ({
  __esModule: true,
  default: ({ children }: { readonly children: ReactNode }) => <div>{children}</div>,
}));

const SESSION_PATH = '/api/pilot/auth/session';

const video = (overrides: Record<string, unknown> = {}) => ({
  video_session_id: 'vid-1',
  title: 'Sparring round 3',
  notes: '',
  file_name: 'round3.mp4',
  file_size_bytes: 2_000_000,
  mime_type: 'video/mp4',
  status: 'quarantined',
  athlete_id: 'ath-1',
  uploaded_by_account_id: 'coach-1',
  created_at: '2026-07-30T00:00:00.000Z',
  ...overrides,
});

function mockFetch(options: {
  videos: () => Array<Record<string, unknown>>;
  release?: () => Response;
  onRelease?: () => void;
  role?: string;
}) {
  return jest.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith(SESSION_PATH)) {
      return {
        ok: true,
        json: async () => ({
          authenticated: true,
          role: options.role ?? 'coach',
          account_id: 'coach-1',
          organization_id: 'org-1',
        }),
      } as Response;
    }
    if (url.includes('/release')) {
      options.onRelease?.();
      return options.release
        ? options.release()
        : ({ ok: true, json: async () => ({ ok: true, status: 'ready' }) } as Response);
    }
    if (url.includes('/api/pilot/video/list')) {
      return { ok: true, json: async () => ({ items: options.videos() }) } as Response;
    }
    return { ok: true, json: async () => ({ items: [] }) } as Response;
  });
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('coach video release control', () => {
  test('the uploading coach is offered Release on their held video, and Play stays unavailable', async () => {
    global.fetch = mockFetch({ videos: () => [video()] }) as unknown as typeof fetch;

    render(<CoachVideoAnalysisPage />);

    await screen.findByRole('button', { name: 'Release' });
    const play = screen.getByRole('button', { name: 'Not released' });
    expect((play as HTMLButtonElement).disabled).toBe(true);
  });

  test('a coach who did not upload the video is not offered Release', async () => {
    global.fetch = mockFetch({
      videos: () => [video({ uploaded_by_account_id: 'coach-2' })],
    }) as unknown as typeof fetch;

    render(<CoachVideoAnalysisPage />);

    await screen.findByText('Held for review by the coach who uploaded it.');
    expect(screen.queryByRole('button', { name: 'Release' })).toBeNull();
  });

  test('an organization admin may release a video another coach uploaded', async () => {
    global.fetch = mockFetch({
      role: 'organization_admin',
      videos: () => [video({ uploaded_by_account_id: 'coach-2' })],
    }) as unknown as typeof fetch;

    render(<CoachVideoAnalysisPage />);

    await screen.findByRole('button', { name: 'Release' });
  });

  test('an already released video offers Play and no Release', async () => {
    global.fetch = mockFetch({ videos: () => [video({ status: 'ready' })] }) as unknown as typeof fetch;

    render(<CoachVideoAnalysisPage />);

    await screen.findByRole('button', { name: 'Play' });
    expect(screen.queryByRole('button', { name: 'Release' })).toBeNull();
  });

  test.each(['infected', 'error'])('a %s video is never offered Release', async (status) => {
    global.fetch = mockFetch({ videos: () => [video({ status })] }) as unknown as typeof fetch;

    render(<CoachVideoAnalysisPage />);

    await screen.findByText('Sparring round 3');
    expect(screen.queryByRole('button', { name: 'Release' })).toBeNull();
  });

  test('releasing reloads the library so the video becomes playable', async () => {
    let released = false;
    global.fetch = mockFetch({
      videos: () => [video({ status: released ? 'ready' : 'quarantined' })],
      onRelease: () => { released = true; },
    }) as unknown as typeof fetch;

    render(<CoachVideoAnalysisPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'Release' }));

    await screen.findByRole('button', { name: 'Play' });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Release' })).toBeNull());
  });

  test("a refused release shows the server's reason", async () => {
    global.fetch = mockFetch({
      videos: () => [video()],
      release: () => ({
        ok: false,
        status: 409,
        json: async () => ({ error: 'This video has already been released.' }),
      }) as Response,
    }) as unknown as typeof fetch;

    render(<CoachVideoAnalysisPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'Release' }));

    await screen.findByText('This video has already been released.');
  });
});
