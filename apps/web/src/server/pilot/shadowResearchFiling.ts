import { createHash } from 'node:crypto';

import type { PilotRole } from './contracts';
import { createShadowResearchRequirement, getShadowResearchRequirementById, isResearchStaff } from './shadowResearch';

/* AN UNANSWERED SHADOW QUESTION FILES ITS OWN RESEARCH ROW (F-054).
 *
 * When SHADOW serves an answer with no verified Library evidence it tells the
 * asker so. This is where that sentence becomes true: the question is filed as
 * one research requirement the coach's research feed shows (Jason 2026-10-07
 * "Build all", 2026-10-11 "Fix or build it": the app does what it says).
 *
 * One row per normalized question: the table upserts on (org, event, entity
 * type, entity id), so a double tap or a repeat ask reaches the same row.
 * The key matches the one app/shadow/page.tsx uses for a coach's own "File as
 * research" button, so a coach and the auto-filing never make two rows.
 *
 * Who reads it is unchanged (CL-A3, OD-2026-10-06-003, OD-2026-10-06-010):
 *  - a staff asker about a specific athlete files it WITH that athlete as its
 *    subject, exactly as the button does;
 *  - anyone else files a row with NO subject: it is the asker's own question,
 *    not a question about a child, so staff and the creating account read it
 *    (mayReadSubjectlessResearchRow) and nobody else does.
 */
/* WHICH EXCHANGES MAY NEVER BE COPIED INTO THE RESEARCH FEED.
 *
 * The row stores the asker's message verbatim and every coach and organization
 * admin of the gym reads it. A flagged exchange is not for the whole coaching
 * staff: on a human-review ticket the organization admin reads "the single
 * flagged question and answer ... and nothing else from the chat"
 * (OD-2026-10-07-009 ruling 4, Q8 "That one exchange (Recommended)"). So an
 * exchange that was flagged, safety-routed, handed off, refused or altered by
 * a filter, or is not a normally served answer, is never filed here.
 *
 * Every clause is a separate guard, each with its own test and mutant. The
 * route passes the facts; this function only decides. A fact that is unknown
 * must be passed as the refusing value. */
export interface UnansweredFilingFacts {
  /** The state the reader was shown ('ok' is the only normally served one). */
  state: string;
  /** persistedRequiresHumanReview: a ticket was or should have been written. */
  requiresHumanReview: boolean;
  /** persistedHandoff: a handoff banner was attached. */
  hasHandoff: boolean;
  /** The response validator filtered the generated answer. */
  responseFiltered: boolean;
  /** The response validator asked for a human to review the answer. */
  responseRequiresHumanReview: boolean;
  /** The response validator recorded any reason (rule fired). */
  responseReasonCount: number;
  /** The text shown differs from the model's text: a filter rewrote it. */
  responseAltered: boolean;
  /** The REQUEST was classified high-risk. */
  requestHighRisk: boolean;
  /** The request carried a high-risk classification or topic. */
  requestFlagged: boolean;
  /** A request-risk human-review row is owed for this exchange. */
  requestRiskOwed: boolean;
}

export function mayFileUnansweredQuestion(facts: UnansweredFilingFacts): boolean {
  if (facts.state !== 'ok') return false;
  if (facts.requiresHumanReview) return false;
  if (facts.hasHandoff) return false;
  if (facts.responseFiltered) return false;
  if (facts.responseRequiresHumanReview) return false;
  if (facts.responseReasonCount > 0) return false;
  if (facts.responseAltered) return false;
  if (facts.requestHighRisk) return false;
  if (facts.requestFlagged) return false;
  if (facts.requestRiskOwed) return false;
  return true;
}

export const SHADOW_UNANSWERED_EVENT = 'shadow_unanswered_question';
export const SHADOW_UNANSWERED_ENTITY = 'shadow_question';
/** An athlete's or parent's own filing lives under its own entity type, which
 *  the create route refuses to a caller, so no staff text can ever land on the
 *  same upsert key (F-054 review). */
export const SHADOW_ASKER_ENTITY = 'shadow_asker_question';

export function normalizeUnansweredQuestion(question: string): string {
  return question.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 500);
}

export function unansweredQuestionKey(question: string, athleteId: string | null): string {
  const normalized = normalizeUnansweredQuestion(question);
  if (!normalized) return '';
  return athleteId ? `athlete:${athleteId}:${normalized}` : normalized;
}

/**
 * Files the question. Returns true only when a row exists afterwards, so the
 * caller can say "passed on" truthfully. Never throws: a failed
 * filing must not take the answer down with it, it just reads as not filed.
 */
export async function fileUnansweredShadowQuestion(input: {
  organizationId: string;
  accountId: string;
  role: PilotRole;
  question: string;
  athleteId?: string | null;
}): Promise<boolean> {
  const staff = isResearchStaff(input.role);
  const subjectId = staff ? (input.athleteId?.trim() || null) : null;
  const base = unansweredQuestionKey(input.question, subjectId);
  if (!base) return false;
  // A non-staff asker's row is their own: its own entity type (so no staff key
  // can collide with it) and a key of the account plus a hash of the WHOLE
  // question. A hash, so the key carries neither the words nor a 500-character
  // prefix two long questions could share; the account, so a second asker of
  // the same words still gets a row they can read.
  const key = staff
    ? base
    : `acct:${input.accountId}:${createHash('sha256').update(input.question.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 2000)).digest('hex')}`;
  try {
    const id = await createShadowResearchRequirement({
      organizationId: input.organizationId,
      sourceEventName: SHADOW_UNANSWERED_EVENT,
      sourceEntityType: staff ? SHADOW_UNANSWERED_ENTITY : SHADOW_ASKER_ENTITY,
      sourceEntityId: key,
      researchRequirement: input.question.trim().slice(0, 2000),
      knowledgeGap: 'No verified Library evidence matched this question in SHADOW.',
      evidenceLabel: null,
      sourceStatus: 'weak',
      sourceConfidenceTier: 'INSUFFICIENT',
      sourceVerificationState: 'unverified',
      createdByAccountId: input.accountId,
      createdByRole: input.role,
      subjectId,
      metadata: { asked_in: 'shadow', auto_filed: true },
    });
    // The upsert returns an existing row unchanged, which may already be
    // closed. "Passed on" is true only while the row is open.
    const stored = await getShadowResearchRequirementById(input.organizationId, id);
    return stored?.status === 'open';
  } catch {
    console.error('SHADOW research filing failed');
    return false;
  }
}
