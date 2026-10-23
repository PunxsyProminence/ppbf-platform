// Labels the two research screens share (/research and /research/review), so
// one state is never named two ways. Issue #345 section 1: each Needs Evidence
// item shows its created date, source context, evidence label and each
// submitted source's evidence-review state.

import { formatGymDateShort } from '@/src/lib/gymTime';

/* A Library source's own evidence review on /evidence. A submission's
   applicability verdict says whether a source answers the question; only
   these say whether SHADOW may cite it. */
export type EvidenceApprovalState = 'pending_review' | 'approved' | 'rejected';
export type EvidenceVerificationState = 'unverified' | 'verified';

export const EVIDENCE_APPROVAL_LABEL: Record<EvidenceApprovalState, string> = {
  pending_review: 'Pending Review',
  approved: 'Approved',
  rejected: 'Rejected',
};

export const EVIDENCE_VERIFICATION_LABEL: Record<EvidenceVerificationState, string> = {
  unverified: 'Unverified',
  verified: 'Verified',
};

function labelFor(labels: Record<string, string>, key: unknown): string | null {
  return typeof key === 'string' && Object.prototype.hasOwnProperty.call(labels, key) ? labels[key] : null;
}

/** "Pending Review · Unverified", or null when the source's review was not read. */
export function evidenceReviewLabel(
  source: { approval_state?: EvidenceApprovalState; verification_state?: EvidenceVerificationState } | null | undefined,
): string | null {
  const approval = labelFor(EVIDENCE_APPROVAL_LABEL, source?.approval_state);
  const verification = labelFor(EVIDENCE_VERIFICATION_LABEL, source?.verification_state);
  return approval && verification ? `${approval} · ${verification}` : null;
}

/** The fields of a requirement row these labels read. A family reader's row
 *  (researchFamilyView.ts) carries none but created_at. */
export interface RequirementRecordFields {
  created_at?: string | null;
  source_entity_type?: string | null;
  evidence_label?: string | null;
  subject_id?: string | null;
  created_by_account_id?: string | null;
  metadata?: Record<string, unknown> | null;
}

/* Where a requirement came from, in words. PROPOSED copy. The row's
   source_entity_id is never shown: its writers put an athlete id in it (a
   Library claim, a staff question about an athlete) or an account id (an
   athlete's or parent's own question, shadowResearchFiling.ts). */
const SOURCE_ENTITY_LABEL: Record<string, string> = {
  shadow_library_claim: 'Library claim',
  shadow_library_capability_map: 'Library capability check',
  intake_case: 'Intake case',
  shadow_question: 'Question asked in SHADOW',
  shadow_asker_question: 'Question from an athlete or parent',
  shadow_learning_event: 'SHADOW feedback',
  formula_id: 'Formula',
  manual_note: 'Manual note',
};

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

// A staff account id is a sign-in email (researchFamilyView.ts).
const ACCOUNT_ID_SHAPE = /\S@\S/;

/** Does this text carry an athlete or account id the row names? */
function carriesAnId(row: RequirementRecordFields, value: string): boolean {
  if (ACCOUNT_ID_SHAPE.test(value)) return true;
  const metadata = row.metadata ?? {};
  return [row.subject_id, metadata.subject_id, metadata.athlete_id, metadata.asker_athlete_id, row.created_by_account_id]
    .map(text)
    .some((id) => id !== null && value.includes(id));
}

/** Is the row about an athlete (the subject keys shadowResearch.ts reads)? */
function aboutAnAthlete(row: RequirementRecordFields): boolean {
  const metadata = row.metadata ?? {};
  return [row.subject_id, metadata.subject_id, metadata.athlete_id].some((id) => text(id) !== null);
}

/** "Library claim about an athlete": the kind of source, never its id or the athlete's. */
export function requirementContextLabel(row: RequirementRecordFields): string | null {
  const type = text(row.source_entity_type);
  if (type === null) return null;
  const kind = labelFor(SOURCE_ENTITY_LABEL, type) ?? (carriesAnId(row, type) ? null : type.replaceAll('_', ' '));
  if (kind === null) return null;
  return aboutAnAthlete(row) ? `${kind} about an athlete` : kind;
}

/** The stored evidence label, unless it is or holds an id. A Library claim's
 *  label is the athlete it is about (shadowLibrary.ts), so it is never shown. */
export function displayableEvidenceLabel(row: RequirementRecordFields): string | null {
  const label = text(row.evidence_label);
  if (label === null || row.source_entity_type === 'shadow_library_claim') return null;
  return carriesAnId(row, label) ? null : label;
}

/** "Created: Aug 10, 2026 | Context: Intake case about an athlete | Evidence
 *  label: ..." in the gym's time zone; parts with nothing to say are left out. */
export function requirementRecordLine(row: RequirementRecordFields): string | null {
  const created = formatGymDateShort(row.created_at);
  const context = requirementContextLabel(row);
  const label = displayableEvidenceLabel(row);
  const parts = [
    created ? `Created: ${created}` : null,
    context ? `Context: ${context}` : null,
    label ? `Evidence label: ${label}` : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(' | ') : null;
}
