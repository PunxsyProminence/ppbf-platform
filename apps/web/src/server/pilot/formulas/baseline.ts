import type { PoolClient, QueryResultRow } from 'pg';

import { query, withTransaction } from '../db';
import { mean, sampleStandardDeviation } from './primitives';
import { deterministicKey, stableJson } from './identity';
import { getFormulaDefinition } from './registry';
import type {
  FormulaBaselineSnapshot,
  FormulaUnit,
  NumericObservation,
} from './types';

export interface BaselinePolicy {
  metricKey: string;
  windowSize: number;
  minimumHistory: 4;
  adequateHistory: number;
  policyVersion: string;
}

export type BaselineClient = Pick<PoolClient, 'query'>;

interface BaselineRow extends QueryResultRow {
  calculation_key: string;
  organization_id: string;
  athlete_id: string;
  formula_id: 'MVP-09';
  formula_version: string;
  metric_key: string;
  unit: FormulaUnit;
  policy_version: string;
  parameters: Record<string, unknown>;
  window_size: number;
  history_status: FormulaBaselineSnapshot['historyStatus'];
  baseline_mean: string | number | null;
  baseline_sample_sd: string | number | null;
  observation_ids: string[];
  effective_at: string | Date;
}

function numeric(value: string | number | null): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function fromRow(row: BaselineRow): FormulaBaselineSnapshot {
  return Object.freeze({
    calculationKey: row.calculation_key,
    organizationId: row.organization_id,
    athleteId: row.athlete_id,
    formulaId: row.formula_id,
    formulaVersion: row.formula_version,
    metricKey: row.metric_key,
    unit: row.unit,
    policyVersion: row.policy_version,
    parameters: Object.freeze({ ...(row.parameters ?? {}) }),
    windowSize: row.window_size,
    historyStatus: row.history_status,
    baselineMean: numeric(row.baseline_mean),
    baselineSampleSd: numeric(row.baseline_sample_sd),
    observationIds: Object.freeze([...(row.observation_ids ?? [])]),
    effectiveAt: row.effective_at instanceof Date
      ? row.effective_at.toISOString()
      : new Date(row.effective_at).toISOString(),
  });
}

export function buildPersonalBaselineSnapshot(input: {
  organizationId: string;
  athleteId: string;
  unit: FormulaUnit;
  history: readonly NumericObservation<'numeric'>[];
  policy: BaselinePolicy;
  effectiveAt?: string;
}): FormulaBaselineSnapshot {
  const { policy } = input;
  if (
    !input.organizationId.trim()
    || !input.athleteId.trim()
    || !input.unit
    || !policy.metricKey.trim()
    || !policy.policyVersion.trim()
    || !Number.isInteger(policy.windowSize)
    || policy.windowSize < 8
    || policy.windowSize > 12
    || policy.minimumHistory !== 4
    || !Number.isInteger(policy.adequateHistory)
    || policy.adequateHistory < 8
    || policy.adequateHistory > policy.windowSize
  ) {
    throw new TypeError('Invalid personal baseline policy.');
  }

  const sorted = [...input.history].sort(
    (left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt),
  );
  const selected = sorted.slice(-policy.windowSize);
  const unit = input.unit;
  for (const observation of selected) {
    if (
      observation.organizationId !== input.organizationId
      || observation.athleteId !== input.athleteId
      || observation.kind !== 'numeric'
      || observation.unit !== unit
      || observation.dimensions?.metricKey !== policy.metricKey
      || observation.value == null
      || !Number.isFinite(observation.value)
      || !Number.isFinite(Date.parse(observation.observedAt))
    ) {
      throw new TypeError('Baseline history contains an invalid or out-of-scope observation.');
    }
  }

  const historyStatus = selected.length < policy.minimumHistory
    ? 'insufficient_history'
    : selected.length < policy.adequateHistory
      ? 'building'
      : 'adequate';
  const values = selected.map((observation) => observation.value!);
  const average = historyStatus === 'insufficient_history' ? null : mean(values);
  const sampleSd = historyStatus === 'insufficient_history'
    ? null
    : sampleStandardDeviation(values);
  if (average && !average.ok) throw new TypeError(`Unable to calculate baseline mean: ${average.reason}`);
  if (sampleSd && !sampleSd.ok) throw new TypeError(`Unable to calculate baseline sample SD: ${sampleSd.reason}`);

  const formula = getFormulaDefinition('MVP-09');
  const parameters = Object.freeze({
    metricKey: policy.metricKey,
    windowSize: policy.windowSize,
    minimumHistory: policy.minimumHistory,
    adequateHistory: policy.adequateHistory,
  });
  const observationIds = selected.map((observation) => observation.observationId);
  const calculationKey = deterministicKey('baseline', {
    formulaId: 'MVP-09',
    formulaVersion: formula.version,
    organizationId: input.organizationId,
    athleteId: input.athleteId,
    metricKey: policy.metricKey,
    unit,
    policyVersion: policy.policyVersion,
    parameters,
    observationIds,
  });
  const effectiveAt = input.effectiveAt
    ?? selected[selected.length - 1]?.observedAt
    ?? new Date(0).toISOString();
  if (!Number.isFinite(Date.parse(effectiveAt))) {
    throw new TypeError('Invalid personal baseline effective timestamp.');
  }

  return Object.freeze({
    calculationKey,
    organizationId: input.organizationId,
    athleteId: input.athleteId,
    formulaId: 'MVP-09',
    formulaVersion: formula.version,
    metricKey: policy.metricKey,
    unit,
    policyVersion: policy.policyVersion,
    parameters,
    windowSize: policy.windowSize,
    historyStatus,
    baselineMean: average?.ok ? average.value : null,
    baselineSampleSd: sampleSd?.ok ? sampleSd.value : null,
    observationIds: Object.freeze(observationIds),
    effectiveAt,
  });
}

function snapshotIdentity(snapshot: FormulaBaselineSnapshot) {
  return {
    calculationKey: snapshot.calculationKey,
    organizationId: snapshot.organizationId,
    athleteId: snapshot.athleteId,
    formulaId: snapshot.formulaId,
    formulaVersion: snapshot.formulaVersion,
    metricKey: snapshot.metricKey,
    unit: snapshot.unit,
    policyVersion: snapshot.policyVersion,
    parameters: snapshot.parameters,
    windowSize: snapshot.windowSize,
    historyStatus: snapshot.historyStatus,
    baselineMean: snapshot.baselineMean,
    baselineSampleSd: snapshot.baselineSampleSd,
    observationIds: snapshot.observationIds,
    effectiveAt: new Date(snapshot.effectiveAt).toISOString(),
  };
}

export async function savePersonalBaselineSnapshotWithClient(
  client: BaselineClient,
  snapshot: FormulaBaselineSnapshot,
): Promise<FormulaBaselineSnapshot> {
  const inserted = await client.query<BaselineRow>(
      `insert into pilot.shadow_formula_baseline_snapshots (
         calculation_key, organization_id, athlete_id, formula_id,
         formula_version, metric_key, unit, policy_version, parameters,
         window_size, history_status, baseline_mean, baseline_sample_sd,
         observation_ids, effective_at
       ) values (
         $1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,
         $10,$11,$12,$13,$14,$15::timestamptz
       )
       on conflict (organization_id, athlete_id, metric_key, calculation_key)
       do nothing
       returning *`,
      [
        snapshot.calculationKey,
        snapshot.organizationId,
        snapshot.athleteId,
        snapshot.formulaId,
        snapshot.formulaVersion,
        snapshot.metricKey,
        snapshot.unit,
        snapshot.policyVersion,
        JSON.stringify(snapshot.parameters),
        snapshot.windowSize,
        snapshot.historyStatus,
        snapshot.baselineMean,
        snapshot.baselineSampleSd,
        [...snapshot.observationIds],
        snapshot.effectiveAt,
      ],
  );
  if (inserted.rows[0]) return fromRow(inserted.rows[0]);

  const existing = await client.query<BaselineRow>(
      `select *
       from pilot.shadow_formula_baseline_snapshots
       where organization_id = $1
         and athlete_id = $2
         and metric_key = $3
         and calculation_key = $4`,
      [
        snapshot.organizationId,
        snapshot.athleteId,
        snapshot.metricKey,
        snapshot.calculationKey,
      ],
  );
  if (!existing.rows[0]) throw new Error('Unable to persist personal baseline snapshot.');
  const persisted = fromRow(existing.rows[0]);
  if (stableJson(snapshotIdentity(persisted)) !== stableJson(snapshotIdentity(snapshot))) {
    throw new Error('Personal baseline calculation key conflicts with a different immutable snapshot.');
  }
  return persisted;
}

export async function savePersonalBaselineSnapshot(
  snapshot: FormulaBaselineSnapshot,
): Promise<FormulaBaselineSnapshot> {
  return withTransaction((client) => savePersonalBaselineSnapshotWithClient(client, snapshot));
}

export async function listPersonalBaselineSnapshots(input: {
  organizationId: string;
  athleteId: string;
  metricKey: string;
  limit?: number;
}): Promise<FormulaBaselineSnapshot[]> {
  const limit = Math.max(1, Math.min(100, Math.trunc(input.limit ?? 20)));
  const rows = await query<BaselineRow>(
    `select *
     from pilot.shadow_formula_baseline_snapshots
     where organization_id = $1
       and athlete_id = $2
       and metric_key = $3
     order by effective_at desc, created_at desc
     limit $4`,
    [input.organizationId, input.athleteId, input.metricKey, limit],
  );
  return rows.map(fromRow);
}
