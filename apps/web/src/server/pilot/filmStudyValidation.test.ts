// Film Study model validation.
//
// The properties under test are the ones that stop a measurement becoming a
// claim it cannot support: a rate is withheld below the sample floor, pending
// proposals never count toward it, and the sample size travels with the number
// everywhere it is reported.

import {
  FILM_STUDY_MINIMUM_REVIEWED,
  describeFilmStudyValidation,
  getFilmStudyValidation,
  type FilmStudyValidationReport,
} from './filmStudyValidation';
import { query } from './db';

jest.mock('./db', () => ({ query: jest.fn() }));

const mockQuery = query as jest.MockedFunction<typeof query>;

interface RowShape {
  model_deployment: string | null;
  reviewed_count: string;
  accepted_count: string;
  rejected_count: string;
  pending_count: string;
  mean_frames: string | null;
}

function row(overrides: Partial<RowShape> = {}): RowShape {
  return {
    model_deployment: null,
    reviewed_count: '0',
    accepted_count: '0',
    rejected_count: '0',
    pending_count: '0',
    mean_frames: null,
    ...overrides,
  };
}

/** Mocks the overall query then the per-deployment query, in call order. */
function mockRows(overall: RowShape, byDeployment: RowShape[] = []): void {
  mockQuery.mockReset();
  mockQuery
    .mockResolvedValueOnce([overall] as never)
    .mockResolvedValueOnce(byDeployment as never);
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

    expect(summary).toMatch(/7 waiting/);
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

  test('the report reads no athlete field -- this measures the model, not a boxer', async () => {
    mockRows(row({ reviewed_count: '9', accepted_count: '5', rejected_count: '4' }));

    const report: FilmStudyValidationReport = await getFilmStudyValidation('org-1');

    expect(JSON.stringify(report)).not.toMatch(/athlete/i);
    for (const call of mockQuery.mock.calls) {
      expect(String(call[0])).not.toMatch(/athlete_id/);
    }
  });
});
