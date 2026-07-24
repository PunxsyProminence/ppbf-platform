import type {
  NumericOutcome,
  NumericSeriesOutcome,
  ValidationReasonCode,
} from './types';

function failure(reason: ValidationReasonCode): NumericOutcome {
  return Object.freeze({ ok: false as const, reason });
}

function seriesFailure(reason: ValidationReasonCode): NumericSeriesOutcome {
  return Object.freeze({ ok: false as const, reason });
}

function finiteValues(values: readonly number[]): ValidationReasonCode | null {
  if (values.length === 0) {
    return 'INSUFFICIENT_DATA';
  }
  return values.every(Number.isFinite) ? null : 'NON_FINITE_VALUE';
}

function success(value: number): NumericOutcome {
  if (!Number.isFinite(value)) {
    return failure('NON_FINITE_VALUE');
  }
  return Object.freeze({ ok: true as const, value });
}

export function mean(values: readonly number[]): NumericOutcome {
  const invalid = finiteValues(values);
  if (invalid) return failure(invalid);

  const total = values.reduce((sum, value) => sum + value, 0);
  return success(total / values.length);
}

export function sampleStandardDeviation(values: readonly number[]): NumericOutcome {
  if (values.length < 2) {
    return failure('INSUFFICIENT_HISTORY');
  }
  const invalid = finiteValues(values);
  if (invalid) return failure(invalid);

  const average = mean(values);
  if (!average.ok) return average;

  const squaredDifferenceTotal = values.reduce(
    (sum, value) => sum + ((value - average.value) ** 2),
    0,
  );
  return success(Math.sqrt(squaredDifferenceTotal / (values.length - 1)));
}

export function rollingMean(values: readonly number[], window: number): NumericOutcome {
  if (!Number.isInteger(window) || window <= 0) {
    return failure('INVALID_WINDOW');
  }
  if (values.length < window) {
    return failure('INSUFFICIENT_HISTORY');
  }
  return mean(values.slice(values.length - window));
}

export function ewma(values: readonly number[], lambda: number): NumericSeriesOutcome {
  if (!Number.isFinite(lambda) || lambda <= 0 || lambda > 1) {
    return seriesFailure('INVALID_LAMBDA');
  }
  const invalid = finiteValues(values);
  if (invalid) return seriesFailure(invalid);

  const series: number[] = [values[0]];
  for (let index = 1; index < values.length; index += 1) {
    const next = (lambda * values[index]) + ((1 - lambda) * series[index - 1]);
    if (!Number.isFinite(next)) {
      return seriesFailure('NON_FINITE_VALUE');
    }
    series.push(next);
  }

  return Object.freeze({
    ok: true as const,
    value: series[series.length - 1],
    series: Object.freeze(series),
  });
}

export function standardizedChange(
  current: number,
  baseline: number,
  denominator: number,
): NumericOutcome {
  if (![current, baseline, denominator].every(Number.isFinite)) {
    return failure('NON_FINITE_VALUE');
  }
  if (denominator === 0) {
    return failure('ZERO_VARIANCE');
  }
  if (denominator < 0) {
    return failure('NEGATIVE_VALUE');
  }
  return success((current - baseline) / denominator);
}

export function smallestWorthwhileChangeBetweenAthletes(
  betweenAthleteSampleSd: number,
): NumericOutcome {
  if (!Number.isFinite(betweenAthleteSampleSd)) {
    return failure('NON_FINITE_VALUE');
  }
  if (betweenAthleteSampleSd < 0) {
    return failure('NEGATIVE_VALUE');
  }
  return success(0.2 * betweenAthleteSampleSd);
}

/**
 * The coefficient is applied to a CV ratio (for example, 0.08 for 8%), not a
 * percentage number. Callers must label the input accordingly.
 */
export function smallestWorthwhileChangeWithinAthlete(
  withinAthleteCvRatio: number,
): NumericOutcome {
  if (!Number.isFinite(withinAthleteCvRatio)) {
    return failure('NON_FINITE_VALUE');
  }
  if (withinAthleteCvRatio < 0) {
    return failure('NEGATIVE_VALUE');
  }
  return success(0.3 * withinAthleteCvRatio);
}

export function acuteChronicWorkloadRatio(
  acuteLoad: number,
  chronicLoad: number,
): NumericOutcome {
  if (![acuteLoad, chronicLoad].every(Number.isFinite)) {
    return failure('NON_FINITE_VALUE');
  }
  if (acuteLoad < 0 || chronicLoad < 0) {
    return failure('NEGATIVE_VALUE');
  }
  if (chronicLoad === 0) {
    return failure('ZERO_CHRONIC_LOAD');
  }
  return success(acuteLoad / chronicLoad);
}
