/**
 * @jest-environment jsdom
 */

import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

import FilmStudyCapturePage from './page';

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
 * Film Study and Teach Shadow both record, and the owner has ruled that what
 * they produce never mixes: there is no promotion path in either direction.
 * Two things make that real rather than aspirational, and both are asserted
 * here because both are one careless edit from being undone:
 *
 *   1. The page SAYS where the footage goes, before any control to record it.
 *      A coach who films a genuinely useful teaching sequence on this page
 *      cannot move it afterwards, so the decision has to be made in front of
 *      them rather than discovered later.
 *
 *   2. The upload sends NO capture_take_id. A take is what groups the angles
 *      of one attempt and what makes footage part of the recognition corpus,
 *      so a takeless upload cannot join one. The absence is the contract.
 *
 * The second is the one a refactor would break silently: adding a take here
 * would look like a feature and would quietly make Film Study footage
 * promotable.
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

const uploads: FormData[] = [];
let athleteListStatus = 200;

function mockFetch() {
  return jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/api/pilot/athletes/list')) {
      return {
        ok: athleteListStatus === 200,
        status: athleteListStatus,
        json: async () => ({ items: [{ athlete_id: 'ath-1', full_name: 'Neeko Neale' }] }),
      } as Response;
    }
    if (url.includes('/api/pilot/video/upload')) {
      uploads.push(init!.body as FormData);
      return { ok: true, status: 202, json: async () => ({ ok: true }) } as Response;
    }
    /*
     * ANY OTHER URL IS A FAILURE, NOT A DEFAULT. A catch-all that answered
     * ok:true would let a fetch added later pass through this suite without
     * ever being exercised -- the exact defect that leaves
     * app/coach/video-analysis/page.test.tsx:156 unable to see a new read.
     */
    throw new Error(`Unexpected fetch in this test: ${url}`);
  });
}

beforeEach(() => {
  recorderInstances = [];
  uploads.length = 0;
  athleteListStatus = 200;
  (global as unknown as { MediaRecorder: unknown }).MediaRecorder = FakeMediaRecorder;
  Object.defineProperty(global.navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: jest.fn(async () => ({ getTracks: () => [{ stop: jest.fn() }] })) },
  });
  // jsdom does not implement playback and throws rather than returning a
  // promise, which the page would then call .catch on.
  HTMLMediaElement.prototype.play = jest.fn(async () => {});
  global.fetch = mockFetch() as unknown as typeof fetch;
});

async function renderPage() {
  render(<FilmStudyCapturePage />);
  // The athlete roster is fetched on mount; without settling it the select is
  // empty and every recording test would fail for the wrong reason.
  await screen.findByRole('option', { name: 'Neeko Neale' });
}

async function recordOneClip() {
  fireEvent.change(screen.getByLabelText(/which athlete/i), { target: { value: 'ath-1' } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Record for Film Study' }));
  });

  const recorder = recorderInstances[0]!;
  await act(async () => {
    recorder.ondataavailable?.({ data: new Blob(['x']) });
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
  });
  await waitFor(() => expect(uploads).toHaveLength(1));
  return uploads[0]!;
}

test('says where the footage goes, above the control that records it', async () => {
  await renderPage();

  const statement = screen.getByText(
    /Media recorded here stays in Film Study and cannot be moved into Teach Shadow/i,
  );
  const control = screen.getByRole('button', { name: 'Record for Film Study' });

  /*
   * ORDER IS THE POINT, not mere presence. The same sentence below the button
   * is read after the decision instead of before it, which is no use to
   * somebody who has already pressed record.
   */
  expect(statement.compareDocumentPosition(control) & Node.DOCUMENT_POSITION_FOLLOWING)
    .toBeTruthy();
});

test('offers the other destination rather than leaving a coach on the wrong page', async () => {
  await renderPage();

  const link = screen.getAllByRole('link').find((el) => el.getAttribute('href') === '/teach-shadow/capture');
  expect(link).toBeDefined();
});

test('a Film Study recording carries no take, so it can never join the corpus', async () => {
  await renderPage();
  const form = await recordOneClip();

  // The absence IS the contract. A take is what makes footage recognition
  // evidence; sending one here would quietly make Film Study promotable.
  expect(form.get('capture_take_id')).toBeNull();
  expect(form.get('recording_session_id')).toBeNull();
  expect(form.get('athlete_id')).toBe('ath-1');
  expect(form.get('capture_source')).toBe('in_app_recording');
});

test('refuses to open the camera until the recording can name its athlete', async () => {
  await renderPage();

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Record for Film Study' }));
  });

  // The server refuses an in-app recording with no athlete, because the
  // guardian-consent sweep only runs for a video that names one. Failing here
  // first means the coach is told before the camera opens, not after the rep.
  expect(await screen.findByRole('alert')).toHaveTextContent(/choose which athlete/i);
  expect(recorderInstances).toHaveLength(0);
  expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
});

test('carries none of the Teach Shadow grouping controls', async () => {
  await renderPage();

  /*
   * Film Study records one coach filming one athlete. Join codes, takes and
   * multi-angle sessions belong to the surface that builds a corpus, and
   * their appearance here would mean the separation had been undone in the UI
   * even if the upload still looked right.
   */
  expect(screen.queryByText(/join code/i)).toBeNull();
  expect(screen.queryByRole('button', { name: /next take/i })).toBeNull();
  expect(screen.queryByRole('button', { name: /finish session/i })).toBeNull();
  expect(screen.queryByRole('button', { name: /start recording session/i })).toBeNull();
});

test('a file chosen from the device is not called an in-app recording', async () => {
  await renderPage();
  fireEvent.change(screen.getByLabelText(/which athlete/i), { target: { value: 'ath-1' } });

  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  await act(async () => {
    fireEvent.change(input, {
      target: { files: [new File(['x'], 'clip.mp4', { type: 'video/mp4' })] },
    });
  });

  await waitFor(() => expect(uploads).toHaveLength(1));
  // Provenance is declared, never inferred. Calling a file this app never
  // recorded an in-app recording would be a false claim about somebody
  // else's bytes.
  expect(uploads[0]!.get('capture_source')).toBe('file_upload');
  expect(uploads[0]!.get('capture_take_id')).toBeNull();
});
