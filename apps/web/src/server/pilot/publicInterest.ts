import { query, queryOne } from './db';
import { getPilotDefaultOrganizationId } from './env';

export type VisitorType =
  | 'Athlete / Participant'
  | 'Parent / Guardian'
  | 'Volunteer'
  | 'Coach'
  | 'Donor / Sponsor'
  | 'Board / Community Partner'
  | 'General Visitor';

export type ProgramInterest =
  | 'Boxing / Fitness'
  | 'Youth Development'
  | 'Adaptive Training'
  | 'Competition Track'
  | 'Parent Support'
  | 'Volunteer Support'
  | 'Sponsorship / Partnership'
  | 'General Information';

export type PreferredContactMethod = 'Email' | 'Phone' | 'Either';

export type PublicInterestReviewState = 'new' | 'contacted' | 'archived';

// Kept in one place so the API route's validation can never drift from what
// the public form actually offers -- an unauthenticated endpoint must not
// trust the client to only ever send one of these values.
export const VISITOR_TYPES: readonly VisitorType[] = [
  'Athlete / Participant',
  'Parent / Guardian',
  'Volunteer',
  'Coach',
  'Donor / Sponsor',
  'Board / Community Partner',
  'General Visitor',
];

export const PROGRAM_INTERESTS: readonly ProgramInterest[] = [
  'Boxing / Fitness',
  'Youth Development',
  'Adaptive Training',
  'Competition Track',
  'Parent Support',
  'Volunteer Support',
  'Sponsorship / Partnership',
  'General Information',
];

export const CONTACT_METHODS: readonly PreferredContactMethod[] = ['Email', 'Phone', 'Either'];

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface PublicInterestSubmissionInput {
  fullName: string;
  email: string;
  phone?: string | null;
  visitorType: string;
  programInterest: string;
  preferredContactMethod: string;
  message?: string | null;
  consentToContact: boolean;
  submittedIp?: string | null;
}

export interface PublicInterestSubmissionRow {
  submission_id: string;
  organization_id: string;
  full_name: string;
  email: string;
  phone: string | null;
  visitor_type: string;
  program_interest: string;
  preferred_contact_method: PreferredContactMethod;
  message: string | null;
  consent_to_contact: boolean;
  review_state: PublicInterestReviewState;
  reviewed_by_account_id: string | null;
  reviewed_at: string | null;
  created_at: string;
}

export class PublicInterestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PublicInterestValidationError';
  }
}

// Every field here is attacker-controlled -- this is the one unauthenticated
// write path in the whole app. Validate everything server-side; the client
// enum lists exist for UX only and must never be trusted.
export function validatePublicInterestSubmission(
  input: PublicInterestSubmissionInput,
): void {
  const fullName = input.fullName.trim();
  if (fullName.length < 1 || fullName.length > 200) {
    throw new PublicInterestValidationError('Full name must be between 1 and 200 characters.');
  }

  const email = input.email.trim();
  if (email.length < 3 || email.length > 320 || !EMAIL_PATTERN.test(email)) {
    throw new PublicInterestValidationError('A valid email address is required.');
  }

  if (input.phone != null && input.phone.trim().length > 40) {
    throw new PublicInterestValidationError('Phone number is too long.');
  }

  if (!VISITOR_TYPES.includes(input.visitorType as VisitorType)) {
    throw new PublicInterestValidationError('Unrecognized visitor type.');
  }

  if (!PROGRAM_INTERESTS.includes(input.programInterest as ProgramInterest)) {
    throw new PublicInterestValidationError('Unrecognized program interest.');
  }

  if (!CONTACT_METHODS.includes(input.preferredContactMethod as PreferredContactMethod)) {
    throw new PublicInterestValidationError('Unrecognized preferred contact method.');
  }

  if (input.message != null && input.message.length > 4000) {
    throw new PublicInterestValidationError('Message is too long (4,000 character limit).');
  }

  if (!input.consentToContact) {
    throw new PublicInterestValidationError('Consent to be contacted is required.');
  }
}

export async function createPublicInterestSubmission(
  input: PublicInterestSubmissionInput,
): Promise<PublicInterestSubmissionRow> {
  validatePublicInterestSubmission(input);

  const row = await queryOne<PublicInterestSubmissionRow>(
    `insert into pilot.public_interest_submissions
       (organization_id, full_name, email, phone, visitor_type, program_interest,
        preferred_contact_method, message, consent_to_contact, submitted_ip)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     returning submission_id, organization_id, full_name, email, phone, visitor_type,
       program_interest, preferred_contact_method, message, consent_to_contact,
       review_state, reviewed_by_account_id, reviewed_at, created_at`,
    [
      getPilotDefaultOrganizationId(),
      input.fullName.trim(),
      input.email.trim(),
      input.phone?.trim() || null,
      input.visitorType,
      input.programInterest,
      input.preferredContactMethod,
      input.message?.trim() || null,
      input.consentToContact,
      input.submittedIp?.trim() || null,
    ],
  );

  if (!row) {
    throw new Error('Unable to record public interest submission.');
  }

  return row;
}

export async function listPublicInterestSubmissions(input: {
  organizationId: string;
  reviewState?: PublicInterestReviewState;
  limit?: number;
}): Promise<PublicInterestSubmissionRow[]> {
  const limit = Math.max(1, Math.min(200, Math.trunc(input.limit ?? 50)));

  return query<PublicInterestSubmissionRow>(
    `select submission_id, organization_id, full_name, email, phone, visitor_type,
       program_interest, preferred_contact_method, message, consent_to_contact,
       review_state, reviewed_by_account_id, reviewed_at, created_at
     from pilot.public_interest_submissions
     where organization_id = $1
       and ($2::text is null or review_state = $2)
     order by created_at desc
     limit $3`,
    [input.organizationId, input.reviewState ?? null, limit],
  );
}

export async function updatePublicInterestSubmissionReviewState(input: {
  organizationId: string;
  submissionId: string;
  reviewState: PublicInterestReviewState;
  reviewedByAccountId: string;
}): Promise<PublicInterestSubmissionRow | null> {
  return queryOne<PublicInterestSubmissionRow>(
    `update pilot.public_interest_submissions
     set review_state = $3,
         reviewed_by_account_id = $4,
         reviewed_at = now()
     where organization_id = $1 and submission_id = $2
     returning submission_id, organization_id, full_name, email, phone, visitor_type,
       program_interest, preferred_contact_method, message, consent_to_contact,
       review_state, reviewed_by_account_id, reviewed_at, created_at`,
    [input.organizationId, input.submissionId, input.reviewState, input.reviewedByAccountId],
  );
}
