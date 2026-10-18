import { query, withTransaction } from './db';
import { ValidationError } from './errors';
import {
  assertAthleteLessonPolicy,
  assertPatternFormationPolicy,
  type AthleteLessonPolicy,
  type PatternFormationPolicy,
} from './patterns';

// The bars the learning loop's evaluators read (lane L49): when a repeated
// behaviour may be called a pattern, and when a reviewed intervention may be
// called a lesson about one athlete. Jason 2026-10-18 Q3, "Needs to be backed
// by research": a bar is stored only with the sources it rests on, and this
// module ships NO numbers -- the patterns library refuses to invent one
// (patterns/policy.ts), and so does this. Ratifying is a gym admin's act, the
// working default until Overwatch confirms it with Jason; each version keeps
// who signed which numbers, when, on what evidence, and a new version
// supersedes the last rather than editing it.

export const POLICY_KINDS = ['pattern_formation', 'athlete_lesson'] as const;
export type PolicyKind = (typeof POLICY_KINDS)[number];

/** The parameters a ratified bar carries, by kind: the library policy minus who, when and which version. */
const PARAMETER_FIELDS: Record<PolicyKind, readonly string[]> = {
  pattern_formation: [
    'minimumOccurrences', 'minimumDistinctSessions', 'minimumDistinctTaskContexts', 'minimumDistinctObservers',
    'requireHumanObservation', 'requireConstraintSpan', 'requireFatigueDiversity', 'requireVideoCorroboration',
    'counterEvidenceContestRatio', 'minimumAthleteAttributionShare', 'evidenceStaleAfterDays',
    'minimumObservationSpanDays',
  ] satisfies readonly (keyof PatternFormationPolicy)[],
  athlete_lesson: [
    'minimumTransferContexts', 'retentionWindowDays', 'minimumRetentionObservations',
    'requireHumanReviewedOutcome', 'acceptedMatchStates',
  ] satisfies readonly (keyof AthleteLessonPolicy)[],
};

export interface Citation {
  source: string;
  note?: string;
}

export interface LearningPolicyRow {
  policy_id: string;
  policy_kind: PolicyKind;
  version: number;
  parameters: Record<string, unknown>;
  citations: Citation[];
  ratified_by_account_id: string;
  ratified_by_role: string;
  ratified_at: string;
  status: 'active' | 'superseded';
  supersedes_policy_id: string | null;
}

const MAX_CITATIONS = 20;

/** The cited sources, each naming one; refused with the reason otherwise. */
export function citationsFrom(raw: unknown): Citation[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ValidationError('A bar needs at least one cited source.');
  }
  if (raw.length > MAX_CITATIONS) throw new ValidationError(`A bar cites at most ${MAX_CITATIONS} sources.`);
  return raw.map((item) => {
    const source = typeof item?.source === 'string' ? item.source.trim() : '';
    if (!source || source.length > 500) {
      throw new ValidationError('Each citation names its source, in at most 500 characters.');
    }
    if (item.note !== undefined && (typeof item.note !== 'string' || item.note.length > 1000)) {
      throw new ValidationError('A citation note is text of at most 1000 characters.');
    }
    return item.note ? { source, note: item.note.trim() } : { source };
  });
}

/**
 * Exactly the kind's fields, checked by the library's own coherence rules
 * (assertPatternFormationPolicy / assertAthleteLessonPolicy) against the
 * version, signer and time they will be stored under.
 */
export function parametersFor(
  kind: PolicyKind,
  raw: unknown,
  stamp: { policyVersion: string; ratifiedByAccountId: string; ratifiedAt: string },
): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ValidationError('A bar\'s parameters are an object.');
  }
  const fields = PARAMETER_FIELDS[kind];
  const given = Object.keys(raw as Record<string, unknown>);
  const unknown = given.filter((key) => !fields.includes(key));
  const missing = fields.filter((key) => !given.includes(key));
  if (unknown.length > 0 || missing.length > 0) {
    throw new ValidationError(
      `A ${kind} bar carries exactly: ${fields.join(', ')}.`
      + (missing.length > 0 ? ` Missing: ${missing.join(', ')}.` : '')
      + (unknown.length > 0 ? ` Not a field: ${unknown.join(', ')}.` : ''),
    );
  }
  const parameters = Object.fromEntries(fields.map((key) => [key, (raw as Record<string, unknown>)[key]]));
  try {
    if (kind === 'pattern_formation') {
      assertPatternFormationPolicy({ ...stamp, ...parameters } as unknown as PatternFormationPolicy);
    } else {
      assertAthleteLessonPolicy({ ...stamp, ...parameters } as unknown as AthleteLessonPolicy);
    }
  } catch (error) {
    if (error instanceof TypeError) throw new ValidationError(error.message);
    throw error;
  }
  return parameters;
}

const FIELDS = `policy_id, policy_kind, version, parameters, citations, ratified_by_account_id, ratified_by_role,
  ratified_at, status, supersedes_policy_id`;

/** Every version of every bar this gym has ratified, newest first per kind. */
export async function listLearningPolicies(organizationId: string): Promise<LearningPolicyRow[]> {
  return query<LearningPolicyRow>(
    `select ${FIELDS} from pilot.learning_policies
      where organization_id = $1
      order by policy_kind, version desc`,
    [organizationId],
  );
}

export async function ratifyLearningPolicy(input: {
  organizationId: string;
  kind: string;
  parameters: unknown;
  citations: unknown;
  ratifiedByAccountId: string;
  ratifiedByRole: string;
}): Promise<LearningPolicyRow> {
  if (!(POLICY_KINDS as readonly string[]).includes(input.kind)) {
    throw new ValidationError(`kind must be one of: ${POLICY_KINDS.join(', ')}.`);
  }
  const kind = input.kind as PolicyKind;
  const citations = citationsFrom(input.citations);
  try {
    return await withTransaction(async (client) => {
      // The latest version of this kind, locked: two admins saving at once
      // cannot both build on it.
      const latest = await client.query<{ policy_id: string; version: number; status: string }>(
        `select policy_id, version, status from pilot.learning_policies
          where organization_id = $1 and policy_kind = $2
          order by version desc limit 1
          for update`,
        [input.organizationId, kind],
      );
      const previous = latest.rows[0] ?? null;
      const version = (previous?.version ?? 0) + 1;
      const ratifiedAt = new Date().toISOString();
      const parameters = parametersFor(kind, input.parameters, {
        policyVersion: String(version),
        ratifiedByAccountId: input.ratifiedByAccountId,
        ratifiedAt,
      });
      if (previous?.status === 'active') {
        await client.query(
          `update pilot.learning_policies set status = 'superseded'
            where organization_id = $1 and policy_id = $2 and status = 'active'`,
          [input.organizationId, previous.policy_id],
        );
      }
      const inserted = await client.query<LearningPolicyRow>(
        `insert into pilot.learning_policies
           (organization_id, policy_kind, version, parameters, citations, ratified_by_account_id,
            ratified_by_role, ratified_at, supersedes_policy_id)
         values ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, $9)
         returning ${FIELDS}`,
        [
          input.organizationId, kind, version, JSON.stringify(parameters), JSON.stringify(citations),
          input.ratifiedByAccountId, input.ratifiedByRole, ratifiedAt, previous?.policy_id ?? null,
        ],
      );
      return inserted.rows[0];
    });
  } catch (error) {
    const pgError = error as { code?: string; constraint?: string };
    if (pgError.code === '23505') {
      throw new ValidationError('The bar was just changed by someone else. Reload and try again.');
    }
    if (pgError.code === '23514' && pgError.constraint === 'pilot_learning_policies_ratifier_of_this_gym') {
      throw new ValidationError('Only an admin of this gym can ratify a bar.');
    }
    if (pgError.code === '23514' && pgError.constraint === 'pilot_learning_policies_citation_source') {
      throw new ValidationError('Each citation names its source.');
    }
    throw error;
  }
}
