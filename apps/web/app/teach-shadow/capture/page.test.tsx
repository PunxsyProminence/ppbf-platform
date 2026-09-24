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

function mockFetch() {
  return jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/api/pilot/athletes/list')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ items: [{ athlete_id: 'ath-1', full_name: 'Neeko Neale' }] }),
      } as Response;
    }
    if (url.includes('/api/pilot/video/capture-session')) {
      if (init?.method === 'POST') sessionPosts.push(JSON.parse(String(init.body)));
      return { ok: true, status: 200, json: async () => ({ session: SESSION }) } as Response;
    }
    if (url.includes('/api/pilot/video/upload')) {
      uploads.push(init!.body as FormData);
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
  (global as unknown as { MediaRecorder: unknown }).MediaRecorder = FakeMediaRecorder;
  Object.defineProperty(global.navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: jest.fn(async () => ({ getTracks: () => [{ stop: jest.fn() }] })) },
  });
  HTMLMediaElement.prototype.play = jest.fn(async () => {});
  global.fetch = mockFetch() as unknown as typeof fetch;
});

async function renderPage() {
  render(<TeachShadowCapturePage />);
  await waitFor(() => expect(global.fetch).toHaveBeenCalled());
}

async function openSession() {
  await renderPage();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Start recording session' }));
  });
  await screen.findByText('H7K2QP');
}

test('says where the footage goes, above the control that records it', async () => {
  await renderPage();

  const statement = screen.getByText(
    /Media recorded here belongs to the recognition-teaching workflow, not Film Study/i,
  );
  // The destination is stated before a session even exists, so it is read
  // before any decision rather than after one.
  expect(statement).toBeInTheDocument();
  expect(screen.getByRole('note')).toBe(statement.closest('[role="note"]'));
});

test('a recording carries the take it was started against', async () => {
  await openSession();

  fireEvent.change(screen.getByLabelText(/which athlete/i), { target: { value: 'ath-1' } });
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
  expect(form.get('athlete_id')).toBe('ath-1');
  expect(form.get('capture_source')).toBe('in_app_recording');
  expect(form.get('recorded_at')).toEqual(expect.any(String));
});

test('the take is fixed when recording starts, not when it stops', async () => {
  await openSession();
  fireEvent.change(screen.getByLabelText(/which athlete/i), { target: { value: 'ath-1' } });

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

test('offers only the contexts with one person in frame', async () => {
  await renderPage();

  const options = screen.getAllByRole('option').map((option) => option.textContent);
  /*
   * Mitts and sparring put a second person in frame whom the row never names
   * and nothing ever asks consent about. The server refuses them too; this is
   * the half a coach can see. They come back when a take can name everyone in
   * it, which is a separate slice.
   */
  expect(options).toEqual(['Shadowboxing', 'Heavy bag']);
});

test('refuses to open the camera until the recording can name its athlete', async () => {
  await openSession();

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Record Example for Shadow' }));
  });

  expect(await screen.findByRole('alert')).toHaveTextContent(/choose which athlete/i);
  expect(recorderInstances).toHaveLength(0);
});

test('an angle chosen from a file joins the same take, and says it was not recorded here', async () => {
  await openSession();
  fireEvent.change(screen.getByLabelText(/which athlete/i), { target: { value: 'ath-1' } });

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
