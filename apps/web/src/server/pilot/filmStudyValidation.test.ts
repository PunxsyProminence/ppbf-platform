// Film Study model validation.
//
// The properties under test are the ones that stop a measurement becoming a
// claim it cannot support: a rate is withheld below the sample floor, pending
// proposals never count toward it, and the sample size travels with the number
// everywhere it is reported.

import {
  FILM_STUDY_MINIMUM_REVIEWED,
  describeFilmStudyValidation,
  formatAcceptRatePercent,
  getFilmStudyValidation,
  type FilmStudyValidationReport,
} from './filmStudyValidation';
import { query } from './db';
import { MODEL_PROPOSAL_SCOPE_SQL } from './shadowFilmStudyProposals';

jest.mock('./db', () => ({ query: jest.fn() }));

const mockQuery = query as jest.MockedFunction<typeof query>;

interface RowShape {
  model_deployment: string | null;
  reviewed_count: string;
  accepted_count: string;
  rejected_count: string;
  pending_count: string;
  corrected_count: string;
  ever_corrected_count: string;
  proposal_count: string;
  mean_frames: string | null;
}

function row(overrides: Partial<RowShape> = {}): RowShape {
  return {
    model_deployment: null,
    reviewed_count: '0',
    accepted_count: '0',
    rejected_count: '0',
    pending_count: '0',
    corrected_count: '0',
    ever_corrected_count: '0',
    proposal_count: '0',
    mean_frames: null,
    ...overrides,
  };
}

/**
 * Mocks the overall query, the per-deployment query, then the coach-report
 * count, in call order.
 *
 * The third mock is not optional padding: getFilmStudyValidation issues three
 * reads, and a helper that stubs two would leave the third resolving undefined
 * -- which is a test failing for its own reason rather than the code's.
 */
function mockRows(
  overall: RowShape,
  byDeployment: RowShape[] = [],
  coachReportedCount = '0',
): void {
  mockQuery.mockReset();
  mockQuery
    .mockResolvedValueOnce([overall] as never)
    .mockResolvedValueOnce(byDeployment as never)
    .mockResolvedValueOnce([{
      coach_reported_count: coachReportedCount,
      coach_reported_confirmed_count: coachReportedCount,
    }] as never);
}

describe('a rate is withheld until the sample can support it', () => {
  test('below the floor the status is insufficient_data and the rate is null', async () => {
    // Two accepted out of two is not "100% accurate", and this is the assertion
    // that stops it being reported as such.
    mockRows(row({ reviewed_count: '2', accepted_count: '2' }));

    const report = await getFilmStudyValidation('org-1');

    expect(report.overall.status).toBe('insufficient_data');
    expect(report.overall.acceptRate).toBeNull();
    // The counts are still reported -- a caller must be able to see how thin
    // the sample is, not merely that a rate was refused.
    expect(report.overall.reviewedCount).toBe(2);
    expect(report.overall.acceptedCount).toBe(2);
  });

  test('exactly at the floor the rate is reported', async () => {
    mockRows(row({
      reviewed_count: String(FILM_STUDY_MINIMUM_REVIEWED),
      accepted_count: String(FILM_STUDY_MINIMUM_REVIEWED),
    }));

    const report = await getFilmStudyValidation('org-1');

    expect(report.overall.status).toBe('available');
    expect(report.overall.acceptRate).toBe(1);
  });

  test('the rate is accepted over reviewed, rounded to three places', async () => {
    mockRows(row({ reviewed_count: '7', accepted_count: '3', rejected_count: '4' }));

    const report = await getFilmStudyValidation('org-1');

    // 3/7 = 0.428571...
    expect(report.overall.acceptRate).toBe(0.429);
  });
});

describe('0% and 100% are reserved for the cases that earned them', () => {
  // Both readings are categorical -- "never right" and "never wrong" -- and a
  // coach acts on them without reading the counts beside them. Rounding hands
  // them out to samples that contradict them, which is the same overclaim this
  // module refuses everywhere else.

  test('one rejection in two hundred is not a perfect record', () => {
    // Math.round(0.995 * 100) === 100.
    expect(formatAcceptRatePercent(199, 200)).toBe('>99%');
  });

  test('one acceptance in three hundred is not a blank record', () => {
    // Math.round(0.00333 * 100) === 0.
    expect(formatAcceptRatePercent(1, 300)).toBe('<1%');
  });

  test('100% is reported only when nothing was rejected', () => {
    expect(formatAcceptRatePercent(200, 200)).toBe('100%');
  });

  test('0% is reported only when nothing was accepted', () => {
    expect(formatAcceptRatePercent(0, 300)).toBe('0%');
  });

  test('ordinary rates round normally', () => {
    expect(formatAcceptRatePercent(26, 40)).toBe('65%');
    expect(formatAcceptRatePercent(3, 7)).toBe('43%');
  });

  test('nothing reviewed has no rate to describe', () => {
    expect(formatAcceptRatePercent(0, 0)).toBeNull();
  });

  test('the display string travels on the report, so the UI never recomputes it', async () => {
    mockRows(row({ reviewed_count: '200', accepted_count: '199', rejected_count: '1' }));

    const report = await getFilmStudyValidation('org-1');

    expect(report.overall.acceptRateDisplay).toBe('>99%');
    // The unrounded rate is still there for anyone doing arithmetic; it is the
    // rendered string that must not claim perfection.
    expect(report.overall.acceptRate).toBe(0.995);
  });

  test('the summary line inherits the same reservation', async () => {
    mockRows(row({ reviewed_count: '200', accepted_count: '199', rejected_count: '1' }));

    const summary = describeFilmStudyValidation(await getFilmStudyValidation('org-1'));

    expect(summary).toContain('>99%');
    expect(summary).not.toMatch(/\(100%\)/);
    expect(summary).toContain('199 of 200');
  });

  test('a withheld rate carries no display string either', async () => {
    mockRows(row({ reviewed_count: '3', accepted_count: '3' }));

    const report = await getFilmStudyValidation('org-1');

    expect(report.overall.acceptRateDisplay).toBeNull();
  });
});

describe('pending proposals are not evidence', () => {
  test('a pending queue does not move the rate', async () => {
    // Folding pending rows into the denominator would drag every rate toward
    // whatever the queue depth happened to be that day.
    mockRows(row({
      reviewed_count: '10',
      accepted_count: '6',
      rejected_count: '4',
      pending_count: '90',
    }));

    const report = await getFilmStudyValidation('org-1');

    expect(report.overall.acceptRate).toBe(0.6);
    expect(report.overall.pendingCount).toBe(90);
  });

  test('a queue with nothing reviewed yet reports no rate at all', async () => {
    mockRows(row({ pending_count: '12' }));

    const report = await getFilmStudyValidation('org-1');

    expect(report.overall.reviewedCount).toBe(0);
    expect(report.overall.acceptRate).toBeNull();
    expect(report.overall.status).toBe('insufficient_data');
  });
});

describe('per-deployment comparison', () => {
  test('each deployment carries its own rate, sample and mean frame count', async () => {
    // The comparison that decides whether a model change helped: two
    // deployments, two accept rates, the same coaches.
    mockRows(
      row({ reviewed_count: '30', accepted_count: '18', rejected_count: '12' }),
      [
        row({
          model_deployment: 'gpt-vision-b',
          reviewed_count: '20',
          accepted_count: '14',
          rejected_count: '6',
          mean_frames: '30.0',
        }),
        row({
          model_deployment: 'gpt-vision-a',
          reviewed_count: '10',
          accepted_count: '4',
          rejected_count: '6',
          mean_frames: '8.4',
        }),
      ],
    );

    const report = await getFilmStudyValidation('org-1');

    expect(report.byDeployment).toHaveLength(2);
    expect(report.byDeployment[0]).toMatchObject({
      modelDeployment: 'gpt-vision-b',
      acceptRate: 0.7,
      reviewedCount: 20,
      meanFramesAnalyzed: 30,
    });
    expect(report.byDeployment[1]).toMatchObject({
      modelDeployment: 'gpt-vision-a',
      acceptRate: 0.4,
      meanFramesAnalyzed: 8.4,
    });
  });

  test('a thin deployment is withheld even when the org total is healthy', async () => {
    // The whole point of the per-deployment split: a new model with three
    // reviews must not inherit the credibility of the old one's hundred.
    mockRows(
      row({ reviewed_count: '103', accepted_count: '70', rejected_count: '33' }),
      [
        row({ model_deployment: 'established', reviewed_count: '100', accepted_count: '68', rejected_count: '32' }),
        row({ model_deployment: 'brand-new', reviewed_count: '3', accepted_count: '3' }),
      ],
    );

    const report = await getFilmStudyValidation('org-1');

    expect(report.overall.status).toBe('available');
    expect(report.byDeployment[1]).toMatchObject({
      modelDeployment: 'brand-new',
      status: 'insufficient_data',
      acceptRate: null,
      acceptedCount: 3,
    });
  });
});

describe('the one-line summary never states a rate without its sample', () => {
  async function summaryFor(overall: RowShape): Promise<string> {
    mockRows(overall);
    const report = await getFilmStudyValidation('org-1');
    return describeFilmStudyValidation(report);
  }

  test('a healthy sample names both numbers, not just a percentage', async () => {
    const summary = await summaryFor(row({
      reviewed_count: '40', accepted_count: '26', rejected_count: '14',
    }));

    expect(summary).toContain('26 of 40');
    expect(summary).toContain('65%');
  });

  test('a thin sample says the rate is withheld and why', async () => {
    const summary = await summaryFor(row({ reviewed_count: '3', accepted_count: '3' }));

    expect(summary).toMatch(/below the 5 needed/);
    expect(summary).toMatch(/withheld/);
    // It must not state a percentage anywhere -- that is the failure mode.
    expect(summary).not.toMatch(/\d+%/);
  });

  test('an unreviewed queue says nothing can be said yet', async () => {
    const summary = await summaryFor(row({ pending_count: '7' }));

    // "outstanding", not "waiting": the count now includes proposals a coach
    // corrected but has not finished, which are genuinely still in the queue.
    // The substance the test guards is unchanged -- the number travels with
    // the claim.
    expect(summary).toMatch(/7 outstanding/);
    expect(summary).toMatch(/Nothing can be said about the model/);
  });

  test('no proposals at all is distinguished from none reviewed', async () => {
    // "The model was never asked" and "the model was asked and nobody looked"
    // are different operational states and must not read the same.
    const summary = await summaryFor(row({}));

    expect(summary).toMatch(/has not been asked/);
  });
});

describe('scope', () => {
  test('both queries are scoped to the caller organization and nothing else', async () => {
    mockRows(row({ reviewed_count: '5', accepted_count: '5' }));

    await getFilmStudyValidation('org-scoped');

    for (const call of mockQuery.mock.calls) {
      expect(call[1]).toEqual(['org-scoped']);
    }
  });

  /* The rate is described as acceptance of MODEL proposals, so both queries
   * must exclude coach-reported rows -- a coach's own observation, accepted, is
   * evidence the model MISSED something, not evidence it was right.
   *
   * Compared against the imported constant rather than a literal typed here:
   * if the predicate is ever tightened (say to spell out a null case), a
   * hand-copied duplicate in filmStudyValidation.ts drifts away from it and
   * this goes red. That is the property worth guarding -- a string match alone
   * cannot tell reuse from a copy, so the real behavioural proof is
   * filmStudyValidationOriginScope.pg.test.ts, which inserts rows of both
   * origins and reads the counts back out of Postgres. */
  test('both model queries carry the shared model-proposal predicate', async () => {
    mockRows(row({ reviewed_count: '5', accepted_count: '5' }));

    await getFilmStudyValidation('org-scoped');

    // Three reads now: the two model-proposal aggregates, and a third that
    // counts coach reports. The third is the ONLY one allowed to omit the
    // predicate, because it exists to count the rows the predicate excludes --
    // so it is named here rather than letting the loop's arity quietly grow.
    expect(mockQuery.mock.calls).toHaveLength(3);

    const [overallSql, byDeploymentSql, coachReportedSql] =
      mockQuery.mock.calls.map((call) => String(call[0]));

    expect(overallSql).toContain(MODEL_PROPOSAL_SCOPE_SQL);
    expect(byDeploymentSql).toContain(MODEL_PROPOSAL_SCOPE_SQL);

    // The inverse, asserted rather than assumed: if this query ever picked up
    // the model predicate it would count zero coach reports forever, and a
    // silent zero reads as "the model missed nothing".
    expect(coachReportedSql).not.toContain(MODEL_PROPOSAL_SCOPE_SQL);
    expect(coachReportedSql).toContain("origin = 'coach_reported'");
  });

  test('every query is organization-scoped', async () => {
    mockRows(row({ reviewed_count: '5', accepted_count: '5' }));

    await getFilmStudyValidation('org-scoped');

    for (const call of mockQuery.mock.calls) {
      expect(String(call[0])).toContain('organization_id = $1');
      expect(call[1]).toEqual(['org-scoped']);
    }
  });

  test('the report reads no athlete field -- this measures the model, not a boxer', async () => {
    mockRows(row({ reviewed_count: '9', accepted_count: '5', rejected_count: '4' }));

    const report: FilmStudyValidationReport = await getFilmStudyValidation('org-1');

    expect(JSON.stringify(report)).not.toMatch(/athlete/i);
    for (const call of mockQuery.mock.calls) {
      expect(String(call[0])).not.toMatch(/athlete_id/);
    }
  });
});

describe('the numbers a reader could otherwise infer wrongly', () => {
  it('states the missed-observation rate as unavailable rather than omitting it', async () => {
    // Nothing records how many observations COULD have been made, so this
    // rate has no denominator. A null would read as "not measured yet" and an
    // absent key as an oversight; both invite someone to fill it in.
    mockRows(row({ reviewed_count: '10', accepted_count: '6', proposal_count: '12' }), [], '4');
    const report = await getFilmStudyValidation('org-1');
    expect(report.missedObservationRate).toBe('UNAVAILABLE — DENOMINATOR_NOT_CAPTURED');
  });

  it('reports coach-reported misses beside the model numbers, never inside them', async () => {
    mockRows(row({ reviewed_count: '10', accepted_count: '6', proposal_count: '12' }), [], '4');
    const report = await getFilmStudyValidation('org-1');
    expect(report.coachReportedCount).toBe(4);
    // The model's own denominator is untouched by what it missed.
    expect(report.overall.modelProposalCount).toBe(12);
  });

  it('names the denominator for the among-proposals rates', async () => {
    // 12 proposals: 6 accepted, 2 corrected, 2 rejected, 2 pending.
    mockRows(row({
      reviewed_count: '8',
      accepted_count: '6',
      rejected_count: '2',
      corrected_count: '2',
      // Two proposals needed correcting; both are still paused in that state
      // here, so state and history agree. They diverge once a coach finishes
      // one -- see the pg suite, which is where that case is proven.
      ever_corrected_count: '2',
      pending_count: '2',
      proposal_count: '12',
    }));
    const { overall } = await getFilmStudyValidation('org-1');
    expect(overall.acceptanceRateAmongProposals).toBe(0.5);
    expect(overall.correctionRateAmongProposals).toBeCloseTo(0.167, 3);
    expect(overall.rejectionRateAmongProposals).toBeCloseTo(0.167, 3);
    // acceptRate keeps its shipped denominator -- settled proposals only.
    expect(overall.acceptRate).toBe(0.75);
  });

  it('withholds the among-proposals rates on their own floor, not the settled one', async () => {
    // A queue of 40 pending and 2 settled has plenty of denominator for an
    // among-proposals rate while reviewedCount is still 2. Withholding on the
    // settled floor would hide the number that says the queue is not worked.
    mockRows(row({
      reviewed_count: '2',
      accepted_count: '2',
      pending_count: '40',
      proposal_count: '42',
    }));
    const { overall } = await getFilmStudyValidation('org-1');
    expect(overall.acceptRate).toBeNull();
    expect(overall.status).toBe('insufficient_data');
    expect(overall.acceptanceRateAmongProposals).toBeCloseTo(0.048, 3);
  });

  it('has no rate at all when there are no proposals', async () => {
    mockRows(row());
    const { overall } = await getFilmStudyValidation('org-1');
    expect(overall.modelProposalCount).toBe(0);
    expect(overall.acceptanceRateAmongProposals).toBeNull();
    expect(overall.correctionRateAmongProposals).toBeNull();
    expect(overall.rejectionRateAmongProposals).toBeNull();
  });
});
