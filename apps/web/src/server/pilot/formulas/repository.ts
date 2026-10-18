import type { PoolClient, QueryResultRow } from 'pg';

import { withTransaction, query } from '../db';
import { deterministicKey, stableJson } from './identity';
import type {
  FormulaId,
  FormulaResult,
  FormulaUnit,
  NumericObservation,
  ObservationKind,
  ObservationSourceType,
  SourceQuality,
} from './types';

export type FormulaClient = Pick<PoolClient, 'query'>;

interface FormulaObservationRow extends QueryResultRow {
  observation_id: string;
  organization_id: string;
  athlete_id: string | null;
  context_id: string;
  observation_kind: ObservationKind;
  numeric_value: string | number | null;
  unit: FormulaUnit;
  dimensions: Record<string, string | number | boolean | null>;
  observed_at: string | Date;
  source_type: ObservationSourceType;
  source_quality: SourceQuality;
  source_reference_id: string;
  source_quality_notes: string | null;
  idempotency_key: string;
  supersedes_observation_id: string | null;
}

export interface PersistedFormulaResultRow extends QueryResultRow {
  result_id: string;
  calculation_key: string;
  formula_id: FormulaId;
  formula_version: string;
  output_key: string;
  policy_version: string;
  parameters: Record<string, unknown>;
  organization_id: string;
  athlete_id: string | null;
  context_id: string | null;
  numeric_value: string | number | null;
  unit: FormulaUnit;
  computed_at: string | Date;
  input_observation_ids: string[];
  provenance: FormulaResult['provenance'];
  validation_state: FormulaResult['validation']['state'];
  hard_blocks: FormulaResult['validation']['hardBlocks'];
  warnings: FormulaResult['validation']['warnings'];
  confidence: FormulaResult['quality']['confidence'];
  completeness: string | number;
  worst_source_quality: SourceQuality | null;
  unavailable_reason: FormulaResult['unavailableReason'];
  human_review_required: boolean;
}

export interface NewFormulaObservation {
  organizationId: string;
  athleteId: string;
  contextId: string;
  kind: ObservationKind;
  value: number | null;
  unit: FormulaUnit;
  dimensions?: Readonly<Record<string, string | number | boolean | null>>;
  observedAt: string;
  source: {
    type: ObservationSourceType;
    quality: SourceQuality;
    referenceId: string;
    qualityNotes?: string;
  };
  idempotencyKey: string;
  supersedesObservationId?: string | null;
  createdByAccountId?: string | null;
}

export class FormulaRepositoryError extends Error {
  constructor(
    readonly code:
      | 'IDEMPOTENCY_CONFLICT'
      | 'OBSERVATION_NOT_FOUND'
      | 'SUPERSEDED_OBSERVATION'
      | 'SCOPE_MISMATCH',
    message: string,
  ) {
    super(message);
    this.name = 'FormulaRepositoryError';
  }
}

function iso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function numeric(value: string | number | null): number | null {
  if (value == null) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function rowToObservation(row: FormulaObservationRow): NumericObservation {
  return Object.freeze({
    observationId: row.observation_id,
    organizationId: row.organization_id,
    athleteId: row.athlete_id,
    contextId: row.context_id,
    kind: row.observation_kind,
    value: numeric(row.numeric_value),
    unit: row.unit,
    dimensions: Object.freeze({ ...(row.dimensions ?? {}) }),
    observedAt: iso(row.observed_at),
    source: Object.freeze({
      type: row.source_type,
      quality: row.source_quality,
      referenceId: row.source_reference_id,
      ...(row.source_quality_notes ? { qualityNotes: row.source_quality_notes } : {}),
    }),
    idempotencyKey: row.idempotency_key,
    supersedesObservationId: row.supersedes_observation_id,
  });
}

function rowToFormulaResult(row: PersistedFormulaResultRow): FormulaResult {
  return Object.freeze({
    resultId: row.result_id,
    calculationKey: row.calculation_key,
    formulaId: row.formula_id,
    formulaVersion: row.formula_version,
    outputKey: row.output_key,
    policyVersion: row.policy_version,
    parameters: Object.freeze({ ...(row.parameters ?? {}) }),
    organizationId: row.organization_id,
    athleteId: row.athlete_id,
    contextId: row.context_id,
    value: numeric(row.numeric_value),
    unit: row.unit,
    computedAt: iso(row.computed_at),
    inputObservationIds: Object.freeze([...(row.input_observation_ids ?? [])]),
    provenance: Object.freeze([...(row.provenance ?? [])]),
    validation: Object.freeze({
      state: row.validation_state,
      hardBlocks: Object.freeze([...(row.hard_blocks ?? [])]),
      warnings: Object.freeze([...(row.warnings ?? [])]),
    }),
    quality: Object.freeze({
      confidence: row.confidence,
      completeness: Number(row.completeness),
      worstSourceQuality: row.worst_source_quality,
    }),
    unavailableReason: row.unavailable_reason,
    humanReviewRequired: row.human_review_required,
  });
}

function observationIdentity(input: NewFormulaObservation) {
  return {
    organizationId: input.organizationId,
    athleteId: input.athleteId,
    contextId: input.contextId,
    kind: input.kind,
    value: input.value,
    unit: input.unit,
    dimensions: input.dimensions ?? {},
    observedAt: new Date(input.observedAt).toISOString(),
    source: input.source,
    supersedesObservationId: input.supersedesObservationId ?? null,
  };
}

function existingObservationIdentity(row: FormulaObservationRow) {
  return {
    organizationId: row.organization_id,
    athleteId: row.athlete_id,
    contextId: row.context_id,
    kind: row.observation_kind,
    value: numeric(row.numeric_value),
    unit: row.unit,
    dimensions: row.dimensions ?? {},
    observedAt: iso(row.observed_at),
    source: {
      type: row.source_type,
      quality: row.source_quality,
      referenceId: row.source_reference_id,
      ...(row.source_quality_notes ? { qualityNotes: row.source_quality_notes } : {}),
    },
    supersedesObservationId: row.supersedes_observation_id,
  };
}

function formulaResultIdentity(result: FormulaResult) {
  return {
    resultId: result.resultId,
    calculationKey: result.calculationKey,
    formulaId: result.formulaId,
    formulaVersion: result.formulaVersion,
    outputKey: result.outputKey,
    policyVersion: result.policyVersion,
    parameters: result.parameters,
    organizationId: result.organizationId,
    athleteId: result.athleteId,
    contextId: result.contextId,
    value: result.value,
    unit: result.unit,
    inputObservationIds: result.inputObservationIds,
    provenance: result.provenance,
    validation: result.validation,
    quality: result.quality,
    unavailableReason: result.unavailableReason,
    humanReviewRequired: result.humanReviewRequired,
  };
}

async function loadObservationForUpdate(
  client: FormulaClient,
  organizationId: string,
  athleteId: string,
  observationId: string,
): Promise<FormulaObservationRow | null> {
  const result = await client.query<FormulaObservationRow>(
    `select *
     from pilot.shadow_formula_observations
     where organization_id = $1
       and athlete_id = $2
       and observation_id = $3
     for update`,
    [organizationId, athleteId, observationId],
  );
  return result.rows[0] ?? null;
}

export async function saveFormulaObservation(
  input: NewFormulaObservation,
): Promise<NumericObservation> {
  if (
    !input.organizationId.trim()
    || !input.athleteId.trim()
    || !input.contextId.trim()
    || !input.idempotencyKey.trim()
    || input.idempotencyKey.length > 300
    || !Number.isFinite(Date.parse(input.observedAt))
    || (input.value != null && !Number.isFinite(input.value))
  ) {
    throw new TypeError('Invalid formula observation');
  }

  return withTransaction(async (client) => {
    if (input.supersedesObservationId) {
      const superseded = await loadObservationForUpdate(
        client,
        input.organizationId,
        input.athleteId,
        input.supersedesObservationId,
      );
      if (!superseded) {
        throw new FormulaRepositoryError(
          'OBSERVATION_NOT_FOUND',
          'Superseded observation does not exist in this athlete scope.',
        );
      }
      const successor = await client.query<{ observation_id: string }>(
        `select observation_id
         from pilot.shadow_formula_observations
         where organization_id = $1
           and supersedes_observation_id = $2
         limit 1`,
        [input.organizationId, input.supersedesObservationId],
      );
      if (successor.rows.length > 0) {
        const existingByKey = await client.query<FormulaObservationRow>(
          `select *
           from pilot.shadow_formula_observations
           where organization_id = $1 and idempotency_key = $2`,
          [input.organizationId, input.idempotencyKey],
        );
        const existing = existingByKey.rows[0];
        if (
          existing
          && stableJson(existingObservationIdentity(existing)) === stableJson(observationIdentity(input))
        ) {
          return rowToObservation(existing);
        }
        throw new FormulaRepositoryError(
          'SUPERSEDED_OBSERVATION',
          'Observation already has a different immutable successor.',
        );
      }
    }

    const observationId = deterministicKey('observation', {
      organizationId: input.organizationId,
      idempotencyKey: input.idempotencyKey,
    });
    const inserted = await client.query<FormulaObservationRow>(
      `insert into pilot.shadow_formula_observations (
         observation_id, organization_id, athlete_id, context_id,
         observation_kind, numeric_value, unit, dimensions, observed_at,
         source_type, source_quality, source_reference_id, source_quality_notes,
         idempotency_key, supersedes_observation_id, created_by_account_id
       ) values (
         $1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::timestamptz,
         $10,$11,$12,$13,$14,$15,$16
       )
       on conflict do nothing
       returning *`,
      [
        observationId,
        input.organizationId,
        input.athleteId,
        input.contextId,
        input.kind,
        input.value,
        input.unit,
        JSON.stringify(input.dimensions ?? {}),
        input.observedAt,
        input.source.type,
        input.source.quality,
        input.source.referenceId,
        input.source.qualityNotes ?? null,
        input.idempotencyKey,
        input.supersedesObservationId ?? null,
        input.createdByAccountId ?? null,
      ],
    );
    if (inserted.rows[0]) return rowToObservation(inserted.rows[0]);

    const existingResult = await client.query<FormulaObservationRow>(
      `select *
       from pilot.shadow_formula_observations
       where organization_id = $1 and idempotency_key = $2`,
      [input.organizationId, input.idempotencyKey],
    );
    const existing = existingResult.rows[0];
    if (
      existing
      && stableJson(existingObservationIdentity(existing)) === stableJson(observationIdentity(input))
    ) {
      return rowToObservation(existing);
    }
    if (input.supersedesObservationId) {
      const successor = await client.query<{ observation_id: string }>(
        `select observation_id
         from pilot.shadow_formula_observations
         where organization_id = $1
           and supersedes_observation_id = $2
         limit 1`,
        [input.organizationId, input.supersedesObservationId],
      );
      if (successor.rows.length > 0) {
        throw new FormulaRepositoryError(
          'SUPERSEDED_OBSERVATION',
          'Observation already has a different immutable successor.',
        );
      }
    }
    throw new FormulaRepositoryError(
      'IDEMPOTENCY_CONFLICT',
      'Idempotency key already belongs to a different observation payload.',
    );
  });
}

export async function getActiveFormulaObservationsByIds(input: {
  organizationId: string;
  athleteId: string;
  observationIds: readonly string[];
}): Promise<NumericObservation[]> {
  const ids = [...new Set(input.observationIds)];
  if (ids.length === 0 || ids.length > 500) {
    throw new TypeError('Formula execution requires 1-500 observation IDs.');
  }
  const rows = await query<FormulaObservationRow>(
    `select o.*
     from pilot.shadow_formula_observations o
     where o.organization_id = $1
       and o.athlete_id = $2
       and o.observation_id = any($3::text[])
       and not exists (
         select 1
         from pilot.shadow_formula_observations successor
         where successor.organization_id = o.organization_id
           and successor.supersedes_observation_id = o.observation_id
       )`,
    [input.organizationId, input.athleteId, ids],
  );
  const byId = new Map(rows.map((row) => [row.observation_id, row]));
  if (byId.size !== ids.length) {
    throw new FormulaRepositoryError(
      'OBSERVATION_NOT_FOUND',
      'One or more observations are missing, outside scope, or superseded.',
    );
  }
  return ids.map((id) => rowToObservation(byId.get(id)!));
}

/**
 * Every active observation in one athlete's context, for a caller that does
 * NOT already know which observation ids belong together.
 *
 * This is deliberately a second function rather than a widening of
 * getActiveFormulaObservationsByIds above. That one is the manual execution
 * path: a caller names ids, and being handed a superseded or out-of-scope id
 * is an error it must throw on, because silently computing over fewer inputs
 * than the caller asked for would produce a result nobody could account for.
 * Detection is the opposite situation -- nothing has been asked for yet, and
 * "this context holds no complete set" is an ordinary answer, not a fault. One
 * function cannot hold both behaviours, so it holds one and this holds the
 * other.
 *
 * The `not exists` clause is byte-identical to the one above on purpose:
 * supersession is what makes a correction replace a measurement rather than
 * sit beside it, and two spellings of that rule is how they come to disagree.
 *
 * The three equality predicates are the leading three columns of
 * idx_shadow_formula_observations_scope (organization_id, athlete_id,
 * context_id, observation_kind, observed_at desc). Read from the index
 * definition in infra/azure/pilot_slice_postgres.sql:1162; not confirmed by
 * EXPLAIN, which needs a database this environment does not have.
 */
export async function getActiveObservationsForContext(input: {
  organizationId: string;
  athleteId: string;
  contextId: string;
}): Promise<NumericObservation[]> {
  if (!input.organizationId.trim() || !input.athleteId.trim() || !input.contextId.trim()) {
    throw new TypeError(
      'Formula observation context read requires an organization, athlete, and context.',
    );
  }
  const rows = await query<FormulaObservationRow>(
    `select o.*
     from pilot.shadow_formula_observations o
     where o.organization_id = $1
       and o.athlete_id = $2
       and o.context_id = $3
       and not exists (
         select 1
         from pilot.shadow_formula_observations successor
         where successor.organization_id = o.organization_id
           and successor.supersedes_observation_id = o.observation_id
       )
     order by o.observed_at asc, o.observation_id asc`,
    [input.organizationId, input.athleteId, input.contextId],
  );
  return rows.map(rowToObservation);
}

function requireFormulaResultScope(
  results: readonly FormulaResult[],
): { organizationId: string; athleteId: string } {
  const organizationId = results[0].organizationId;
  const athleteId = results[0].athleteId;
  if (
    !organizationId
    || !athleteId
    || results.some((result) => (
      result.organizationId !== organizationId
      || result.athleteId !== athleteId
      || result.validation.state === 'unsupported'
    ))
  ) {
    throw new FormulaRepositoryError(
      'SCOPE_MISMATCH',
      'Persisted formula results require one organization and athlete scope.',
    );
  }
  return { organizationId, athleteId };
}

export async function saveFormulaResultsWithClient(
  client: FormulaClient,
  results: readonly FormulaResult[],
): Promise<FormulaResult[]> {
  if (results.length === 0) return [];
  const { organizationId } = requireFormulaResultScope(results);
  const persisted: FormulaResult[] = [];
  for (const result of results) {
    const inserted = await client.query<PersistedFormulaResultRow>(
        `insert into pilot.shadow_formula_results (
           result_id, calculation_key, formula_id, formula_version,
           output_key, policy_version, parameters,
           organization_id, athlete_id, context_id, numeric_value, unit,
           computed_at, input_observation_ids, provenance, validation_state,
           hard_blocks, warnings, confidence, completeness,
           worst_source_quality, unavailable_reason, human_review_required
         ) values (
           $1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,
           $13::timestamptz,$14,$15::jsonb,$16,$17,$18,$19,$20,
           $21,$22,$23
         )
         on conflict (organization_id, calculation_key) do nothing
         returning *`,
        [
          result.resultId,
          result.calculationKey,
          result.formulaId,
          result.formulaVersion,
          result.outputKey,
          result.policyVersion,
          JSON.stringify(result.parameters),
          result.organizationId,
          result.athleteId,
          result.contextId,
          result.value,
          result.unit,
          result.computedAt,
          [...result.inputObservationIds],
          JSON.stringify(result.provenance),
          result.validation.state,
          [...result.validation.hardBlocks],
          [...result.validation.warnings],
          result.quality.confidence,
          result.quality.completeness,
          result.quality.worstSourceQuality,
          result.unavailableReason,
          result.humanReviewRequired,
        ],
    );
    if (inserted.rows[0]) {
      persisted.push(rowToFormulaResult(inserted.rows[0]));
      continue;
    }
    const existing = await client.query<PersistedFormulaResultRow>(
        `select *
         from pilot.shadow_formula_results
         where organization_id = $1 and calculation_key = $2`,
        [organizationId, result.calculationKey],
    );
    const existingResult = existing.rows[0]
      ? rowToFormulaResult(existing.rows[0])
      : null;
    if (
      !existingResult
      || stableJson(formulaResultIdentity(existingResult))
        !== stableJson(formulaResultIdentity(result))
    ) {
      throw new FormulaRepositoryError(
        'IDEMPOTENCY_CONFLICT',
        'Formula calculation key conflicts with a different immutable result.',
      );
    }
    persisted.push(existingResult);
  }
  return persisted;
}

export async function saveFormulaResults(
  results: readonly FormulaResult[],
): Promise<FormulaResult[]> {
  if (results.length === 0) return [];
  requireFormulaResultScope(results);
  return withTransaction((client) => saveFormulaResultsWithClient(client, results));
}

export async function listActiveFormulaResults(input: {
  organizationId: string;
  athleteId: string;
  formulaId?: FormulaId;
  limit?: number;
}): Promise<FormulaResult[]> {
  const limit = Math.max(1, Math.min(200, Math.trunc(input.limit ?? 50)));
  const rows = await query<PersistedFormulaResultRow>(
    `select r.*
     from pilot.shadow_formula_results r
     where r.organization_id = $1
       and r.athlete_id = $2
       and ($3::text is null or r.formula_id = $3)
       and not exists (
         select 1
         from unnest(r.input_observation_ids) input_id
         join pilot.shadow_formula_observations successor
           on successor.organization_id = r.organization_id
          and successor.supersedes_observation_id = input_id
       )
     order by r.computed_at desc, r.formula_id asc, r.output_key asc
     limit $4`,
    [input.organizationId, input.athleteId, input.formulaId ?? null, limit],
  );
  return rows.map(rowToFormulaResult);
}

/**
 * The CURRENT results an observation feeds, for re-running when that one
 * observation is corrected.
 *
 * A result some OTHER input of which was corrected earlier is not current: it
 * was already replaced when that earlier correction re-ran it. Re-running it
 * now would hand the runner an id that is already superseded, and
 * getActiveFormulaObservationsByIds refuses that -- so fixing two numbers of
 * one sparring entry, one after the other, failed the second fix after it had
 * been stored. The exclusion is the readers' own (listLatestFormulaResultsPerOutput
 * below), minus the observation being replaced right now, which is already
 * superseded by the time this runs and is exactly the input being swapped.
 */
export async function findFormulaResultsUsingObservation(input: {
  organizationId: string;
  athleteId: string;
  observationId: string;
}): Promise<FormulaResult[]> {
  const rows = await query<PersistedFormulaResultRow>(
    `select r.*
     from pilot.shadow_formula_results r
     where r.organization_id = $1
       and r.athlete_id = $2
       and $3 = any(r.input_observation_ids)
       and not exists (
         select 1
         from unnest(r.input_observation_ids) input_id
         join pilot.shadow_formula_observations successor
           on successor.organization_id = r.organization_id
          and successor.supersedes_observation_id = input_id
         where input_id <> $3
       )
     order by r.computed_at asc, r.formula_id asc, r.output_key asc`,
    [input.organizationId, input.athleteId, input.observationId],
  );
  return rows.map(rowToFormulaResult);
}

/** The numbers the sparring page's "Fix a number" corrects. Anyone the
 *  observations route admits for the athlete may correct them, as POST always
 *  allowed; this list only bounds which kinds the screen offers. */
export const SPARRING_CORRECTABLE_KINDS: readonly ObservationKind[] = Object.freeze([
  'punch_attempted',
  'punch_landed',
  'punch_absorbed',
]);

/** The sparring page names every entry's context `sparring_<epoch ms>`
 * (app/athlete/dashboard/sparring/page.tsx); that prefix is what marks an
 * entry as one of its own. */
export const SPARRING_CONTEXT_PREFIX = 'sparring_';

export interface SparringEntry {
  readonly contextId: string;
  readonly observedAt: string;
  readonly observations: readonly NumericObservation[];
}

/**
 * One athlete's most recent sparring-page entries, newest first, holding only
 * the active (not superseded) correctable punch numbers.
 *
 * Narrow on purpose. A sparring context also holds body weight, contact and
 * free-text notes; body weight has its own correction path and its own youth
 * narrowing (athleteBodyMass.ts), and nothing on the fix screen needs the
 * rest, so none of it leaves the database here.
 */
export async function listRecentSparringEntries(input: {
  organizationId: string;
  athleteId: string;
  limit?: number;
}): Promise<SparringEntry[]> {
  if (!input.organizationId.trim() || !input.athleteId.trim()) {
    throw new TypeError('Sparring entries require an organization and athlete.');
  }
  const limit = Math.max(1, Math.min(20, Math.trunc(input.limit ?? 5)));
  const rows = await query<FormulaObservationRow>(
    `with active as (
       select o.*
       from pilot.shadow_formula_observations o
       where o.organization_id = $1
         and o.athlete_id = $2
         and left(o.context_id, length($3)) = $3
         and o.observation_kind = any($4::text[])
         and not exists (
           select 1
           from pilot.shadow_formula_observations successor
           where successor.organization_id = o.organization_id
             and successor.supersedes_observation_id = o.observation_id
         )
     ),
     recent as (
       select context_id, max(observed_at) as entry_at
       from active
       group by context_id
       order by entry_at desc, context_id desc
       limit $5
     )
     select active.*
     from active
     join recent using (context_id)
     order by recent.entry_at desc, active.context_id desc, active.observation_kind asc`,
    [
      input.organizationId,
      input.athleteId,
      // Compared as a prefix, not through LIKE: '_' is a LIKE wildcard.
      SPARRING_CONTEXT_PREFIX,
      [...SPARRING_CORRECTABLE_KINDS],
      limit,
    ],
  );
  const entries = new Map<string, NumericObservation[]>();
  for (const row of rows) {
    const members = entries.get(row.context_id) ?? [];
    members.push(rowToObservation(row));
    entries.set(row.context_id, members);
  }
  return [...entries.entries()].map(([contextId, observations]) => ({
    contextId,
    observedAt: observations.reduce(
      (latest, observation) => (observation.observedAt > latest ? observation.observedAt : latest),
      observations[0].observedAt,
    ),
    observations,
  }));
}

/**
 * The latest result for EVERY formula output this athlete has, one row per
 * (formula_id, output_key).
 *
 * `listActiveFormulaResults` above answers a different question and is kept
 * for the callers that want it: it orders by computed_at and takes the newest N
 * ROWS. Nothing in it is per-output, so a formula that recomputes often buries
 * every formula that does not -- fifty recomputes of MVP-01 push MVP-05 off the
 * page, and the caller cannot tell that from MVP-05 having no value at all.
 * Raising the limit does not fix it; it only moves the number of recomputes
 * needed to hide something. `athleteIntelligence.pg.test.ts` measures the
 * difference on real rows rather than asserting it.
 *
 * The superseded-input exclusion is carried over verbatim: a result computed
 * from an observation that has since been corrected is not a current value.
 *
 * `limit` caps DISTINCT OUTPUTS, not rows -- the shape of the answer is one row
 * per output, so a cap on rows would be a cap on formulas.
 */
export async function listLatestFormulaResultsPerOutput(input: {
  organizationId: string;
  athleteId: string;
  formulaId?: FormulaId;
  limit?: number;
}): Promise<FormulaResult[]> {
  const limit = Math.max(1, Math.min(500, Math.trunc(input.limit ?? 200)));
  const rows = await query<PersistedFormulaResultRow>(
    `select distinct on (r.formula_id, r.output_key) r.*
     from pilot.shadow_formula_results r
     where r.organization_id = $1
       and r.athlete_id = $2
       and ($3::text is null or r.formula_id = $3)
       and not exists (
         select 1
         from unnest(r.input_observation_ids) input_id
         join pilot.shadow_formula_observations successor
           on successor.organization_id = r.organization_id
          and successor.supersedes_observation_id = input_id
       )
     -- distinct on keeps the FIRST row of each group, so the group key must
     -- lead the sort and recency must follow it. created_at and result_id are
     -- tie-breakers only: two rows with the same computed_at would otherwise
     -- resolve arbitrarily, and an arbitrary winner is an unreproducible read.
     order by r.formula_id, r.output_key, r.computed_at desc, r.created_at desc, r.result_id desc
     limit $4`,
    [input.organizationId, input.athleteId, input.formulaId ?? null, limit],
  );
  return rows.map(rowToFormulaResult);
}
