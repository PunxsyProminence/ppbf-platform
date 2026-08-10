/**
 * @jest-environment jsdom
 */

// An upload is held on arrival and nothing else in the platform moves it, so
// the release control on this page is the only thing standing between a coach
// and footage that can never be played. It belongs to the coach who uploaded
// the video and to nobody else.

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  requestFilmStudy?: () => Response;
  pollFilmStudyJob?: (jobId: string) => Response;
  proposals?: () => Array<Record<string, unknown>>;
  resolveProposal?: () => Response;
  onResolveProposal?: (body: { proposal_id?: string; verdict?: string }) => void;
}) {
  return jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
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
    if (url.includes('/api/pilot/shadow/video-analysis')) {
      if (init?.method === 'POST') {
        return options.requestFilmStudy
          ? options.requestFilmStudy()
          : ({
            ok: true,
            status: 202,
            json: async () => ({ ok: true, jobId: 'job-1', status: 'queued', message: 'Film Study queued.' }),
          } as Response);
      }
      const jobId = url.split('jobId=')[1] ?? '';
      return options.pollFilmStudyJob
        ? options.pollFilmStudyJob(decodeURIComponent(jobId))
        : ({
          ok: true,
          json: async () => ({ ok: true, jobId, status: 'completed', message: 'Video analysis job completed.' }),
        } as Response);
    }
    if (url.includes('/api/pilot/shadow/film-study/proposals')) {
      if (init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body ?? '{}')) as { proposal_id?: string; verdict?: string };
        options.onResolveProposal?.(body);
        return options.resolveProposal
          ? options.resolveProposal()
          : ({ ok: true, json: async () => ({ ok: true, proposal: {} }) } as Response);
      }
      return { ok: true, json: async () => ({ ok: true, proposals: options.proposals ? options.proposals() : [] }) } as Response;
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

describe('requesting Film Study analysis', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  test('a released video offers Request Film Study', async () => {
    global.fetch = mockFetch({ videos: () => [video({ status: 'ready' })] }) as unknown as typeof fetch;

    render(<CoachVideoAnalysisPage />);

    await screen.findByRole('button', { name: 'Request Film Study' });
  });

  test('a video still held for review does not offer Request Film Study', async () => {
    global.fetch = mockFetch({ videos: () => [video()] }) as unknown as typeof fetch;

    render(<CoachVideoAnalysisPage />);

    await screen.findByText('Sparring round 3');
    expect(screen.queryByRole('button', { name: 'Request Film Study' })).toBeNull();
  });

  test('requesting shows the queued message, then the completed message once the job settles', async () => {
    jest.useFakeTimers();
    global.fetch = mockFetch({
      videos: () => [video({ status: 'ready' })],
      requestFilmStudy: () => ({
        ok: true,
        status: 202,
        json: async () => ({ ok: true, jobId: 'job-1', status: 'queued', message: 'Film Study queued.' }),
      }) as Response,
      pollFilmStudyJob: () => ({
        ok: true,
        json: async () => ({ ok: true, jobId: 'job-1', status: 'completed', message: 'Video analysis job completed.' }),
      }) as Response,
    }) as unknown as typeof fetch;

    render(<CoachVideoAnalysisPage />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Request Film Study' }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText('Film Study: Film Study queued.')).toBeTruthy();

    await act(async () => {
      jest.advanceTimersByTime(3_000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText('Film Study: Video analysis job completed.')).toBeTruthy();
  });

  test('an unconfigured Film Study deployment shows the server reason, not a generic error', async () => {
    global.fetch = mockFetch({
      videos: () => [video({ status: 'ready' })],
      requestFilmStudy: () => ({
        ok: false,
        status: 503,
        json: async () => ({
          ok: false,
          jobId: '',
          status: 'unavailable',
          message: 'Film Study is not enabled in this environment. No analysis job was created.',
        }),
      }) as Response,
    }) as unknown as typeof fetch;

    render(<CoachVideoAnalysisPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'Request Film Study' }));

    await screen.findByText('Film Study: Film Study is not enabled in this environment. No analysis job was created.');
    // 'unavailable' is a terminal state, not an in-flight one -- the button
    // must not stay stuck disabled after a refusal the coach could act on
    // (e.g. try a different video).
    expect((screen.getByRole('button', { name: 'Request Film Study' }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('Film Study review queue', () => {
  const proposal = (overrides: Record<string, unknown> = {}) => ({
    proposal_id: 'prop-1',
    athlete_id: 'ath-1',
    video_session_id: 'vid-1',
    observation_text: 'Athlete kept guard low in round 2.',
    model_deployment: 'gpt-4o-vision',
    frames_analyzed: 12,
    review_state: 'pending_review',
    created_at: '2026-08-04T00:00:00.000Z',
    ...overrides,
  });

  test('lists a pending observation for review', async () => {
    global.fetch = mockFetch({ videos: () => [], proposals: () => [proposal()] }) as unknown as typeof fetch;

    render(<CoachVideoAnalysisPage />);

    await screen.findByText('Athlete kept guard low in round 2.');
  });

  test('an empty queue says so rather than showing nothing', async () => {
    global.fetch = mockFetch({ videos: () => [], proposals: () => [] }) as unknown as typeof fetch;

    render(<CoachVideoAnalysisPage />);

    await screen.findByText('No Film Study observations awaiting review.');
  });

  test('accepting a proposal sends the accepted verdict and removes it from the queue', async () => {
    let recordedVerdict: string | undefined;
    global.fetch = mockFetch({
      videos: () => [],
      proposals: () => [proposal()],
      onResolveProposal: (body) => { recordedVerdict = body.verdict; },
    }) as unknown as typeof fetch;

    render(<CoachVideoAnalysisPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'Accept' }));

    await waitFor(() => expect(screen.queryByText('Athlete kept guard low in round 2.')).toBeNull());
    expect(recordedVerdict).toBe('accepted');
  });

  test('rejecting a proposal sends the rejected verdict and removes it from the queue', async () => {
    let recordedVerdict: string | undefined;
    global.fetch = mockFetch({
      videos: () => [],
      proposals: () => [proposal()],
      onResolveProposal: (body) => { recordedVerdict = body.verdict; },
    }) as unknown as typeof fetch;

    render(<CoachVideoAnalysisPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'Reject' }));

    await waitFor(() => expect(screen.queryByText('Athlete kept guard low in round 2.')).toBeNull());
    expect(recordedVerdict).toBe('rejected');
  });

  test('a proposal already settled by another reviewer shows the server reason', async () => {
    global.fetch = mockFetch({
      videos: () => [],
      proposals: () => [proposal()],
      resolveProposal: () => ({
        ok: false,
        status: 409,
        json: async () => ({
          ok: false,
          error: 'This proposal was already accepted by another reviewer. A recorded verdict cannot be replaced.',
        }),
      }) as Response,
    }) as unknown as typeof fetch;

    render(<CoachVideoAnalysisPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'Accept' }));

    await screen.findByText('This proposal was already accepted by another reviewer. A recorded verdict cannot be replaced.');
    // A rejected write must not silently clear a real proposal from view --
    // the coach still needs to see it to retry or escalate.
    expect(screen.getByText('Athlete kept guard low in round 2.')).toBeTruthy();
  });
});
