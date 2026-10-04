import {
  bodyMassInputError,
  recordCheckInBodyMass,
  summarizeBodyMass,
  toKilograms,
} from './athleteBodyMass';
import { query } from './db';
import { saveFormulaObservation } from './formulas/repository';

jest.mock('./db', () => ({ query: jest.fn(), queryOne: jest.fn() }));
jest.mock('./formulas/repository', () => ({ saveFormulaObservation: jest.fn() }));

const mockQuery = query as jest.Mock;
const mockSave = saveFormulaObservation as jest.Mock;

const NOW = new Date('2026-10-04T18:00:00Z');
const HOUR = 60 * 60 * 1_000;
const DAY = 24 * HOUR;

function row(id: string, value: number, msBeforeNow: number, unit = 'kilograms') {
  return {
    observation_id: id,
    numeric_value: String(value),
    unit,
    observed_at: new Date(NOW.getTime() - msBeforeNow),
  };
}

afterEach(() => jest.clearAllMocks());

describe('bodyMassInputError', () => {
  test('absence is legal', () => {
    expect(bodyMassInputError(undefined, undefined)).toBeNull();
    expect(bodyMassInputError(null, 'lb')).toBeNull();
  });

  test('a value needs a known unit and a finite number in range', () => {
    expect(bodyMassInputError(150, undefined)).toMatch(/body_mass_unit/);
    expect(bodyMassInputError(150, 'stone')).toMatch(/body_mass_unit/);
    expect(bodyMassInputError('150', 'lb')).toMatch(/number/);
    expect(bodyMassInputError(Number.NaN, 'kg')).toMatch(/number/);
    expect(bodyMassInputError(19.9, 'kg')).toMatch(/20 to 250 kg/);
    expect(bodyMassInputError(250.1, 'kg')).toMatch(/20 to 250 kg/);
    expect(bodyMassInputError(40, 'lb')).toMatch(/lb/);
    expect(bodyMassInputError(20, 'kg')).toBeNull();
    expect(bodyMassInputError(150.5, 'lb')).toBeNull();
  });

  test('pounds convert to kilograms to the hundredth', () => {
    expect(toKilograms(150, 'lb')).toBe(68.04);
    expect(toKilograms(68.04, 'kg')).toBe(68.04);
  });
});

describe('recordCheckInBodyMass', () => {
  test('stores the same body_weight observation the sparring form writes, keyed by the check-in', async () => {
    await recordCheckInBodyMass({
      organizationId: 'org-1',
      athleteId: 'ath-1',
      checkInId: 'ci-1',
      kilograms: 68.04,
      observedAt: '2026-10-04T17:00:00.000Z',
      accountId: 'acct-1',
    });
    expect(mockSave).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: 'org-1',
      athleteId: 'ath-1',
      kind: 'body_weight',
      value: 68.04,
      unit: 'kilograms',
      contextId: 'check-in:ci-1',
      idempotencyKey: 'check-in:ci-1:body_weight',
      observedAt: '2026-10-04T17:00:00.000Z',
      createdByAccountId: 'acct-1',
    }));
  });
});

describe('summarizeBodyMass', () => {
  test('nothing in the last month is no summary', async () => {
    mockQuery.mockResolvedValue([]);
    const summary = await summarizeBodyMass('org-1', 'ath-1', NOW);
    expect(summary).toMatchObject({ latest: null, change: null, flagged: false, flag_text: null });
  });

  test('the read is scoped, body_weight only, bounded to the last 30 days, and skips superseded entries', async () => {
    mockQuery.mockResolvedValue([]);
    await summarizeBodyMass('org-1', 'ath-1', NOW);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/organization_id = \$1/);
    expect(sql).toMatch(/athlete_id = \$2/);
    expect(sql).toMatch(/observation_kind = 'body_weight'/);
    expect(sql).toMatch(/supersedes_observation_id = o\.observation_id/);
    expect(params).toEqual(['org-1', 'ath-1', new Date(NOW.getTime() - 30 * DAY).toISOString(), NOW.toISOString()]);
  });

  test('one weigh-in gives a latest weight and no change', async () => {
    mockQuery.mockResolvedValue([row('a', 70, DAY)]);
    const summary = await summarizeBodyMass('org-1', 'ath-1', NOW);
    expect(summary.latest).toEqual({ kilograms: 70, pounds: 154.3, observed_at: new Date(NOW.getTime() - DAY).toISOString() });
    expect(summary.change).toBeNull();
    expect(summary.flagged).toBe(false);
  });

  test.each([
    ['exactly 5% down is not flagged', 100, 95, -5, false],
    ['5.1% down is flagged', 100, 94.9, -5.1, true],
    ['5.1% up is flagged too', 100, 105.1, 5.1, true],
    ['a small change is not flagged', 100, 98, -2, false],
  ])('%s', async (_label, prior, latest, percent, flagged) => {
    mockQuery.mockResolvedValue([row('p', prior, 8 * DAY), row('l', latest, DAY)]);
    const summary = await summarizeBodyMass('org-1', 'ath-1', NOW);
    expect(summary.change).toMatchObject({ percent, days: 7 });
    expect(summary.flagged).toBe(flagged);
    expect(summary.flag_text === null).toBe(!flagged);
  });

  test('the flag sentence', async () => {
    mockQuery.mockResolvedValue([row('p', 60, 8 * DAY), row('l', 56.4, DAY)]);
    const summary = await summarizeBodyMass('org-1', 'ath-1', NOW);
    expect(summary.flag_text).toBe('Weight down 6.0% in 7 days (132.3 lb → 124.3 lb). Check in with the athlete.');
  });

  test('the earlier weigh-in must fall within a day of seven days back', async () => {
    // 9 days before the latest: outside 7 days +- 24 hours.
    mockQuery.mockResolvedValue([row('p', 100, 10 * DAY), row('l', 80, DAY)]);
    const summary = await summarizeBodyMass('org-1', 'ath-1', NOW);
    expect(summary.change).toBeNull();
    expect(summary.flagged).toBe(false);
  });

  test('the edge of the window counts; one hour past it does not', async () => {
    mockQuery.mockResolvedValue([row('p', 100, 9 * DAY), row('l', 90, DAY)]);
    expect((await summarizeBodyMass('org-1', 'ath-1', NOW)).change).toMatchObject({ days: 8 });
    mockQuery.mockResolvedValue([row('p', 100, 9 * DAY + HOUR), row('l', 90, DAY)]);
    expect((await summarizeBodyMass('org-1', 'ath-1', NOW)).change).toBeNull();
  });

  test('of several earlier weigh-ins, the one closest to seven days back is used', async () => {
    mockQuery.mockResolvedValue([
      row('far', 90, 8 * DAY + 20 * HOUR),
      row('near', 100, 8 * DAY + 2 * HOUR),
      row('l', 94, DAY),
    ]);
    const summary = await summarizeBodyMass('org-1', 'ath-1', NOW);
    expect(summary.change).toMatchObject({ prior_kilograms: 100, percent: -6 });
  });

  test('a weigh-in stored in pounds is compared in kilograms', async () => {
    mockQuery.mockResolvedValue([row('p', 150, 8 * DAY, 'pounds'), row('l', 64.3, DAY)]);
    const summary = await summarizeBodyMass('org-1', 'ath-1', NOW);
    expect(summary.change).toMatchObject({ prior_kilograms: 68.04, percent: -5.5 });
    expect(summary.flagged).toBe(true);
  });
});

describe('review fixes', () => {
  test('the 5% test uses the unrounded change: 5.04% is flagged though it reads 5.0%', async () => {
    mockQuery.mockResolvedValue([row('p', 100, 8 * DAY), row('l', 94.96, DAY)]);
    const summary = await summarizeBodyMass('org-1', 'ath-1', NOW);
    expect(summary.change).toMatchObject({ percent: -5 });
    expect(summary.flagged).toBe(true);
  });

  test('a weigh-in outside 20-250 kg (a typing slip on the sparring form) is left out', async () => {
    mockQuery.mockResolvedValue([row('p', 70, 8 * DAY), row('typo', 700, DAY)]);
    const summary = await summarizeBodyMass('org-1', 'ath-1', NOW);
    expect(summary.latest).toMatchObject({ kilograms: 70 });
    expect(summary.flagged).toBe(false);
  });
});

describe('option B: any two weigh-ins within the 7 days up to the latest (Jason 2026-10-04)', () => {
  test('a Monday-to-Friday cut flags with no weigh-in a week earlier', async () => {
    mockQuery.mockResolvedValue([row('mon', 70, 5 * DAY), row('fri', 66, DAY)]);
    const summary = await summarizeBodyMass('org-1', 'ath-1', NOW);
    expect(summary.change).toBeNull();
    expect(summary.largest_change_in_window).toMatchObject({ percent: -5.7, days: 4 });
    expect(summary.flagged).toBe(true);
    expect(summary.flag_text).toBe('Weight down 5.7% in 4 days (154.3 lb → 145.5 lb). Check in with the athlete.');
  });

  test('a dip and recovery inside the week flags even when day 0 and day 7 match', async () => {
    mockQuery.mockResolvedValue([row('d0', 70, 8 * DAY), row('d5', 66, 3 * DAY), row('d7', 69.5, DAY)]);
    const summary = await summarizeBodyMass('org-1', 'ath-1', NOW);
    expect(summary.change).toMatchObject({ percent: -0.7 });
    expect(summary.flagged).toBe(true);
    expect(summary.flag_text).toMatch(/^Weight down 5\.7% in 5 days/);
  });

  test('the sentence names the larger of the two changes', async () => {
    // 7-day-back: 100 -> 94 (-6.0%), listed first. Inside the week 101 -> 94
    // (-6.9% in 4 days) is larger, so that one is named.
    mockQuery.mockResolvedValue([row('p', 100, 8 * DAY), row('m', 101, 5 * DAY), row('l', 94, DAY)]);
    const summary = await summarizeBodyMass('org-1', 'ath-1', NOW);
    expect(summary.change).toMatchObject({ percent: -6 });
    expect(summary.flag_text).toMatch(/^Weight down 6\.9% in 4 days/);
  });

  test('two weigh-ins the same day read "within a day"', async () => {
    mockQuery.mockResolvedValue([row('am', 70, DAY + 6 * 60 * 60 * 1_000), row('pm', 66, DAY)]);
    const summary = await summarizeBodyMass('org-1', 'ath-1', NOW);
    expect(summary.flag_text).toBe('Weight down 5.7% within a day (154.3 lb → 145.5 lb). Check in with the athlete.');
  });

  test('a weigh-in older than the week before the latest is not part of the window', async () => {
    mockQuery.mockResolvedValue([row('old', 80, 9 * DAY + 60 * 60 * 1_000), row('l', 70, DAY)]);
    const summary = await summarizeBodyMass('org-1', 'ath-1', NOW);
    expect(summary.largest_change_in_window).toBeNull();
    expect(summary.flagged).toBe(false);
  });
});
