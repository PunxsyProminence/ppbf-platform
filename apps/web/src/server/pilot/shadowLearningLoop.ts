// shadowLearningLoop.ts — Learning Loop + The Playbook Updates
// Connects recommendation outcomes → Growth Metrics → SHADOW Library → Scout Reports.
// This is how SHADOW improves over time: each interaction informs future advice.

import { query, queryOne } from './db';
import type { PilotRole } from './contracts';
import { recordRecommendationEffectiveness } from './shadowMetrics';
import { upsertRememberedFact } from './shadowUserProfile';
import { createShadowResearchRequirement } from './shadowResearch';
import { evaluateShadowUnlockState, isFeatureEnabled, type ShadowUnlockState } from './shadowUnlocks';

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
  feedbackId: number;
  shadowEventId?: number | null;
  messageId: string;
  userId: string;
  organizationId: string;
  role: PilotRole;
  topic: string;
  sessionType: string;
  outcome: OutcomeSignal;
  responseText?: string;
  userNote?: string;
  verificationState: 'unverified' | 'durable_client' | 'human_reviewed';
}

export interface LearningLoopResult {
  profileUpdated: boolean;
  metricsRecorded: boolean;
  libraryFlagged: boolean;
  factsExtracted: number;
  humanReviewRequired: boolean;
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
  if (
    !Number.isSafeInteger(signal.feedbackId)
    || signal.feedbackId <= 0
    || !signal.messageId.trim()
    || signal.verificationState === 'unverified'
  ) {
    actions.push('Learning rejected: durable correlation and verified feedback are required');
    await safeLogLearningEvent(signal, null, actions);
    return {
      profileUpdated: false,
      metricsRecorded: false,
      libraryFlagged: false,
      factsExtracted: 0,
      humanReviewRequired: true,
      actions,
    };
  }

  const effectivenessScore = outcomeToScore(signal.outcome);
  const outcome = outcomeToCategory(signal.outcome);
  const metricsRecorded = await recordMetrics(signal, outcome, effectivenessScore, actions);

  if (signal.verificationState !== 'human_reviewed') {
    const libraryFlagged = await queueClientSignalForReview(signal, actions);
    await safeLogLearningEvent(signal, effectivenessScore, actions);
    return {
      profileUpdated: false,
      metricsRecorded,
      libraryFlagged,
      factsExtracted: 0,
      humanReviewRequired: true,
      actions,
    };
  }

  const unlockState = await loadUnlockState(signal, actions);
  const positiveResult = await handlePositiveOutcome(signal, actions, unlockState);
  const libraryFlagged = await handleNegativeOutcome(signal, actions, unlockState);
  await queueLibraryChangeForReview(
    metricsRecorded,
    signal,
    effectivenessScore,
    actions,
    unlockState,
  );
  await maybeUpdateCommunicationStyle(signal, actions);
  await safeLogLearningEvent(signal, effectivenessScore, actions);

  return {
    profileUpdated: positiveResult.profileUpdated,
    metricsRecorded,
    libraryFlagged,
    factsExtracted: positiveResult.factsExtracted,
    humanReviewRequired: true,
    actions,
  };
}

async function loadUnlockState(signal: LearningSignal, actions: string[]): Promise<ShadowUnlockState | null> {
  try {
    return await evaluateShadowUnlockState({
      organizationId: signal.organizationId,
      accountId: signal.userId,
    });
  } catch {
    actions.push('Unlock state unavailable');
    return null;
  }
}

async function safeLogLearningEvent(
  signal: LearningSignal,
  effectivenessScore: number | null,
  actions: string[],
): Promise<void> {
  try {
    await logLearningEvent(signal, effectivenessScore, actions);
  } catch {
    // Non-critical — don't fail the whole loop
  }
}

async function recordMetrics(
  signal: LearningSignal,
  outcome: 'improved' | 'neutral' | 'degraded' | 'unknown',
  effectivenessScore: number,
  actions: string[],
): Promise<boolean> {
  try {
    await recordRecommendationEffectiveness({
      recommendationType: signal.sessionType,
      organizationId: signal.organizationId,
      userId: signal.userId,
      feedbackId: signal.feedbackId,
      recommendationId: signal.messageId,
      outcome,
      effectivenessScore,
      verificationState: signal.verificationState,
      humanReviewRequired: signal.verificationState !== 'human_reviewed',
    });
    actions.push(`Effectiveness recorded: ${outcome} (${effectivenessScore})`);
    return true;
  } catch {
    actions.push('Metrics recording failed');
    return false;
  }
}

async function handlePositiveOutcome(
  signal: LearningSignal,
  actions: string[],
  unlockState: ShadowUnlockState | null,
): Promise<{ profileUpdated: boolean; factsExtracted: number }> {
  if (!['thumbs_up', 'followed_advice', 'asked_followup'].includes(signal.outcome)) {
    return { profileUpdated: false, factsExtracted: 0 };
  }

  if (!unlockState || !isFeatureEnabled(unlockState, 'strong_personalization')) {
    actions.push('Strong personalization remains locked (observation mode)');
    return { profileUpdated: false, factsExtracted: 0 };
  }

  try {
    const factsExtracted = await extractAndStoreFacts(signal);
    if (factsExtracted > 0) {
      actions.push(`Extracted ${factsExtracted} fact(s) from positive signal`);
      return { profileUpdated: true, factsExtracted };
    }
    return { profileUpdated: false, factsExtracted: 0 };
  } catch {
    actions.push('Fact extraction failed');
    return { profileUpdated: false, factsExtracted: 0 };
  }
}

async function handleNegativeOutcome(
  signal: LearningSignal,
  actions: string[],
  unlockState: ShadowUnlockState | null,
): Promise<boolean> {
  const baseNegative = ['thumbs_down', 'escalated_to_human'];
  const aggressiveNegative = ['ignored_advice', 'session_ended'];
  const shouldUseAggressiveMode = unlockState && isFeatureEnabled(unlockState, 'aggressive_research_generation');
  const negativeOutcomes = shouldUseAggressiveMode ? [...baseNegative, ...aggressiveNegative] : baseNegative;

  if (!negativeOutcomes.includes(signal.outcome)) {
    return false;
  }

  // Two separate failure domains, attributed separately: a single catch here
  // used to report a research-requirement failure as "Library review flag
  // failed" -- a failure that had not occurred -- in the durable learning
  // audit. The flag can succeed while the requirement fails, and the audit
  // trail must say which one actually broke.
  let flagged = false;
  try {
    await flagLibraryEntryForReview(signal);
    actions.push(`Library entry flagged for review (topic: ${signal.topic})`);
    flagged = true;
  } catch {
    actions.push('Library review flag failed');
  }

  try {
    const researchRequirementId = await createResearchRequirementFromNegativeSignal(signal);
    actions.push(`Research requirement created (#${researchRequirementId})`);
  } catch {
    actions.push('Research requirement creation failed');
  }

  return flagged;
}

async function queueLibraryChangeForReview(
  metricsRecorded: boolean,
  signal: LearningSignal,
  effectivenessScore: number,
  actions: string[],
  unlockState: ShadowUnlockState | null,
): Promise<void> {
  if (!metricsRecorded) {
    return;
  }

  if (!unlockState || !isFeatureEnabled(unlockState, 'auto_library_updates')) {
    actions.push('Library changes remain in observation mode');
    return;
  }

  try {
    const action = await queueLibraryEntryChangeForHumanReview(signal, effectivenessScore);
    if (action) {
      actions.push(action);
    }
  } catch {
    actions.push('Library review queue update skipped');
  }
}

async function queueClientSignalForReview(
  signal: LearningSignal,
  actions: string[],
): Promise<boolean> {
  try {
    await query(
      `INSERT INTO pilot.shadow_library_review_flags (
         organization_id, account_id, feedback_id, topic, session_type,
         outcome_signal, user_note, review_state, flagged_at, last_flagged_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', NOW(), NOW())
       ON CONFLICT (organization_id, topic)
       DO UPDATE SET
         flag_count = pilot.shadow_library_review_flags.flag_count
           + CASE
               WHEN pilot.shadow_library_review_flags.feedback_id IS DISTINCT FROM EXCLUDED.feedback_id
               THEN 1
               ELSE 0
             END,
         account_id = EXCLUDED.account_id,
         feedback_id = EXCLUDED.feedback_id,
         session_type = EXCLUDED.session_type,
         outcome_signal = EXCLUDED.outcome_signal,
         user_note = EXCLUDED.user_note,
         last_flagged_at = NOW(),
         latest_outcome_signal = EXCLUDED.outcome_signal,
         review_state = 'pending'`,
      [
        signal.organizationId,
        signal.userId,
        signal.feedbackId,
        signal.topic,
        signal.sessionType,
        signal.outcome,
        signal.userNote ?? null,
      ],
    );
    actions.push('Client feedback queued for human review; no learning was promoted');
    return true;
  } catch {
    actions.push('Client feedback review queue unavailable');
    return false;
  }
}

async function maybeUpdateCommunicationStyle(signal: LearningSignal, actions: string[]): Promise<void> {
  if (signal.outcome !== 'thumbs_up') {
    return;
  }

  try {
    // Neither feedback call site supplies responseText, so requiring it here
    // meant communication_style stayed 'unknown' forever and the
    // "Communication Preference" branch of personalization never fired. The
    // text now comes from the durable assistant message row itself -- the
    // server-trusted record the feedback was verified against -- rather than
    // anything a client chose to send.
    const responseText = signal.responseText ?? await loadDurableResponseText(signal);
    if (!responseText) {
      return;
    }
    await inferCommunicationPreference({ ...signal, responseText });
    actions.push('Communication preference updated');
  } catch {
    actions.push('Style update skipped');
  }
}

async function loadDurableResponseText(signal: LearningSignal): Promise<string | null> {
  const row = await queryOne<{ content: string }>(
    `SELECT content
     FROM pilot.shadow_chat_messages
     WHERE message_id = $1::uuid
       AND organization_id = $2
       AND account_id = $3
       AND role = 'assistant'
       AND response_state = 'ok'`,
    [signal.messageId, signal.organizationId, signal.userId],
  );
  return row?.content ?? null;
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

// ─── Human-reviewed library change proposals ────────────────────────────────
async function queueLibraryEntryChangeForHumanReview(
  signal: LearningSignal,
  effectivenessScore: number,
): Promise<string | null> {
  const proposedAction =
    effectivenessScore >= 0.75
      ? 'promote'
      : effectivenessScore < 0.4
        ? 'demote'
        : 'retain';
  await query(
    `INSERT INTO pilot.shadow_library_review_flags (
       organization_id, account_id, feedback_id, topic, session_type,
       outcome_signal, flag_count, review_state, proposed_action,
       flagged_at, last_flagged_at
     ) VALUES ($1, $2, $3, $4, $5, $6, 1, 'pending', $7, NOW(), NOW())
     ON CONFLICT (organization_id, topic)
     DO UPDATE SET
       flag_count = pilot.shadow_library_review_flags.flag_count
         + CASE
             WHEN pilot.shadow_library_review_flags.feedback_id IS DISTINCT FROM EXCLUDED.feedback_id
             THEN 1
             ELSE 0
           END,
       account_id = EXCLUDED.account_id,
       feedback_id = EXCLUDED.feedback_id,
       session_type = EXCLUDED.session_type,
       outcome_signal = EXCLUDED.outcome_signal,
       last_flagged_at = NOW(),
       latest_outcome_signal = EXCLUDED.outcome_signal,
       proposed_action = EXCLUDED.proposed_action,
       review_state = 'pending',
       reviewed_by_account_id = NULL,
       reviewed_at = NULL`,
    [
      signal.organizationId,
      signal.userId,
      signal.feedbackId,
      signal.topic,
      signal.sessionType,
      signal.outcome,
      proposedAction,
    ],
  );
  return `Library '${proposedAction}' proposal queued for human review`;
}

// ─── Library Flag ─────────────────────────────────────────────────────────────

async function flagLibraryEntryForReview(signal: LearningSignal): Promise<void> {
  await query(
    `INSERT INTO pilot.shadow_library_review_flags (
       organization_id, account_id, topic, session_type,
       feedback_id, outcome_signal, user_note, review_state,
       flagged_at, last_flagged_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', NOW(), NOW())
     ON CONFLICT (organization_id, topic)
     DO UPDATE SET
       flag_count = pilot.shadow_library_review_flags.flag_count
         + CASE
             WHEN pilot.shadow_library_review_flags.feedback_id IS DISTINCT FROM EXCLUDED.feedback_id
             THEN 1
             ELSE 0
           END,
       account_id = EXCLUDED.account_id,
       feedback_id = EXCLUDED.feedback_id,
       session_type = EXCLUDED.session_type,
       outcome_signal = EXCLUDED.outcome_signal,
       user_note = EXCLUDED.user_note,
       last_flagged_at = NOW(),
       latest_outcome_signal = $6,
       review_state = 'pending'`,
    [
      signal.organizationId,
      signal.userId,
      signal.topic,
      signal.sessionType,
      signal.feedbackId,
      signal.outcome,
      signal.userNote ?? null,
    ],
  );
}

async function createResearchRequirementFromNegativeSignal(signal: LearningSignal): Promise<number> {
  const safeTopic = signal.topic && signal.topic.trim().length > 0
    ? signal.topic.trim().slice(0, 200)
    : 'general';
  const sourceEntityId = signal.messageId && signal.messageId.trim().length > 0
    ? signal.messageId
    : `learning-${Date.now()}`;

  return createShadowResearchRequirement({
    organizationId: signal.organizationId,
    sourceEventName: 'shadow_learning_negative_outcome',
    sourceEntityType: 'shadow_learning_event',
    sourceEntityId,
    researchRequirement: `Strengthen SHADOW guidance for topic '${safeTopic}' after outcome '${signal.outcome}'.`,
    knowledgeGap: signal.userNote?.trim() || `Recent response on '${safeTopic}' was judged insufficient and requires evidence reinforcement.`,
    evidenceLabel: `Learning loop escalation (${signal.outcome})`,
    sourceStatus: 'weak',
    sourceConfidenceTier: 'LIMITED',
    sourceVerificationState: 'unverified',
    createdByAccountId: signal.userId,
    createdByRole: signal.role,
    metadata: {
      sessionType: signal.sessionType,
      outcome: signal.outcome,
      topic: safeTopic,
      note: signal.userNote ?? null,
    },
  });
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
  score: number | null,
  actions: string[],
): Promise<void> {
  await query(
    `INSERT INTO pilot.shadow_learning_events (
       organization_id, account_id, role, feedback_id, shadow_event_id, message_id,
       topic, session_type, outcome_signal, effectiveness_score,
       verification_state, human_review_required, actions_taken, created_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6,
       $7, $8, $9, $10,
       $11, true, $12::jsonb, NOW()
     )
     ON CONFLICT (feedback_id, verification_state)
     DO UPDATE SET
       shadow_event_id = EXCLUDED.shadow_event_id,
       message_id = EXCLUDED.message_id,
       topic = EXCLUDED.topic,
       session_type = EXCLUDED.session_type,
       outcome_signal = EXCLUDED.outcome_signal,
       effectiveness_score = EXCLUDED.effectiveness_score,
       human_review_required = EXCLUDED.human_review_required,
       actions_taken = EXCLUDED.actions_taken`,
    [
      signal.organizationId,
      signal.userId,
      signal.role,
      signal.feedbackId,
      signal.shadowEventId ?? null,
      signal.messageId,
      signal.topic,
      signal.sessionType,
      signal.outcome,
      score,
      signal.verificationState,
      JSON.stringify(actions),
    ],
  );
}

// ─── Scorecard (Growth Metrics Summary) ──────────────────────────────────────



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
