/**
 * @jest-environment jsdom
 */

/**
 * The screen that finally reads what the engine computes -- and the ways it
 * would be worse than no screen.
 *
 * pilot.shadow_formula_results has had a reachable writer since
 * auto-calculation shipped and no reader at all: both routes over it had no
 * caller in the product. Putting a screen on it is only an improvement if the
 * screen says what the read model means, and the read model is unusually
 * explicit about being mis-said. These cases are those ways:
 *
 *   - reporting "nothing computed" as though it were reassurance;
 *   - rendering the FORMULA's standing human-review property as a per-result
 *     queue state, which would say "awaiting review" forever;
 *   - showing a confidence without the validation state that qualifies it;
 *   - showing a null value as a zero;
 *   - showing an unreadable read as an empty one;
 *   - and re-rendering the three sections that already have their own screens.
 */

import { act, fireEvent, render, screen } from '@testing-library/react';

import AthleteIntelligencePage from './page';

jest.mock('@/components/RoleSessionGate', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

function result(overrides: Record<string, unknown> = {}) {
  return {
    resultId: 'res-1',
    calculationKey: 'key-1',
    formulaId: 'CORE-01',
    formulaVersion: '1.0.0',
    outputKey: 'acute_load',
    policyVersion: 'p1',
    parameters: {},
    organizationId: 'org-a',
    athleteId: 'ath-1',
    contextId: null,
    value: 412,
    unit: 'load_au',
    computedAt: '2026-08-28T14:00:00.000Z',
    inputObservationIds: ['obs-1', 'obs-2'],
    provenance: [],
    validation: { state: 'valid', hardBlocks: [], warnings: [] },
    quality: { confidence: 'HIGH', completeness: 1, worstSourceQuality: 'verified' },
    unavailableReason: null,
    humanReviewRequired: false,
    ...overrides,
  };
}

function entry(overrides: Record<string, unknown> = {}, resultOverrides: Record<string, unknown> = {}) {
  return {
    result: result(resultOverrides),
    formulaRequiresHumanReview: false,
    perResultReviewState: null,
    ...overrides,
  };
}

function model(overrides: Record<string, unknown> = {}) {
  return {
    organizationId: 'org-a',
    athleteId: 'ath-1',
    generatedAt: '2026-08-29T09:00:00.000Z',
    formulaOutputs: { availability: 'available', items: [entry()] },
    trainingAttempts: { availability: 'available', items: [{ attempt_id: 'a-1' }] },
    metricTransfer: { availability: 'none_recorded', items: [], windowDays: 60 },
    reviewedFilmStudy: { availability: 'none_recorded', items: [] },
    ...overrides,
  };
}

function installFetch(payload: unknown, init?: { ok?: boolean }) {
  const fetchMock = jest.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes('/api/pilot/athletes/list')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ items: [{ athlete_id: 'ath-1', full_name: 'Jordan P.' }] }),
      };
    }
    if (url.includes('/api/pilot/coach/athlete-intelligence')) {
      return { ok: init?.ok ?? true, status: init?.ok === false ? 500 : 200, json: async () => payload };
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

async function renderAndPick(payload: unknown, init?: { ok?: boolean }) {
  const fetchMock = installFetch(payload, init);
  await act(async () => {
    render(<AthleteIntelligencePage />);
  });
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Athlete'), { target: { value: 'ath-1' } });
  });
  return fetchMock;
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('it reads the route that nothing was reading', () => {
  it('calls coach/athlete-intelligence for the chosen athlete', async () => {
    // The point of the whole change. Without this call the formula engine
    // keeps computing into a table with no reader.
    const fetchMock = await renderAndPick(model());

    const called = fetchMock.mock.calls.map(([u]) => String(u));
    expect(called.some((u) => u.includes('/api/pilot/coach/athlete-intelligence?athlete_id=ath-1')))
      .toBe(true);
  });

  it('renders the value with its unit', async () => {
    await renderAndPick(model());

    expect(screen.getByTestId('value').textContent).toContain('412');
    expect(screen.getByTestId('value').textContent).toContain('load_au');
  });
});

describe('"nothing computed" is never reassurance', () => {
  it('says an empty result set is not a clean bill of health', async () => {
    // THE CASE THIS FILE EXISTS FOR. The read model's own header: none_recorded
    // "does not mean the athlete is fine, improving, or without problems.
    // Absence of evidence is not evidence." An empty list renders as exactly
    // that reassurance unless the page says otherwise out loud.
    await renderAndPick(model({ formulaOutputs: { availability: 'none_recorded', items: [] } }));

    expect(screen.getByText(/Nothing has been computed for this athlete/)).toBeTruthy();
    expect(screen.getByText(/not a clean bill of health/)).toBeTruthy();
    expect(screen.getByText(/absence of evidence is not evidence/i)).toBeTruthy();
  });

  it('says the same for a source that is only reported by availability', async () => {
    await renderAndPick(model());

    expect(screen.getAllByText(/which is not the same as nothing wrong/).length).toBeGreaterThan(0);
  });
});

describe('the standing formula property is not a review queue', () => {
  it('never words humanReviewRequired as awaiting or pending review', async () => {
    // humanReviewRequired is copied from the formula DEFINITION at compute
    // time and nothing anywhere clears it -- there is no update against
    // pilot.shadow_formula_results. Rendered as a queue state it says
    // "awaiting review" for every result of that formula, forever.
    await renderAndPick(model({
      formulaOutputs: {
        availability: 'available',
        items: [entry({ formulaRequiresHumanReview: true })],
      },
    }));

    const note = screen.getByTestId('human-review-note').textContent ?? '';
    expect(note).toContain('standing property');
    expect(note).not.toMatch(/awaiting/i);
    expect(note).not.toMatch(/pending/i);
    expect(document.body.textContent).not.toMatch(/awaiting review/i);
  });

  it('offers no per-result review control, because there is nowhere to put one', async () => {
    // perResultReviewState is always null: no column, no table, no writer.
    // A button here would be a promise the database cannot keep.
    await renderAndPick(model({
      formulaOutputs: {
        availability: 'available',
        items: [entry({ formulaRequiresHumanReview: true })],
      },
    }));

    expect(screen.queryByRole('button', { name: /review/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /mark/i })).toBeNull();
    expect(document.body.textContent).not.toMatch(/mark (as )?reviewed/i);
  });
});

describe('confidence never travels without the state that qualifies it', () => {
  it('prints INSUFFICIENT confidence beside a valid state and a real value', async () => {
    // MVP-10's confidenceOverride: a REAL value, validation state `valid`, and
    // confidence INSUFFICIENT. Read alone that confidence condemns a number
    // that is fine, which is why the read model nests them in one object.
    await renderAndPick(model({
      formulaOutputs: {
        availability: 'available',
        items: [entry({}, {
          value: 7.5,
          validation: { state: 'valid', hardBlocks: [], warnings: [] },
          quality: { confidence: 'INSUFFICIENT', completeness: 0.4, worstSourceQuality: 'low' },
        })],
      },
    }));

    const line = screen.getByTestId('quality-line').textContent ?? '';
    expect(line).toContain('INSUFFICIENT');
    expect(line).toContain('valid');          // in the SAME sentence
    expect(screen.getByTestId('value').textContent).toContain('7.5');
  });

  it('renders completeness as a percentage of the 0..1 the engine stores', async () => {
    await renderAndPick(model({
      formulaOutputs: {
        availability: 'available',
        items: [entry({}, { quality: { confidence: 'LOW', completeness: 0.4, worstSourceQuality: null } })],
      },
    }));

    const line = screen.getByTestId('quality-line').textContent ?? '';
    expect(line).toContain('40%');
    expect(line).toContain('no source quality recorded');
  });
});

describe('a missing value is not a zero', () => {
  it('names the reason instead of printing a number', async () => {
    await renderAndPick(model({
      formulaOutputs: {
        availability: 'available',
        items: [entry({}, {
          value: null,
          unavailableReason: 'MISSING_RPE',
          validation: { state: 'insufficient', hardBlocks: ['MISSING_RPE'], warnings: [] },
        })],
      },
    }));

    const cell = screen.getByTestId('no-value').textContent ?? '';
    expect(cell).toContain('No value');
    expect(cell).toContain('missing rpe');
    expect(cell).toContain('MISSING_RPE');
    expect(screen.queryByTestId('value')).toBeNull();
    expect(cell).not.toMatch(/\b0\b/);
  });

  it('still says so when no reason was recorded', async () => {
    await renderAndPick(model({
      formulaOutputs: {
        availability: 'available',
        items: [entry({}, { value: null, unavailableReason: null })],
      },
    }));

    expect(screen.getByTestId('no-value').textContent).toContain('no reason recorded');
  });
});

describe('an unreadable read is never an empty one', () => {
  it('shows the failure and no sections when the request fails', async () => {
    await renderAndPick(model(), { ok: false });

    expect(screen.getByRole('alert').textContent).toContain('could not be read');
    expect(screen.getByRole('alert').textContent).toContain('a failed read is not an empty record');
    expect(screen.queryByText(/Nothing has been computed/)).toBeNull();
    expect(screen.queryByTestId('value')).toBeNull();
  });

  it('treats a payload with no formulaOutputs as unreadable, not as none recorded', async () => {
    // A 200 with a malformed body is the quieter version of the same lie.
    await renderAndPick({ organizationId: 'org-a', athleteId: 'ath-1' });

    expect(screen.getByRole('alert').textContent).toContain('could not be read');
    expect(screen.queryByText(/Nothing has been computed/)).toBeNull();
  });
});

describe('the three sections that already have screens are not copied here', () => {
  it('reports them by availability and links out', async () => {
    // Re-rendering attempts and transfer would put a third and fourth copy of
    // the same records on a new surface. coach-reviews/update was deleted this
    // month for being a second copy of an authorization sequence; the same
    // reasoning applies to a second copy of a readout.
    await renderAndPick(model());

    expect(screen.getByText('Training attempts')).toBeTruthy();
    expect(screen.getByText(/Metric transfer, last 60 days/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Attempt Log' })).toBeTruthy();
    // Two of these: the section link and the footer nav.
    expect(screen.getAllByRole('link', { name: 'Transfer Check' }).length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: 'Video Analysis' })).toBeTruthy();
  });

  it('renders none of the transfer readout\'s own counts', async () => {
    // The tell that a copy has crept in: Transfer Check's raw counts appearing
    // on this page.
    await renderAndPick(model({
      metricTransfer: {
        availability: 'available',
        windowDays: 60,
        items: [{
          metric_kind: 'jab_accuracy',
          controlled_makes: 9, controlled_misses: 1,
          live_makes: 2, live_misses: 8,
          state: 'not_transferring',
        }],
      },
    }));

    expect(document.body.textContent).not.toContain('jab_accuracy');
    expect(document.body.textContent).not.toMatch(/not.transferring/i);
    expect(document.body.textContent).not.toMatch(/practice: 9/);
  });
});

describe('the safeguarding red is not spent on an arithmetic failure', () => {
  it('badges an invalid result restricted, never locked', async () => {
    // #A81E22 is reserved for a person who may not participate. An invalid
    // formula result is a fact about a calculation.
    await renderAndPick(model({
      formulaOutputs: {
        availability: 'available',
        items: [entry({}, { validation: { state: 'invalid', hardBlocks: ['RPE_OUT_OF_RANGE'], warnings: [] } })],
      },
    }));

    const badge = screen.getByText('invalid');
    expect(badge.className).toContain('badge--restricted');
    expect(badge.className).not.toContain('badge--locked');
  });

  it('shows an unrecognized validation state rather than dropping it', async () => {
    await renderAndPick(model({
      formulaOutputs: {
        availability: 'available',
        items: [entry({}, { validation: { state: 'some_new_state', hardBlocks: [], warnings: [] } })],
      },
    }));

    expect(screen.getByText('some_new_state')).toBeTruthy();
  });
});
