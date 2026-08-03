import { FEEDBACK_ACKNOWLEDGEMENT } from '@/lib/feedbackWording';

import type { PilotRole } from './contracts';
import { query } from './db';
import { scanForSafetyLanguage } from './feedbackSafetyScan';

/**
 * The comment box: what any signed-in person tells the gym is broken,
 * frustrating, missing, or worth building.
 *
 * pilot.feedback_submissions is owned by
 * infra/azure/pilot_slice_postgres_feedback_migration.sql and applied through
 * the migration runner. Nothing here creates schema.
 *
 * TWO THINGS IN THIS FILE ARE LOAD-BEARING.
 *
 * 1. THE ROUTE IS DECIDED ONCE, AT WRITE TIME. decideFeedbackRoute runs in
 *    createFeedbackSubmission and the answer is stored. No read path re-derives
 *    it, and the database's freeze trigger refuses to let anything rewrite it.
 *    Detection rules are meant to be edited; a child who was told a person
 *    would read their words does not get reclassified out of that queue months
 *    later because a regex moved.
 *
 * 2. DE-IDENTIFICATION LIVES IN THE QUERY. The platform owner reads every
 *    gym's submissions in order to see whether a frustration is one person or a
 *    pattern; that needs the role and the gym and nothing else. So the owner's
 *    statement does not select an account column, does not join pilot.accounts,
 *    and cannot be refactored into leaking one -- rather than a component that
 *    happens not to render a name today.
 */

export const FEEDBACK_KINDS = ['bug', 'idea', 'frustration', 'other'] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

export const FEEDBACK_ROUTES = ['product', 'safeguarding'] as const;
export type FeedbackRoute = (typeof FEEDBACK_ROUTES)[number];

export const FEEDBACK_TRIAGE_STATUSES = ['new', 'triaged', 'planned', 'declined', 'done'] as const;
export type FeedbackTriageStatus = (typeof FEEDBACK_TRIAGE_STATUSES)[number];

export const FEEDBACK_BODY_MAX_LENGTH = 4000;
export const FEEDBACK_NOTE_MAX_LENGTH = 2000;
const FEEDBACK_LIST_MAX_LIMIT = 200;
const FEEDBACK_LIST_DEFAULT_LIMIT = 50;

export function isFeedbackKind(value: unknown): value is FeedbackKind {
  return FEEDBACK_KINDS.includes(value as FeedbackKind);
}

export function isFeedbackRoute(value: unknown): value is FeedbackRoute {
  return FEEDBACK_ROUTES.includes(value as FeedbackRoute);
}

export function isFeedbackTriageStatus(value: unknown): value is FeedbackTriageStatus {
  return FEEDBACK_TRIAGE_STATUSES.includes(value as FeedbackTriageStatus);
}

/**
 * One gym's submission, with the person who wrote it named. Only that gym's own
 * administrators read this shape.
 *
 * submitter_name is null when the account has been removed, or when the account
 * carries no email and no athlete record. A reader shows the role in that case;
 * it never invents a stand-in name.
 */
export interface OrganizationFeedbackItem {
  submission_id: string;
  organization_id: string;
  submitted_by_account_id: string | null;
  submitted_by_role: PilotRole;
  submitter_name: string | null;
  kind: FeedbackKind;
  body: string;
  route: FeedbackRoute;
  triage_status: FeedbackTriageStatus;
  triage_note: string | null;
  triaged_at: string | null;
  created_at: string;
}

/**
 * The same submission as the platform owner sees it, across every gym: the
 * capacity the writer was in and the gym they were in, and no way back to the
 * person. There is no account id on this type because there is none in the
 * statement that builds it.
 */
export interface PlatformFeedbackItem {
  submission_id: string;
  organization_id: string;
  organization_name: string;
  submitted_by_role: PilotRole;
  kind: FeedbackKind;
  // NULL for every safeguarding row. PLATFORM_FEEDBACK_SQL withholds the body
  // on purpose -- what a child disclosed belongs to the gym handling it -- and
  // this type said `string`, so every consumer was written believing there was
  // always text to render. The admin queue drew an empty card because of it.
  body: string | null;
  route: FeedbackRoute;
  triage_status: FeedbackTriageStatus;
  created_at: string;
}

export interface FeedbackQueueFilter {
  route?: FeedbackRoute | null;
  triageStatus?: FeedbackTriageStatus | null;
  limit?: number;
}

// Both statements order safeguarding first regardless of age, then newest. An
// ordering that buried a child's disclosure under a week of feature requests
// would be a response-time problem, not a cosmetic one.
const ORGANIZATION_FEEDBACK_SQL = `
  select s.submission_id,
         s.organization_id,
         s.submitted_by_account_id,
         s.submitted_by_role,
         coalesce(athlete.full_name, account.login_email) as submitter_name,
         s.kind,
         s.body,
         s.route,
         s.triage_status,
         s.triage_note,
         s.triaged_at,
         s.created_at
  from pilot.feedback_submissions s
  left join pilot.accounts account
    on account.account_id = s.submitted_by_account_id
   and account.organization_id = s.organization_id
  left join pilot.athletes athlete
    on athlete.athlete_id = account.athlete_id
   and athlete.organization_id = s.organization_id
  where s.organization_id = $1
    and ($2::text is null or s.route = $2)
    and ($3::text is null or s.triage_status = $3)
  order by case when s.route = 'safeguarding' then 0 else 1 end, s.created_at desc
  limit $4`;

/**
 * The owner's cross-gym statement, for seeing whether a frustration is one
 * person or a pattern.
 *
 * It selects no account column and joins no table holding a name, an email, or
 * an athlete record, so there is no submitter identity for a later reader to
 * render by accident.
 *
 * A SAFEGUARDING BODY IS NEVER RETURNED HERE. De-identifying the columns is not
 * enough for those: a child's disclosure is about their own gym and routinely
 * names the adult in it, so the text re-identifies both of them however
 * anonymous the metadata is. The row still appears -- gym, role, date, triage
 * status -- because the owner is owed knowing a gym has safeguarding reports
 * open. The words belong to that gym's admin, who is the person who can act on
 * them. Product bodies pass through: those are feature complaints, and reading
 * them across gyms is the entire point of this query.
 *
 * Exported so a test can assert both properties against the SQL itself.
 */
export const PLATFORM_FEEDBACK_SQL = `
  select s.submission_id,
         s.organization_id,
         organization.organization_name,
         s.submitted_by_role,
         s.kind,
         case when s.route = 'safeguarding' then null else s.body end as body,
         s.route,
         s.triage_status,
         s.created_at
  from pilot.feedback_submissions s
  join pilot.organizations organization
    on organization.organization_id = s.organization_id
  where ($1::text is null or s.route = $1)
    and ($2::text is null or s.triage_status = $2)
  order by case when s.route = 'safeguarding' then 0 else 1 end, s.created_at desc
  limit $3`;

function clampLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit)) {
    return FEEDBACK_LIST_DEFAULT_LIMIT;
  }

  return Math.max(1, Math.min(Math.trunc(limit as number), FEEDBACK_LIST_MAX_LIMIT));
}

/**
 * Where a submission goes, decided from the capacity its writer was in and the
 * words they used.
 *
 * An athlete's submission is scanned, because the athlete is the minor. Every
 * other role's goes to the product queue. The database deliberately places no
 * role constraint on `route`, so the safeguarding lane stays reachable if the
 * gym later decides another role's words should be scanned too.
 */
export function decideFeedbackRoute(params: { role: PilotRole; body: string }): FeedbackRoute {
  if (params.role !== 'athlete') {
    return 'product';
  }

  return scanForSafetyLanguage(params.body).safeguarding ? 'safeguarding' : 'product';
}

/**
 * What the writer is told once their words are stored.
 *
 * ONE message, whatever the route. Two messages made the confirmation a
 * classifier: anyone could submit throwaway text and read the reply to learn
 * which phrasings reach a human -- including an adult a child might be
 * disclosing about, sitting beside them while they type. The route is a fact
 * about where the submission went, never a fact the submitter is handed back.
 *
 * It also drops a promise the platform cannot keep. Nothing here schedules a
 * conversation, so telling a child someone will come and talk with them was an
 * assurance no code backed. What is true of every submission is that a person
 * reads it, and that is what it says.
 *
 * The text itself lives in lib/feedbackWording so the admin queue can quote it
 * rather than restate it. Restating it is how the responder's screen came to
 * promise a conversation months after the child stopped being promised one.
 */
export function feedbackAcknowledgement(): string {
  return FEEDBACK_ACKNOWLEDGEMENT;
}

export interface CreatedFeedbackSubmission {
  submission_id: string;
  route: FeedbackRoute;
}

export async function createFeedbackSubmission(params: {
  organizationId: string;
  accountId: string;
  role: PilotRole;
  kind: FeedbackKind;
  body: string;
}): Promise<CreatedFeedbackSubmission> {
  const route = decideFeedbackRoute({ role: params.role, body: params.body });

  const rows = await query<{ submission_id: string }>(
    `insert into pilot.feedback_submissions
       (organization_id, submitted_by_account_id, submitted_by_role, kind, body, route)
     values ($1,$2,$3,$4,$5,$6)
     returning submission_id`,
    [params.organizationId, params.accountId, params.role, params.kind, params.body, route],
  );

  if (!rows[0]) {
    throw new Error('Feedback write verification failed');
  }

  return { submission_id: rows[0].submission_id, route };
}

// One gym's queue, submitters named, scoped by the organization the caller's
// session is in. There is no parameter for reading another gym's queue.
export async function listOrganizationFeedback(
  organizationId: string,
  filter: FeedbackQueueFilter = {},
): Promise<OrganizationFeedbackItem[]> {
  return query<OrganizationFeedbackItem>(ORGANIZATION_FEEDBACK_SQL, [
    organizationId,
    filter.route ?? null,
    filter.triageStatus ?? null,
    clampLimit(filter.limit),
  ]);
}

// Every gym's queue, de-identified. Reserved for the platform owner.
export async function listPlatformFeedback(
  filter: FeedbackQueueFilter = {},
): Promise<PlatformFeedbackItem[]> {
  return query<PlatformFeedbackItem>(PLATFORM_FEEDBACK_SQL, [
    filter.route ?? null,
    filter.triageStatus ?? null,
    clampLimit(filter.limit),
  ]);
}

export interface FeedbackTriageResult {
  submission_id: string;
  triage_status: FeedbackTriageStatus;
  triage_note: string | null;
  triaged_at: string | null;
}

/**
 * Triage is the only part of a submission that moves. The body, the route and
 * the capacity the writer was in are frozen by the database.
 *
 * A null note leaves whatever note is already there: an admin changing a status
 * has not thereby erased a colleague's handover note. Returns null when no row
 * in this organization carries that id, so the caller reports "nothing changed"
 * rather than a silent success -- and an admin cannot touch another gym's row
 * by pasting its id.
 */
export async function setFeedbackTriage(params: {
  organizationId: string;
  submissionId: string;
  triageStatus: FeedbackTriageStatus;
  note: string | null;
  triagedByAccountId: string;
}): Promise<FeedbackTriageResult | null> {
  const rows = await query<FeedbackTriageResult>(
    `update pilot.feedback_submissions
     set triage_status = $3,
         triage_note = coalesce($4, triage_note),
         triaged_by_account_id = $5,
         triaged_at = now(),
         updated_at = now()
     where organization_id = $1 and submission_id = $2
     returning submission_id, triage_status, triage_note, triaged_at`,
    [
      params.organizationId,
      params.submissionId,
      params.triageStatus,
      params.note,
      params.triagedByAccountId,
    ],
  );

  return rows[0] ?? null;
}
