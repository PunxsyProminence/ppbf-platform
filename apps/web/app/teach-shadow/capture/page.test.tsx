/**
 * @jest-environment jsdom
 */

import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

import TeachShadowCapturePage from './page';

jest.mock('@/components/RoleSessionGate', () => ({
  __esModule: true,
  default: ({ children }: { readonly children: ReactNode }) => children,
}));

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children }: { readonly href: string; readonly children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

/*
 * WHAT THIS SUITE IS FOR.
 *
 * This is the surface that builds the recognition corpus, and the Film Study
 * recorder is the surface that must never feed it. The two mirror each other:
 * everything asserted here as PRESENT is asserted absent in
 * app/coach/video-analysis/capture/page.test.tsx, and the pair is what makes
 * the owner's no-promotion ruling a property of the code rather than a note
 * in a design document.
 *
 * The take is the load-bearing one. It groups the angles of one attempt and
 * it is what makes a video part of the corpus at all, so a recording that
 * lost it would look fine on screen and quietly become an ungrouped upload --
 * discoverable only much later, in the data, when alternate views of one
 * punch turned out to be spread across a train/test split.
 */

interface RecorderInstance {
  ondataavailable: ((event: { data: Blob }) => void) | null;
  onstop: (() => void) | null;
  state: string;
  start: jest.Mock;
  stop: jest.Mock;
}

let recorderInstances: RecorderInstance[] = [];

class FakeMediaRecorder implements RecorderInstance {
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  state = 'inactive';
  start: jest.Mock;
  stop: jest.Mock;

  constructor() {
    this.start = jest.fn(() => { this.state = 'recording'; });
    this.stop = jest.fn(() => { this.state = 'inactive'; this.onstop?.(); });
    recorderInstances.push(this);
  }

  static isTypeSupported() { return true; }
}

const SESSION = {
  recording_session_id: 'rs-1',
  join_code: 'H7K2QP',
  training_context: 'heavy_bag',
  state: 'open',
  current_take: { capture_take_id: 'take-1', take_number: 1, state: 'open', files: [] },
};

const uploads: FormData[] = [];
const sessionPosts: Array<Record<string, unknown>> = [];
// What the reload lookup (?mine=1) answers. null is the ordinary case: this
// coach has nothing open, so the page offers to start one.
let resumableSession: typeof SESSION | null = null;
// How the next uploads answer, front first; empty means success.
let uploadAnswers: Array<{ ok: boolean; status: number; error?: string }> = [];

function mockFetch() {
  return jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    /*
     * TS-ANON-01: DELIBERATELY NOT ANSWERED. This page must not read the
     * roster any more -- who is being filmed is settled at clearance, and a
     * picker here would put the name back on the anonymous surface. The
     * throw below turns a reintroduced roster fetch into a failing test
     * rather than a silently passing one.
     */
    if (url.includes('/api/pilot/video/capture-session')) {
      if (init?.method === 'POST') sessionPosts.push(JSON.parse(String(init.body)));
      if (url.includes('mine=1')) {
        return { ok: true, status: 200, json: async () => ({ session: resumableSession }) } as Response;
      }
      return { ok: true, status: 200, json: async () => ({ session: SESSION }) } as Response;
    }
    if (url.includes('/api/pilot/video/upload')) {
      uploads.push(init!.body as FormData);
      const answer = uploadAnswers.shift();
      if (answer && !answer.ok) {
        return { ok: false, status: answer.status, json: async () => ({ error: answer.error }) } as Response;
      }
      return { ok: true, status: 202, json: async () => ({ ok: true }) } as Response;
    }
    // Any other URL is a failure, not a default -- see the note in the Film
    // Study suite. A catch-all would let a fetch added later go unexercised.
    throw new Error(`Unexpected fetch in this test: ${url}`);
  });
}

beforeEach(() => {
  recorderInstances = [];
  uploads.length = 0;
  sessionPosts.length = 0;
  resumableSession = null;
  uploadAnswers = [];
  (global as unknown as { MediaRecorder: unknown }).MediaRecorder = FakeMediaRecorder;
  Object.defineProperty(global.navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: jest.fn(async () => ({ getTracks: () => [{ stop: jest.fn() }] })) },
  });
  HTMLMediaElement.prototype.play = jest.fn(async () => {});
  global.fetch = mockFetch() as unknown as typeof fetch;
});

async function renderPage() {
  // The reload lookup answers on mount; flush it so a test sees the settled page.
  await act(async () => {
    render(<TeachShadowCapturePage />);
  });
}

async function openSession() {
  await renderPage();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Start recording session' }));
  });
  await screen.findByText('H7K2QP');
}

test('says where the footage goes, above the control that records it', async () => {
  /*
   * WITH A SESSION OPEN, so there is a Record control to be above. The first
   * version of this test rendered the page in its no-session state, where the
   * only thing on screen is the session form -- it asserted the sentence
   * existed and could not have caught the sentence moving BELOW the controls,
   * which is the arrangement the owner made an acceptance requirement.
   */
  await openSession();

  const statement = screen.getByText(
    /Media recorded here belongs to the recognition-teaching workflow, not Film Study/i,
  );
  const control = screen.getByRole('button', { name: 'Record Example for Shadow' });

  expect(statement.compareDocumentPosition(control) & Node.DOCUMENT_POSITION_FOLLOWING)
    .toBeTruthy();
});

test('the destination is stated before a session even exists', async () => {
  // Read before the first decision, not after it: a coach choosing between
  // the two recorders has not started a session yet.
  await renderPage();

  expect(
    screen.getByText(/Media recorded here belongs to the recognition-teaching workflow, not Film Study/i),
  ).toBeInTheDocument();
});

test('a recording carries the take it was started against', async () => {
  await openSession();

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Record Example for Shadow' }));
  });
  await act(async () => {
    recorderInstances[0]!.ondataavailable?.({ data: new Blob(['x']) });
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
  });

  await waitFor(() => expect(uploads).toHaveLength(1));
  const form = uploads[0]!;
  // Without this the angles of one attempt cannot be kept on the same side of
  // a train/test split, which is the single property the grouping exists for.
  expect(form.get('capture_take_id')).toBe('take-1');
  // TS-ANON-01: teaching media names nobody, and the server REFUSES an upload
  // that does. Absence here is the contract, not an omission.
  expect(form.get('athlete_id')).toBeNull();
  expect(form.get('capture_source')).toBe('in_app_recording');
  expect(form.get('recorded_at')).toEqual(expect.any(String));
});

test('the take is fixed when recording starts, not when it stops', async () => {
  await openSession();

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Record Example for Shadow' }));
  });

  /*
   * THE FAILURE THIS CATCHES. A coach who presses "Next take" while the camera
   * is still running would, under a stop-time read, have the footage filed
   * against the NEW take -- silently, and only discoverable later in the data.
   * The advancing session here answers with take-2; the upload must still say
   * take-1, because that is the attempt that was actually filmed.
   */
  SESSION.current_take = { capture_take_id: 'take-2', take_number: 2, state: 'open', files: [] };

  await act(async () => {
    recorderInstances[0]!.ondataavailable?.({ data: new Blob(['x']) });
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
  });

  await waitFor(() => expect(uploads).toHaveLength(1));
  expect(uploads[0]!.get('capture_take_id')).toBe('take-1');

  SESSION.current_take = { capture_take_id: 'take-1', take_number: 1, state: 'open', files: [] };
});

test('the camera view is the one that was typed when filming started', async () => {
  /*
   * A coach on the second phone types 'front', presses record, then
   * repositions the phone mid-rep and retypes the field -- or types ahead for
   * the angle they are about to shoot. Read at stop time, the footage would be
   * filed under a viewpoint it was not shot from, and nothing downstream could
   * tell: a wrong camera_view is a plausible-looking label nobody checks.
   */
  await openSession();
  fireEvent.change(screen.getByLabelText(/this camera/i), { target: { value: 'front' } });

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Record Example for Shadow' }));
  });
  fireEvent.change(screen.getByLabelText(/this camera/i), { target: { value: 'side' } });
  await act(async () => {
    recorderInstances[0]!.ondataavailable?.({ data: new Blob(['x']) });
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
  });

  await waitFor(() => expect(uploads).toHaveLength(1));
  expect(uploads[0]!.get('camera_view')).toBe('front');
});

test('nothing stands between a coach and recording', async () => {
  /*
   * THE OWNER RULE, PINNED. Filming to teach the recognizer is not gated: no
   * consent, no clearance, no participant, and no page to pass through first.
   * A session starts from this screen, and nobody is named anywhere on it.
   *
   * This suite has held the opposite twice -- first that the camera refused
   * until a recording named its athlete, then that a session could only come
   * from a clearance page. Both were restrictions the owner removed.
   */
  await renderPage();

  expect(screen.getByRole('button', { name: 'Start recording session' })).toBeEnabled();
  expect(screen.queryByLabelText(/which athlete/i)).toBeNull();
  expect(document.body.textContent ?? '').not.toMatch(/clearance|consent/i);
});

test('offers only the contexts with one person in frame', async () => {
  await renderPage();

  // Mitts and sparring put a second person in frame. The server refuses them
  // too; this is the half a coach can see.
  const options = screen.getAllByRole('option').map((option) => option.textContent);
  expect(options).toEqual(['Shadowboxing', 'Heavy bag']);
});

test('TS-ANON-01 -- the camera opens with nobody named', async () => {
  // The old refusal is gone, and its absence is asserted rather than assumed:
  // recording starts, and the recorder is actually constructed.
  await openSession();

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Record Example for Shadow' }));
  });

  expect(recorderInstances).toHaveLength(1);
  expect(screen.queryByRole('alert')).toBeNull();
});

test('an angle chosen from a file joins the same take, and says it was not recorded here', async () => {
  await openSession();

  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  await act(async () => {
    fireEvent.change(input, {
      target: { files: [new File(['x'], 'angle.mp4', { type: 'video/mp4' })] },
    });
  });

  await waitFor(() => expect(uploads).toHaveLength(1));
  expect(uploads[0]!.get('capture_take_id')).toBe('take-1');
  // Provenance is declared, never inferred from the presence of a take.
  expect(uploads[0]!.get('capture_source')).toBe('file_upload');
});

test('leads back into Teach Shadow rather than into Film Study', async () => {
  await renderPage();

  const hrefs = screen.getAllByRole('link').map((el) => el.getAttribute('href'));
  expect(hrefs).toContain('/teach-shadow');
  expect(hrefs).not.toContain('/coach/video-analysis');
});

test('a take that cannot be re-read after an upload says so, never "Nothing recorded", and does not call the upload failed', async () => {
  const base = mockFetch();
  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    // The GET re-read fails; opening the session (POST) and the upload succeed.
    if (url.includes('/api/pilot/video/capture-session') && init?.method !== 'POST') {
      return { ok: false, status: 500, json: async () => ({ error: 'boom' }) } as Response;
    }
    return base(input, init);
  }) as unknown as typeof fetch;

  await openSession();
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  await act(async () => {
    fireEvent.change(input, {
      target: { files: [new File(['x'], 'angle.mp4', { type: 'video/mp4' })] },
    });
  });

  await waitFor(() => expect(uploads).toHaveLength(1));
  expect(await screen.findByTestId('angles-unreadable')).toBeTruthy();
  expect(screen.queryByText(/Nothing recorded against this take yet/)).toBeNull();
  expect(screen.queryByText(/could not be added to this take/)).toBeNull();
});

// NO TEXT ON THE WALL, the check #1108 put on Label Agreement. The error alert
// used to stand on the bare page ground; .alert--warning is only a tint with
// light type, so it was unreadable there. jsdom cannot measure contrast, so
// this pins the structural cause: every element that carries its own text
// sits inside a material. Buttons and button-styled links are exempt because
// they carry their own face.
const MATERIAL = '.mat-leather, .mat-wood';

function textOnTheWall(container: HTMLElement): string[] {
  const bare: string[] = [];
  for (const element of Array.from(container.querySelectorAll('*'))) {
    const ownText = Array.from(element.childNodes)
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent ?? '')
      .join('')
      .trim();
    if (!ownText) continue;
    if (element.closest(MATERIAL)) continue;
    if (element.closest('.btn')) continue;
    bare.push(`<${element.tagName.toLowerCase()}> ${ownText}`);
  }
  return bare;
}

test('no text sits on the wall before a session, or inside one', async () => {
  let container!: HTMLElement;
  await act(async () => {
    ({ container } = render(<TeachShadowCapturePage />));
  });
  expect(textOnTheWall(container)).toEqual([]);

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Start recording session' }));
  });
  await screen.findByText('H7K2QP');
  expect(textOnTheWall(container)).toEqual([]);
});

test('a refused session start puts its alert on a material, not the wall', async () => {
  global.fetch = jest.fn(async () => (
    { ok: false, status: 403, json: async () => ({ error: 'Forbidden: role not allowed' }) } as Response
  )) as unknown as typeof fetch;
  let container!: HTMLElement;
  await act(async () => {
    ({ container } = render(<TeachShadowCapturePage />));
  });

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Start recording session' }));
  });
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent('Forbidden: role not allowed');
  expect(alert.closest(MATERIAL)).toHaveClass('mat-leather');
  expect(textOnTheWall(container)).toEqual([]);
});

async function recordOnce() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Record Example for Shadow' }));
  });
  await act(async () => {
    recorderInstances[0]!.ondataavailable?.({ data: new Blob(['footage-bytes']) });
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
  });
}

describe('a failed or refused upload keeps the footage (TEACH-02)', () => {
  test('the recording is held, the person is told, and retry sends the same file again', async () => {
    uploadAnswers = [{ ok: false, status: 503, error: 'Service unavailable' }];
    await openSession();

    await recordOnce();

    await waitFor(() => expect(uploads).toHaveLength(1));
    const held = await screen.findByTestId('held-recording');
    expect(held).toHaveTextContent(/being kept on this page/);
    // It must not claim the phone has it: the bytes are in page memory only.
    expect(held).toHaveTextContent(/not saved to your phone yet/);
    expect(held).toHaveTextContent(/nothing has been thrown away/i);
    expect(screen.getByRole('alert')).toHaveTextContent('Service unavailable');
    expect(screen.getByRole('button', { name: 'Save to this phone' })).toBeEnabled();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    });

    await waitFor(() => expect(uploads).toHaveLength(2));
    const first = uploads[0]!.get('file') as File;
    const second = uploads[1]!.get('file') as File;
    expect(second.size).toBe(first.size);
    expect(second.size).toBe('footage-bytes'.length);
    expect(uploads[1]!.get('capture_take_id')).toBe('take-1');
    await waitFor(() => expect(screen.queryByTestId('held-recording')).toBeNull());
  });

  test('a take closed under the recording keeps the recording and says the take is closed', async () => {
    uploadAnswers = [{ ok: false, status: 409, error: 'That attempt is already closed. Start the next take and record again.' }];
    await openSession();

    await recordOnce();
    await screen.findByTestId('held-recording');
    expect(screen.queryByTestId('held-take-closed')).toBeNull();

    try {
      // Another phone presses Next take: this one's view moves to take 2.
      SESSION.current_take = { capture_take_id: 'take-2', take_number: 2, state: 'open', files: [] };
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Next take' }));
      });

      expect(await screen.findByTestId('held-take-closed')).toHaveTextContent(/will be refused/i);
      // Still held, still saveable -- and NOT quietly re-filed against take 2.
      expect(screen.getByTestId('held-recording')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Save to this phone' })).toBeEnabled();
      // Try again would only be refused, so it is not offered as a live control.
      expect(screen.getByRole('button', { name: 'Try again' })).toBeDisabled();
      expect(uploads).toHaveLength(1);
    } finally {
      SESSION.current_take = { capture_take_id: 'take-1', take_number: 1, state: 'open', files: [] };
    }
  });

  test('finishing the session does not drop a held recording either', async () => {
    uploadAnswers = [{ ok: false, status: 409, error: 'closed' }];
    await openSession();
    await recordOnce();
    await screen.findByTestId('held-recording');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Finish session' }));
    });

    expect(await screen.findByRole('button', { name: 'Start recording session' })).toBeInTheDocument();
    expect(screen.getByTestId('held-recording')).toBeInTheDocument();
    expect(screen.getByTestId('held-take-closed')).toBeInTheDocument();
  });

  test('another recording cannot be started over a held one', async () => {
    uploadAnswers = [{ ok: false, status: 503, error: 'down' }];
    await openSession();
    await recordOnce();
    await screen.findByTestId('held-recording');

    expect(screen.getByRole('button', { name: 'Record Example for Shadow' })).toBeDisabled();
  });

  test('discarding asks first, and declining keeps the recording', async () => {
    uploadAnswers = [{ ok: false, status: 503, error: 'down' }];
    await openSession();
    await recordOnce();
    await screen.findByTestId('held-recording');

    const confirm = jest.spyOn(window, 'confirm').mockReturnValue(false);
    fireEvent.click(screen.getByRole('button', { name: 'Discard recording' }));
    expect(confirm).toHaveBeenCalled();
    expect(screen.getByTestId('held-recording')).toBeInTheDocument();

    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'Discard recording' }));
    await waitFor(() => expect(screen.queryByTestId('held-recording')).toBeNull());
    confirm.mockRestore();
  });

  test('the held panel stands on a material, not the bare wall', async () => {
    uploadAnswers = [{ ok: false, status: 503, error: 'down' }];
    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<TeachShadowCapturePage />));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Start recording session' }));
    });
    await screen.findByText('H7K2QP');
    await recordOnce();
    await screen.findByTestId('held-recording');

    expect(textOnTheWall(container)).toEqual([]);
  });
});

describe('a reload goes back into the coach own open session (TEACH-04)', () => {
  test('the open session and its join code come back without starting anything', async () => {
    resumableSession = { ...SESSION, created_at: '2026-10-01T10:00:00Z' } as unknown as typeof SESSION;

    await renderPage();

    expect(await screen.findByText('H7K2QP')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start recording session' })).toBeNull();
    // The coach is told this was picked up, not started, with when it began.
    expect(screen.getByTestId('session-resumed')).toHaveTextContent(/Picked up your open session, started .*Finish session/);
    // Nothing was created or joined to get here.
    expect(sessionPosts).toEqual([]);
  });

  test('a session started on this page carries no "picked up" notice', async () => {
    await openSession();

    expect(screen.queryByTestId('session-resumed')).toBeNull();
  });

  test('with nothing open the page offers to start one, as before', async () => {
    await renderPage();

    expect(screen.getByRole('button', { name: 'Start recording session' })).toBeEnabled();
    expect(screen.queryByText('H7K2QP')).toBeNull();
  });

  test('Start and Join wait for the lookup, so a pending session cannot be doubled', async () => {
    let answer!: (response: Response) => void;
    const base = mockFetch();
    global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('mine=1')) return new Promise<Response>((resolve) => { answer = resolve; });
      return base(input, init);
    }) as unknown as typeof fetch;

    await act(async () => {
      render(<TeachShadowCapturePage />);
    });
    expect(screen.getByRole('button', { name: 'Start recording session' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Join session' })).toBeDisabled();

    await act(async () => {
      answer({ ok: true, status: 200, json: async () => ({ session: SESSION }) } as Response);
    });
    expect(await screen.findByText('H7K2QP')).toBeInTheDocument();
  });

  describe('a lookup that never answers cannot lock the coach out', () => {
    let lateAnswer!: (response: Response) => void;

    beforeEach(() => {
      jest.useFakeTimers();
      const base = mockFetch();
      // Ignores the abort signal on purpose: a hung network call may answer
      // long after the page gave up, and that late answer must count for nothing.
      global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).includes('mine=1')) return new Promise<Response>((resolve) => { lateAnswer = resolve; });
        return base(input, init);
      }) as unknown as typeof fetch;
    });
    afterEach(() => {
      jest.useRealTimers();
    });

    test('Start and Join come back after the bound, and the page says it could not check', async () => {
      await act(async () => {
        render(<TeachShadowCapturePage />);
      });
      expect(screen.getByRole('button', { name: 'Start recording session' })).toBeDisabled();

      await act(async () => {
        jest.advanceTimersByTime(5000);
      });
      // Still inside the bound.
      expect(screen.getByRole('button', { name: 'Start recording session' })).toBeDisabled();

      await act(async () => {
        jest.advanceTimersByTime(1500);
      });
      expect(screen.getByRole('button', { name: 'Start recording session' })).toBeEnabled();
      expect(screen.getByRole('alert')).toHaveTextContent(/Could not check whether you already have a session open/);
    });

    test('a late reply does not replace a session the coach has since started', async () => {
      await act(async () => {
        render(<TeachShadowCapturePage />);
      });
      await act(async () => {
        jest.advanceTimersByTime(7000);
      });
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Start recording session' }));
      });
      expect(await screen.findByText('H7K2QP')).toBeInTheDocument();

      await act(async () => {
        lateAnswer({
          ok: true,
          status: 200,
          json: async () => ({ session: { ...SESSION, recording_session_id: 'rs-late', join_code: 'LATE99' } }),
        } as Response);
      });

      expect(screen.getByText('H7K2QP')).toBeInTheDocument();
      expect(screen.queryByText('LATE99')).toBeNull();
      expect(screen.queryByTestId('session-resumed')).toBeNull();
    });
  });

  test('a lookup that fails says so rather than quietly offering a second session', async () => {
    const base = mockFetch();
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('mine=1')) {
        return { ok: false, status: 500, json: async () => ({ error: 'boom' }) } as Response;
      }
      return base(input, init);
    }) as unknown as typeof fetch;

    await renderPage();

    expect(await screen.findByRole('alert')).toHaveTextContent(/Could not check whether you already have a session open/);
    expect(screen.getByRole('button', { name: 'Start recording session' })).toBeEnabled();
  });
});

describe('what a coach reads for their own angle (TEACH-10)', () => {
  test.each([
    ['quarantined', 'Uploaded, being checked'],
    ['ready', 'Ready'],
  ])('%s reads %s, not the raw word', async (status, label) => {
    resumableSession = {
      ...SESSION,
      current_take: {
        ...SESSION.current_take,
        files: [{ videoSessionId: 'v1', cameraView: 'side', uploadedByAccountId: 'a', status }],
      },
    } as unknown as typeof SESSION;

    await renderPage();

    expect(await screen.findByText(`side · ${label}`)).toBeInTheDocument();
    expect(document.body.textContent ?? '').not.toMatch(/quarantined/i);
  });
});
