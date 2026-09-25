/**
 * @jest-environment jsdom
 */

// TEACH SHADOW: the home.
//
// What this suite pins is the one claim this page is forbidden to make. No
// recognition model has been trained or evaluated, so a percentage, a gauge or
// an "0%" anywhere on this surface would tell a coach the recognizer had been
// tried -- and, at zero, that it had failed. The wording in page.tsx says so in
// a comment; a comment does not fail a build, and the figure most likely to be
// added later ("it looks empty, put a readiness dial on it") is exactly the one
// that breaks the ruling. The rest of the file holds the teaching order, the
// two doors, and the difference between a corpus with nothing in it and a read
// that did not come back.

import '@testing-library/jest-dom';
import { render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';

import TeachShadowHomePage from './page';

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

// The page builds this from `apiBase()`, which is '' unless NEXT_PUBLIC_API_BASE
// is set (src/lib/apiBase.ts:15) -- it is not set under Jest, so the request is
// the bare path. Pinning the literal is deliberate: if the page ever reads a
// different route, these tests must not quietly follow it.
const COVERAGE_URL = '/api/pilot/teach-shadow/coverage';
// The second read this page makes. Pinned as its own literal for the same
// reason as the first: if the page ever asks for something else, these tests
// must not quietly follow it.
const HELD_URL = '/api/pilot/teach-shadow/held';

// A catch-all fetch mock that answers ok:true to anything is a known hazard in
// this repo (app/coach/video-analysis/page.test.tsx:156): a fetch added later is
// never exercised and the suite still reports green. Worse here -- this page
// catches every error from its effect and turns it into the alert, so an
// unrecognised URL would masquerade as the error state and the error test would
// pass for the wrong reason. So: throw on anything unexpected AND record it,
// and fail the test in afterEach on the record.
const unexpectedRequests: string[] = [];

function mockCoverageFetch(respond: () => Response, held: () => Response = () => jsonResponse({ ok: true, items: [] })) {
  const mock = jest.fn(async (input: RequestInfo | URL) => {
    const requested = String(input);
    if (requested === COVERAGE_URL) return respond();
    if (requested === HELD_URL) return held();
    unexpectedRequests.push(requested);
    throw new Error(`Unexpected fetch: ${requested}`);
  });
  global.fetch = mock as unknown as typeof fetch;
  return mock;
}

function jsonResponse(body: unknown, ok = true) {
  return { ok, json: async () => body } as Response;
}

/*
 * Numbers chosen so that no constant in the page could produce them by
 * accident, and so that no two fields share a value: a count rendered from the
 * wrong field would read as a different number here, not as a coincidence.
 */
const COVERAGE = {
  ontology_version: 'boxing-ontology-0.1',
  capture: {
    recording_sessions: 5,
    capture_takes: 19,
    captured_files: 37,
    takes_with_multiple_files: 11,
    athletes_captured: 23,
  },
  labelling: {
    clips_cut: 64,
    submitted_sets: 41,
    clips_with_two_submitted_sets: 17,
    adjudications: 9,
    gold_records: 13,
    gold_candidates: 6,
  },
  punch_evidence: [
    // Deliberately handed to the page BEST-COVERED FIRST, so a page that simply
    // rendered the payload in the order it arrived would fail the ordering test.
    { punch_type: 'lead_straight', stance: 'orthodox', events: 412, clips: 57 },
    { punch_type: 'lead_hook', stance: null, events: 6, clips: 3 },
    { punch_type: 'rear_uppercut', stance: 'southpaw', events: 0, clips: 0 },
    // Catch-alls, at zero. They must not occupy the list: nobody can be sent
    // to the gym to film an unclassifiable punch.
    { punch_type: 'other_punch', stance: 'orthodox', events: 0, clips: 0 },
    { punch_type: 'unclassifiable_punch', stance: 'orthodox', events: 0, clips: 0 },
  ],
  defense_evidence: [
    { defense_type: 'slip', events: 28, clips: 14 },
    { defense_type: 'roll', events: 0, clips: 0 },
  ],
  vocabulary: {
    punch_types: ['lead_straight', 'lead_hook', 'rear_uppercut', 'other_punch', 'unclassifiable_punch'],
    defense_types: ['slip', 'roll'],
    stances: ['orthodox', 'southpaw'],
  },
};

const originalFetch = global.fetch;

afterEach(() => {
  expect(unexpectedRequests).toEqual([]);
  unexpectedRequests.length = 0;
  global.fetch = originalFetch;
  jest.clearAllMocks();
});

/** Whitespace as JSX emits it is not whitespace as a reader sees it. */
function pageText(): string {
  return (document.body.textContent ?? '').replace(/\s+/g, ' ');
}

/** The <dd> that belongs to a given <dt>, so a count is read through its label. */
function valueFor(label: string): string {
  const term = screen.getByText(label);
  return (term.nextElementSibling?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

async function renderLoaded() {
  mockCoverageFetch(() => jsonResponse({ ok: true, coverage: COVERAGE }));
  render(<TeachShadowHomePage />);
  // Only rendered once the coverage payload has landed, so awaiting it means
  // every later assertion is against the loaded page, not the loading one.
  await screen.findByText('Athletes filmed');
}

test('the loaded page makes no model-performance claim: no percentage anywhere, and no figure in the model section', async () => {
  // THE RULING THIS FILE EXISTS FOR. Nothing has been trained or evaluated, so
  // any percentage is a claim about a model that does not exist -- and 0% is
  // the worst of them, because it reads as "measured, and hopeless" rather than
  // "not measured". This is what stops somebody later adding a readiness gauge
  // to fill the space.
  await renderLoaded();

  expect(pageText()).not.toContain('%');

  const modelSection = screen.getByRole('heading', { name: 'Model performance' }).closest('section');
  expect(modelSection).not.toBeNull();
  expect(modelSection?.textContent).toContain('No evaluated recognition model yet');
  // No digit at all in that section: "0%", "72% accuracy" and "confidence 0.4"
  // all fail here, and a sentence about an absent model needs no number.
  expect(modelSection?.textContent ?? '').not.toMatch(/\d/);

  // A gauge would most likely arrive as one of these rather than as literal text.
  expect(screen.queryByRole('meter')).not.toBeInTheDocument();
  expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  expect(document.querySelector('meter, progress')).toBeNull();
});

test('the page says Teach Shadow footage stays separate from Film Study', async () => {
  // Film Study footage can never be promoted into the teaching corpus, and the
  // home is where a coach first learns the two are not one pool of video.
  await renderLoaded();

  expect(pageText()).toContain('stays separate from Film Study');
});

test('the sections run in the order of the teaching loop, not in tool-directory order', async () => {
  // The order IS the method: find the thinnest area, film it, label it, see
  // what the corpus now holds, then the vocabulary, and only last the model
  // that does not exist yet. Alphabetising these, or hoisting the two buttons
  // to the top, would leave the same tools and none of the instruction.
  await renderLoaded();

  const headings = screen
    .getAllByRole('heading', { level: 2 })
    .map((heading) => heading.textContent);

  /*
   * THREE STACKED STAGES, NOT A TWO-CARD PAIRING. Capture, release, label is a
   * DEPENDENCY: footage cannot be labelled until somebody has released it. A
   * grid with release underneath would read "capture and label, then release",
   * which is the wrong instruction.
   */
  expect(headings).toEqual([
    'What Shadow needs more of',
    'Capture examples',
    'Held teaching footage',
    'Label & verify',
    'Corpus coverage',
    'Current vocabulary',
    'Model performance',
  ]);
});

test('the two doors point at capture and annotation', async () => {
  await renderLoaded();

  expect(screen.getByRole('link', { name: 'Capture Examples' })).toHaveAttribute(
    'href',
    '/teach-shadow/capture',
  );
  expect(screen.getByRole('link', { name: 'Clip Annotation' })).toHaveAttribute(
    'href',
    '/teach-shadow/annotation',
  );
});

test('every coverage count is rendered from the payload, not from a constant in the page', async () => {
  // Counts are evidence that exists. A number baked into the page would be a
  // claim about the gym's work that no row stands behind, and it would keep
  // reading the same after a month of filming.
  const fetchMock = mockCoverageFetch(() => jsonResponse({ ok: true, coverage: COVERAGE }));

  render(<TeachShadowHomePage />);
  await screen.findByText('Athletes filmed');

  // credentials:'include' is what makes this read org-scoped from the session
  // rather than from anything the caller could name. Dropping it would send an
  // unauthenticated read, and the route would refuse it (route.ts:31).
  expect(fetchMock).toHaveBeenCalledWith(COVERAGE_URL, { credentials: 'include' });

  expect(pageText()).toContain('boxing-ontology-0.1');

  /*
   * EVERY COUNT READ THROUGH ITS OWN LABEL, not looked for anywhere on the
   * page. A value landing under the wrong heading fails here rather than
   * passing because the digits exist somewhere in the document -- which is
   * how a coverage panel comes to report takes under "athletes" and nobody
   * notices.
   */
  expect(valueFor('Files captured')).toBe('37');
  expect(valueFor('Takes recorded')).toBe('19 in 5 sessions');
  expect(valueFor('Takes with more than one file')).toBe('11');
  expect(valueFor('Athletes filmed')).toBe('23');
  expect(valueFor('Clips cut for labelling')).toBe('64');
  expect(valueFor('Annotation sets submitted')).toBe('41');
  expect(valueFor('Clips with two submitted sets')).toBe('17');
  expect(valueFor('Adjudications settled')).toBe('9');
  // PROMOTED and CANDIDATE are different states and the panel must not merge
  // them: a candidate is adjudicated and deliberately not in the dataset.
  expect(valueFor('Gold records promoted')).toBe('13, with 6 still a candidate');
});

test('the thinnest evidence is listed first, and a cell with nothing in it says so in words', async () => {
  // THINNEST FIRST is the whole point of the section: a gym films its orthodox
  // fighters constantly and its southpaws rarely, and the cell nobody has
  // filmed is the one somebody should go and film. If the well-covered cell
  // floated to the top -- an inverted comparator, or the payload order used
  // as-is -- the section would point coaches at the work already done.
  await renderLoaded();

  const needsSection = screen
    .getByRole('heading', { name: 'What Shadow needs more of' })
    .closest('section');
  expect(needsSection).not.toBeNull();

  const items = within(needsSection as HTMLElement)
    .getAllByRole('listitem')
    .map((item) => item.textContent ?? '');

  expect(items).toHaveLength(3);
  expect(items[0]).toContain('Rear uppercut');
  expect(items[0]).toContain('Southpaw');
  expect(items[1]).toContain('Lead hook');
  expect(items[2]).toContain('Lead straight');

  // The empty cell is named as unlabelled, not rendered as the number 0, which
  // would sit in a list of counts looking like a measurement.
  expect(items[0]).toContain('No labelled examples yet');
  expect(items[0]).not.toMatch(/\d/);
  expect(items[1]).toContain('6 labelled examples across 3 clips');
});

test('the gap list names only punches somebody could go and film', async () => {
  /*
   * 'other_punch' and 'unclassifiable_punch' name what an annotator could not
   * classify. They sit at or near zero permanently, so a thinnest-first list
   * that included them would be topped by them forever and would push out the
   * cells a coach could actually do something about.
   */
  await renderLoaded();

  const needsSection = screen
    .getByRole('heading', { name: 'What Shadow needs more of' })
    .closest('section') as HTMLElement;

  expect(needsSection.textContent).not.toContain('Other punch');
  expect(needsSection.textContent).not.toContain('Unclassifiable punch');
});

const HELD_ITEM = {
  video_session_id: 'vs-1',
  file_name: 'capture.webm',
  take_number: 3,
  camera_view: 'front',
  status: 'quarantined',
  scan_state: 'unconfigured',
  releasable: true,
  refused_by_scan: false,
};

test('held footage is listed by take and angle, and Release waits on opening it', async () => {
  /*
   * THE REGRESSION THIS SECTION EXISTS FOR. Every upload is held, and the only
   * Release control used to live on the Film Study screen -- which this area
   * was deliberately hidden from. Teaching footage then sat quarantined
   * forever, calibration refused it for not being 'ready', and nothing a coach
   * could open said why.
   *
   * Release starts disabled because the SERVER refuses a release with no
   * review link. The button is not the protection; it just stops a coach
   * pressing something that would fail.
   */
  mockCoverageFetch(
    () => jsonResponse({ ok: true, coverage: COVERAGE }),
    () => jsonResponse({ ok: true, items: [HELD_ITEM] }),
  );

  render(<TeachShadowHomePage />);
  await screen.findByText(/Take 3/);

  expect(pageText()).toContain('front');
  expect(screen.getByRole('button', { name: 'Open for review' })).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Release' })).toBeDisabled();
  expect(pageText()).toContain('Open this footage for review before Release becomes available');
});

test('footage the scan refused is shown and marked, not quietly dropped', async () => {
  /*
   * Nobody can release it -- but a coach who films something and watches it
   * vanish cannot tell a refusal from a capture that never saved. It stays on
   * the list, with no controls and a plain reason.
   */
  mockCoverageFetch(
    () => jsonResponse({ ok: true, coverage: COVERAGE }),
    () => jsonResponse({
      ok: true,
      items: [{ ...HELD_ITEM, releasable: false, refused_by_scan: true, scan_state: 'blocked' }],
    }),
  );

  render(<TeachShadowHomePage />);
  await screen.findByText(/Take 3/);

  expect(pageText()).toContain('The content screen refused this file');
  expect(screen.queryByRole('button', { name: 'Release' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Open for review' })).toBeNull();
});

test('nothing held says so, rather than looking broken', async () => {
  mockCoverageFetch(() => jsonResponse({ ok: true, coverage: COVERAGE }));

  render(<TeachShadowHomePage />);
  await screen.findByText(/Nothing is waiting/);

  expect(pageText()).toContain('Footage you film appears here until you release it');
});

test('the held section never claims anybody watched anything', async () => {
  /*
   * THE HONESTY CONSTRAINT ON A SAFEGUARDING CONTROL. The server can prove it
   * issued this person a review link for this file. It cannot prove they
   * watched -- the browser fetches the footage straight from storage. Wording
   * that said "reviewed" or "watched" would be claiming what nothing here can
   * observe.
   */
  mockCoverageFetch(
    () => jsonResponse({ ok: true, coverage: COVERAGE }),
    () => jsonResponse({ ok: true, items: [HELD_ITEM] }),
  );

  render(<TeachShadowHomePage />);
  await screen.findByText(/Take 3/);

  const section = screen.getByRole('heading', { name: 'Held teaching footage' }).closest('section');
  expect(section?.textContent ?? '').not.toMatch(/watched|you have reviewed|inspection/i);
  expect(section?.textContent ?? '').toContain('open');
});

test('a failed read shows an alert and does not render zeros as if the gym had filmed nothing', async () => {
  // A READ THAT DID NOT COME BACK IS NOT AN EMPTY CORPUS. Falling back to zeros
  // would paint a specific and wrong picture of the gym's work -- and would
  // send a coach to film footage they may already have.
  mockCoverageFetch(() => jsonResponse({ error: 'The coverage figures could not be read.' }, false));

  render(<TeachShadowHomePage />);

  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent('The coverage figures could not be read.');

  const text = pageText();
  expect(screen.queryByText('Athletes filmed')).not.toBeInTheDocument();
  expect(text).not.toMatch(/\b0 (file|take|session|adjudication|gold)/);
  expect(text).toContain('No coverage figures are available.');
});

test('a 200 with no coverage body is an alert too, not a silently empty corpus', async () => {
  // The route answers { ok: true, coverage } (route.ts:36). A response that
  // parsed but carried no coverage is a broken read wearing a success status,
  // and the guard that catches it is one line and easy to delete.
  mockCoverageFetch(() => jsonResponse({ ok: true }));

  render(<TeachShadowHomePage />);

  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent('The coverage figures could not be read.');
  expect(screen.queryByText('Athletes filmed')).not.toBeInTheDocument();
});
