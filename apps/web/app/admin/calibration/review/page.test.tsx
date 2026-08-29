/**
 * @jest-environment jsdom
 */

import type { ReactNode } from 'react';
import '@testing-library/jest-dom';
import { render, screen, within } from '@testing-library/react';

import CalibrationReviewPage from './page';

/**
 * THE REVIEW TABLE.
 *
 * What these cases are for: this screen is the only place in the platform that
 * shows one coach's work to somebody other than that coach, so the things it
 * must NOT do are as load-bearing as the things it must. It must not invent an
 * agreement figure, must not turn "only one coach marked it" into a verdict on
 * who was right, and must not carry a control that changes anything.
 */

const searchParams = new URLSearchParams('calibration_clip_id=clip-1');

jest.mock('next/navigation', () => ({
  useSearchParams: () => searchParams,
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));

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

function eventOf(overrides: Record<string, unknown> = {}) {
  return {
    event_id: 'evt-a1',
    event_class: 'punch',
    actor_track: 'red',
    start_ms: 1_000,
    end_ms: 1_400,
    punch_type: 'lead_straight',
    defense_type: null,
    visibility: 'clear',
    certainty: 'clear',
    ...overrides,
  };
}

const COMPARISON = {
  ok: true,
  clip: {
    calibration_clip_id: 'clip-1',
    clip_code: 'C-01',
    start_ms: 12_000,
    end_ms: 18_000,
    primary_sampling_reason: 'occlusion',
  },
  comparison: {
    calibrationClipId: 'clip-1',
    annotationSetIdA: 'set-a',
    annotationSetIdB: 'set-b',
    annotatorAccountIdA: 'coach-a',
    annotatorAccountIdB: 'coach-b',
    ontologyVersion: 'boxing-ontology-0.1',
    matchingPolicy: {
      policyVersion: 'pilot-temporal-overlap-v0',
      calibrationState: 'UNCALIBRATED',
      overlapToleranceMs: 0,
    },
    pairings: [
      {
        outcome: 'MATCHED',
        eventA: eventOf(),
        eventB: eventOf({
          event_id: 'evt-b1',
          start_ms: 1_050,
          end_ms: 1_450,
          punch_type: 'rear_hook',
        }),
        candidateCount: 1,
        disagreements: [
          { category: 'BOUNDARY', field: 'start_ms', valueA: '1000', valueB: '1050', deltaMs: -50 },
          { category: 'PUNCH_TYPE', field: 'punch_type', valueA: 'lead_straight', valueB: 'rear_hook' },
        ],
      },
      {
        outcome: 'ONLY_IN_A',
        eventA: eventOf({ event_id: 'evt-a2', start_ms: 3_000, end_ms: 3_200 }),
        eventB: null,
        candidateCount: 0,
        disagreements: [
          { category: 'EVENT_MISSED', field: 'event_id', valueA: 'evt-a2', valueB: null },
        ],
      },
      {
        outcome: 'MATCH_AMBIGUOUS',
        eventA: eventOf({ event_id: 'evt-a3', start_ms: 5_000, end_ms: 5_900 }),
        eventB: null,
        candidateCount: 3,
        disagreements: [],
      },
    ],
  },
  disagreement_counts: {
    EVENT_MISSED: 1,
    BOUNDARY: 1,
    PUNCH_TYPE: 1,
    PHYSICAL_HAND: 0,
    HAND_ROLE: 0,
    STANCE: 0,
    TARGET: 0,
    CONTACT_RESULT: 0,
    CONTACT_ZONE: 0,
    DEFENSE_TYPE: 0,
    COMBINATION: 0,
    COUNTER: 0,
    VISIBILITY: 0,
    CERTAINTY: 0,
    OTHER: 0,
  },
};

function respond(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as Response;
}

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  jest.clearAllMocks();
});

test('puts both readings of the same moment in one row, and names what differs', async () => {
  global.fetch = jest.fn().mockResolvedValue(respond(COMPARISON)) as unknown as typeof fetch;

  render(<CalibrationReviewPage />);

  const paired = (await screen.findByText('Paired')).closest('tr') as HTMLElement;
  const cells = within(paired).getAllByRole('cell');

  // Column by column, so "both readings side by side" is asserted as a
  // position and not merely as two strings that happen to be on the page.
  expect(cells[1]).toHaveTextContent('0:01.000 – 0:01.400');
  expect(cells[1]).toHaveTextContent('lead_straight');
  expect(cells[2]).toHaveTextContent('0:01.050 – 0:01.450');
  expect(cells[2]).toHaveTextContent('rear_hook');
  expect(cells[3]).toHaveTextContent('PUNCH_TYPE · punch_type: lead_straight vs rear_hook');
  expect(cells[3]).toHaveTextContent('BOUNDARY · start_ms: 1000 vs 1050 (-50ms)');
});

test('an action only one coach marked reads as unrecorded, never as a verdict on who was right', async () => {
  // comparison.ts is explicit that ONLY_IN_A is not proof the event did not
  // happen. The row must not print "missed", "wrong" or "error" against a
  // coach, and the absence must be stated as an absence.
  global.fetch = jest.fn().mockResolvedValue(respond(COMPARISON)) as unknown as typeof fetch;

  render(<CalibrationReviewPage />);

  const onlyA = (await screen.findByText('Recorded by A only')).closest('tr') as HTMLElement;
  expect(within(onlyA).getByText('Not recorded')).toBeInTheDocument();

  const page = document.body.textContent ?? '';
  expect(page).toContain('only that it was not annotated');
  expect(page).not.toMatch(/\bwrong\b|\bincorrect\b|\berror\b/i);
});

test('a pair that cannot honestly be matched says so, with the evidence for why', async () => {
  global.fetch = jest.fn().mockResolvedValue(respond(COMPARISON)) as unknown as typeof fetch;

  render(<CalibrationReviewPage />);

  expect(
    await screen.findByText('No honest pairing (overlaps 3 on the other side)'),
  ).toBeInTheDocument();
});

test('the uncalibrated pairing rule is stated on the screen, not assumed', async () => {
  global.fetch = jest.fn().mockResolvedValue(respond(COMPARISON)) as unknown as typeof fetch;

  render(<CalibrationReviewPage />);

  expect(await screen.findByText(/pilot-temporal-overlap-v0/)).toBeInTheDocument();
  expect(screen.getByText(/UNCALIBRATED/)).toBeInTheDocument();
});

test('every disagreement category is listed, so a zero is a measured zero', async () => {
  global.fetch = jest.fn().mockResolvedValue(respond(COMPARISON)) as unknown as typeof fetch;

  render(<CalibrationReviewPage />);

  const counts = (await screen.findByText(/Disagreements by category/)).closest('table') as HTMLElement;
  for (const category of Object.keys(COMPARISON.disagreement_counts)) {
    expect(within(counts).getByText(category)).toBeInTheDocument();
  }
});

test('no scalar agreement figure is rendered, even when one arrives in the payload', async () => {
  /* THE GUARD THAT MATTERS. A number here would be read as a verdict on two
   * coaches, and the weights that would justify one have not been measured.
   *
   * The payload is deliberately poisoned with fields the route does not send,
   * because the page could only display them by reaching for something it was
   * never given -- which is exactly what a later "while we are here, show the
   * agreement rate" change looks like. Asserting on the page's own prose
   * instead would be circular: the explanatory sentence below legitimately
   * contains the words "agreement" and "rate". */
  global.fetch = jest.fn().mockResolvedValue(respond({
    ...COMPARISON,
    agreement_rate: 0.8333,
    kappa: 0.71,
    agreement_percent: 83,
  })) as unknown as typeof fetch;

  render(<CalibrationReviewPage />);
  await screen.findByText('Paired');

  const page = document.body.textContent ?? '';
  expect(page).not.toContain('0.8333');
  expect(page).not.toContain('0.71');
  expect(page).not.toContain('83%');
  expect(page).not.toMatch(/\d%/);
  expect(page.toLowerCase()).not.toContain('kappa');

  // And the absence is explained rather than silently left out, so nobody adds
  // one back believing it was an oversight.
  expect(page).toContain('There is no overall agreement figure here');
});

test('the screen carries no control that changes anything', async () => {
  // Read-only is the design, not a stage. No adjudication, no "accept A", no
  // gold nomination -- each of those is a decision with its own record and its
  // own gate, and a button here before that exists would either do nothing or
  // do something nobody agreed to.
  global.fetch = jest.fn().mockResolvedValue(respond(COMPARISON)) as unknown as typeof fetch;

  render(<CalibrationReviewPage />);
  await screen.findByText('Paired');

  expect(screen.queryAllByRole('button')).toHaveLength(0);
  expect(screen.queryAllByRole('textbox')).toHaveLength(0);
  expect(screen.queryAllByRole('combobox')).toHaveLength(0);
  expect(document.querySelectorAll('form')).toHaveLength(0);

  // One fetch, and it was a GET of the read route.
  expect(global.fetch).toHaveBeenCalledTimes(1);
  const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
  expect(String(url)).toContain('/api/pilot/calibration/comparison?calibration_clip_id=clip-1');
  expect(init?.method ?? 'GET').toBe('GET');
});

test("a refusal is shown in the server's own words, and nothing that came with it is rendered", async () => {
  /* Two properties in one case, and the second is the one that bites.
   *
   * The route's refusals were written for an organization administrator to
   * read, so "this clip is not ready for adjudication" is the answer and a
   * house-style replacement would tell them less than the platform knows.
   *
   * And the refusal here arrives WITH a full payload attached, which the route
   * as written never sends. That is deliberate: a case fed a bare `{error}`
   * proves only that a page renders nothing when it is given nothing, and stays
   * green against a page that would happily table whatever came back beside a
   * 403. The client is the second place that has to refuse, because it is the
   * one that paints. */
  global.fetch = jest.fn().mockResolvedValue(respond(
    {
      ...COMPARISON,
      ok: false,
      error: 'Forbidden: this clip is not ready for adjudication -- an annotation set on it has not been submitted',
    },
    false,
    403,
  )) as unknown as typeof fetch;

  render(<CalibrationReviewPage />);

  expect(await screen.findByText(/not ready for adjudication/)).toBeInTheDocument();
  expect(screen.queryByText('Paired')).not.toBeInTheDocument();
  expect(screen.queryByText(/Disagreements by category/)).not.toBeInTheDocument();
  expect(screen.queryByRole('table')).not.toBeInTheDocument();
  expect(document.body.textContent).not.toContain('coach-a');
  expect(document.body.textContent).not.toContain('lead_straight');
});

test('with no clip named it says so and asks the server nothing', async () => {
  global.fetch = jest.fn() as unknown as typeof fetch;
  searchParams.delete('calibration_clip_id');

  render(<CalibrationReviewPage />);

  expect(screen.getByText(/No clip named/)).toBeInTheDocument();
  expect(global.fetch).not.toHaveBeenCalled();

  searchParams.set('calibration_clip_id', 'clip-1');
});
