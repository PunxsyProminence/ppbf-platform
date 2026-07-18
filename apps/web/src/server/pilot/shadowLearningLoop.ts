// shadowLearningLoop.ts — Learning Loop + The Playbook Updates
// Connects recommendation outcomes → Growth Metrics → SHADOW Library → Scout Reports.
// This is how SHADOW improves over time: each interaction informs future advice.

import { query, queryOne } from './db';
import type { PilotRole } from './contracts';
import { recordRecommendationEffectiveness } from './shadowMetrics';
import { upsertRememberedFact } from './shadowUserProfile';

// ─── Types ────────────────────────────────────────────────────────────────────

export type OutcomeSignal =
  | 'thumbs_up'           // User explicitly liked the response
  | 'thumbs_down'         // User explicitly disliked
  | 'followed_advice'     // User reported they followed the suggestion
  | 'ignored_advice'      // User indicated advice wasn't applied
  | 'asked_followup'      // User asked a follow-up (engagement signal)
  | 'session_ended'       // Session ended without follow-up (neutral)
  | 'escalated_to_human'; // User escalated — SHADOW wasn't sufficient

export interface LearningSignal {
  messageId: string;
  userId: string;
  organizationId: string;
  role: PilotRole;
  topic: string;
  sessionType: string;
  outcome: OutcomeSignal;
  responseText?: string;
  userNote?: string;
}

export interface LearningLoopResult {
  profileUpdated: boolean;
  metricsRecorded: boolean;
  libraryFlagged: boolean;
  factsExtracted: number;
  actions: string[];
}

// ─── Main Learning Loop ───────────────────────────────────────────────────────

/**
 * Process an outcome signal through the full learning loop.
 *
 * Flow:
 *   Signal → Effectiveness Score → Profile Facts → Library Flag → Metrics
 */
export async function processLearningSignal(
  signal: LearningSignal,
): Promise<LearningLoopResult> {
  const actions: string[] = [];
  let profileUpdated = false;
  let metricsRecorded = false;
  let libraryFlagged = false;
  let factsExtracted = 0;

  const effectivenessScore = outcomeToScore(signal.outcome);
  const outcome = outcomeToCategory(signal.outcome);

  // ── Step 1: Record effectiveness metrics ─────────────────────────────────
  try {
    await recordRecommendationEffectiveness({
      organizationId: signal.organizationId,
      userId: signal.userId,
      role: signal.role,
      recommendationId: signal.messageId,
      outcome,
      effectivenessScore,
    });
    metricsRecorded = true;
    actions.push(`Effectiveness recorded: ${outcome} (${effectivenessScore})`);
  } catch (err) {
    actions.push(`Metrics failed: ${err}`);
  }

  // ── Step 2: Extract profile facts from positive outcomes ─────────────────
  if (['thumbs_up', 'followed_advice', 'asked_followup'].includes(signal.outcome)) {
    try {
      const extracted = await extractAndStoreFacts(signal);
      factsExtracted = extracted;
      if (extracted > 0) {
        profileUpdated = true;
        actions.push(`Extracted ${extracted} fact(s) from positive signal`);
      }
    } catch (err) {
      actions.push(`Fact extraction failed: ${err}`);
    }
  }

  // ── Step 3: Flag library entries for review on negative outcomes ──────────
  if (['thumbs_down', 'escalated_to_human'].includes(signal.outcome)) {
    try {
      await flagLibraryEntryForReview(signal);
      libraryFlagged = true;
      actions.push(`Library entry flagged for review (topic: ${signal.topic})`);
    } catch (err) {
      actions.push(`Library flag failed: ${err}`);
    }
  }

  // ── Step 3.5: Auto-promote/demote library entries based on effectiveness ──
  if (metricsRecorded) {
    try {
      const action = await promoteOrDemoteLibraryEntry(
        signal.organizationId,
        signal.topic,
        effectivenessScore,
      );
      if (action) {
        actions.push(action);
      }
    } catch (err) {
      actions.push(`Library promotion/demotion skipped: ${err}`);
    }
  }

  // ── Step 4: Update communication style preference ─────────────────────────
  if (signal.outcome === 'thumbs_up' && signal.responseText) {
    try {
      await inferCommunicationPreference(signal);
      actions.push('Communication preference updated');
    } catch (err) {
      actions.push(`Style update skipped: ${err}`);
    }
  }

  // ── Step 5: Log the learning event ───────────────────────────────────────
  try {
    await logLearningEvent(signal, effectivenessScore, actions);
  } catch {
    // Non-critical — don't fail the whole loop
  }

  return { profileUpdated, metricsRecorded, libraryFlagged, factsExtracted, actions };
}

// ─── Profile Fact Extraction ──────────────────────────────────────────────────

/**
 * Heuristically extract profile facts from positive outcome signals.
 * These become The Playbook entries for this specific user.
 */
async function extractAndStoreFacts(signal: LearningSignal): Promise<number> {
  const factsToStore: Array<{ key: string; value: string; confidence: number }> = [];

  // Topic preference: user engaged positively with this topic
  if (signal.topic && signal.topic !== 'general') {
    factsToStore.push({
      key: `engaged_topic_${signal.topic}`,
      value: 'true',
      confidence: signal.outcome === 'followed_advice' ? 0.8 : 0.6,
    });
  }

  // Session type preference: user used heavy bag or quick round successfully
  if (signal.sessionType === 'heavy_bag' && signal.outcome === 'thumbs_up') {
    factsToStore.push({
      key: 'prefers_deep_analysis',
      value: 'true',
      confidence: 0.75,
    });
  }

  // Follow-up questions = engagement pattern
  if (signal.outcome === 'asked_followup') {
    factsToStore.push({
      key: 'asks_follow_up_questions',
      value: 'true',
      confidence: 0.7,
    });
  }

  // Store all extracted facts
  for (const fact of factsToStore) {
    await upsertRememberedFact(signal.userId, signal.organizationId, fact);
  }

  return factsToStore.length;
}

// ─── Library Promotion/Demotion ──────────────────────────────────────────────

/**
 * Auto-promote library entries with >75% effectiveness, demote <40%.
 * Updates shadow_library_review_flags with promotion/demotion action.
 */
async function promoteOrDemoteLibraryEntry(
  organizationId: string,
  topic: string,
  effectivenessScore: number,
): Promise<string | null> {
  if (effectivenessScore >= 0.75) {
    // Promote: mark for promotion in library flags
    await query(
      `INSERT INTO pilot.shadow_library_review_flags (
         organization_id, topic, session_type, outcome_signal,
         flag_count, flagged_at
       ) VALUES ($1, $2, 'auto', 'promote', 1, NOW())
       ON CONFLICT (organization_id, topic)
       DO UPDATE SET
         flag_count = pilot.shadow_library_review_flags.flag_count + 1,
         last_flagged_at = NOW(),
         latest_outcome_signal = 'promote'`,
      [organizationId, topic],
    );
    return `Library entry promoted for topic '${topic}' (effectiveness: ${(effectivenessScore * 100).toFixed(0)}%)`;
  } else if (effectivenessScore < 0.4) {
    // Demote: mark for demotion
    await query(
      `INSERT INTO pilot.shadow_library_review_flags (
         organization_id, topic, session_type, outcome_signal,
         flag_count, flagged_at
       ) VALUES ($1, $2, 'auto', 'demote', 1, NOW())
       ON CONFLICT (organization_id, topic)
       DO UPDATE SET
         flag_count = pilot.shadow_library_review_flags.flag_count + 1,
         last_flagged_at = NOW(),
         latest_outcome_signal = 'demote'`,
      [organizationId, topic],
    );
    return `Library entry demoted for topic '${topic}' (effectiveness: ${(effectivenessScore * 100).toFixed(0)}%)`;
  }
  return null;
}

// ─── Library Flag ─────────────────────────────────────────────────────────────

async function flagLibraryEntryForReview(signal: LearningSignal): Promise<void> {
  await query(
    `INSERT INTO pilot.shadow_library_review_flags (
       organization_id, account_id, topic, session_type,
       outcome_signal, user_note, flagged_at
     ) VALUES ($1, $2, $3, $4, $5, $6, NOW())
     ON CONFLICT (organization_id, topic)
     DO UPDATE SET
       flag_count = pilot.shadow_library_review_flags.flag_count + 1,
       last_flagged_at = NOW(),
       latest_outcome_signal = $5`,
    [
      signal.organizationId,
      signal.userId,
      signal.topic,
      signal.sessionType,
      signal.outcome,
      signal.userNote ?? null,
    ],
  );
}

// ─── Communication Style Inference ───────────────────────────────────────────

async function inferCommunicationPreference(signal: LearningSignal): Promise<void> {
  if (!signal.responseText) return;

  const text = signal.responseText;
  const wordCount = text.split(/\s+/).length;
  const hasBullets = /^[-•*]/m.test(text);

  let detectedStyle: string | null = null;

  if (wordCount < 100 && !hasBullets) {
    detectedStyle = 'concise';
  } else if (hasBullets && wordCount > 150) {
    detectedStyle = 'detailed';
  } else if (/for example|e\.g\.|such as/i.test(text)) {
    detectedStyle = 'example-heavy';
  }

  if (detectedStyle) {
    await query(
      `UPDATE pilot.shadow_user_profiles
       SET communication_style = $3, updated_at = NOW()
       WHERE account_id = $1 AND organization_id = $2
         AND communication_style = 'unknown'`,
      [signal.userId, signal.organizationId, detectedStyle],
    );
  }
}

// ─── Learning Event Log ───────────────────────────────────────────────────────

async function logLearningEvent(
  signal: LearningSignal,
  score: number,
  actions: string[],
): Promise<void> {
  await query(
    `INSERT INTO pilot.shadow_learning_events (
       organization_id, account_id, role, message_id,
       topic, session_type, outcome_signal, effectiveness_score,
       actions_taken, created_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, NOW())`,
    [
      signal.organizationId,
      signal.userId,
      signal.role,
      signal.messageId,
      signal.topic,
      signal.sessionType,
      signal.outcome,
      score,
      JSON.stringify(actions),
    ],
  );
}

// ─── Scorecard (Growth Metrics Summary) ──────────────────────────────────────

export interface ShadowScorecard {
  organizationId: string;
  period: string;
  totalInteractions: number;
  positiveOutcomes: number;
  negativeOutcomes: number;
  positiveRate: number;        // 0–1
  factsExtracted: number;
  libraryFlagsRaised: number;
  topEngagedTopics: string[];
  profilesAtGold: number;
  profilesAtSilver: number;
  profilesAtBronze: number;
}

export async function getScorecard(
  organizationId: string,
  days = 30,
): Promise<ShadowScorecard> {
  const [events, topTopics, profiles] = await Promise.all([
    queryOne<{
      total: number;
      positive: number;
      negative: number;
      facts_extracted: number;
    }>(
      `SELECT
         COUNT(*) AS total,
         COUNT(*) FILTER (WHERE outcome_signal IN ('thumbs_up', 'followed_advice', 'asked_followup')) AS positive,
         COUNT(*) FILTER (WHERE outcome_signal IN ('thumbs_down', 'escalated_to_human')) AS negative,
         COALESCE(SUM((actions_taken::jsonb)->>'factsExtracted')::int, 0) AS facts_extracted
       FROM pilot.shadow_learning_events
       WHERE organization_id = $1
         AND created_at > NOW() - INTERVAL '${days} days'`,
      [organizationId],
    ),
    query<{ topic: string; count: number }>(
      `SELECT topic, COUNT(*) AS count
       FROM pilot.shadow_learning_events
       WHERE organization_id = $1
         AND created_at > NOW() - INTERVAL '${days} days'
       GROUP BY topic
       ORDER BY count DESC
       LIMIT 5`,
      [organizationId],
    ),
    queryOne<{ gold: number; silver: number; bronze: number }>(
      `SELECT
         COUNT(*) FILTER (WHERE interaction_count >= 50) AS gold,
         COUNT(*) FILTER (WHERE interaction_count >= 20 AND interaction_count < 50) AS silver,
         COUNT(*) FILTER (WHERE interaction_count < 20) AS bronze
       FROM pilot.shadow_user_profiles
       WHERE organization_id = $1`,
      [organizationId],
    ),
  ]);

  const total = events?.total ?? 0;
  const positive = events?.positive ?? 0;
  const negative = events?.negative ?? 0;

  return {
    organizationId,
    period: `Last ${days} days`,
    totalInteractions: total,
    positiveOutcomes: positive,
    negativeOutcomes: negative,
    positiveRate: total > 0 ? positive / total : 0,
    factsExtracted: events?.facts_extracted ?? 0,
    libraryFlagsRaised: 0, // TODO: query shadow_library_review_flags
    topEngagedTopics: topTopics.map((r) => r.topic),
    profilesAtGold: profiles?.gold ?? 0,
    profilesAtSilver: profiles?.silver ?? 0,
    profilesAtBronze: profiles?.bronze ?? 0,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function outcomeToScore(signal: OutcomeSignal): number {
  const scores: Record<OutcomeSignal, number> = {
    thumbs_up: 1.0,
    followed_advice: 0.9,
    asked_followup: 0.7,
    session_ended: 0.5,
    ignored_advice: 0.3,
    thumbs_down: 0.1,
    escalated_to_human: 0.0,
  };
  return scores[signal] ?? 0.5;
}

function outcomeToCategory(signal: OutcomeSignal): 'improved' | 'neutral' | 'degraded' | 'unknown' {
  if (['thumbs_up', 'followed_advice'].includes(signal)) return 'improved';
  if (['thumbs_down', 'escalated_to_human'].includes(signal)) return 'degraded';
  if (['asked_followup', 'session_ended'].includes(signal)) return 'neutral';
  return 'unknown';
}

// ─── DB Migration SQL ─────────────────────────────────────────────────────────

export const LEARNING_LOOP_MIGRATION = `
CREATE TABLE IF NOT EXISTS pilot.shadow_learning_events (
  event_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   TEXT NOT NULL,
  account_id        TEXT NOT NULL,
  role              TEXT NOT NULL,
  message_id        TEXT,
  topic             TEXT NOT NULL DEFAULT 'general',
  session_type      TEXT NOT NULL DEFAULT 'quick_round',
  outcome_signal    TEXT NOT NULL,
  effectiveness_score NUMERIC(4,3),
  actions_taken     JSONB NOT NULL DEFAULT '[]',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_learning_events_org_date
  ON pilot.shadow_learning_events (organization_id, created_at DESC);

CREATE TABLE IF NOT EXISTS pilot.shadow_library_review_flags (
  flag_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   TEXT NOT NULL,
  account_id        TEXT NOT NULL,
  topic             TEXT NOT NULL,
  session_type      TEXT,
  outcome_signal    TEXT,
  user_note         TEXT,
  flag_count        INTEGER NOT NULL DEFAULT 1,
  flagged_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_flagged_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  latest_outcome_signal TEXT,
  UNIQUE (organization_id, topic)
);
`;
