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

const BODY_POINTS_0_4_COUNT = 23;

/* A body-points answer with one moment opened and two points on it, as the
   server shapes it. The missing list is the server's wording verbatim. */
const BODY_DATA = {
  ok: true,
  set: BODY_POINT_SET,
  expected_points: Array.from({ length: BODY_POINTS_0_4_COUNT }, (_, i) => `point_${i}`),
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
  bodyData?: unknown;
  bodyDataOk?: boolean;
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
    if (url.includes('/api/pilot/calibration/body-points')) {
      if (options.bodyDataOk === false) {
        return json({ error: 'Not found: no such annotation set in this organization' }, false);
      }
      return json(options.bodyData ?? BODY_DATA);
    }
    if (url.includes('/api/pilot/calibration/annotation-set/submit')) {
      return json({
        ok: true,
        set: { ...OPEN_SET, status: 'submitted', submitted_at: '2026-08-27T10:00:00.000Z' },
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
    expect(section.textContent).toContain('5 still to mark');
    expect(screen.getByTestId('body-point-totals').textContent).toBe(
      'Points 2 of 69 · moments opened 1 of 3 · stance types 0 of 1',
    );
    expect(section.textContent).toContain('start (start at 0:12.400) · 2 of 23 points · lead side orthodox · guard not set');
    expect(section.textContent).toContain('middle · not opened');
    expect(section.textContent).toContain('stance type · not set');

    // The server's wording after the colon is kept; the event id in front is
    // swapped for the event's place in the clip.
    const missing = screen.getByTestId('body-point-missing').textContent ?? '';
    expect(missing).toContain('punch at 0:12.400: start points, 2 of 23');
    expect(missing).toContain('punch at 0:12.400: stance type');
    expect(missing).not.toContain('evt-1');
  });

  test('body points are re-read after an event write, because the write may have removed marks', async () => {
    global.fetch = mockFetch({ set: BODY_POINT_SET, events: [PUNCH_EVENT] });

    await openClip();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    });

    expect(bodyPointCalls()).toHaveLength(2);
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

test('nothing on the page states a frame number or a frame rate', async () => {
  global.fetch = mockFetch({ events: [PUNCH_EVENT] });

  await openClip();

  const text = document.body.textContent ?? '';
  // "frame 412", "frame #412", "f412", "at 30fps" -- any of these would be a
  // precision claim the platform cannot back, because it stores no frame rate
  // and the browser exposes no frame index. The page is allowed to SAY that
  // (and does), which is why this looks for a frame NUMBER rather than the
  // word.
  expect(text).not.toMatch(/frames?\s*#?\d/i);
  expect(text).not.toMatch(/\d\s*fps\b/i);
});
