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
export const SHADOW_UNANSWERED_EVENT = 'shadow_unanswered_question';
export const SHADOW_UNANSWERED_ENTITY = 'shadow_question';

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
 * caller can say "passed to the coaches" truthfully. Never throws: a failed
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
  // A non-staff asker's row is their own: keyed on the account, so it cannot
  // pre-claim a key a coach files an athlete's question under, and a second
  // asker of the same words still gets a row they can read.
  const key = staff ? base : `acct:${input.accountId}:${base}`;
  try {
    const id = await createShadowResearchRequirement({
      organizationId: input.organizationId,
      sourceEventName: SHADOW_UNANSWERED_EVENT,
      sourceEntityType: SHADOW_UNANSWERED_ENTITY,
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
    // closed. "Passed to the coaches" is true only while the row is open.
    const stored = await getShadowResearchRequirementById(input.organizationId, id);
    return stored?.status === 'open';
  } catch {
    console.error('SHADOW research filing failed');
    return false;
  }
}
