/**
 * @jest-environment jsdom
 */

// The annotation bench.
//
// What this suite pins is the half of the contract that lives in the browser:
// an annotator cannot leave the clip, cannot type into a submitted set, and is
// never shown a visibility or certainty field they could skip. The server
// enforces all three again (and the database under it), so nothing here is the
// only guard -- but the page is where a coach actually meets the rules, and a
// page that quietly lets them past one produces work that gets refused on save.

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

import { BODY_POINTS_0_4 } from '@/src/server/pilot/calibration/ontology';

import CoachCalibrationPage from './page';

jest.mock('@/components/RoleStandaloneView', () => ({
  __esModule: true,
  default: ({ children }: { readonly children: ReactNode }) => <div>{children}</div>,
}));

const PROJECT = {
  calibration_project_id: 'proj-1',
  name: 'Pilot study',
  ontology_version: 'boxing-ontology-0.1',
  status: 'annotating',
};

const CLIP = {
  calibration_clip_id: 'clip-1',
  calibration_project_id: 'proj-1',
  video_session_id: 'vid-1',
  athlete_id: 'ath-1',
  clip_code: 'C-01',
  start_ms: 12_000,
  end_ms: 18_000,
  primary_sampling_reason: 'combination',
  playable: true,
};

const OPEN_SET = {
  annotation_set_id: 'set-1',
  calibration_clip_id: 'clip-1',
  annotator_account_id: 'coach-1',
  ontology_version: 'boxing-ontology-0.1',
  status: 'in_progress',
  submitted_at: null,
};

const PUNCH_EVENT = {
  event_id: 'evt-1',
  event_class: 'punch',
  actor_track: 'red corner',
  opponent_track: null,
  start_ms: 12_400,
  end_ms: 12_800,
  contact_ms: null,
  peak_ms: null,
  physical_hand: 'left',
  hand_role: 'lead',
  stance: null,
  punch_type: 'lead_straight',
  target_zone: 'head',
  contact_result: 'clean_target_contact',
  contact_zone: null,
  defense_type: null,
  visibility: 'partially_occluded',
  certainty: 'probable',
  combination_group: null,
  sequence_order: null,
  counter_against_event_id: null,
  defends_against_event_id: null,
};

const BODY_POINT_SET = { ...OPEN_SET, ontology_version: 'boxing-ontology-0.4' };

/* A body-points answer with one moment opened and two points on it, as the
   server shapes it: the set's own point list in marking order (0.4's 23),
   and the missing list in the server's wording verbatim. */
const BODY_DATA = {
  ok: true,
  set: BODY_POINT_SET,
  expected_points: [...BODY_POINTS_0_4],
  moments: [
    {
      body_moment_id: 'mom-1',
      event_id: 'evt-1',
      moment_slot: 'start',
      moment_kind: 'start',
      observation_ms: 12_400,
      event_start_ms: 12_400,
      event_end_ms: 12_800,
      lead_side: 'orthodox',
      guard_type: null,
      source_frame_width_px: null,
      source_frame_height_px: null,
      points: [
        { body_point_id: 'p-1', point_code: 'nose', state: 'placed', x_norm: 0.5, y_norm: 0.2 },
        { body_point_id: 'p-2', point_code: 'chin', state: 'not_visible', x_norm: null, y_norm: null },
      ],
    },
  ],
  stance_labels: [],
  missing: [
    'evt-1: end moment',
    'evt-1: middle moment',
    'evt-1: stance type',
    'evt-1: start guard',
    'evt-1: start points, 2 of 23',
  ],
};

interface Options {
  set?: unknown;
  events?: unknown[];
  eventsResponse?: () => { ok: boolean; body: unknown };
  /** The body-points answer: a value, or a function called per read (which
   * may return a promise, or throw to stand for a network failure). */
  bodyData?: unknown | (() => unknown);
  bodyDataOk?: boolean;
  submitResponse?: () => { ok: boolean; body: unknown };
  /** The set the submit route answers with (before its status is set). */
  submitSet?: unknown;
  /** A body-points write's answer; undefined falls back to the echo. */
  bodyWriteResponse?: (path: string, method: string, body: Record<string, unknown>) => { ok: boolean; body: unknown } | undefined;
}

const calls: Array<{ url: string; method: string; body: unknown }> = [];

function mockFetch(options: Options = {}) {
  return jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({
      url,
      method,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
    });

    const json = (body: unknown, ok = true) => ({
      ok,
      status: ok ? 200 : 400,
      json: async () => body,
      headers: new Headers(),
    } as unknown as Response);

    if (url.includes('/api/pilot/calibration/projects')) {
      return json({ ok: true, projects: [PROJECT] });
    }
    if (url.includes('/api/pilot/calibration/clips')) {
      return json({ ok: true, clips: [CLIP] });
    }
    if (url.includes('/api/pilot/calibration/body-points/')) {
      const path = url.slice(url.indexOf('/body-points/') + '/body-points'.length);
      const sent = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {};
      const outcome = options.bodyWriteResponse?.(path, method, sent);
      if (outcome) return json(outcome.body, outcome.ok);
      // The routes' own shapes, echoing what was sent.
      if (path === '/moments' && method === 'POST') {
        return json({ ok: true, moment: { ...BODY_DATA.moments[0], body_moment_id: 'mom-new', event_id: sent.event_id, moment_slot: sent.moment_slot, observation_ms: sent.observation_ms ?? 12_400, points: [] } });
      }
      if (path === '/moments' && method === 'PUT') {
        return json({ ok: true, moment: { ...BODY_DATA.moments[0], lead_side: sent.lead_side ?? null, guard_type: sent.guard_type ?? null, points: undefined } });
      }
      if (path === '/points' && method === 'PUT') {
        const marks = sent.points as { point_code: string; state: string; x_norm?: number; y_norm?: number }[];
        return json({
          ok: true,
          points: [
            ...BODY_DATA.moments[0].points.filter((p) => !marks.some((m) => m.point_code === p.point_code)),
            ...marks.map((m, i) => ({ body_point_id: `p-new-${i}`, point_code: m.point_code, state: m.state, x_norm: m.x_norm ?? null, y_norm: m.y_norm ?? null })),
          ],
        });
      }
      if (path === '/stance' && method === 'PUT') {
        return json({ ok: true, stance_label: { event_id: sent.event_id, stance_type: sent.stance_type } });
      }
      return json({ ok: true });
    }
    if (url.includes('/api/pilot/calibration/body-points')) {
      if (options.bodyDataOk === false) {
        return json({ error: 'Not found: no such annotation set in this organization' }, false);
      }
      const answer = typeof options.bodyData === 'function'
        ? (options.bodyData as () => unknown)()
        : options.bodyData ?? BODY_DATA;
      return json(await answer);
    }
    if (url.includes('/api/pilot/calibration/annotation-set/submit')) {
      if (options.submitResponse) {
        const outcome = options.submitResponse();
        return json(outcome.body, outcome.ok);
      }
      const base = (options.submitSet ?? OPEN_SET) as typeof OPEN_SET;
      return json({
        ok: true,
        set: { ...base, status: 'submitted', submitted_at: '2026-08-27T10:00:00.000Z' },
        event_count: 1,
      });
    }
    if (url.includes('/api/pilot/calibration/annotation-set')) {
      if (method === 'POST') {
        return json({ ok: true, created: true, set: OPEN_SET });
      }
      return json({
        ok: true,
        project: PROJECT,
        clip: CLIP,
        set: options.set === undefined ? OPEN_SET : options.set,
        events: options.events ?? [],
      });
    }
    if (url.includes('/api/pilot/calibration/events')) {
      const outcome = options.eventsResponse?.() ?? { ok: true, body: { ok: true } };
      return json(outcome.body, outcome.ok);
    }
    if (url.includes('/api/pilot/teach-shadow/footage/')) {
      // The teaching door's own response shape, not the Film Study route's:
      // it carries no `title`, and a mock that offered one would let a later
      // change read a field the live route never sends.
      return json({
        ok: true,
        video_session_id: 'vid-1',
        file_name: 'take-1.mp4',
        stream_url: 'https://blob.example/clip.mp4?sig=abc',
        expires_in_minutes: 60,
      });
    }
    // NO BRANCH FOR THE FILM STUDY VIDEO ROUTE, deliberately. That route
    // refuses take-backed footage, which is the only footage a clip can come
    // from, so a page that asked it would get no stream -- and gets none here.
    return json({ ok: true });
  }) as unknown as typeof fetch;
}

async function openClip() {
  await act(async () => {
    render(<CoachCalibrationPage />);
  });
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Calibration project'), { target: { value: 'proj-1' } });
  });
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Clip'), { target: { value: 'clip-1' } });
  });
}

beforeEach(() => {
  calls.length = 0;
});

afterEach(() => {
  jest.restoreAllMocks();
});

test('opening a clip starts the playhead at the clip start, not at zero', async () => {
  global.fetch = mockFetch();

  await openClip();

  expect(screen.getByTestId('playhead').textContent).toContain('0:12.000');
  expect(screen.getByTestId('playhead').textContent).toContain('0:00.000 into the clip');
});

test('the stream comes from the teaching footage door, never the Film Study route or the review link', async () => {
  /*
   * THIS TEST USED TO PIN THE DEFECT. It required the Film Study video route,
   * which refuses take-backed footage -- the only footage a clip can be cut
   * from -- so the suite was green while the labelling screen could not play
   * a single clip it was allowed to show.
   */
  global.fetch = mockFetch();

  await openClip();

  const streamCalls = calls.filter((call) => call.url.includes('/api/pilot/teach-shadow/footage/'));
  expect(streamCalls).toHaveLength(1);
  expect(streamCalls[0].url).toMatch(/\/api\/pilot\/teach-shadow\/footage\/vid-1\/stream$/);
  expect(streamCalls[0].method).toBe('GET');
  expect(calls.some((call) => call.url.includes('/api/pilot/video'))).toBe(false);
  expect(calls.some((call) => call.url.includes('review-link'))).toBe(false);

  // And the player actually received it: a page that asked the right door and
  // dropped the answer would pass every assertion above.
  await waitFor(() => {
    expect(document.querySelector('video')?.getAttribute('src')).toBe('https://blob.example/clip.mp4?sig=abc');
  });
});

test('seeking past the end of the clip lands on the end, not past it', async () => {
  global.fetch = mockFetch();

  await openClip();

  await act(async () => {
    fireEvent.change(screen.getByLabelText('Seek within the clip'), { target: { value: '99000' } });
  });
  expect(screen.getByTestId('playhead').textContent).toContain('0:18.000');

  await act(async () => {
    fireEvent.change(screen.getByLabelText('Seek within the clip'), { target: { value: '0' } });
  });
  expect(screen.getByTestId('playhead').textContent).toContain('0:12.000');
});

test('stepping forward past the end of the clip stops at the end', async () => {
  global.fetch = mockFetch();

  await openClip();

  // Eight one-second steps from 12.000 would reach 20.000; the clip ends at
  // 18.000. Deliberately driven through the step buttons rather than the range
  // input: a range element clamps to its own max in the browser, so a test
  // that only scrubbed would pass with no clamp in the page at all.
  for (let i = 0; i < 8; i += 1) {
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '+1000ms' }));
    });
  }

  expect(screen.getByTestId('playhead').textContent).toContain('0:18.000');
});

test('stepping backward from the clip start does not walk out of the clip', async () => {
  global.fetch = mockFetch();

  await openClip();

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: '-1000ms' }));
  });

  expect(screen.getByTestId('playhead').textContent).toContain('0:12.000');
});

test('a punch form asks for visibility and certainty in the open, not behind a disclosure', async () => {
  global.fetch = mockFetch();

  await openClip();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Add punch' }));
  });

  const visibility = screen.getByLabelText('Visibility (of the footage)');
  const certainty = screen.getByLabelText('Certainty (yours)');
  expect(visibility).toBeTruthy();
  expect(certainty).toBeTruthy();
  // Neither may sit inside the collapsed <details> block.
  expect(visibility.closest('details')).toBeNull();
  expect(certainty.closest('details')).toBeNull();
  // And neither is answered for the annotator.
  expect((visibility as HTMLSelectElement).value).toBe('');
  expect((certainty as HTMLSelectElement).value).toBe('');
});

test('a punch is posted with the labels the annotator chose', async () => {
  global.fetch = mockFetch();

  await openClip();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Add punch' }));
  });

  await act(async () => {
    fireEvent.change(screen.getByLabelText('Actor (which fighter)'), { target: { value: 'red corner' } });
    fireEvent.change(screen.getByLabelText('Punch type'), { target: { value: 'rear_hook' } });
    fireEvent.change(screen.getByLabelText('Physical hand'), { target: { value: 'right' } });
    fireEvent.change(screen.getByLabelText('Hand role'), { target: { value: 'rear' } });
    fireEvent.change(screen.getByLabelText('Target zone (aimed at)'), { target: { value: 'torso' } });
    fireEvent.change(screen.getByLabelText('Contact result'), { target: { value: 'guard_contact' } });
    fireEvent.change(screen.getByLabelText('Visibility (of the footage)'), { target: { value: 'clear' } });
    fireEvent.change(screen.getByLabelText('Certainty (yours)'), { target: { value: 'uncertain' } });
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Save event' }));
  });

  const write = calls.find((call) => call.url.includes('/calibration/events'));
  expect(write?.method).toBe('POST');
  expect(write?.body).toMatchObject({
    annotation_set_id: 'set-1',
    event_class: 'punch',
    actor_track: 'red corner',
    punch_type: 'rear_hook',
    physical_hand: 'right',
    hand_role: 'rear',
    target_zone: 'torso',
    contact_result: 'guard_contact',
    visibility: 'clear',
    certainty: 'uncertain',
    start_ms: 12_000,
  });
});

test('a defense is posted with no punch fields attached to it', async () => {
  global.fetch = mockFetch();

  await openClip();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Add defense' }));
  });
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Actor (which fighter)'), { target: { value: 'blue corner' } });
    fireEvent.change(screen.getByLabelText('Defense type'), { target: { value: 'slip' } });
    fireEvent.change(screen.getByLabelText('Visibility (of the footage)'), { target: { value: 'camera_cut' } });
    fireEvent.change(screen.getByLabelText('Certainty (yours)'), { target: { value: 'probable' } });
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Save event' }));
  });

  const write = calls.find((call) => call.url.includes('/calibration/events'));
  const body = write?.body as Record<string, unknown>;
  expect(body.event_class).toBe('defense');
  expect(body.defense_type).toBe('slip');
  expect(body.punch_type).toBe('');
  expect(body.target_zone).toBe('');
  expect(body.contact_result).toBe('');
  expect(body.combination_group).toBe('');
});

test('a span that runs backwards is refused before it reaches the server', async () => {
  global.fetch = mockFetch();

  await openClip();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Add punch' }));
  });
  await act(async () => {
    fireEvent.change(screen.getByLabelText('End (ms, video time)'), { target: { value: '12000' } });
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Save event' }));
  });

  expect(screen.getByRole('alert').textContent).toContain('stay inside the clip');
  expect(calls.some((call) => call.url.includes('/calibration/events'))).toBe(false);
});

test('a timestamp typed outside the clip is pulled back to the clip', async () => {
  global.fetch = mockFetch();

  await openClip();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Add punch' }));
  });
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Start (ms, video time)'), { target: { value: '999999' } });
  });

  expect((screen.getByLabelText('Start (ms, video time)') as HTMLInputElement).value).toBe('18000');
});

test('an existing event can be edited, and the edit replaces that event', async () => {
  global.fetch = mockFetch({ events: [PUNCH_EVENT] });

  await openClip();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
  });

  expect((screen.getByLabelText('Punch type') as HTMLSelectElement).value).toBe('lead_straight');

  await act(async () => {
    fireEvent.change(screen.getByLabelText('Punch type'), { target: { value: 'lead_hook' } });
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Save replacement' }));
  });

  const write = calls.find((call) => call.url.includes('/calibration/events'));
  expect(write?.method).toBe('PUT');
  expect(write?.body).toMatchObject({ event_id: 'evt-1', punch_type: 'lead_hook' });
});

test('an event can be withdrawn', async () => {
  global.fetch = mockFetch({ events: [PUNCH_EVENT] });

  await openClip();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
  });

  const write = calls.find((call) => call.url.includes('/calibration/events'));
  expect(write?.method).toBe('DELETE');
  expect(write?.body).toMatchObject({ annotation_set_id: 'set-1', event_id: 'evt-1' });
});

test('a refusal from the server is shown to the annotator in its own words', async () => {
  global.fetch = mockFetch({
    eventsResponse: () => ({
      ok: false,
      body: { error: 'Missing punch_type: not a value in boxing-ontology-0.1' },
    }),
  });

  await openClip();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Add punch' }));
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Save event' }));
  });

  await waitFor(() => {
    expect(screen.getByRole('alert').textContent).toContain('Missing punch_type');
  });
});

test('submitting takes a confirmation and then locks the set', async () => {
  global.fetch = mockFetch({ events: [PUNCH_EVENT] });

  await openClip();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Submit annotation set' }));
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /Yes, submit 1 event/ }));
  });

  expect(calls.some((call) => call.url.includes('/annotation-set/submit'))).toBe(true);
  expect(screen.getByText('Submitted · read-only')).toBeTruthy();
});

describe('a submitted set', () => {
  const SUBMITTED = { ...OPEN_SET, status: 'submitted', submitted_at: '2026-08-01T00:00:00.000Z' };

  test('offers no way to add, edit, delete or submit again', async () => {
    global.fetch = mockFetch({ set: SUBMITTED, events: [PUNCH_EVENT] });

    await openClip();

    expect(screen.queryByRole('button', { name: 'Add punch' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add defense' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Submit annotation set' })).toBeNull();
  });

  test('says plainly that it cannot be reopened, and still shows the work', async () => {
    global.fetch = mockFetch({ set: SUBMITTED, events: [PUNCH_EVENT] });

    await openClip();

    expect(screen.getAllByText(/read-only/).length).toBeGreaterThan(0);
    expect(screen.getAllByTestId('annotation-event')).toHaveLength(1);
    expect(screen.getByText(/visibility partially occluded/)).toBeTruthy();
  });

  test('a status this build does not recognise is treated as closed', async () => {
    global.fetch = mockFetch({ set: { ...OPEN_SET, status: 'adjudicated' }, events: [] });

    await openClip();

    expect(screen.queryByRole('button', { name: 'Add punch' })).toBeNull();
  });
});

test('a clip with no set of the annotator\'s own offers to open one', async () => {
  global.fetch = mockFetch({ set: null });

  await openClip();

  expect(screen.getByRole('button', { name: 'Open my annotation set' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Add punch' })).toBeNull();

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Open my annotation set' }));
  });

  const open = calls.find(
    (call) => call.url.endsWith('/calibration/annotation-set') && call.method === 'POST',
  );
  expect(open?.body).toMatchObject({ calibration_clip_id: 'clip-1' });
});

describe('body points', () => {
  const bodyPointCalls = () => calls.filter((call) => call.url.includes('/api/pilot/calibration/body-points'));

  test('a 0.1 set is never asked for body points and shows no body-point section', async () => {
    global.fetch = mockFetch({ events: [PUNCH_EVENT] });

    await openClip();
    // And after an event write, which is when a body-point set re-reads.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    });

    expect(bodyPointCalls()).toHaveLength(0);
    expect(screen.queryByTestId('body-point-progress')).toBeNull();
    expect(screen.getByRole('button', { name: 'Add punch' })).toBeTruthy();
  });

  test('a body-point set reads its marks and shows the server\'s count and missing list', async () => {
    global.fetch = mockFetch({ set: BODY_POINT_SET, events: [PUNCH_EVENT] });

    await openClip();

    const reads = bodyPointCalls();
    expect(reads).toHaveLength(1);
    expect(reads[0].method).toBe('GET');
    expect(reads[0].url).toMatch(/\/api\/pilot\/calibration\/body-points\?annotation_set_id=set-1$/);

    const section = screen.getByTestId('body-point-progress');
    expect(section.textContent).toContain('5 items still to mark');
    expect(screen.getByTestId('body-point-totals').textContent).toBe(
      'Points 2 of 69 · moments opened 1 of 3 · stance types 0 of 1',
    );
    expect(section.textContent).toContain('start at 0:12.400 · 2 of 23 points · lead side orthodox · guard not set');
    expect(section.textContent).toContain('middle · not opened');
    // On an in-progress set the stance type is a control, not a line.
    expect((screen.getByLabelText('Stance type (once per event)') as HTMLSelectElement).value).toBe('');

    // The server's wording after the colon is kept; the event id in front is
    // swapped for the event's place in the clip.
    const missing = screen.getByTestId('body-point-missing').textContent ?? '';
    expect(missing).toContain('punch at 0:12.400 (red corner): start points, 2 of 23');
    expect(missing).toContain('punch at 0:12.400 (red corner): stance type');
    expect(missing).not.toContain('evt-1');
  });

  test('body points are re-read after an event write, and the re-read is what is shown', async () => {
    let reads = 0;
    global.fetch = mockFetch({
      set: BODY_POINT_SET,
      events: [PUNCH_EVENT],
      bodyData: () => {
        reads += 1;
        // The second read answers as the database would after the event's
        // marks were cascaded away.
        return reads === 1 ? BODY_DATA : { ...BODY_DATA, moments: [], missing: ['evt-1: start moment'] };
      },
    });

    await openClip();
    expect(screen.getByTestId('body-point-totals').textContent).toContain('Points 2 of 69');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    });

    expect(bodyPointCalls()).toHaveLength(2);
    await waitFor(() => {
      expect(screen.getByTestId('body-point-totals').textContent).toContain('Points 0 of 69');
    });
    expect(screen.getByTestId('body-point-progress').textContent).toContain('1 item still to mark');
  });

  test('body points are read when a set is opened, and again after submit', async () => {
    global.fetch = mockFetch({ set: null, events: [] });

    await openClip();
    expect(bodyPointCalls()).toHaveLength(0);

    // The mock's POST answers with OPEN_SET (0.1), so opening it must not
    // read body points either; the read happens only for a body-point set.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open my annotation set' }));
    });
    expect(bodyPointCalls()).toHaveLength(0);

    global.fetch = mockFetch({ set: BODY_POINT_SET, events: [PUNCH_EVENT], submitSet: BODY_POINT_SET });
    calls.length = 0;
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Clip'), { target: { value: '' } });
    });
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Clip'), { target: { value: 'clip-1' } });
    });
    expect(bodyPointCalls()).toHaveLength(1);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Submit annotation set' }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Yes, submit 1 event/ }));
    });
    expect(bodyPointCalls()).toHaveLength(2);
    expect(screen.getByTestId('body-point-progress')).toBeTruthy();
  });

  test('a refused submit re-reads the marks so the panel shows what the server named', async () => {
    let reads = 0;
    global.fetch = mockFetch({
      set: BODY_POINT_SET,
      events: [PUNCH_EVENT],
      bodyData: () => {
        reads += 1;
        return reads === 1 ? { ...BODY_DATA, missing: [] } : BODY_DATA;
      },
      submitResponse: () => ({
        ok: false,
        body: {
          error: 'Missing body points: 5 items still to mark',
          code: 'CALIBRATION_BODY_POINTS_INCOMPLETE',
          missing: BODY_DATA.missing,
        },
      }),
    });

    await openClip();
    expect(screen.getByTestId('body-point-progress').textContent).toContain('Complete');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Submit annotation set' }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Yes, submit 1 event/ }));
    });

    expect(screen.getByRole('alert').textContent).toContain('Missing body points');
    await waitFor(() => {
      expect(screen.getByTestId('body-point-progress').textContent).toContain('5 items still to mark');
    });
  });

  test('a body-points reply that lands after the clip was left is dropped', async () => {
    let release: (() => void) | null = null;
    global.fetch = mockFetch({
      set: BODY_POINT_SET,
      events: [PUNCH_EVENT],
      bodyData: () => new Promise<unknown>((resolve) => {
        release = () => resolve(BODY_DATA);
      }),
    });

    await openClip();
    expect(bodyPointCalls()).toHaveLength(1);
    expect(screen.queryByTestId('body-point-progress')).toBeNull();

    // The coach leaves the clip before the read answers.
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Clip'), { target: { value: '' } });
    });
    await act(async () => {
      release?.();
    });

    expect(screen.queryByTestId('body-point-progress')).toBeNull();
  });

  test('a body-points read that fails outright is reported, and the events still show', async () => {
    global.fetch = mockFetch({
      set: BODY_POINT_SET,
      events: [PUNCH_EVENT],
      bodyData: () => { throw new TypeError('Failed to fetch'); },
    });

    await openClip();

    expect(screen.getByRole('alert').textContent).toContain('could not be read');
    expect(screen.getAllByTestId('annotation-event')).toHaveLength(1);
  });

  test('a complete set says so, with nothing still to mark', async () => {
    global.fetch = mockFetch({
      set: BODY_POINT_SET,
      events: [PUNCH_EVENT],
      bodyData: { ...BODY_DATA, missing: [] },
    });

    await openClip();

    expect(screen.getByTestId('body-point-progress').textContent).toContain('Complete');
    expect(screen.queryByTestId('body-point-missing')).toBeNull();
  });

  test('a refused body-points read is shown beside the section, and the events still show', async () => {
    global.fetch = mockFetch({ set: BODY_POINT_SET, events: [PUNCH_EVENT], bodyDataOk: false });

    await openClip();

    expect(screen.getByRole('alert').textContent).toContain('Body points could not be read');
    expect(screen.queryByTestId('body-point-progress')).toBeNull();
    expect(screen.getAllByTestId('annotation-event')).toHaveLength(1);
  });

  test('a submitted body-point set still shows its marks, read-only', async () => {
    global.fetch = mockFetch({
      set: { ...BODY_POINT_SET, status: 'submitted', submitted_at: '2026-08-01T00:00:00.000Z' },
      events: [PUNCH_EVENT],
      bodyData: { ...BODY_DATA, missing: [] },
    });

    await openClip();

    expect(screen.getByTestId('body-point-progress')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
  });
});

describe('body-point marking', () => {
  const writes = () => calls.filter((call) => call.url.includes('/api/pilot/calibration/body-points/'));

  /* jsdom lays nothing out and its <video> has no picture; the canvas reads
     these, so the page's tap path needs them to exist. A 1920x1080 video in
     a 400x225 box: the picture fills it. */
  const videoProps = { videoWidth: 1920, videoHeight: 1080, clientWidth: 400, clientHeight: 225 };
  let pause: jest.SpyInstance;
  beforeEach(() => {
    for (const [name, value] of Object.entries(videoProps)) {
      Object.defineProperty(HTMLVideoElement.prototype, name, { configurable: true, get: () => value });
    }
    // jsdom's pause() throws "not implemented"; the page holds the video on
    // the moment by pausing it, and the hold is what is asserted below.
    pause = jest.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
  });
  afterEach(() => {
    for (const name of Object.keys(videoProps)) {
      delete (HTMLVideoElement.prototype as unknown as Record<string, unknown>)[name];
    }
    pause.mockRestore();
  });

  async function openStartMoment() {
    await openClip();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Mark start' }));
    });
    await waitFor(() => {
      expect(screen.getByTestId('body-point-moment-panel')).toBeTruthy();
    });
  }

  test('opening a start moment posts the slot with no time, then holds the video on the server\'s time', async () => {
    global.fetch = mockFetch({
      set: BODY_POINT_SET,
      events: [PUNCH_EVENT],
      bodyData: { ...BODY_DATA, moments: [] },
    });

    await openClip();
    // The playhead is at the clip start (12.000); the event starts at 12.400.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open start' }));
    });

    const open = writes().find((call) => call.method === 'POST');
    expect(open?.body).toEqual({ annotation_set_id: 'set-1', event_id: 'evt-1', moment_slot: 'start', source_frame_width_px: 1920, source_frame_height_px: 1080 });
    expect(screen.getByTestId('playhead').textContent).toContain('0:12.400');
    expect(pause).toHaveBeenCalled();
  });

  test('opening the middle of an event with no contact time sends the playhead, held inside the event', async () => {
    global.fetch = mockFetch({
      set: BODY_POINT_SET,
      events: [PUNCH_EVENT],
      bodyData: { ...BODY_DATA, moments: [] },
    });

    await openClip();
    expect(screen.getByRole('button', { name: 'Open middle at playhead (full extension)' })).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open middle at playhead (full extension)' }));
    });

    const open = writes().find((call) => call.method === 'POST');
    // Playhead 12.000 is before the event's 12.400 start: pulled to it.
    expect(open?.body).toMatchObject({ moment_slot: 'middle', observation_ms: 12_400 });
  });

  test('the middle of an event with a contact time is opened without a time', async () => {
    global.fetch = mockFetch({
      set: BODY_POINT_SET,
      events: [{ ...PUNCH_EVENT, contact_ms: 12_600 }],
      bodyData: { ...BODY_DATA, moments: [] },
    });

    await openClip();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open middle (at contact)' }));
    });

    const open = writes().find((call) => call.method === 'POST');
    expect(open?.body).not.toHaveProperty('observation_ms');
  });

  test('a tap places the next unmarked point as a fraction of the picture, one request per tap', async () => {
    global.fetch = mockFetch({ set: BODY_POINT_SET, events: [PUNCH_EVENT] });

    await openStartMoment();
    // nose placed and chin not visible already: neck is next in marking order.
    expect(screen.getByTestId('body-point-next').textContent).toContain('place neck');

    await act(async () => {
      fireEvent.click(screen.getByTestId('body-point-canvas'), { clientX: 100, clientY: 45, detail: 1 });
    });

    const mark = writes().find((call) => call.url.endsWith('/points') && call.method === 'PUT');
    const body = mark?.body as { body_moment_id: string; points: { point_code: string; state: string; x_norm: number; y_norm: number }[] };
    expect(body.body_moment_id).toBe('mom-1');
    expect(body.points).toHaveLength(1);
    expect(body.points[0].point_code).toBe('neck');
    expect(body.points[0].state).toBe('placed');
    expect(body.points[0].x_norm).toBeCloseTo(0.25, 9);
    expect(body.points[0].y_norm).toBeCloseTo(0.2, 9);
    // And the next point is now mid hip.
    await waitFor(() => {
      expect(screen.getByTestId('body-point-next').textContent).toContain('place mid hip');
    });
  });

  test('Not visible records that observation; Clear removes a mark; Undo takes back the last placement', async () => {
    global.fetch = mockFetch({ set: BODY_POINT_SET, events: [PUNCH_EVENT] });

    await openStartMoment();
    const row = (code: string) => screen.getByTestId('body-point-list').querySelector(`[data-point-code="${code}"]`) as HTMLElement;

    await act(async () => {
      fireEvent.click(row('neck').querySelector('button[type="button"]:nth-of-type(2)') as HTMLElement); // Not visible
    });
    let mark = writes().filter((call) => call.url.endsWith('/points') && call.method === 'PUT').pop();
    expect(mark?.body).toMatchObject({ body_moment_id: 'mom-1', points: [{ point_code: 'neck', state: 'not_visible' }] });
    expect((mark?.body as { points: Record<string, unknown>[] }).points[0]).not.toHaveProperty('x_norm');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Undo last placement' }));
    });
    // neck had no mark before: undo removes the row.
    const removed = writes().filter((call) => call.url.endsWith('/points') && call.method === 'DELETE').pop();
    expect(removed?.body).toEqual({ annotation_set_id: 'set-1', body_moment_id: 'mom-1', point_code: 'neck' });

    // Clear on a point the server holds (nose).
    await act(async () => {
      fireEvent.click(row('nose').querySelector('button[type="button"]:nth-of-type(3)') as HTMLElement); // Clear
    });
    mark = writes().filter((call) => call.url.endsWith('/points') && call.method === 'DELETE').pop();
    expect(mark?.body).toMatchObject({ point_code: 'nose' });
  });

  test('a scrub off the moment lifts the hold even when paused: taps place nothing until the coach goes back', async () => {
    global.fetch = mockFetch({ set: BODY_POINT_SET, events: [PUNCH_EVENT] });

    await openStartMoment();
    expect(screen.getByTestId('body-point-next')).toBeTruthy();

    // Paused, but stepped 250 ms past the moment.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '+250ms' }));
    });
    expect(screen.queryByTestId('body-point-next')).toBeNull();
    expect(screen.getByRole('status').textContent).toContain('not held on this moment');
    await act(async () => {
      fireEvent.click(screen.getByTestId('body-point-canvas'), { clientX: 100, clientY: 45, detail: 1 });
    });
    expect(writes().some((call) => call.url.endsWith('/points'))).toBe(false);

    // One fine step (40 ms) is within the hold: a browser lands on its
    // nearest frame, not on the exact millisecond.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Go to the moment' }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '+40ms' }));
    });
    expect(screen.getByTestId('body-point-next')).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByTestId('body-point-canvas'), { clientX: 100, clientY: 45, detail: 1 });
    });
    expect(writes().filter((call) => call.url.endsWith('/points') && call.method === 'PUT')).toHaveLength(1);
  });

  test('Undo after Clear puts the cleared mark back, and a failed undo keeps its turn', async () => {
    let failNext = false;
    global.fetch = mockFetch({
      set: BODY_POINT_SET,
      events: [PUNCH_EVENT],
      bodyWriteResponse: (path, method) => {
        if (path === '/points' && method === 'PUT' && failNext) {
          failNext = false;
          return { ok: false, body: { error: 'Request refused (500).' } };
        }
        return undefined;
      },
    });

    await openStartMoment();
    const row = (code: string) => screen.getByTestId('body-point-list').querySelector(`[data-point-code="${code}"]`) as HTMLElement;

    // nose is placed at (0.5, 0.2) on the server. Clear it, then undo.
    await act(async () => {
      fireEvent.click(row('nose').querySelectorAll('button')[2]); // Clear
    });
    failNext = true;
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Undo last placement' }));
    });
    // The undo's write failed: the entry stays, so it can be tried again.
    expect((screen.getByRole('button', { name: 'Undo last placement' }) as HTMLButtonElement).disabled).toBe(false);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Undo last placement' }));
    });
    const restores = writes().filter((call) => call.url.endsWith('/points') && call.method === 'PUT');
    expect(restores).toHaveLength(2);
    expect(restores[1].body).toMatchObject({ points: [{ point_code: 'nose', state: 'placed', x_norm: 0.5, y_norm: 0.2 }] });
    expect((screen.getByRole('button', { name: 'Undo last placement' }) as HTMLButtonElement).disabled).toBe(true);
  });

  test('removing a moment is asked twice, with its point count', async () => {
    global.fetch = mockFetch({ set: BODY_POINT_SET, events: [PUNCH_EVENT] });

    await openClip();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Remove start moment' }));
    });
    expect(writes().some((call) => call.method === 'DELETE')).toBe(false);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Yes, remove it and its 2 points' }));
    });
    const removed = writes().find((call) => call.method === 'DELETE');
    expect(removed?.url.endsWith('/moments')).toBe(true);
    expect(removed?.body).toEqual({ annotation_set_id: 'set-1', body_moment_id: 'mom-1' });
  });

  test('the panel names whose body is being marked', async () => {
    global.fetch = mockFetch({ set: BODY_POINT_SET, events: [PUNCH_EVENT] });

    await openStartMoment();
    expect(screen.getByTestId('body-point-moment-panel').textContent).toContain('Marking red corner, start moment');
  });

  test('lead side and guard are set on the moment; the stance type on the event', async () => {
    global.fetch = mockFetch({ set: BODY_POINT_SET, events: [PUNCH_EVENT] });

    await openStartMoment();
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Lead side at this moment'), { target: { value: 'southpaw' } });
    });
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Guard at this moment'), { target: { value: 'usa_boxing__half_guard' } });
    });
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Stance type (once per event)'), { target: { value: 'usa_boxing__classic' } });
    });

    const momentWrites = writes().filter((call) => call.url.endsWith('/moments') && call.method === 'PUT');
    expect(momentWrites[0].body).toEqual({ annotation_set_id: 'set-1', body_moment_id: 'mom-1', lead_side: 'southpaw' });
    expect(momentWrites[1].body).toEqual({ annotation_set_id: 'set-1', body_moment_id: 'mom-1', guard_type: 'usa_boxing__half_guard' });
    const stance = writes().find((call) => call.url.endsWith('/stance'));
    expect(stance?.method).toBe('PUT');
    expect(stance?.body).toEqual({ annotation_set_id: 'set-1', event_id: 'evt-1', stance_type: 'usa_boxing__classic' });
    // The guard option reads as the manual's heading with the body and page.
    expect(screen.getByText('Half Guard, USA Boxing, p. 82 (PDF 83)')).toBeTruthy();
  });

  test('an already-open slot is read back and shown, not refused', async () => {
    global.fetch = mockFetch({
      set: BODY_POINT_SET,
      events: [PUNCH_EVENT],
      bodyData: { ...BODY_DATA, moments: [] },
      bodyWriteResponse: (path, method) => (path === '/moments' && method === 'POST'
        ? { ok: false, body: { error: 'Conflict: that moment is already open', code: 'CALIBRATION_BODY_MOMENT_SLOT_TAKEN' } }
        : undefined),
    });

    await openClip();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open start' }));
    });

    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('status').textContent).toContain('already open');
    expect(calls.filter((call) => call.url.includes('/body-points?')).length).toBeGreaterThanOrEqual(2);
  });

  test('when the event under a moment changed, the page reloads rather than marking on a ghost', async () => {
    global.fetch = mockFetch({
      set: BODY_POINT_SET,
      events: [PUNCH_EVENT],
      bodyWriteResponse: (path, method) => (path === '/points' && method === 'PUT'
        ? { ok: false, body: { error: 'Conflict: the event changed', code: 'CALIBRATION_BODY_MOMENT_EVENT_CHANGED' } }
        : undefined),
    });

    await openStartMoment();
    const workspaceReads = () => calls.filter((call) => call.url.includes('/annotation-set?')).length;
    const before = workspaceReads();
    await act(async () => {
      fireEvent.click(screen.getByTestId('body-point-canvas'), { clientX: 100, clientY: 45, detail: 1 });
    });

    expect(workspaceReads()).toBe(before + 1);
    expect(screen.queryByTestId('body-point-moment-panel')).toBeNull();
  });

  test('a write that lost a race is sent once more', async () => {
    let attempts = 0;
    global.fetch = mockFetch({
      set: BODY_POINT_SET,
      events: [PUNCH_EVENT],
      bodyWriteResponse: (path, method) => {
        if (path !== '/points' || method !== 'PUT') return undefined;
        attempts += 1;
        return attempts === 1
          ? { ok: false, body: { error: 'Conflict: write race', code: 'CALIBRATION_BODY_POINTS_WRITE_RACE' } }
          : undefined;
      },
    });

    await openStartMoment();
    await act(async () => {
      fireEvent.click(screen.getByTestId('body-point-canvas'), { clientX: 100, clientY: 45, detail: 1 });
    });

    expect(attempts).toBe(2);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('the event form on a body-point set has no stance or peak, asks the contact time in the open, and refuses a contact punch without one', async () => {
    global.fetch = mockFetch({ set: BODY_POINT_SET, events: [] });

    await openClip();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Add punch' }));
    });

    expect(screen.queryByLabelText('Stance')).toBeNull();
    expect(screen.queryByLabelText('Peak (ms, video time)')).toBeNull();
    const contact = screen.getByLabelText(/^Contact \(ms, video time\)/);
    expect(contact.closest('details')).toBeNull();

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Contact result'), { target: { value: 'guard_contact' } });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save event' }));
    });
    expect(screen.getByRole('alert').textContent).toContain('needs its contact time');
    expect(calls.some((call) => call.url.includes('/calibration/events'))).toBe(false);

    // A miss needs none, and the 0.1 fields go out empty.
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Contact result'), { target: { value: 'no_contact' } });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save event' }));
    });
    const write = calls.find((call) => call.url.includes('/calibration/events'));
    expect(write?.body).toMatchObject({ stance: '', peak_ms: '', contact_ms: '' });
  });

  test('a 0.1 set\'s event form still has its stance and peak fields', async () => {
    global.fetch = mockFetch({ events: [] });

    await openClip();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Add punch' }));
    });

    expect(screen.getByLabelText('Stance')).toBeTruthy();
    expect(screen.getByLabelText('Peak (ms, video time)')).toBeTruthy();
    expect(screen.getByLabelText('Contact (ms, video time)').closest('details')).not.toBeNull();
  });

  test('a submitted body-point set shows its moments but offers no marking control', async () => {
    global.fetch = mockFetch({
      set: { ...BODY_POINT_SET, status: 'submitted', submitted_at: '2026-08-01T00:00:00.000Z' },
      events: [PUNCH_EVENT],
    });

    await openClip();

    expect(screen.queryByRole('button', { name: 'Mark start' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Open / })).toBeNull();
    expect(screen.queryByLabelText('Stance type (once per event)')).toBeNull();
    expect(screen.getByTestId('body-point-progress').textContent).toContain('stance type · not set');
  });
});

test.each([
  ['a 0.1 set', OPEN_SET],
  ['a body-point set with its progress on screen', BODY_POINT_SET],
])('nothing on the page states a frame number or a frame rate (%s)', async (_name, set) => {
  global.fetch = mockFetch({ set, events: [PUNCH_EVENT] });

  await openClip();
  if (set === BODY_POINT_SET) {
    expect(screen.getByTestId('body-point-progress')).toBeTruthy();
  }

  const text = document.body.textContent ?? '';
  // "frame 412", "frame #412", "f412", "at 30fps" -- any of these would be a
  // precision claim the platform cannot back, because it stores no frame rate
  // and the browser exposes no frame index. The page is allowed to SAY that
  // (and does), which is why this looks for a frame NUMBER rather than the
  // word.
  expect(text).not.toMatch(/frames?\s*#?\d/i);
  expect(text).not.toMatch(/\d\s*fps\b/i);
});
