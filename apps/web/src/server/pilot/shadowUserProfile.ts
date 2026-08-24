import { query, queryOne } from './db';
import type { PilotRole } from './contracts';

export interface RememberedFact {
  key: string;      // e.g. "prefers_concise_answers", "coaches_welterweights"
  value: string;    // e.g. "true", "3 athletes: A, B, C"
  /**
   * A HAND-PICKED HEURISTIC WEIGHT. NOT A PROBABILITY, NOT A CONFIDENCE.
   *
   * The values are 0.6, 0.7, 0.75 and 0.8, chosen by a developer writing a
   * switch statement in shadowLearningLoop.ts. Nothing was measured, nothing
   * was calibrated, and there is no event whose frequency they estimate. Until
   * 2026-08-23 they were rendered into model prompts as "confidence: 80%",
   * which stated a calibrated probability that has never existed.
   *
   * It is retained as an internal sort key only -- it decides which facts
   * survive the 20-fact prune -- and it is NEVER rendered. `observationCount`
   * is what gets described, through `describeFactSupport`. The stored key name
   * is kept because renaming it would mean rewriting every persisted jsonb row,
   * and a misleading field name is a smaller problem than a data rewrite.
   */
  confidence: number;
  /**
   * How many separate positive signals produced this fact.
   *
   * This is the honest support: a thing that happened once, counted once. It is
   * what a reader sees, and it is what stops a single thumbs-up reading like an
   * established trait. Absent on rows written before 2026-08-23; those are read
   * as a single observation, which is all their contents evidence.
   */
  observationCount?: number;
  /** First time this fact was observed. Absent on pre-2026-08-23 rows. */
  firstObservedAt?: string;
  updatedAt: string;
}

export type CommunicationStyle = 'concise' | 'detailed' | 'example-heavy' | 'unknown';

export interface ShadowUserProfileRow {
  profile_id: number;
  account_id: string;
  organization_id: string;
  role: PilotRole;
  interaction_count: number;
  last_interaction_at: string | null;
  recent_topics: string[];             // Last 10 topic areas discussed
  athlete_ids_discussed: string[];     // Coaches: athletes discussed recently
  // open_questions and shadow_notes are still selected and still on the row so
  // the type matches the table, but nothing writes them and nothing reads them
  // into a prompt any more. Both were advertised profile factors with no
  // production writer: profiles are born empty/null and stayed that way, so the
  // prompt sections they fed ("Unresolved Questions", "Unresolved Items",
  // "Open Questions to Address When Relevant", "Context Notes") rendered for
  // nobody, and the tier/completeness scores that counted them were capped
  // below their advertised maximum. The columns are kept so building the
  // feature later needs no migration -- but a writer has to arrive with its
  // reader, not before it.
  open_questions: string[];            // Retained column; no writer, no reader
  remembered_facts: RememberedFact[];  // Key-value intelligence about this user
  communication_style: CommunicationStyle; // How this user prefers responses
  shadow_notes: string | null;         // Retained column; no writer, no reader
  created_at: string;
  updated_at: string;
}

// Get or create a user's shadow profile
export async function getOrCreateShadowUserProfile(
  accountId: string,
  organizationId: string,
  role: PilotRole,
): Promise<ShadowUserProfileRow> {
  const created = await queryOne<ShadowUserProfileRow>(
    `INSERT INTO pilot.shadow_user_profiles
       (account_id, organization_id, role, interaction_count,
         recent_topics, athlete_ids_discussed, open_questions,
         remembered_facts, communication_style,
         created_at, updated_at)
      VALUES ($1, $2, $3, 0, '{}', '{}', '{}', '[]'::jsonb, 'unknown', NOW(), NOW())
      ON CONFLICT (account_id, organization_id)
      DO UPDATE SET
        role = EXCLUDED.role,
        updated_at = CASE
          WHEN pilot.shadow_user_profiles.role IS DISTINCT FROM EXCLUDED.role
          THEN NOW()
          ELSE pilot.shadow_user_profiles.updated_at
        END
      RETURNING *`,
    [accountId, organizationId, role],
  );

  if (!created) throw new Error('Failed to create shadow user profile');
  return created;
}

/**
 * Record one observation of a fact about this user.
 *
 * REPEAT OBSERVATIONS ACCUMULATE. This used to overwrite the stored row
 * wholesale, so seeing the same signal a second time changed nothing: one
 * thumbs-up and fifty thumbs-up produced an identical row, and the fact was
 * described to the model in identical terms. A single click became a permanent
 * statement about a person, indistinguishable from a settled pattern.
 *
 * Now each observation increments a count, and it is the count that gets
 * described (`describeFactSupport`). The first observation reads as a single
 * observation, because that is what it is.
 *
 * `firstObservedAt` is preserved across updates; `updatedAt` moves. A fact that
 * has not been seen again is therefore visible as stale to anything that later
 * wants to expire one -- and `forgetRememberedFact` is how it goes away.
 */
export async function upsertRememberedFact(
  accountId: string,
  organizationId: string,
  fact: Omit<RememberedFact, 'updatedAt' | 'observationCount' | 'firstObservedAt'>,
): Promise<void> {
  const profile = await queryOne<{ remembered_facts: RememberedFact[] }>(
    `SELECT remembered_facts FROM pilot.shadow_user_profiles
     WHERE account_id = $1 AND organization_id = $2`,
    [accountId, organizationId],
  );

  if (!profile) return;

  const existing = profile.remembered_facts || [];
  const idx = existing.findIndex(f => f.key === fact.key);
  const now = new Date().toISOString();
  const previous = idx >= 0 ? existing[idx] : undefined;

  const updated: RememberedFact = {
    ...fact,
    // A row written before counting existed evidences one observation; this one
    // makes two. Absent means one, never zero -- the fact is on the row because
    // something was seen.
    observationCount: (previous?.observationCount ?? (previous ? 1 : 0)) + 1,
    firstObservedAt: previous?.firstObservedAt ?? now,
    updatedAt: now,
  };

  if (idx >= 0) {
    existing[idx] = updated;
  } else {
    existing.push(updated);
  }

  // Keep 20 facts. Most-observed first, heuristic weight breaking ties -- the
  // weight alone used to decide this, which meant a 0.8 seen once outranked a
  // 0.6 seen forty times.
  const sorted = existing.toSorted((a, b) => {
    const observed = (b.observationCount ?? 1) - (a.observationCount ?? 1);
    return observed !== 0 ? observed : b.confidence - a.confidence;
  });
  const pruned = sorted
    .slice(0, 20);

  await query(
    `UPDATE pilot.shadow_user_profiles
     SET remembered_facts = $3::jsonb, updated_at = NOW()
     WHERE account_id = $1 AND organization_id = $2`,
    [accountId, organizationId, JSON.stringify(pruned)],
  );
}

/**
 * Remove one remembered fact, or every remembered fact, for this user.
 *
 * A PREFERENCE HAS TO BE REVISABLE. Without this there was no code path in the
 * platform that could un-remember anything: facts were written by the learning
 * loop and lived until the row was deleted. That is a permanent profile
 * identity assembled from clicks, and for an account that may belong to a
 * child, it is the wrong default in both directions -- they cannot correct it
 * and nobody can correct it for them.
 *
 * Returns the number of facts removed. Omit `key` to clear all of them.
 */
export async function forgetRememberedFact(
  accountId: string,
  organizationId: string,
  key?: string,
): Promise<number> {
  const profile = await queryOne<{ remembered_facts: RememberedFact[] }>(
    `SELECT remembered_facts FROM pilot.shadow_user_profiles
     WHERE account_id = $1 AND organization_id = $2`,
    [accountId, organizationId],
  );

  if (!profile) return 0;

  const existing = profile.remembered_facts || [];
  const kept = key === undefined ? [] : existing.filter((f) => f.key !== key);
  const removed = existing.length - kept.length;

  if (removed === 0) return 0;

  await query(
    `UPDATE pilot.shadow_user_profiles
     SET remembered_facts = $3::jsonb, updated_at = NOW()
     WHERE account_id = $1 AND organization_id = $2`,
    [accountId, organizationId, JSON.stringify(kept)],
  );

  return removed;
}

// Update communication style based on feedback patterns
export async function updateCommunicationStyle(
  accountId: string,
  organizationId: string,
  style: CommunicationStyle,
): Promise<void> {
  await query(
    `UPDATE pilot.shadow_user_profiles
     SET communication_style = $3, updated_at = NOW()
     WHERE account_id = $1 AND organization_id = $2`,
    [accountId, organizationId, style],
  );
}

// Record a new interaction and update the profile
export async function updateShadowUserProfile(
  accountId: string,
  organizationId: string,
  update: {
    topicAdded?: string;
    athleteIdDiscussed?: string;
  },
): Promise<void> {
  // Append topic to recent_topics (keep last 10)
  if (update.topicAdded) {
    await query(
      `UPDATE pilot.shadow_user_profiles
       SET recent_topics = (
          SELECT COALESCE(array_agg(topic ORDER BY last_ordinality), ARRAY[]::text[])
          FROM (
            SELECT topic, MAX(ordinality) AS last_ordinality
            FROM unnest(array_append(recent_topics, $3)) WITH ORDINALITY AS expanded(topic, ordinality)
            GROUP BY topic
            ORDER BY MAX(ordinality) DESC
            LIMIT 10
          ) recent
       ),
       interaction_count = interaction_count + 1,
       last_interaction_at = NOW(),
       updated_at = NOW()
       WHERE account_id = $1 AND organization_id = $2`,
      [accountId, organizationId, update.topicAdded],
    );
  } else {
    await query(
      `UPDATE pilot.shadow_user_profiles
       SET interaction_count = interaction_count + 1,
           last_interaction_at = NOW(),
           updated_at = NOW()
       WHERE account_id = $1 AND organization_id = $2`,
      [accountId, organizationId],
    );
  }

  // Track athlete discussed (coaches only, keep last 20)
  if (update.athleteIdDiscussed) {
    await query(
      `UPDATE pilot.shadow_user_profiles
       SET athlete_ids_discussed = (
          SELECT COALESCE(array_agg(athlete_id ORDER BY last_ordinality), ARRAY[]::text[])
          FROM (
            SELECT athlete_id, MAX(ordinality) AS last_ordinality
            FROM unnest(array_append(athlete_ids_discussed, $3)) WITH ORDINALITY
              AS expanded(athlete_id, ordinality)
            GROUP BY athlete_id
            ORDER BY MAX(ordinality) DESC
            LIMIT 20
          ) recent
       ),
       updated_at = NOW()
       WHERE account_id = $1 AND organization_id = $2`,
      [accountId, organizationId, update.athleteIdDiscussed],
    );
  }

}

// buildUserShadowContext and getShadowUserContext lived here: a complete
// role/query-weighted context assembler and its lightweight sibling, neither
// with a single caller anywhere in the tree. Deleted with the weighting
// system that fed them (audit 2026-07-31 finding F8; owner decision --
// git history keeps both). Real prompt context comes from
// shadowContextBuilder.
