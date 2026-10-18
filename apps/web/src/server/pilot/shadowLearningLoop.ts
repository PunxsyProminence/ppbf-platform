// shadowLearningLoop.ts — Learning Loop + The Playbook Updates
// Connects recommendation outcomes → Growth Metrics → SHADOW Library → Scout Reports.
// This is how SHADOW improves over time: each interaction informs future advice.

import type { PoolClient } from 'pg';

import { query, queryOne, sanitizedSqlState, withTransaction } from './db';
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
  // Every effect that applied to this signal is done, on this attempt or an
  // earlier one. False is retryable: the effects that must not happen twice
  // (fact counts, the topic's flag count) are marked on the feedback row in
  // the same transaction as the write, so a retry skips them, and the rest
  // are safe to repeat (upserts keyed by the feedback or its message, or a
  // style update that only fills an unset value).
  complete: boolean;
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
      complete: false,
    };
  }

  if (signal.verificationState !== 'human_reviewed') {
    return projectClientSignal(signal, actions);
  }

  const effectivenessScore = outcomeToScore(signal.outcome);
  const outcome = outcomeToCategory(signal.outcome);
  const metricsRecorded = await recordMetrics(signal, outcome, effectivenessScore, actions);

  const unlockState = await loadUnlockState(signal, actions);
  const positiveResult = await handlePositiveOutcome(signal, actions, unlockState);
  const negativeResult = await handleNegativeOutcome(signal, actions, unlockState);
  const proposalOk = await queueLibraryChangeForReview(
    metricsRecorded,
    signal,
    effectivenessScore,
    actions,
    unlockState,
  );
  const styleOk = await maybeUpdateCommunicationStyle(signal, actions);
  const logged = await safeLogLearningEvent(signal, effectivenessScore, actions);

  // Which effects apply depends on the unlock state, so an unreadable one is
  // a failure to retry, not a reason to skip them.
  const everyEffectDone = metricsRecorded
    && unlockState !== null
    && positiveResult.ok
    && negativeResult.ok
    && proposalOk
    && styleOk
    && logged;
  const complete = everyEffectDone && await markLearningComplete(signal);

  return {
    profileUpdated: positiveResult.profileUpdated,
    metricsRecorded,
    libraryFlagged: negativeResult.flagged,
    factsExtracted: positiveResult.factsExtracted,
    humanReviewRequired: true,
    actions,
    complete,
  };
}

/**
 * A durable client signal -- also the path a pending EDIT takes (editable
 * until reviewed, owner decision 2026-07-31). Its effectiveness row, its
 * topic's flag and its learning log follow the feedback row's CURRENT value,
 * read under the row's lock and written in that one transaction: two quick
 * submissions each carry the value their own upsert returned, so the later
 * projection could follow the earlier tap. Every write is keyed by the
 * feedback id, so an edit corrects the projections rather than adding a
 * second observation, and a failure leaves none of them half-written.
 */
async function projectClientSignal(signal: LearningSignal, actions: string[]): Promise<LearningLoopResult> {
  let projected = false;
  let flagged = false;
  try {
    await withTransaction(async (client) => {
      const feedback = await lockFeedback(client, signal);
      if (!feedback.pendingReview) {
        // Reviewed feedback is frozen; the approval path owns its projections.
        actions.push('Feedback already reviewed; nothing re-projected');
        return;
      }
      const current: LearningSignal = { ...signal, outcome: feedback.outcome, userNote: feedback.comment ?? undefined };
      const score = outcomeToScore(current.outcome);
      const category = outcomeToCategory(current.outcome);
      await recordRecommendationEffectiveness(effectivenessFor(current, category, score), client);
      actions.push(`Effectiveness recorded: ${category} (${score})`);
      flagged = await projectClientFlag(client, current, feedback, actions);
      await logLearningEvent(current, score, actions, client);
      projected = true;
    });
  } catch (error) {
    console.error('SHADOW client feedback projection failed', {
      organizationId: signal.organizationId,
      feedbackId: signal.feedbackId,
      errorClass: error instanceof Error ? error.constructor?.name : typeof error,
    });
    actions.push('Client feedback projection failed; resubmitting the rating retries it');
    return {
      profileUpdated: false,
      metricsRecorded: false,
      libraryFlagged: false,
      factsExtracted: 0,
      humanReviewRequired: true,
      actions,
      complete: false,
    };
  }
  return {
    profileUpdated: false,
    metricsRecorded: projected,
    libraryFlagged: flagged,
    factsExtracted: 0,
    humanReviewRequired: true,
    actions,
    complete: true,
  };
}

// ─── Once-only effects ──────────────────────────────────────────────────────
//
// pilot.shadow_feedback.learning_effects_done records the effects of one
// feedback event that must not happen twice (lane L46; the
// shadow-learning-effects migration). Each is written in the SAME transaction
// as the effect it records, under a lock on the feedback row, so a retry, a
// pending edit or the approval path finds the mark and does not repeat it.

type LearningEffect = 'library_flag' | 'facts' | 'complete';

interface LockedFeedback {
  done: LearningEffect[];
  // The row's CURRENT judgment, read under the lock. Two quick submissions
  // each carry the value their own upsert returned, so the later projection
  // could follow the earlier tap; this is what the row says now.
  outcome: OutcomeSignal;
  comment: string | null;
  pendingReview: boolean;
}

async function lockFeedback(client: PoolClient, signal: LearningSignal): Promise<LockedFeedback> {
  const { rows } = await client.query<{
    learning_effects_done: LearningEffect[];
    outcome_signal: OutcomeSignal;
    comment: string | null;
    human_review_required: boolean;
  }>(
    `SELECT learning_effects_done, outcome_signal, comment, human_review_required
     FROM pilot.shadow_feedback
     WHERE feedback_id = $1 AND organization_id = $2
     FOR UPDATE`,
    [signal.feedbackId, signal.organizationId],
  );
  if (!rows[0]) {
    throw new Error('SHADOW_FEEDBACK_NOT_FOUND');
  }
  return {
    done: rows[0].learning_effects_done ?? [],
    outcome: rows[0].outcome_signal,
    comment: rows[0].comment,
    pendingReview: rows[0].human_review_required,
  };
}

async function setFeedbackEffect(
  client: PoolClient,
  signal: LearningSignal,
  effect: LearningEffect,
  done: boolean,
): Promise<void> {
  await client.query(
    done
      ? `UPDATE pilot.shadow_feedback
         SET learning_effects_done = array_append(learning_effects_done, $3::text)
         WHERE feedback_id = $1 AND organization_id = $2
           AND NOT ($3::text = ANY (learning_effects_done))`
      : `UPDATE pilot.shadow_feedback
         SET learning_effects_done = array_remove(learning_effects_done, $3::text)
         WHERE feedback_id = $1 AND organization_id = $2`,
    [signal.feedbackId, signal.organizationId, effect],
  );
}

async function markLearningComplete(signal: LearningSignal): Promise<boolean> {
  try {
    await query(
      `UPDATE pilot.shadow_feedback
       SET learning_effects_done = array_append(learning_effects_done, 'complete')
       WHERE feedback_id = $1 AND organization_id = $2
         AND NOT ('complete' = ANY (learning_effects_done))`,
      [signal.feedbackId, signal.organizationId],
    );
    return true;
  } catch (error) {
    console.error('SHADOW learning completion not recorded', {
      organizationId: signal.organizationId,
      feedbackId: signal.feedbackId,
      errorClass: error instanceof Error ? error.constructor?.name : typeof error,
    });
    return false;
  }
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
): Promise<boolean> {
  try {
    await logLearningEvent(signal, effectivenessScore, actions);
    return true;
  } catch (error) {
    // Non-critical -- don't fail the whole loop. But this INSERT is the
    // ONLY durable record that the loop ran, what it decided, and why: a
    // silent catch here previously left an operator debugging "why did
    // SHADOW stop updating its playbook for this org" with no log line and
    // no row to find. errorClass/code only -- never the raw error object,
    // matching db.ts's own sanitized-logging stance.
    const rawCode = error && typeof error === 'object' && 'code' in error ? (error as { code: unknown }).code : undefined;
    const code = sanitizedSqlState(rawCode);
    console.error('SHADOW learning event not recorded', {
      organizationId: signal.organizationId,
      feedbackId: signal.feedbackId,
      errorClass: error instanceof Error ? error.constructor?.name : typeof error,
      ...(code ? { code } : {}),
    });
    return false;
  }
}

async function recordMetrics(
  signal: LearningSignal,
  outcome: 'improved' | 'neutral' | 'degraded' | 'unknown',
  effectivenessScore: number,
  actions: string[],
): Promise<boolean> {
  try {
    await recordRecommendationEffectiveness(effectivenessFor(signal, outcome, effectivenessScore));
    actions.push(`Effectiveness recorded: ${outcome} (${effectivenessScore})`);
    return true;
  } catch {
    actions.push('Metrics recording failed');
    return false;
  }
}

function effectivenessFor(
  signal: LearningSignal,
  outcome: 'improved' | 'neutral' | 'degraded' | 'unknown',
  effectivenessScore: number,
): Parameters<typeof recordRecommendationEffectiveness>[0] {
  return {
    recommendationType: signal.sessionType,
    organizationId: signal.organizationId,
    userId: signal.userId,
    feedbackId: signal.feedbackId,
    recommendationId: signal.messageId,
    outcome,
    effectivenessScore,
    verificationState: signal.verificationState,
    humanReviewRequired: signal.verificationState !== 'human_reviewed',
  };
}

async function handlePositiveOutcome(
  signal: LearningSignal,
  actions: string[],
  unlockState: ShadowUnlockState | null,
): Promise<{ ok: boolean; profileUpdated: boolean; factsExtracted: number }> {
  if (!['thumbs_up', 'followed_advice', 'asked_followup'].includes(signal.outcome)) {
    return { ok: true, profileUpdated: false, factsExtracted: 0 };
  }

  if (!unlockState || !isFeatureEnabled(unlockState, 'strong_personalization')) {
    actions.push('Strong personalization remains locked (observation mode)');
    return { ok: true, profileUpdated: false, factsExtracted: 0 };
  }

  const facts = factsFromSignal(signal);
  if (facts.length === 0) {
    return { ok: true, profileUpdated: false, factsExtracted: 0 };
  }

  try {
    const stored = await storeFactsOnce(signal, facts);
    if (!stored) {
      actions.push('Facts from this feedback were already counted');
      return { ok: true, profileUpdated: false, factsExtracted: 0 };
    }
    actions.push(`Extracted ${facts.length} fact(s) from positive signal`);
    return { ok: true, profileUpdated: true, factsExtracted: facts.length };
  } catch {
    actions.push('Fact extraction failed');
    return { ok: false, profileUpdated: false, factsExtracted: 0 };
  }
}

async function handleNegativeOutcome(
  signal: LearningSignal,
  actions: string[],
  unlockState: ShadowUnlockState | null,
): Promise<{ ok: boolean; flagged: boolean }> {
  const baseNegative = ['thumbs_down', 'escalated_to_human'];
  const aggressiveNegative = ['ignored_advice', 'session_ended'];
  const shouldUseAggressiveMode = unlockState && isFeatureEnabled(unlockState, 'aggressive_research_generation');
  const negativeOutcomes = shouldUseAggressiveMode ? [...baseNegative, ...aggressiveNegative] : baseNegative;

  if (!negativeOutcomes.includes(signal.outcome)) {
    // The approved judgment is not negative, so a pending flag this feedback
    // still holds from an earlier thumbs-down must go before the topic is
    // listed as a concern on its account.
    return { ok: await withdrawLibraryFlag(signal, actions), flagged: false };
  }

  // Two separate failure domains, attributed separately: a single catch here
  // used to report a research-requirement failure as "Library review flag
  // failed" -- a failure that had not occurred -- in the durable learning
  // audit. The flag can succeed while the requirement fails, and the audit
  // trail must say which one actually broke.
  let flagged = false;
  let ok = true;
  try {
    actions.push(await flagLibraryEntryForReview(signal)
      ? `Library entry flagged for review (topic: ${signal.topic})`
      : `Library flag already counted for this feedback (topic: ${signal.topic})`);
    flagged = true;
  } catch {
    actions.push('Library review flag failed');
    ok = false;
  }

  try {
    const researchRequirementId = await createResearchRequirementFromNegativeSignal(signal);
    actions.push(`Research requirement created (#${researchRequirementId})`);
  } catch {
    actions.push('Research requirement creation failed');
    ok = false;
  }

  return { ok, flagged };
}

async function queueLibraryChangeForReview(
  metricsRecorded: boolean,
  signal: LearningSignal,
  effectivenessScore: number,
  actions: string[],
  unlockState: ShadowUnlockState | null,
): Promise<boolean> {
  if (!metricsRecorded) {
    // Not attempted: the loop is already incomplete on metrics, and the retry
    // that records them runs this.
    return true;
  }

  if (!unlockState || !isFeatureEnabled(unlockState, 'auto_library_updates')) {
    actions.push('Library changes remain in observation mode');
    return true;
  }

  try {
    const action = await queueLibraryEntryChangeForHumanReview(signal, effectivenessScore);
    if (action) {
      actions.push(action);
    }
    return true;
  } catch {
    actions.push('Library review queue update skipped');
    return false;
  }
}

/**
 * The outcomes that put a topic on the Library review queue from a client
 * signal (OD-2026-10-08 GO-RECS-CONFIRMED, O11 = A: "Library review flags come
 * from negative feedback only; thumbs-up still counts in metrics but makes no
 * flag"). Until then every durable client signal, praise included, wrote a
 * 'pending' flag, so the /admin/shadow "Review flags" list and the metrics
 * route's "concerned topics" were counting thumbs-up as concern.
 *
 * These are the same two outcomes handleNegativeOutcome calls baseNegative.
 * ignored_advice and session_ended are negative there ONLY under the
 * aggressive_research_generation unlock, which is a human-reviewed path with
 * an unlock state loaded; this client path loads none and never has, so they
 * are not flagged here. followed_advice and asked_followup are praise or
 * engagement. Metrics are recorded for every outcome before this is reached.
 */
const CLIENT_SIGNAL_FLAG_OUTCOMES: ReadonlySet<OutcomeSignal> = new Set<OutcomeSignal>([
  'thumbs_down',
  'escalated_to_human',
]);

async function projectClientFlag(
  client: PoolClient,
  signal: LearningSignal,
  feedback: LockedFeedback,
  actions: string[],
): Promise<boolean> {
  if (!CLIENT_SIGNAL_FLAG_OUTCOMES.has(signal.outcome)) {
    actions.push(`Client feedback recorded in metrics; no Library flag for ${signal.outcome}`);
    // A pending thumbs-down edited to anything else no longer supports the
    // flag it raised; left in place, the topic stayed a concern on the
    // strength of a judgment its author had taken back.
    if (await withdrawFlagLocked(client, signal, feedback)) {
      actions.push(`Library flag withdrawn (topic: ${signal.topic}); this feedback is no longer negative`);
    }
    return false;
  }
  const added = await addFlagLocked(client, signal, feedback, () => client.query(
    `INSERT INTO pilot.shadow_library_review_flags (
       organization_id, account_id, feedback_id, topic, session_type,
       outcome_signal, user_note, review_state, flagged_at, last_flagged_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', NOW(), NOW())
     ON CONFLICT (organization_id, topic)
     DO UPDATE SET
       flag_count = pilot.shadow_library_review_flags.flag_count + 1,
       account_id = EXCLUDED.account_id,
       feedback_id = EXCLUDED.feedback_id,
       session_type = EXCLUDED.session_type,
       outcome_signal = EXCLUDED.outcome_signal,
       user_note = EXCLUDED.user_note,
       last_flagged_at = NOW(),
       latest_outcome_signal = EXCLUDED.outcome_signal,
       -- A fresh negative signal supersedes a pending praise proposal on
       -- the topic: left in place, a 'promote' here would hide this flag
       -- from the metrics route's concerned topics.
       proposed_action = NULL,
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
  ), refreshNegativeFlag(client, signal, signal.outcome, signal.userNote ?? null));
  actions.push(added
    ? 'Client feedback queued for human review; no learning was promoted'
    : 'Client feedback already counted on its topic flag; no learning was promoted');
  return true;
}

/**
 * Write the topic's flag row, adding this feedback to its flag_count at most
 * once across every path (client flag, approval flag, Library proposal),
 * retries and edits included. The count used to skip +1 only when the topic
 * row's LATEST feedback was this one, so this feedback re-processed after
 * another flag landed counted twice.
 *
 * Once counted, a repeat must not be a new observation: `write` is not run
 * again, because it reopens the flag, replaces a pending proposal and moves
 * last_flagged_at -- which put a flag a curator had resolved back on the
 * concern list when its author resubmitted the same rating. `refresh` may
 * correct what this feedback itself shows on a pending row (its note).
 */
async function addFlagLocked(
  client: PoolClient,
  signal: LearningSignal,
  feedback: LockedFeedback,
  write: () => Promise<unknown>,
  refresh?: () => Promise<unknown>,
): Promise<boolean> {
  if (feedback.done.includes('library_flag')) {
    await refresh?.();
    return false;
  }
  await write();
  await setFeedbackEffect(client, signal, 'library_flag', true);
  return true;
}

async function addLibraryFlagOnce(
  signal: LearningSignal,
  write: (client: PoolClient) => Promise<unknown>,
  refresh?: (client: PoolClient) => Promise<unknown>,
): Promise<boolean> {
  return withTransaction(async (client) => {
    const feedback = await lockFeedback(client, signal);
    return addFlagLocked(client, signal, feedback, () => write(client), refresh && (() => refresh(client)));
  });
}

/** This feedback's own note and outcome on a pending flag row that names it. */
function refreshNegativeFlag(
  client: PoolClient,
  signal: LearningSignal,
  outcome: OutcomeSignal,
  note: string | null,
): () => Promise<unknown> {
  return () => client.query(
    `UPDATE pilot.shadow_library_review_flags
     SET user_note = $4, outcome_signal = $5, latest_outcome_signal = $5
     WHERE organization_id = $1 AND topic = $2 AND feedback_id = $3
       AND review_state = 'pending' AND proposed_action IS NULL`,
    [signal.organizationId, signal.topic, signal.feedbackId, note, outcome],
  );
}

/**
 * Take this feedback's contribution back out of its topic's PENDING flag
 * once the feedback is no longer negative. The count drops by one and, if the
 * row names this feedback, its account and note go with it; a negative flag
 * whose count was this feedback alone goes. A flag a reviewer has already
 * resolved is left as judged, and a pending proposal whose count is one is a
 * judgment of its own: in both, this feedback stays counted, so nothing that
 * runs later can count it a second time.
 */
async function withdrawLibraryFlag(signal: LearningSignal, actions: string[]): Promise<boolean> {
  try {
    const withdrawn = await withTransaction(async (client) => (
      withdrawFlagLocked(client, signal, await lockFeedback(client, signal))
    ));
    if (withdrawn) {
      actions.push(`Library flag withdrawn (topic: ${signal.topic}); this feedback is no longer negative`);
    }
    return true;
  } catch {
    actions.push('Library flag withdrawal failed');
    return false;
  }
}

async function withdrawFlagLocked(
  client: PoolClient,
  signal: LearningSignal,
  feedback: LockedFeedback,
): Promise<boolean> {
  if (!feedback.done.includes('library_flag')) {
    return false;
  }
  const { rows } = await client.query<{
    flag_count: number;
    feedback_id: string | number | null;
    review_state: string;
    proposed_action: string | null;
  }>(
    `SELECT flag_count, feedback_id, review_state, proposed_action
     FROM pilot.shadow_library_review_flags
     WHERE organization_id = $1 AND topic = $2
     FOR UPDATE`,
    [signal.organizationId, signal.topic],
  );
  const flag = rows[0];
  if (flag && flag.review_state !== 'pending') {
    return false;
  }
  if (flag) {
    if (flag.flag_count <= 1 && flag.proposed_action !== null) {
      return false;
    }
    if (flag.flag_count <= 1) {
      // Every contribution is counted once and this one is in the count,
      // so a count of one is this feedback's alone, whoever the row names.
      await client.query(
        `DELETE FROM pilot.shadow_library_review_flags
         WHERE organization_id = $1 AND topic = $2`,
        [signal.organizationId, signal.topic],
      );
    } else {
      await client.query(
        `UPDATE pilot.shadow_library_review_flags
         SET flag_count = flag_count - 1,
             account_id = CASE WHEN feedback_id = $3 THEN NULL ELSE account_id END,
             user_note = CASE WHEN feedback_id = $3 THEN NULL ELSE user_note END,
             feedback_id = CASE WHEN feedback_id = $3 THEN NULL ELSE feedback_id END
         WHERE organization_id = $1 AND topic = $2`,
        [signal.organizationId, signal.topic, signal.feedbackId],
      );
    }
  }
  await setFeedbackEffect(client, signal, 'library_flag', false);
  return true;
}

async function maybeUpdateCommunicationStyle(signal: LearningSignal, actions: string[]): Promise<boolean> {
  if (signal.outcome !== 'thumbs_up') {
    return true;
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
      return true;
    }
    await inferCommunicationPreference({ ...signal, responseText });
    actions.push('Communication preference updated');
    return true;
  } catch {
    actions.push('Style update skipped');
    return false;
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
 *
 * THESE NUMBERS ARE NOT CONFIDENCES. 0.6, 0.7, 0.75 and 0.8 are literals
 * chosen while writing this function. They are stored as an internal sort key
 * that decides which facts survive the 20-fact prune, and they are never
 * rendered -- what a reader sees is the observation count, through
 * `describeFactSupport`. See the doc comment on `RememberedFact.confidence`.
 *
 * ONE SIGNAL IS ONE OBSERVATION. `upsertRememberedFact` counts each call, so
 * the first thumbs-up on a topic produces a fact described as a single
 * observation rather than as an established preference, and only repetition
 * moves it. Nothing here writes a permanent statement about a person.
 */
type SignalFact = { key: string; value: string; confidence: number };

function factsFromSignal(signal: LearningSignal): SignalFact[] {
  const factsToStore: SignalFact[] = [];

  // Topic preference: user engaged positively with this topic
  if (signal.topic && signal.topic !== 'general') {
    factsToStore.push({
      key: `engaged_topic_${signal.topic}`,
      value: 'true',
      // Internal prune weight, not a probability. Acting on advice outranks a
      // thumbs-up when 20 facts have to become 19; that is all it decides.
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

  return factsToStore;
}

/**
 * Count this feedback's observations once: all of them and the 'facts' mark
 * commit together, so a failure part-way leaves none counted and a retry
 * after a later failure finds the mark. Returns false when they were already
 * counted.
 */
async function storeFactsOnce(signal: LearningSignal, facts: SignalFact[]): Promise<boolean> {
  return withTransaction(async (client) => {
    const { done } = await lockFeedback(client, signal);
    if (done.includes('facts')) {
      return false;
    }
    for (const fact of facts) {
      await upsertRememberedFact(signal.userId, signal.organizationId, fact, client);
    }
    await setFeedbackEffect(client, signal, 'facts', true);
    return true;
  });
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
  const added = await addLibraryFlagOnce(signal, (client) => client.query(
    `INSERT INTO pilot.shadow_library_review_flags (
       organization_id, account_id, feedback_id, topic, session_type,
       outcome_signal, flag_count, review_state, proposed_action,
       flagged_at, last_flagged_at
     ) VALUES ($1, $2, $3, $4, $5, $6, 1, 'pending', $7, NOW(), NOW())
     ON CONFLICT (organization_id, topic)
     DO UPDATE SET
       flag_count = pilot.shadow_library_review_flags.flag_count + 1,
       account_id = EXCLUDED.account_id,
       feedback_id = EXCLUDED.feedback_id,
       session_type = EXCLUDED.session_type,
       outcome_signal = EXCLUDED.outcome_signal,
       -- The row now names this account: an earlier flagger's note must not
       -- be shown as theirs (#1600 PR 3).
       user_note = NULL,
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
  ), (client) => client.query(
    // Already counted: the action this feedback's own pending row proposes
    // follows the review, with nothing reopened or re-counted.
    `UPDATE pilot.shadow_library_review_flags
     SET proposed_action = $4
     WHERE organization_id = $1 AND topic = $2 AND feedback_id = $3 AND review_state = 'pending'`,
    [signal.organizationId, signal.topic, signal.feedbackId, proposedAction],
  ));
  return added
    ? `Library '${proposedAction}' proposal queued for human review`
    : `Library proposal already counted for this feedback (topic: ${signal.topic})`;
}

// ─── Library Flag ─────────────────────────────────────────────────────────────

async function flagLibraryEntryForReview(signal: LearningSignal): Promise<boolean> {
  return addLibraryFlagOnce(signal, (client) => client.query(
    `INSERT INTO pilot.shadow_library_review_flags (
       organization_id, account_id, topic, session_type,
       feedback_id, outcome_signal, user_note, review_state,
       flagged_at, last_flagged_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', NOW(), NOW())
     ON CONFLICT (organization_id, topic)
     DO UPDATE SET
       flag_count = pilot.shadow_library_review_flags.flag_count + 1,
       account_id = EXCLUDED.account_id,
       feedback_id = EXCLUDED.feedback_id,
       session_type = EXCLUDED.session_type,
       outcome_signal = EXCLUDED.outcome_signal,
       user_note = EXCLUDED.user_note,
       last_flagged_at = NOW(),
       latest_outcome_signal = $6,
       proposed_action = NULL,
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
  ), (client) => refreshNegativeFlag(client, signal, signal.outcome, signal.userNote ?? null)());
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
  transaction?: PoolClient,
): Promise<void> {
  const write = (text: string, params: unknown[]) => (transaction ? transaction.query(text, params) : query(text, params));
  await write(
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
