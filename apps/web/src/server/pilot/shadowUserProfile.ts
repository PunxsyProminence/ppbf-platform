import { query, queryOne } from './db';
import type { PilotRole } from './contracts';
import {
  type ContextCategory,
  type ShadowQueryType,
  type WeightedContextItem,
  calculateDynamicWeights,
  detectQueryType,
  scoreConfidence,
  selectTopContextItems,
} from './shadowContextWeights';

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

export interface ShadowUserContext {
  interactionCount: number;
  lastInteractionAt: string | null;
  recentTopics: string[];
  openQuestions: string[];
  rememberedFacts: RememberedFact[];
  communicationStyle: CommunicationStyle;
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

// Build role+query-aware context string for LLM prompt injection
export function buildUserShadowContext(
  profile: ShadowUserProfileRow,
  userQuery = '',
): string {
  const role = profile.role;
  const queryType: ShadowQueryType = detectQueryType(userQuery);
  const weights = calculateDynamicWeights(role, queryType);
  const now = new Date();

  const items: WeightedContextItem[] = [];

  const push = (
    category: ContextCategory,
    content: string,
    initialConfidence: number,
    timestamp?: Date,
    sourceType?: 'verified_pattern' | 'observation' | 'profile' | 'raw_data',
  ) => {
    const confidence = scoreConfidence(category, initialConfidence, timestamp, sourceType);
    const weight = weights[category] ?? 0;
    items.push({ category, content, weight, confidence, priority: weight * confidence, timestamp });
  };

  // ── Role framing ──────────────────────────────────────────────────────────
  const roleFraming: Partial<Record<PilotRole, string>> = {
    coach:              'Responding to a COACH. Prioritize: actionable recommendations, athlete patterns, program effectiveness, practical next steps.',
    athlete:            'Responding to an ATHLETE. Prioritize: education, mindset, personal clarity, encouragement. Keep it simple and direct.',
    organization_admin: 'Responding to an ADMIN. Prioritize: organizational patterns, compliance trends, research requirements, strategic insights.',
    admin:              'Responding to an ADMIN. Prioritize: organizational patterns, compliance trends, research requirements, strategic insights.',
    parent:             'Responding to a PARENT. Prioritize: safety transparency, child progress, how to support their athlete. No jargon.',
    volunteer:          'Responding to a VOLUNTEER. Prioritize: role clarity, safety awareness, how to contribute effectively.',
  };
  const framing = roleFraming[role];
  if (framing) push('role_framing', framing, 1.0, now, 'profile');

  // ── Communication style ───────────────────────────────────────────────────
  if (profile.communication_style !== 'unknown') {
    const styleMap: Record<CommunicationStyle, string> = {
      concise:        'Preference: concise, action-focused answers.',
      detailed:       'Preference: detailed explanations with full reasoning.',
      'example-heavy':'Preference: concrete examples over abstract theory.',
      unknown:        '',
    };
    const hint = styleMap[profile.communication_style];
    if (hint) push('communication_style', hint, 0.85, undefined, 'profile');
  }

  // ── Remembered facts — role-filtered, confidence-decayed ─────────────────
  const allFacts = (profile.remembered_facts || []).filter(f => f.confidence >= 0.5);
  const roleFacts = role === 'coach'
    ? allFacts.filter(f => f.key.includes('athlete') || f.key.includes('program') || f.key.includes('team'))
    : (() => role === 'athlete'
        ? allFacts.filter(f => !f.key.startsWith('org_') && !f.key.startsWith('program_'))
        : allFacts
      )();

  if (roleFacts.length > 0) {
    const topFacts = roleFacts
      .map(f => ({ ...f, decayed: scoreConfidence('remembered_facts', f.confidence, f.updatedAt ? new Date(f.updatedAt) : undefined) }))
      .sort((a, b) => b.decayed - a.decayed)
      .slice(0, 4);
    const facts = topFacts.map(f => `-  ${f.key}: ${f.value}`);
    const factsText = `Known:\n${facts.join('\n')}`;
    const avgConf = topFacts.reduce((s, f) => s + f.decayed, 0) / topFacts.length;
    push('remembered_facts', factsText, avgConf, undefined, 'observation');
  }

  // ── Open questions ────────────────────────────────────────────────────────
  const openQ = profile.open_questions.slice(-2);
  if (openQ.length > 0) {
    const openQList = openQ.map(q => `- ${q}`).join('\n');
    push('open_questions', `Unresolved:\n${openQList}`, 0.70);
  }

  // ── Recent topics ─────────────────────────────────────────────────────────
  if (profile.interaction_count > 1 && profile.recent_topics.length > 0) {
    const topics = profile.recent_topics.slice(-3).join(', ');
    const label = role === 'coach'
      ? `Coach's recent focus: ${topics}.`
      : (() => role === 'athlete'
          ? `What this athlete has been working on: ${topics}.`
          : `Recent topics: ${topics}.`
        )();
    push('org_patterns', label, 0.60);
  }

  const selected = selectTopContextItems(items, 6);
  if (selected.length === 0) return '';
  return `\nUSER CONTEXT:\n${selected.map(i => i.content).join('\n')}`;
}


// Get lightweight context for prompt injection (no DB write)
export async function getShadowUserContext(
  accountId: string,
  organizationId: string,
  role: PilotRole,
): Promise<ShadowUserContext> {
  const profile = await getOrCreateShadowUserProfile(accountId, organizationId, role);
  return {
    interactionCount: profile.interaction_count,
    lastInteractionAt: profile.last_interaction_at,
    recentTopics: profile.recent_topics,
    openQuestions: profile.open_questions,
    rememberedFacts: profile.remembered_facts || [],
    communicationStyle: profile.communication_style,
  };
}
