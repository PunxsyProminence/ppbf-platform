import { query, queryOne } from './db';
import type { PilotRole } from './contracts';

export interface RememberedFact {
  key: string;      // e.g. "prefers_concise_answers", "coaches_welterweights"
  value: string;    // e.g. "true", "3 athletes: A, B, C"
  confidence: number; // 0-1, how reliable this fact is
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
  open_questions: string[];            // Unresolved questions this user has raised
  remembered_facts: RememberedFact[];  // Key-value intelligence about this user
  communication_style: CommunicationStyle; // How this user prefers responses
  shadow_notes: string | null;         // Free-form accumulated observations
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

// Add or update a remembered fact for this user
export async function upsertRememberedFact(
  accountId: string,
  organizationId: string,
  fact: Omit<RememberedFact, 'updatedAt'>,
): Promise<void> {
  const profile = await queryOne<{ remembered_facts: RememberedFact[] }>(
    `SELECT remembered_facts FROM pilot.shadow_user_profiles
     WHERE account_id = $1 AND organization_id = $2`,
    [accountId, organizationId],
  );

  if (!profile) return;

  const existing = profile.remembered_facts || [];
  const idx = existing.findIndex(f => f.key === fact.key);
  const updated: RememberedFact = { ...fact, updatedAt: new Date().toISOString() };

  if (idx >= 0) {
    existing[idx] = updated;
  } else {
    existing.push(updated);
  }

  // Keep only top 20 highest-confidence facts
  const sorted = existing.toSorted((a, b) => b.confidence - a.confidence);
  const pruned = sorted
    .slice(0, 20);

  await query(
    `UPDATE pilot.shadow_user_profiles
     SET remembered_facts = $3::jsonb, updated_at = NOW()
     WHERE account_id = $1 AND organization_id = $2`,
    [accountId, organizationId, JSON.stringify(pruned)],
  );
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
    questionRaised?: string;
    questionResolved?: string;
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

  // Track open question
  if (update.questionRaised) {
    await query(
      `UPDATE pilot.shadow_user_profiles
       SET open_questions = array_append(open_questions, $3),
           updated_at = NOW()
       WHERE account_id = $1 AND organization_id = $2`,
      [accountId, organizationId, update.questionRaised],
    );
  }

  // Remove resolved question
  if (update.questionResolved) {
    await query(
      `UPDATE pilot.shadow_user_profiles
       SET open_questions = array_remove(open_questions, $3),
           updated_at = NOW()
       WHERE account_id = $1 AND organization_id = $2`,
      [accountId, organizationId, update.questionResolved],
    );
  }
}

// buildUserShadowContext and getShadowUserContext lived here: a complete
// role/query-weighted context assembler and its lightweight sibling, neither
// with a single caller anywhere in the tree. Deleted with the weighting
// system that fed them (audit 2026-07-31 finding F8; owner decision --
// git history keeps both). Real prompt context comes from
// shadowContextBuilder.
