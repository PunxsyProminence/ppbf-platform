/**
 * @jest-environment jsdom
 */

// LABEL AGREEMENT -- one sentence first, detail behind a button.
//
// What this suite pins: the sentence never states a percentage the report
// withheld, the page says body points are not included, a gym with one study
// is not asked to pick it, and a coach who is sent no progress sees none.

import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

import LabelAgreementPage from './page';

jest.mock('@/components/RoleSessionGate', () => ({
  __esModule: true,
  default: ({ children }: { readonly children: ReactNode }) => children,
}));

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href }: { readonly children: ReactNode; readonly href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

const PROJECTS_URL = '/api/pilot/calibration/projects';
const REPORT_URL = (id: string) => `/api/pilot/calibration/qa-report?calibration_project_id=${id}`;

// An unrecognised URL is recorded and fails the test, rather than answered
// ok:true and mistaken for a working page.
const unexpectedRequests: string[] = [];

const STUDY = { calibration_project_id: 'proj-1', name: 'Jab study' };
const OTHER_STUDY = { calibration_project_id: 'proj-2', name: 'Hook study' };

function rate(count: number, denominator: number, value: number | null, kind = 'matched pairs') {
  return { count, denominator, denominatorKind: kind, rate: value };
}

function report(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    project_name: 'Jab study',
    status: 'available',
    comparison_count: 6,
    minimum_comparisons: 5,
    report: {
      disagreementCounts: { PUNCH_TYPE: 4, BOUNDARY: 3, STANCE: 1, TARGET: 0 },
      disagreementRates: {
        PUNCH_TYPE: rate(4, 16, 0.25),
        BOUNDARY: rate(3, 16, 0.188),
        STANCE: rate(1, 16, 0.063),
        TARGET: rate(0, 16, 0),
      },
      boundaryDeltas: {
        start_ms: { count: 3, medianAbsoluteMs: 40 },
        contact_ms: { count: 0, medianAbsoluteMs: null },
        end_ms: { count: 0, medianAbsoluteMs: null },
      },
      unknownRate: rate(2, 80, 0.025, 'ontology values actually recorded'),
      hedgedCertaintyRate: rate(5, 32, 0.156, 'annotated events'),
      adjudicationRate: rate(1, 7, 0.143, 'pairings that raised a disagreement'),
    },
    clip_progress: { total_clips: 10, still_to_do_count: 3, left_out_count: 1 },
    ...overrides,
  };
}

function mockFetch(studies: unknown[], reports: Record<string, { status?: number; body: unknown }>) {
  const fetchMock = jest.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const answer = (status: number, body: unknown) => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    });
    if (url.endsWith(PROJECTS_URL)) return answer(200, { projects: studies });
    for (const [id, entry] of Object.entries(reports)) {
      if (url.endsWith(REPORT_URL(id))) return answer(entry.status ?? 200, entry.body);
    }
    unexpectedRequests.push(url);
    return answer(500, { error: `unexpected request ${url}` });
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

beforeEach(() => {
  unexpectedRequests.length = 0;
});

afterEach(() => {
  expect(unexpectedRequests).toEqual([]);
});

test('one study opens straight onto its sentence, with no picker', async () => {
  mockFetch([STUDY], { 'proj-1': { body: report() } });
  render(<LabelAgreementPage />);

  const headline = await screen.findByTestId('headline');
  expect(headline).toHaveTextContent(
    '6 clips compared. Top disagreements: which punch it was (4 times) and the timing of the action (3 times).',
  );
  expect(screen.queryByLabelText('Study')).not.toBeInTheDocument();
  expect(screen.queryByTestId('below-minimum')).not.toBeInTheDocument();
});

test('says body points are not included, and that nobody is being scored', async () => {
  mockFetch([STUDY], { 'proj-1': { body: report() } });
  render(<LabelAgreementPage />);

  const note = await screen.findByTestId('scope-note');
  expect(note).toHaveTextContent('Body-point labels (elbow, shoulder, hips, knees, feet) are not included yet.');
  expect(note).toHaveTextContent('not a coach and not an athlete');
});

test('with several studies it asks which, and reads only the one chosen', async () => {
  const fetchMock = mockFetch([STUDY, OTHER_STUDY], {
    'proj-2': { body: report({ project_name: 'Hook study', comparison_count: 0 }) },
  });
  render(<LabelAgreementPage />);

  fireEvent.change(await screen.findByLabelText('Study'), { target: { value: 'proj-2' } });

  expect(await screen.findByTestId('headline')).toHaveTextContent(
    'No clips can be compared yet. A clip is compared once two coaches have both finished labelling it.',
  );
  expect(fetchMock.mock.calls.map((call) => String(call[0])).filter((url) => url.includes('qa-report')))
    .toEqual([expect.stringContaining('calibration_project_id=proj-2')]);
  // Nothing to open when nothing was compared.
  expect(screen.queryByRole('button', { name: 'Show detail' })).not.toBeInTheDocument();
});

test('below the minimum it shows counts, says so, and prints no percentage anywhere', async () => {
  const thin = report({ status: 'insufficient_data', comparison_count: 2 });
  for (const entry of Object.values(thin.report.disagreementRates)) entry.rate = null;
  thin.report.unknownRate.rate = null;
  thin.report.hedgedCertaintyRate.rate = null;
  mockFetch([STUDY], { 'proj-1': { body: thin } });
  render(<LabelAgreementPage />);

  expect(await screen.findByTestId('below-minimum')).toHaveTextContent(
    'Not enough clips yet for percentages: 2 of the 5 needed.',
  );
  expect(screen.getByTestId('headline')).toHaveTextContent('which punch it was (4 times)');

  fireEvent.click(screen.getByRole('button', { name: 'Show detail' }));
  expect(screen.getByTestId('detail')).toHaveTextContent('4 of 16 matched pairs');
  expect(document.body.textContent).not.toMatch(/\d\s*%/);
});

test('says what is left to do and what was not counted, when it is told', async () => {
  mockFetch([STUDY], { 'proj-1': { body: report() } });
  render(<LabelAgreementPage />);

  expect(await screen.findByTestId('whats-left')).toHaveTextContent(
    'Still to do: 3 of 10 clips not yet labelled by two coaches.',
  );
  expect(screen.getByTestId('left-out')).toHaveTextContent('1 clip not counted yet');
});

test('a coach who is sent no progress sees no progress line', async () => {
  mockFetch([STUDY], { 'proj-1': { body: report({ clip_progress: null }) } });
  render(<LabelAgreementPage />);

  await screen.findByTestId('headline');
  expect(screen.queryByTestId('whats-left')).not.toBeInTheDocument();
  expect(screen.queryByTestId('left-out')).not.toBeInTheDocument();
});

test('the detail lists only what was disagreed on, each with what it was counted out of', async () => {
  mockFetch([STUDY], { 'proj-1': { body: report() } });
  render(<LabelAgreementPage />);

  await screen.findByTestId('headline');
  expect(screen.queryByTestId('detail')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Show detail' }));

  const detail = screen.getByTestId('detail');
  expect(detail).toHaveTextContent('which punch it was');
  expect(detail).toHaveTextContent('4 of 16 matched pairs');
  expect(detail).toHaveTextContent('25%');
  expect(detail).not.toHaveTextContent('where it was aimed');
  expect(detail).toHaveTextContent('When they differed on the start of an action (3 times), the typical gap was 40 ms.');
  expect(detail).toHaveTextContent('Actions with a disagreement: 7. Reviewed by an administrator so far: 1.');
  expect(detail).not.toHaveTextContent('contact of an action');
  expect(detail).toHaveTextContent('2 of 80 values (3%)');
});

test('timing differences are counted, never given as a share that could pass 100%', async () => {
  const busy = report();
  busy.report.disagreementCounts.BOUNDARY = 8;
  busy.report.disagreementRates.BOUNDARY = rate(8, 4, 2);
  busy.report.disagreementRates.STANCE = rate(1, 250, 0.004);
  mockFetch([STUDY], { 'proj-1': { body: busy } });
  render(<LabelAgreementPage />);

  fireEvent.click(await screen.findByRole('button', { name: 'Show detail' }));

  const detail = screen.getByTestId('detail');
  expect(detail).toHaveTextContent('8 differences across 4 matched pairs');
  expect(detail).not.toHaveTextContent('200%');
  expect(detail).toHaveTextContent('under 1%');
});

test('no recorded disagreement is reported as that, not as agreement', async () => {
  const quiet = report();
  quiet.report.disagreementCounts = { PUNCH_TYPE: 0, BOUNDARY: 0, STANCE: 0, TARGET: 0 };
  for (const entry of Object.values(quiet.report.disagreementRates)) entry.count = 0;
  mockFetch([STUDY], { 'proj-1': { body: quiet } });
  render(<LabelAgreementPage />);

  expect(await screen.findByTestId('headline')).toHaveTextContent(
    /^6 clips compared\. No disagreements were recorded on them\.$/,
  );
  expect(screen.getByTestId('headline')).not.toHaveTextContent(/agreed/);
  expect(screen.getByTestId('scope-note')).toBeInTheDocument();
});

test('a slow answer for the first study is not shown under the second', async () => {
  let releaseFirst: (value: unknown) => void = () => {};
  const first = new Promise((resolve) => { releaseFirst = resolve; });
  const answer = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
  global.fetch = jest.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith(PROJECTS_URL)) return answer({ projects: [STUDY, OTHER_STUDY] });
    if (url.endsWith(REPORT_URL('proj-1'))) {
      await first;
      return answer(report({ project_name: 'Jab study', comparison_count: 9 }));
    }
    return answer(report({ project_name: 'Hook study', comparison_count: 0 }));
  }) as unknown as typeof fetch;
  render(<LabelAgreementPage />);

  const picker = await screen.findByLabelText('Study');
  fireEvent.change(picker, { target: { value: 'proj-1' } });
  fireEvent.change(picker, { target: { value: 'proj-2' } });
  await screen.findByText('Hook study', { selector: 'p' });
  releaseFirst(undefined);
  await new Promise((resolve) => { setTimeout(resolve, 0); });

  expect(screen.getByTestId('headline')).toHaveTextContent('No clips can be compared yet.');
  expect(screen.queryByText('Jab study', { selector: 'p' })).not.toBeInTheDocument();

  // Back to "choose a study" clears the figures rather than leaving them up.
  fireEvent.change(picker, { target: { value: '' } });
  await waitFor(() => expect(screen.queryByTestId('headline')).not.toBeInTheDocument());
});

test('figures that arrive half-formed are an error, not a crash', async () => {
  mockFetch([STUDY], { 'proj-1': { body: { comparison_count: 3, report: { disagreementCounts: {} } } } });
  render(<LabelAgreementPage />);

  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('could not be read'));
});

test('when the figures are withheld it still says how many clips were compared', async () => {
  mockFetch([STUDY], { 'proj-1': { body: report({ report: null, comparison_count: 2, status: 'insufficient_data' }) } });
  render(<LabelAgreementPage />);

  expect(await screen.findByTestId('headline')).toHaveTextContent(/^2 clips compared\.$/);
  expect(screen.queryByRole('button', { name: 'Show detail' })).not.toBeInTheDocument();
});

test('a refusal is shown as the alert, not as an empty study', async () => {
  mockFetch([STUDY], { 'proj-1': { status: 403, body: { error: 'Forbidden: role not allowed' } } });
  render(<LabelAgreementPage />);

  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Forbidden: role not allowed'));
  expect(screen.queryByTestId('headline')).not.toBeInTheDocument();
});

test('no study yet points at the cutter', async () => {
  mockFetch([], {});
  render(<LabelAgreementPage />);

  expect(await screen.findByRole('link', { name: 'Cut a study clip' })).toHaveAttribute(
    'href',
    '/teach-shadow/cut',
  );
});
