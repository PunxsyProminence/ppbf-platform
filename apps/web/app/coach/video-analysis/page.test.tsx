/**
 * @jest-environment jsdom
 */

// An upload is held on arrival and nothing else in the platform moves it, so
// the release control on this page is the only thing standing between a coach
// and footage that can never be played. It belongs to the coach who uploaded
// the video and to nobody else.
//
// It is also the only irreversible control here, which is why so much of this
// suite is about what has to happen BEFORE it fires: the reviewer must have
// opened the footage, and must confirm. A Release that can be reached without
// looking is the rubber stamp the preview was added to prevent.

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

const athlete = (overrides: Record<string, unknown> = {}) => ({
  athlete_id: 'ath-1',
  full_name: 'Marcus Reed',
  ...overrides,
});

function mockFetch(options: {
  videos: () => Array<Record<string, unknown>>;
  athletes?: () => Array<Record<string, unknown>>;
  release?: () => Response;
  onRelease?: () => void;
  reviewLink?: () => Response;
  role?: string;
  requestFilmStudy?: () => Response;
  pollFilmStudyJob?: (jobId: string) => Response;
  proposals?: () => Array<Record<string, unknown>>;
  resolveProposal?: () => Response;
  onResolveProposal?: (body: {
    proposal_id?: string;
    verdict?: string;
    corrected_observation_text?: string;
  }) => void;
  reportObservation?: () => Response;
  onReportObservation?: (body: {
    athlete_id?: string;
    video_session_id?: string;
    observation_text?: string;
  }) => void;
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
    // The 15-minute review link behind 'Watch first'. Resolving it is what
    // records the inspection, so a test that needs Release reachable has to go
    // through here.
    if (url.includes('/api/pilot/video/review-link')) {
      return options.reviewLink
        ? options.reviewLink()
        : ({ ok: true, json: async () => ({ url: 'https://example.invalid/sas', title: 'Sparring round 3' }) } as Response);
    }
    if (url.includes('/api/pilot/athletes/list')) {
      return { ok: true, json: async () => ({ items: options.athletes ? options.athletes() : [] }) } as Response;
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
        const body = JSON.parse(String(init.body ?? '{}')) as {
          proposal_id?: string;
          verdict?: string;
          corrected_observation_text?: string;
        };
        options.onResolveProposal?.(body);
        return options.resolveProposal
          ? options.resolveProposal()
          : ({ ok: true, json: async () => ({ ok: true, proposal: {} }) } as Response);
      }
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body ?? '{}')) as {
          athlete_id?: string;
          video_session_id?: string;
          observation_text?: string;
        };
        options.onReportObservation?.(body);
        return options.reportObservation
          ? options.reportObservation()
          : ({ ok: true, status: 201, json: async () => ({ ok: true, proposal: {} }) } as Response);
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
  // jsdom has no confirm, and the release path now asks for one. Returning
  // true is "the reviewer agreed"; the refusal is asserted on its own below.
  beforeEach(() => {
    jest.spyOn(window, 'confirm').mockReturnValue(true);
  });

  // Release is gated on the reviewer having opened the footage, so every test
  // that gets as far as releasing has to watch first -- which is the point.
  const watchFirst = async () => {
    fireEvent.click(await screen.findByRole('button', { name: 'Watch first' }));
    await waitFor(() => {
      expect((screen.getByRole('button', { name: 'Release' }) as HTMLButtonElement).disabled).toBe(false);
    });
  };

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

    await watchFirst();
    fireEvent.click(screen.getByRole('button', { name: 'Release' }));

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

    await watchFirst();
    fireEvent.click(screen.getByRole('button', { name: 'Release' }));

    await screen.findByText('This video has already been released.');
  });

  test('Release is unavailable until the footage has been watched, and says so in words', async () => {
    global.fetch = mockFetch({ videos: () => [video()] }) as unknown as typeof fetch;

    render(<CoachVideoAnalysisPage />);

    const release = await screen.findByRole('button', { name: 'Release' });
    expect((release as HTMLButtonElement).disabled).toBe(true);
    // Law 3: a greyed button is colour only. The reason has to be readable.
    await screen.findByText('Watch it first — Release stays unavailable until you have opened this video for review.');
  });

  test('watching the footage unlocks Release and withdraws the explanation', async () => {
    global.fetch = mockFetch({ videos: () => [video()] }) as unknown as typeof fetch;

    render(<CoachVideoAnalysisPage />);

    await watchFirst();

    expect(
      screen.queryByText('Watch it first — Release stays unavailable until you have opened this video for review.'),
    ).toBeNull();
  });

  test('a preview that never resolves is not an inspection and does not unlock Release', async () => {
    global.fetch = mockFetch({
      videos: () => [video()],
      reviewLink: () => ({
        ok: false,
        status: 502,
        json: async () => ({ error: 'Could not issue a review link.' }),
      }) as Response,
    }) as unknown as typeof fetch;

    render(<CoachVideoAnalysisPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'Watch first' }));

    await screen.findByText('Could not issue a review link.');
    expect((screen.getByRole('button', { name: 'Release' }) as HTMLButtonElement).disabled).toBe(true);
  });

  test('watching a second video does not re-lock the first — inspection is per video', async () => {
    global.fetch = mockFetch({
      videos: () => [video(), video({ video_session_id: 'vid-2', title: 'Bag work', file_name: 'bag.mp4' })],
    }) as unknown as typeof fetch;

    render(<CoachVideoAnalysisPage />);

    fireEvent.click((await screen.findAllByRole('button', { name: 'Watch first' }))[0]);
    await waitFor(() => {
      expect((screen.getAllByRole('button', { name: 'Release' })[0] as HTMLButtonElement).disabled).toBe(false);
    });

    fireEvent.click(screen.getAllByRole('button', { name: 'Watch first' })[1]);
    await waitFor(() => {
      expect((screen.getAllByRole('button', { name: 'Release' })[1] as HTMLButtonElement).disabled).toBe(false);
    });

    // The player is a single slot, so the second video replaced the first in
    // it. That is not the first video's inspection being taken back -- gating
    // on the open player rather than on a set of ids would have said it was.
    expect((screen.getAllByRole('button', { name: 'Release' })[0] as HTMLButtonElement).disabled).toBe(false);
  });

  test('declining the confirm releases nothing', async () => {
    jest.spyOn(window, 'confirm').mockReturnValue(false);
    let releaseCalls = 0;
    global.fetch = mockFetch({
      videos: () => [video()],
      onRelease: () => { releaseCalls += 1; },
    }) as unknown as typeof fetch;

    render(<CoachVideoAnalysisPage />);

    await watchFirst();
    fireEvent.click(screen.getByRole('button', { name: 'Release' }));

    // Nothing is sent, and the video is still held -- a coach who thought
    // better of it must not find the footage playable anyway.
    await waitFor(() => expect(releaseCalls).toBe(0));
    expect(screen.getByRole('button', { name: 'Not released' })).toBeTruthy();
  });

  test('releasing asks first, naming who can then play the footage', async () => {
    const confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(true);
    global.fetch = mockFetch({ videos: () => [video()] }) as unknown as typeof fetch;

    render(<CoachVideoAnalysisPage />);

    await watchFirst();
    fireEvent.click(screen.getByRole('button', { name: 'Release' }));

    await waitFor(() => expect(confirmSpy).toHaveBeenCalledTimes(1));
    expect(confirmSpy.mock.calls[0][0]).toContain('the athlete and their guardians');
  });
});

describe('athlete identity on this page', () => {
  test('the library names the athlete rather than printing their id', async () => {
    global.fetch = mockFetch({
      videos: () => [video()],
      athletes: () => [athlete()],
    }) as unknown as typeof fetch;

    render(<CoachVideoAnalysisPage />);

    await screen.findByText(/Athlete: Marcus Reed/);
  });

  test('an id the roster read did not return still identifies the row', async () => {
    global.fetch = mockFetch({
      videos: () => [video({ athlete_id: 'ath-off-roster' })],
      athletes: () => [athlete()],
    }) as unknown as typeof fetch;

    render(<CoachVideoAnalysisPage />);

    // Falling back to the raw id is worse than a name and far better than a
    // blank: the row is about a real minor and has to stay traceable.
    await screen.findByText(/Athlete: ath-off-roster/);
  });

  test('the review queue names the athlete a proposal is about', async () => {
    global.fetch = mockFetch({
      videos: () => [],
      athletes: () => [athlete()],
      proposals: () => [{
        proposal_id: 'prop-1',
        athlete_id: 'ath-1',
        video_session_id: 'vid-1',
        origin: 'model_proposed',
        observation_text: 'Athlete kept guard low in round 2.',
        model_deployment: 'gpt-4o-vision',
        frames_analyzed: 12,
        review_state: 'pending_review',
        created_at: '2026-08-04T00:00:00.000Z',
      }],
    }) as unknown as typeof fetch;

    render(<CoachVideoAnalysisPage />);

    await screen.findByText(/Athlete: Marcus Reed · 12 frame\(s\) · gpt-4o-vision/);
  });

  test('the upload form picks an athlete from the roster instead of asking for a UUID', async () => {
    global.fetch = mockFetch({
      videos: () => [],
      athletes: () => [athlete(), athlete({ athlete_id: 'ath-2', full_name: 'Dana Whitcomb' })],
    }) as unknown as typeof fetch;

    render(<CoachVideoAnalysisPage />);

    const picker = await screen.findByLabelText('Athlete (optional)');
    expect(picker.tagName).toBe('SELECT');
    await waitFor(() => expect(within(picker).getByRole('option', { name: 'Dana Whitcomb' })).toBeTruthy());
    // Optional means optional: linking no athlete has to stay reachable.
    expect((within(picker).getByRole('option', { name: 'Not linked to one athlete…' }) as HTMLOptionElement).value)
      .toBe('');
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
    origin: 'model_proposed',
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

  test('correcting sends the replacement wording, not just a verdict', async () => {
    let recorded: { verdict?: string; corrected_observation_text?: string } = {};
    global.fetch = mockFetch({
      videos: () => [],
      proposals: () => [proposal()],
      onResolveProposal: (body) => { recorded = body; },
    }) as unknown as typeof fetch;

    render(<CoachVideoAnalysisPage />);

    fireEvent.change(await screen.findByLabelText('Corrected observation (only needed if you are correcting)'), {
      target: { value: 'Guard dropped in round 3, not round 2.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Correct' }));

    await waitFor(() => expect(recorded.verdict).toBe('corrected'));
    expect(recorded.corrected_observation_text).toBe('Guard dropped in round 3, not round 2.');
  });

  test('a correction with no wording is refused before anything is sent', async () => {
    let called = false;
    global.fetch = mockFetch({
      videos: () => [],
      proposals: () => [proposal()],
      onResolveProposal: () => { called = true; },
    }) as unknown as typeof fetch;

    render(<CoachVideoAnalysisPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'Correct' }));

    // An empty rewrite would settle as 'corrected' while reading, downstream,
    // as agreement.
    await screen.findByText('Write the corrected observation before recording a correction.');
    expect(called).toBe(false);
    expect(screen.getByText('Athlete kept guard low in round 2.')).toBeTruthy();
  });

  test('a coach-reported observation says the model did not propose it', async () => {
    global.fetch = mockFetch({
      videos: () => [],
      proposals: () => [proposal({
        origin: 'coach_reported',
        observation_text: 'Head stayed still on the slip.',
        model_deployment: null,
        frames_analyzed: null,
      })],
    }) as unknown as typeof fetch;

    render(<CoachVideoAnalysisPage />);

    await screen.findByText('Head stayed still on the slip.');
    // It must not render "null frame(s) · null" -- a coach entry has no
    // inference run to describe, and saying so is the point of the row.
    await screen.findByText(/reported by a coach — the model did not propose this/);
  });
});

describe('recording what the model missed', () => {
  // Neither id is typed any more, so the form can only be filled from the
  // roster read and the video library -- which is the fix. A test that
  // supplies neither is testing an empty picker, not a coach's entry.
  const fillMissedForm = async () => {
    await waitFor(() => expect(within(screen.getByLabelText('Athlete')).getByRole('option', { name: 'Marcus Reed' })).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Athlete'), { target: { value: 'ath-1' } });
    fireEvent.change(screen.getByLabelText('Video session'), { target: { value: 'vid-1' } });
    fireEvent.change(screen.getByLabelText('What did you see that the model did not raise?'), {
      target: { value: 'Model said nothing about the head staying still.' },
    });
  };

  test('a coach picks the athlete and the video by name, and the ids still reach the server', async () => {
    let recorded: { athlete_id?: string; video_session_id?: string; observation_text?: string } = {};
    global.fetch = mockFetch({
      videos: () => [video()],
      athletes: () => [athlete()],
      proposals: () => [],
      onReportObservation: (body) => { recorded = body; },
    }) as unknown as typeof fetch;

    render(<CoachVideoAnalysisPage />);
    await screen.findByText('No Film Study observations awaiting review.');

    await fillMissedForm();
    fireEvent.click(screen.getByRole('button', { name: 'Add to review queue' }));

    await waitFor(() => expect(recorded.athlete_id).toBe('ath-1'));
    expect(recorded.video_session_id).toBe('vid-1');
    expect(recorded.observation_text).toBe('Model said nothing about the head staying still.');
  });

  test('the video is chosen from the library the page already lists', async () => {
    global.fetch = mockFetch({
      videos: () => [video()],
      athletes: () => [athlete()],
      proposals: () => [],
    }) as unknown as typeof fetch;

    render(<CoachVideoAnalysisPage />);

    const picker = await screen.findByLabelText('Video session');
    expect(picker.tagName).toBe('SELECT');
    // Title plus file name: two sessions can share a title, and the coach has
    // to be able to tell which clip they just watched.
    await waitFor(() => {
      expect((within(picker).getByRole('option', { name: 'Sparring round 3 · round3.mp4' }) as HTMLOptionElement).value)
        .toBe('vid-1');
    });
  });

  test('an empty library says there is nothing to record against', async () => {
    global.fetch = mockFetch({
      videos: () => [],
      athletes: () => [athlete()],
      proposals: () => [],
    }) as unknown as typeof fetch;

    render(<CoachVideoAnalysisPage />);

    // An empty picker on its own reads as a broken form.
    await screen.findByText('No videos in the library yet, so there is nothing to record an observation against.');
  });

  test('an incomplete entry is refused before anything is sent', async () => {
    let called = false;
    global.fetch = mockFetch({
      videos: () => [video()],
      athletes: () => [athlete()],
      proposals: () => [],
      onReportObservation: () => { called = true; },
    }) as unknown as typeof fetch;

    render(<CoachVideoAnalysisPage />);
    await screen.findByText('No Film Study observations awaiting review.');

    await waitFor(() => expect(within(screen.getByLabelText('Athlete')).getByRole('option', { name: 'Marcus Reed' })).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Athlete'), { target: { value: 'ath-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add to review queue' }));

    await screen.findByText('Athlete, video and the observation are all required.');
    expect(called).toBe(false);
  });

  test("a refused entry shows the server's reason", async () => {
    global.fetch = mockFetch({
      videos: () => [video()],
      athletes: () => [athlete()],
      proposals: () => [],
      reportObservation: () => ({
        ok: false,
        status: 403,
        json: async () => ({ ok: false, error: 'Forbidden: that athlete is not on your roster.' }),
      }) as Response,
    }) as unknown as typeof fetch;

    render(<CoachVideoAnalysisPage />);
    await screen.findByText('No Film Study observations awaiting review.');

    await fillMissedForm();
    fireEvent.click(screen.getByRole('button', { name: 'Add to review queue' }));

    await screen.findByText('Forbidden: that athlete is not on your roster.');
  });

  test('a recorded observation reloads the queue rather than assuming it landed', async () => {
    let submitted = false;
    global.fetch = mockFetch({
      videos: () => [video()],
      athletes: () => [athlete()],
      // It lands pending like anything else, so it must appear in the queue
      // above rather than counting itself as settled.
      proposals: () => (submitted
        ? [{
          proposal_id: 'prop-2',
          athlete_id: 'ath-1',
          video_session_id: 'vid-1',
          origin: 'coach_reported',
          observation_text: 'Head stayed still on the slip.',
          model_deployment: null,
          frames_analyzed: null,
          review_state: 'pending_review',
          created_at: '2026-08-04T00:00:00.000Z',
        }]
        : []),
      onReportObservation: () => { submitted = true; },
    }) as unknown as typeof fetch;

    render(<CoachVideoAnalysisPage />);
    await screen.findByText('No Film Study observations awaiting review.');

    await fillMissedForm();
    fireEvent.click(screen.getByRole('button', { name: 'Add to review queue' }));

    await screen.findByText('Head stayed still on the slip.');
  });
});
