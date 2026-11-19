/**
 * @jest-environment jsdom
 */

/**
 * BOA-01 (lane SH): the calibration clip picker that replaces the "No clip
 * named" dead end on the Calibration Review and Adjudication pages. It lists
 * studies and a study's clips from the two annotator reads and opens the page
 * it sits on with the chosen clip. Every state says what it is; a failed read
 * never reads as "no studies" or "no clips".
 */

import '@testing-library/jest-dom';
import type { ReactNode } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';

import CalibrationClipPicker, { clipOptionLabel } from './CalibrationClipPicker';

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href, className }: { readonly children: ReactNode; readonly href: string; readonly className?: string }) => (
    <a href={href} className={className}>{children}</a>
  ),
}));

const BASE = '/admin/calibration/review';
const STUDIES = [
  { calibration_project_id: 'proj-1', name: 'Jab study', ontology_version: '0.1', status: 'draft' },
  { calibration_project_id: 'proj-2', name: 'Hook study', ontology_version: '0.1', status: 'draft' },
];
const CLIPS = [
  { calibration_clip_id: 'clip-a', calibration_project_id: 'proj-1', clip_code: 'C-001', start_ms: 12_000, end_ms: 18_000, playable: true },
  { calibration_clip_id: 'clip b/2', calibration_project_id: 'proj-1', clip_code: 'C-002', start_ms: 61_500, end_ms: 67_500, playable: false },
];

function respond(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 500, json: async () => body } as unknown as Response;
}

type Handler = (url: string) => Response | Promise<Response>;

function serve(handler: Handler) {
  const fetchMock = jest.fn(async (input: unknown) => handler(String(input)));
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

const defaultHandler: Handler = (url) => {
  if (url.includes('/api/pilot/calibration/projects')) return respond({ ok: true, projects: STUDIES });
  if (url.includes('calibration_project_id=proj-1')) return respond({ ok: true, clips: CLIPS });
  if (url.includes('calibration_project_id=proj-2')) return respond({ ok: true, clips: [] });
  throw new Error(`unexpected ${url}`);
};

afterEach(() => {
  jest.restoreAllMocks();
});

test('reads the studies, then the chosen study\'s clips, and opens this page with the chosen clip', async () => {
  const fetchMock = serve(defaultHandler);
  render(<CalibrationClipPicker basePath={BASE} />);

  expect(screen.getByRole('heading', { name: 'Pick a clip' })).toBeInTheDocument();
  expect(screen.getByText('Reading studies')).toBeInTheDocument();
  const study = await screen.findByLabelText('Study');
  expect((screen.getByRole('button', { name: 'Open clip' }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByLabelText('Clip') as HTMLSelectElement).disabled).toBe(true);

  await act(async () => {
    fireEvent.change(study, { target: { value: 'proj-1' } });
  });
  const clip = screen.getByLabelText('Clip') as HTMLSelectElement;
  expect(clip.disabled).toBe(false);
  expect(Array.from(clip.options).map((o) => o.textContent)).toEqual([
    'Choose a clip',
    clipOptionLabel(CLIPS[0]),
    clipOptionLabel(CLIPS[1]),
  ]);
  expect(clipOptionLabel(CLIPS[0])).toBe('C-001 · 0:12.000 to 0:18.000');

  fireEvent.change(clip, { target: { value: 'clip b/2' } });
  const open = screen.getByRole('link', { name: 'Open clip' });
  expect(open.getAttribute('href')).toBe(`${BASE}?calibration_clip_id=clip%20b%2F2`);

  expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
    expect.stringContaining('/api/pilot/calibration/projects'),
    expect.stringContaining('/api/pilot/calibration/clips?calibration_project_id=proj-1'),
  ]);
});

test('no studies yet says where studies are made', async () => {
  serve(() => respond({ ok: true, projects: [] }));
  render(<CalibrationClipPicker basePath={BASE} />);
  expect(await screen.findByText('No studies yet. Studies are made on the Teach SHADOW annotation page.')).toBeInTheDocument();
  expect(screen.queryByLabelText('Study')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Open clip' })).toBeNull();
});

test.each([
  ['a refused read', () => respond({ error: 'Forbidden' }, false)],
  ['an answer with no study list', () => respond({ ok: true })],
  ['no answer at all', () => { throw new TypeError('Failed to fetch'); }],
])('%s says the studies could not be read, never "no studies"', async (_name, answer) => {
  serve(answer as Handler);
  render(<CalibrationClipPicker basePath={BASE} />);
  expect(await screen.findByText(/Studies could not be read\. Reload to try again\./)).toBeInTheDocument();
  expect(screen.queryByText(/No studies yet/)).toBeNull();
});

test('a study with no clips says so, and nothing can be opened', async () => {
  serve(defaultHandler);
  render(<CalibrationClipPicker basePath={BASE} />);
  const study = await screen.findByLabelText('Study');
  await act(async () => {
    fireEvent.change(study, { target: { value: 'proj-2' } });
  });
  expect(screen.getByText('This study has no clips yet.')).toBeInTheDocument();
  expect((screen.getByLabelText('Clip') as HTMLSelectElement).disabled).toBe(true);
  expect(screen.queryByRole('link', { name: 'Open clip' })).toBeNull();
});

test('a failed clip read says so, never "no clips"', async () => {
  serve((url) => (url.includes('/projects') ? respond({ ok: true, projects: STUDIES }) : respond({ error: 'x' }, false)));
  render(<CalibrationClipPicker basePath={BASE} />);
  const study = await screen.findByLabelText('Study');
  await act(async () => {
    fireEvent.change(study, { target: { value: 'proj-1' } });
  });
  expect(screen.getByText(/Clips could not be read\. Reload to try again\./)).toBeInTheDocument();
  expect(screen.queryByText('This study has no clips yet.')).toBeNull();
  expect(screen.queryByRole('link', { name: 'Open clip' })).toBeNull();
});

test('changing the study clears the chosen clip, and a slow answer for the old study is dropped', async () => {
  let releaseOld: (() => void) | undefined;
  serve((url) => {
    if (url.includes('/projects')) return respond({ ok: true, projects: STUDIES });
    if (url.includes('proj-1')) {
      return new Promise<Response>((resolve) => {
        releaseOld = () => resolve(respond({ ok: true, clips: CLIPS }));
      });
    }
    return respond({ ok: true, clips: [] });
  });
  render(<CalibrationClipPicker basePath={BASE} />);
  const study = await screen.findByLabelText('Study');

  await act(async () => {
    fireEvent.change(study, { target: { value: 'proj-1' } });
  });
  expect(screen.getByText('Reading clips')).toBeInTheDocument();
  await act(async () => {
    fireEvent.change(study, { target: { value: 'proj-2' } });
  });
  expect(screen.getByText('This study has no clips yet.')).toBeInTheDocument();

  await act(async () => {
    releaseOld?.();
  });
  // proj-1's clips arrived late and are not shown under proj-2.
  const clip = screen.getByLabelText('Clip') as HTMLSelectElement;
  expect(Array.from(clip.options).map((o) => o.value)).toEqual(['']);
  expect(screen.getByText('This study has no clips yet.')).toBeInTheDocument();
});

test('choosing a clip, then another study, takes the open link away', async () => {
  serve(defaultHandler);
  render(<CalibrationClipPicker basePath={BASE} />);
  const study = await screen.findByLabelText('Study');
  await act(async () => {
    fireEvent.change(study, { target: { value: 'proj-1' } });
  });
  fireEvent.change(screen.getByLabelText('Clip'), { target: { value: 'clip-a' } });
  expect(screen.getByRole('link', { name: 'Open clip' })).toBeInTheDocument();
  await act(async () => {
    fireEvent.change(study, { target: { value: 'proj-2' } });
  });
  expect(screen.queryByRole('link', { name: 'Open clip' })).toBeNull();
});
