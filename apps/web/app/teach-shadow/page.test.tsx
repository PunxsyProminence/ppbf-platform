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
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
// The two writes the held queue makes. Pinned as literals for the same reason
// as the reads: a page that starts calling something else must fail here
// rather than have these tests follow it.
const REVIEW_LINK_URL = '/api/pilot/video/review-link';
const RELEASE_URL = (id: string) => `/api/pilot/video/${id}/release`;
// The third read, and the write it offers. The released list is the inventory
// behind the coverage figures and the only surface that withdraws footage from
// them; archiving is the only thing on this page that makes a count go DOWN.
const RELEASED_URL = '/api/pilot/teach-shadow/released';
const ARCHIVE_URL = (id: string) => `/api/pilot/video/${id}/archive`;

// A catch-all fetch mock that answers ok:true to anything is a known hazard in
// this repo (app/coach/video-analysis/page.test.tsx:156): a fetch added later is
// never exercised and the suite still reports green. Worse here -- this page
// catches every error from its effect and turns it into the alert, so an
// unrecognised URL would masquerade as the error state and the error test would
// pass for the wrong reason. So: throw on anything unexpected AND record it,
// and fail the test in afterEach on the record.
const unexpectedRequests: string[] = [];

function mockCoverageFetch(
  respond: () => Response,
  held: () => Response = () => jsonResponse({ ok: true, items: [] }),
  reviewLink: () => Response = () => jsonResponse({ ok: true, url: REVIEW_SAS }),
  released: () => Response = () => jsonResponse({ ok: true, items: [] }),
  archive: () => Response = () => jsonResponse({ ok: true }),
) {
  // The init is captured as well as the URL: the archive control sends its
  // action in the body, and a suite that only saw the path could not tell
  // "archive" from "restore".
  const mock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const requested = String(input);
    // Declared so the RECORDED calls carry the request body; no responder reads
    // it. The archive assertions below need it, and a one-parameter mock records
    // only the URL -- which cannot tell "archive" from "restore".
    void init;
    if (requested === COVERAGE_URL) return respond();
    if (requested === HELD_URL) return held();
    if (requested === RELEASED_URL) return released();
    if (requested === REVIEW_LINK_URL) return reviewLink();
    if (requested === RELEASE_URL('vs-1')) return jsonResponse({ ok: true });
    if (requested === ARCHIVE_URL('vs-live') || requested === ARCHIVE_URL('vs-gone')) return archive();
    unexpectedRequests.push(requested);
    throw new Error(`Unexpected fetch: ${requested}`);
  });
  global.fetch = mock as unknown as typeof fetch;
  return mock;
}

const REVIEW_SAS = 'https://blob.example/v.webm?sas';

function requestedUrls(mock: ReturnType<typeof mockCoverageFetch>): string[] {
  return mock.mock.calls.map(([input]) => String(input));
}

/*
 * A stand-in for the window the page opens on the click. The page navigates
 * this handle once the URL arrives, so the test can see whether the footage
 * was ever actually shown -- which a spy returning a bare truthy object
 * could not.
 */
function fakeReviewWindow() {
  return { opener: {} as unknown, location: { replace: jest.fn() }, close: jest.fn() };
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
  await screen.findByText('Takes with more than one file');
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
    // CUT sits between release and label because that is the order of the
    // work: footage cannot be labelled until somebody has cut a clip from it.
    // Its absence is what broke the loop -- cutting was an operator script, so
    // a coach could film and could label and nothing joined the two.
    'Cut study clips',
    'Label & verify',
    'Corpus coverage',
    'Current vocabulary',
    'Model performance',
    // LAST, AND OUTSIDE THE LOOP. Withdrawing footage is housekeeping, not a
    // stage of teaching, and it reads as the inventory behind the figures
    // rather than as a step somebody is meant to take each session.
    'Footage in the corpus',
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
  await screen.findByText('Takes with more than one file');

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
  // TS-ANON-01: removed on purpose. An anonymous corpus cannot honestly
  // report how many unique people are in it, and a number that looked
  // authoritative would be worse than no number.
  expect(screen.queryByText('Athletes filmed')).toBeNull();
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

/*
 * Scoped rather than searched page-wide, and it THROWS when the section is
 * missing: the read-failure assertion below is a negative one, and against a
 * section that had not rendered at all it would pass for the wrong reason.
 * Same shape as releasedSection() further down.
 */
function heldSection(): HTMLElement {
  const section = screen.getByRole('heading', { name: 'Held teaching footage' }).closest('section');
  if (!section) throw new Error('test bug: the held section did not render');
  return section as HTMLElement;
}

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

test('NEGATIVE CONTROL -- a blocked review window asks for no link at all', async () => {
  /*
   * THE ORDER IS THE CONTROL, not just the null check.
   *
   * review-link WRITES the video_review_link_issued audit row that the server
   * accepts as the release prerequisite. Requesting the link first and only
   * then discovering the popup was blocked leaves that row already written:
   * Release stays disabled on this page, but a direct POST would satisfy the
   * server with no review window ever opened. So the window must be opened
   * synchronously on the click, and a refusal must abort BEFORE the request.
   */
  const opener = jest.spyOn(window, 'open').mockReturnValue(null);
  const fetchMock = mockCoverageFetch(
    () => jsonResponse({ ok: true, coverage: COVERAGE }),
    () => jsonResponse({ ok: true, items: [HELD_ITEM] }),
  );

  render(<TeachShadowHomePage />);
  await screen.findByText(/Take 3/);
  fireEvent.click(screen.getByRole('button', { name: 'Open for review' }));

  expect(await screen.findByRole('alert')).toHaveTextContent(/blocked the review window/i);
  expect(screen.getByRole('button', { name: 'Release' })).toBeDisabled();
  // The whole point: no credential was minted, so nothing exists for a direct
  // POST to lean on.
  expect(requestedUrls(fetchMock)).not.toContain(REVIEW_LINK_URL);
  opener.mockRestore();
});

test('NEGATIVE CONTROL -- a failed review-link closes the window it opened', async () => {
  /*
   * The window is opened before the request, so the failure path owns it. A
   * blank tab left behind would look like the footage failed to load rather
   * than like the request failing, and the coach would sit waiting on it.
   */
  const reviewWindow = fakeReviewWindow();
  const opener = jest.spyOn(window, 'open').mockReturnValue(reviewWindow as unknown as Window);
  mockCoverageFetch(
    () => jsonResponse({ ok: true, coverage: COVERAGE }),
    () => jsonResponse({ ok: true, items: [HELD_ITEM] }),
    () => jsonResponse({ error: 'That footage could not be opened for review.' }, false),
  );

  render(<TeachShadowHomePage />);
  await screen.findByText(/Take 3/);
  fireEvent.click(screen.getByRole('button', { name: 'Open for review' }));

  expect(await screen.findByRole('alert')).toHaveTextContent(/could not be opened for review/i);
  expect(reviewWindow.close).toHaveBeenCalled();
  expect(reviewWindow.location.replace).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Release' })).toBeDisabled();
  opener.mockRestore();
});

test('a successful issuance navigates the open window, and only then arms Release', async () => {
  /*
   * The positive control the two above are negatives of. Release becomes
   * available only once the window is actually showing the footage -- and the
   * opener reference is severed, so the review tab cannot reach back into
   * this page.
   */
  const reviewWindow = fakeReviewWindow();
  const opener = jest.spyOn(window, 'open').mockReturnValue(reviewWindow as unknown as Window);
  mockCoverageFetch(
    () => jsonResponse({ ok: true, coverage: COVERAGE }),
    () => jsonResponse({ ok: true, items: [HELD_ITEM] }),
  );

  render(<TeachShadowHomePage />);
  await screen.findByText(/Take 3/);
  // Opened blank on the click -- the URL is not known yet.
  fireEvent.click(screen.getByRole('button', { name: 'Open for review' }));
  expect(opener).toHaveBeenCalledWith('', '_blank');

  /*
   * waitFor, not findByRole: the Release button is ALREADY in the document,
   * disabled. findByRole would resolve on it immediately, before the state
   * that arms it has flushed, and the assertion below would read the stale
   * disabled button -- a test that passes only by accident of timing.
   */
  await waitFor(() => {
    expect(screen.getByRole('button', { name: 'Release' })).toBeEnabled();
  });
  expect(reviewWindow.location.replace).toHaveBeenCalledWith(REVIEW_SAS);
  expect(reviewWindow.opener).toBeNull();
  opener.mockRestore();
});

test('malware and a content-screen refusal are not the same message', async () => {
  /*
   * 'infected' came from a real scanner and no human may release it on any
   * surface; 'blocked' is a judgement an organization admin can still review.
   * Telling a coach to ask an administrator about malware sends them after
   * something nobody can do.
   */
  mockCoverageFetch(
    () => jsonResponse({ ok: true, coverage: COVERAGE }),
    () => jsonResponse({
      ok: true,
      items: [{ ...HELD_ITEM, status: 'infected', releasable: false, refused_by_scan: true }],
    }),
  );

  render(<TeachShadowHomePage />);
  await screen.findByText(/Take 3/);

  expect(pageText()).toContain('A scanner found malware in this file. It cannot be released by anyone.');
  expect(pageText()).not.toContain('an administrator can review it');
});

test('the section does not claim every upload needs a person', async () => {
  /*
   * Both deploy workflows set PPBF_VIDEO_CONTENT_SCAN=vision, so the sweep
   * promotes what it can clear. Saying everything waits for a human would
   * describe an environment the gym does not run.
   */
  mockCoverageFetch(() => jsonResponse({ ok: true, coverage: COVERAGE }));

  render(<TeachShadowHomePage />);
  await screen.findByText(/Nothing is waiting/);

  expect(pageText()).toContain('Most clears itself');
  expect(pageText()).not.toContain('Everything filmed here is held until someone');
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

  // Not "everything you film waits here": the screen clears most of it, so a
  // queue describing itself as the destination for all footage would describe
  // an environment the gym does not run.
  expect(pageText()).toContain('Footage the content screen clears on its own never appears here');
});

test('a failed read of the held queue is an alert, not an empty queue', async () => {
  /*
   * Same rule the coverage and released reads hold, and it bit hardest here.
   * loadHeld leaves `held` at [] and sets heldLoaded in its finally, so a read
   * that did not come back used to render the alert AND "Nothing is waiting"
   * together -- which a coach reads as "my footage is gone". Stopping uploads
   * from silently disappearing is the whole reason this queue is on the screen.
   */
  mockCoverageFetch(
    () => jsonResponse({ ok: true, coverage: COVERAGE }),
    () => jsonResponse({ error: 'Held footage could not be read.' }, false),
  );
  render(<TeachShadowHomePage />);

  expect(await screen.findByRole('alert')).toHaveTextContent('Held footage could not be read.');
  expect(heldSection().textContent).not.toContain('Nothing is waiting');
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

/*
 * FOOTAGE IN THE CORPUS -- the inventory behind the coverage figures, and the
 * only place footage can be taken back out.
 *
 * WHY THIS SECTION EXISTS AT ALL. Released teaching footage appeared on no
 * screen anywhere: the held queue reads quarantined rows only, the Film Study
 * list refuses take-backed ones, and coverage COUNTED this footage without
 * naming it. So the first unwanted capture was unremovable through the app, and
 * the only way to withdraw it was an UPDATE typed against the production
 * database. An archive button with nowhere to live is not a feature.
 */
const RELEASED_LIVE = {
  video_session_id: 'vs-live',
  file_name: 'take-2-front.webm',
  take_number: 2,
  camera_view: 'front',
  created_at: '2026-01-01T00:00:00.000Z',
  status: 'ready',
  clips_cut: 7,
  clips_labelled: 3,
  archived: false,
  archive_reason: null,
};

const RELEASED_ARCHIVED = {
  ...RELEASED_LIVE,
  video_session_id: 'vs-gone',
  file_name: 'take-9-desk.webm',
  take_number: 9,
  clips_cut: 0,
  clips_labelled: 0,
  status: 'archived',
  archived: true,
  archive_reason: 'test footage of a desk',
};

function mockWithReleased(items: unknown[], archive?: () => Response) {
  return mockCoverageFetch(
    () => jsonResponse({ ok: true, coverage: COVERAGE }),
    () => jsonResponse({ ok: true, items: [] }),
    () => jsonResponse({ ok: true, url: REVIEW_SAS }),
    () => jsonResponse({ ok: true, items }),
    archive,
  );
}

function releasedSection(): HTMLElement {
  const section = screen.getByRole('heading', { name: 'Footage in the corpus' }).closest('section');
  if (!section) throw new Error('test bug: the released section did not render');
  return section as HTMLElement;
}

function reasonBox(): HTMLElement {
  return within(releasedSection()).getByLabelText(/why is this being withdrawn/i);
}

/**
 * The whole archive gesture: open the prompt, optionally type, submit.
 *
 * A helper rather than three lines repeated, because the SHAPE is the thing
 * under test in several places and a test that inlined it would go on passing
 * if the prompt silently stopped appearing -- getByRole would just find the
 * outer button twice.
 */
async function archiveWithReason(reason?: string) {
  fireEvent.click(within(releasedSection()).getByRole('button', { name: 'Archive' }));
  const box = await within(releasedSection()).findByLabelText(/why is this being withdrawn/i);
  if (reason !== undefined) fireEvent.change(box, { target: { value: reason } });
  fireEvent.click(within(releasedSection()).getByRole('button', { name: 'Archive' }));
}

test('what archiving would cost is stated before the button, not discovered afterwards', async () => {
  /*
   * A coverage figure that dropped after the click is not a warning, it is a
   * surprise. Labelled clips are called out separately from clips merely cut
   * because they are two coaches' finished work.
   */
  mockWithReleased([RELEASED_LIVE]);
  render(<TeachShadowHomePage />);

  await screen.findByText('take-2-front.webm');
  const section = releasedSection();

  expect(section.textContent).toContain('7 study clips cut, 3 labelled');
  expect(within(section).getByRole('button', { name: 'Archive' })).toBeEnabled();
});

test('footage with nothing cut from it says so, rather than showing a bare zero', async () => {
  mockWithReleased([RELEASED_ARCHIVED]);
  render(<TeachShadowHomePage />);

  await screen.findByText('take-9-desk.webm');
  expect(releasedSection().textContent).toContain('No study clips cut from this yet.');
});

test('archived footage stays listed, marked, with its reason and a way back', async () => {
  /*
   * A reversible action whose result vanishes from the only screen that offers
   * it cannot be reversed by anybody unwilling to write SQL. So the row stays,
   * says what happened to it, and offers the undo.
   */
  mockWithReleased([RELEASED_ARCHIVED]);
  render(<TeachShadowHomePage />);

  await screen.findByText('take-9-desk.webm');
  const section = releasedSection();

  expect(section.textContent).toContain('Archived');
  expect(section.textContent).toContain('Reason given: test footage of a desk');
  expect(within(section).getByRole('button', { name: 'Restore to the corpus' })).toBeEnabled();
  expect(within(section).queryByRole('button', { name: 'Archive' })).not.toBeInTheDocument();
});

test('the page never claims archiving deletes anything', async () => {
  // videoArchive.ts keeps the row and the media on purpose, and a surface that
  // implied otherwise would be a false statement about what the button did --
  // the difference between a decision somebody can undo and one they cannot.
  mockWithReleased([RELEASED_LIVE]);
  render(<TeachShadowHomePage />);

  await screen.findByText('take-2-front.webm');
  expect(releasedSection().textContent).toContain('Nothing is deleted');
});

test('archiving posts the action and re-reads the figures, not just the row', async () => {
  /*
   * Archiving retracts this footage's clips and labels from the coverage counts
   * above -- that IS the point of it. A page that refreshed only its own list
   * would leave those figures stating what was true before the click.
   */
  const fetchMock = mockWithReleased([RELEASED_LIVE]);
  render(<TeachShadowHomePage />);

  await screen.findByText('take-2-front.webm');
  await archiveWithReason();

  await waitFor(() => {
    expect(requestedUrls(fetchMock).filter((url) => url === COVERAGE_URL)).toHaveLength(2);
  });

  const archiveCall = fetchMock.mock.calls.find(([input]) => String(input) === ARCHIVE_URL('vs-live'));
  expect(archiveCall).toBeDefined();
  // No reason typed, so none is SENT -- not an empty string, which would read
  // as "a reason was recorded" to every later reader of scan_detail.
  expect(JSON.parse(String(archiveCall?.[1]?.body))).toEqual({ action: 'archive' });
  expect(requestedUrls(fetchMock).filter((url) => url === RELEASED_URL)).toHaveLength(2);
});

test('restoring posts restore, and never archive', async () => {
  const fetchMock = mockWithReleased([RELEASED_ARCHIVED]);
  render(<TeachShadowHomePage />);

  await screen.findByText('take-9-desk.webm');
  fireEvent.click(within(releasedSection()).getByRole('button', { name: 'Restore to the corpus' }));

  await waitFor(() => {
    expect(requestedUrls(fetchMock)).toContain(ARCHIVE_URL('vs-gone'));
  });

  const call = fetchMock.mock.calls.find(([input]) => String(input) === ARCHIVE_URL('vs-gone'));
  expect(JSON.parse(String(call?.[1]?.body))).toEqual({ action: 'restore' });
});

test('a refused archive shows the server reason and leaves the row alone', async () => {
  // The 409 this most often is says the footage changed underneath the reader.
  // Replacing it with a generic failure would hide the one instruction that
  // helps: reload and look again.
  mockWithReleased(
    [RELEASED_LIVE],
    () => jsonResponse({ error: 'This footage changed state while you were looking at it. Reload and check before deciding again.' }, false),
  );
  render(<TeachShadowHomePage />);

  await screen.findByText('take-2-front.webm');
  await archiveWithReason('wrong subject in frame');

  expect(await screen.findByRole('alert')).toHaveTextContent(/changed state while you were looking at it/i);
  // THE PROMPT STAYS OPEN AND KEEPS WHAT WAS TYPED. A 409 that says "reload
  // and check" must not also cost somebody the sentence they just wrote --
  // they would retype it, or more likely not bother.
  expect(reasonBox()).toHaveValue('wrong subject in frame');
  expect(within(releasedSection()).getByRole('button', { name: 'Archive' })).toBeInTheDocument();
});

test('a failed read of the released list is an alert, not an empty corpus', async () => {
  /*
   * Same rule the coverage read holds. "Nothing released yet" on a read that
   * did not come back would tell a coach their footage had vanished.
   */
  mockCoverageFetch(
    () => jsonResponse({ ok: true, coverage: COVERAGE }),
    () => jsonResponse({ ok: true, items: [] }),
    () => jsonResponse({ ok: true, url: REVIEW_SAS }),
    () => jsonResponse({ error: 'Released footage could not be read.' }, false),
  );
  render(<TeachShadowHomePage />);

  expect(await screen.findByRole('alert')).toHaveTextContent('Released footage could not be read.');
  expect(releasedSection().textContent).not.toContain('Nothing released yet');
});

test('no athlete name appears in this section', async () => {
  // Teaching media names nobody. The route does not send an athlete id and the
  // page has no field for one; this is what stops a later "helpful" addition.
  mockWithReleased([RELEASED_LIVE, RELEASED_ARCHIVED]);
  render(<TeachShadowHomePage />);

  await screen.findByText('take-2-front.webm');
  expect(releasedSection().textContent?.toLowerCase()).not.toContain('athlete');
});

/*
 * THE REASON A WITHDRAWAL WAS MADE.
 *
 * Archive shipped without this and four files were withdrawn from production
 * with no answer to "why" beyond a timestamp and an account id. The API always
 * accepted a reason and the list always rendered one; there was simply no field.
 *
 * What these pin is the shape, because the shape is the whole argument: a
 * prompt that produces a sentence rather than a modal that produces a click,
 * optional so it never becomes a gate, and on archive only.
 */

test('Archive opens a prompt rather than withdrawing immediately', async () => {
  const fetchMock = mockWithReleased([RELEASED_LIVE]);
  render(<TeachShadowHomePage />);

  await screen.findByText('take-2-front.webm');
  fireEvent.click(within(releasedSection()).getByRole('button', { name: 'Archive' }));

  expect(await within(releasedSection()).findByLabelText(/why is this being withdrawn/i)).toBeInTheDocument();
  // NOTHING HAS HAPPENED YET. The first click is where somebody realises they
  // picked the wrong row, so it must not be the click that withdraws it.
  expect(requestedUrls(fetchMock)).not.toContain(ARCHIVE_URL('vs-live'));
});

test('the reason reaches the server, trimmed', async () => {
  const fetchMock = mockWithReleased([RELEASED_LIVE]);
  render(<TeachShadowHomePage />);

  await screen.findByText('take-2-front.webm');
  await archiveWithReason('   filmed the wrong athlete   ');

  await waitFor(() => {
    expect(requestedUrls(fetchMock)).toContain(ARCHIVE_URL('vs-live'));
  });

  const call = fetchMock.mock.calls.find(([input]) => String(input) === ARCHIVE_URL('vs-live'));
  expect(JSON.parse(String(call?.[1]?.body))).toEqual({
    action: 'archive',
    reason: 'filmed the wrong athlete',
  });
});

test('whitespace alone sends no reason at all', async () => {
  /*
   * '' and '   ' on the row would both read as "a reason was recorded" to
   * anybody later querying scan_detail for withdrawals that were explained.
   * Absent and blank are different facts and must stay different.
   */
  const fetchMock = mockWithReleased([RELEASED_LIVE]);
  render(<TeachShadowHomePage />);

  await screen.findByText('take-2-front.webm');
  await archiveWithReason('    ');

  await waitFor(() => {
    expect(requestedUrls(fetchMock)).toContain(ARCHIVE_URL('vs-live'));
  });

  const call = fetchMock.mock.calls.find(([input]) => String(input) === ARCHIVE_URL('vs-live'));
  expect(JSON.parse(String(call?.[1]?.body))).toEqual({ action: 'archive' });
});

test('the reason is optional -- an empty box still archives', async () => {
  /*
   * A REQUIRED FIELD ON A REVERSIBLE ACTION IS ANSWERED WITH "x" WITHIN A WEEK.
   * The point of the prompt is that a useful sentence is easy to write, not
   * that the platform refuses to act without one.
   */
  const fetchMock = mockWithReleased([RELEASED_LIVE]);
  render(<TeachShadowHomePage />);

  await screen.findByText('take-2-front.webm');
  fireEvent.click(within(releasedSection()).getByRole('button', { name: 'Archive' }));
  await within(releasedSection()).findByLabelText(/why is this being withdrawn/i);
  fireEvent.click(within(releasedSection()).getByRole('button', { name: 'Archive' }));

  await waitFor(() => {
    expect(requestedUrls(fetchMock)).toContain(ARCHIVE_URL('vs-live'));
  });
});

test('Enter submits, so a typed sentence does not need the mouse', async () => {
  const fetchMock = mockWithReleased([RELEASED_LIVE]);
  render(<TeachShadowHomePage />);

  await screen.findByText('take-2-front.webm');
  fireEvent.click(within(releasedSection()).getByRole('button', { name: 'Archive' }));
  const box = await within(releasedSection()).findByLabelText(/why is this being withdrawn/i);
  fireEvent.change(box, { target: { value: 'test footage of a desk' } });
  fireEvent.submit(box.closest('form')!);

  await waitFor(() => {
    expect(requestedUrls(fetchMock)).toContain(ARCHIVE_URL('vs-live'));
  });
  const call = fetchMock.mock.calls.find(([input]) => String(input) === ARCHIVE_URL('vs-live'));
  expect(JSON.parse(String(call?.[1]?.body)).reason).toBe('test footage of a desk');
});

test('Cancel withdraws nothing and forgets what was typed', async () => {
  const fetchMock = mockWithReleased([RELEASED_LIVE]);
  render(<TeachShadowHomePage />);

  await screen.findByText('take-2-front.webm');
  fireEvent.click(within(releasedSection()).getByRole('button', { name: 'Archive' }));
  fireEvent.change(await within(releasedSection()).findByLabelText(/why is this being withdrawn/i), {
    target: { value: 'changed my mind halfway through' },
  });
  fireEvent.click(within(releasedSection()).getByRole('button', { name: 'Cancel' }));

  expect(requestedUrls(fetchMock)).not.toContain(ARCHIVE_URL('vs-live'));
  expect(within(releasedSection()).getByRole('button', { name: 'Archive' })).toBeInTheDocument();

  // Reopening starts clean: a sentence abandoned on one row must not arrive
  // attached to a decision made later.
  fireEvent.click(within(releasedSection()).getByRole('button', { name: 'Archive' }));
  expect(await within(releasedSection()).findByLabelText(/why is this being withdrawn/i)).toHaveValue('');
});

test('restore is still one click, with nothing to fill in', async () => {
  // An undo needs no justification, and a form in front of one is friction
  // pointing the wrong way.
  const fetchMock = mockWithReleased([RELEASED_ARCHIVED]);
  render(<TeachShadowHomePage />);

  await screen.findByText('take-9-desk.webm');
  fireEvent.click(within(releasedSection()).getByRole('button', { name: 'Restore to the corpus' }));

  await waitFor(() => {
    expect(requestedUrls(fetchMock)).toContain(ARCHIVE_URL('vs-gone'));
  });
  expect(within(releasedSection()).queryByLabelText(/why is this being withdrawn/i)).not.toBeInTheDocument();
  const call = fetchMock.mock.calls.find(([input]) => String(input) === ARCHIVE_URL('vs-gone'));
  expect(JSON.parse(String(call?.[1]?.body))).toEqual({ action: 'restore' });
});

test('the prompt says the reason outlives the click', async () => {
  // Somebody deciding whether to bother typing needs to know who reads it.
  mockWithReleased([RELEASED_LIVE]);
  render(<TeachShadowHomePage />);

  await screen.findByText('take-2-front.webm');
  fireEvent.click(within(releasedSection()).getByRole('button', { name: 'Archive' }));
  await within(releasedSection()).findByLabelText(/why is this being withdrawn/i);

  expect(releasedSection().textContent).toContain('stays on the footage');
});
