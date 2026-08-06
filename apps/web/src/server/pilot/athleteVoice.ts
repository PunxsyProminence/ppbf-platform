import { queryOne } from './db';
import {
  fileEscalation,
  type SafetyEscalationRow,
  type SafetyEscalationSeverity,
} from './escalationLadder';
import { scanForSafetyLanguage } from './feedbackSafetyScan';

/**
 * Athlete Voice (capability #198): the bridge from the feedback box to the
 * escalation ladder.
 *
 * The feedback system already does the hard parts -- a comment box every
 * PIN-signed-in child can reach, safety-language classification tuned for
 * how a twelve-year-old actually types, a write-time-frozen safeguarding
 * route, and an admin triage queue that orders safeguarding first. What it
 * did NOT do is make anything happen next: a safeguarding row waited for an
 * admin to happen to open the triage page. The escalation ladder is the
 * platform's only notification mechanism (no email, ever), so a disclosure
 * that never reaches it is a disclosure nobody is told about.
 *
 * This module files an 'athlete_voice' escalation for each athlete
 * safeguarding submission. Three properties are load-bearing:
 *
 * 1. NON-DISCLOSING. The escalation carries a fixed reason and a
 *    submission-id pointer -- never the submission text, and never the
 *    matched cues (the scan module's contract is that cues are diagnostic
 *    only and are never persisted). Escalation rows travel to surfaces the
 *    disclosure body must never reach.
 * 2. ADMIN-ONLY. Filed to 'organization_admin', and the coach-scoped
 *    escalation list excludes athlete_voice rows entirely -- the athlete's
 *    coach may be exactly who the child is disclosing about, and even the
 *    existence of a disclosure is information.
 * 3. ORACLE-SAFE AT THE CALLER. The submit route swallows every outcome of
 *    this filing, because any response difference on the safeguarding path
 *    -- an error only safeguarding submissions can hit, a latency-free
 *    early return only product submissions take -- is a classifier oracle
 *    for whoever is sitting next to the child.
 */

/**
 * Cues whose presence makes the escalation 'critical' rather than 'high'.
 * Every safeguarding submission already errs toward a human; this split
 * only decides how loudly the ladder sorts it. Chosen from the scan's cue
 * vocabulary: active-harm and crisis language outranks pain/fear language.
 * This map is safeguarding-critical -- if a cue id in the scan module is
 * renamed, the drift test in athleteVoice.test.ts fails loudly rather than
 * silently downgrading a crisis to 'high'.
 */
export const ATHLETE_VOICE_CRITICAL_CUES: readonly string[] = [
  'crisis',
  'crisis_indirect',
  'someone_is_hurting_me',
  'grooming_or_isolation',
  'harm_to_someone_else',
];

const CRITICAL_CUE_SET: ReadonlySet<string> = new Set(ATHLETE_VOICE_CRITICAL_CUES);

export function athleteVoiceSeverity(cues: readonly string[]): SafetyEscalationSeverity {
  return cues.some((cue) => CRITICAL_CUE_SET.has(cue)) ? 'critical' : 'high';
}

/**
 * Fixed on purpose: the reason renders on the escalation surface, so it must
 * say where to read the words without quoting any of them.
 */
export const ATHLETE_VOICE_REASON =
  'An athlete used the feedback box to say something that needs a person to read it. '
  + 'The submission itself is in the safeguarding lane of the feedback triage queue -- read it there.';

export interface FileAthleteVoiceEscalationParams {
  organizationId: string;
  /** The submitting athlete's account id (from the session principal). */
  accountId: string;
  /** The pilot.feedback_submissions id the escalation points at. */
  submissionId: string;
  /** The submission text -- used ONLY to re-derive severity in process; never stored here. */
  body: string;
}

/**
 * Files the escalation, or returns null when the account has no athlete
 * record: pilot.safety_escalations.athlete_id is NOT NULL with a composite
 * FK, so an athlete-role account that was never linked to an athlete row
 * cannot be escalated -- the submission still sits first in the
 * safeguarding queue, which was the pre-#198 behavior for everyone.
 *
 * Severity re-runs scanForSafetyLanguage on the body rather than plumbing
 * cues out of createFeedbackSubmission -- the scan is pure and cheap, and
 * feedback.ts stays untouched (it is another session's reserved file).
 */
export async function fileAthleteVoiceEscalation(
  params: FileAthleteVoiceEscalationParams,
): Promise<SafetyEscalationRow | null> {
  const account = await queryOne<{ athlete_id: string | null }>(
    'select athlete_id from pilot.accounts where account_id = $1 and organization_id = $2',
    [params.accountId, params.organizationId],
  );

  if (!account?.athlete_id) {
    return null;
  }

  const scan = scanForSafetyLanguage(params.body);

  return fileEscalation({
    organizationId: params.organizationId,
    sourceType: 'athlete_voice',
    sourceId: params.submissionId,
    athleteId: account.athlete_id,
    severity: athleteVoiceSeverity(scan.cues),
    reason: ATHLETE_VOICE_REASON,
    escalatedToRole: 'organization_admin',
    triggeredBy: 'system',
    // The submission id only. No body, no cues, no matched-language hints:
    // metadata is readable wherever the escalation row is readable.
    metadata: { submission_id: params.submissionId },
  });
}
