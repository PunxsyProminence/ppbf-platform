import { lockConsentSet } from './consentSetLock';
import { withTransaction } from './db';
import { ForbiddenError, NotFoundError } from './errors';
import { guardianLinkEnded } from './guardianAccess';
import {
  ATHLETE_SELF_SIGNED_BY_ROLE,
  MEDIA_CONSENT_WAIVER_TYPE,
  type QueryExecutor,
} from './guardianConsent';
import { upsertWaiverWithClient } from './intake';

/*
 * THE ADULT ATHLETE'S OWN MEDIA CONSENT -- the writer. Owner ruling
 * OD-2026-10-08-015 (Jason, "A: adult consents for themselves
 * (Recommended)"): at 18 guardian-era consent stops counting for a new
 * publication, and the adult consents for themselves. The reader and the
 * publication gate are in guardianConsent.ts (readOwnMediaConsent,
 * assertNewPublicationConsentPath); the row shape is described there.
 *
 * ONLY THE ATHLETE, FOR THEMSELVES. The route hands this the athlete id bound
 * to the signed-in athlete's session and never takes one from the caller;
 * this writer then requires, inside its transaction, that the recording
 * account IS that athlete's own live login (pilot.accounts.athlete_id, role
 * athlete, not deleted). No staff or guardian path writes here.
 *
 * ONLY AN ADULT. 18 or older on the gym's day (guardianLinkEnded, the same
 * day the guardian link goes dormant), decided inside the transaction from
 * the athlete row as committed. An unknown date of birth reads as a minor and
 * is refused, as everywhere else. A minor's media consent stays with their
 * guardians.
 *
 * LOCK: the consent-set lock EXCLUSIVE, first. Every new-publication reader
 * takes it SHARED (assertNewPublicationConsentPath with a client), so a
 * publish, approve or reopen and this write cannot overlap even when the
 * athlete has no guardian link row to lock: whichever starts second waits and
 * then reads the other's committed result. When this runs inside
 * recordMediaConsentAndSuppress (withdrawal, photo-only), that function takes
 * the exclusive lock before its link locks (exclusiveConsentSet) and the call
 * here is then a lock this transaction already holds.
 */

export const ATHLETE_NOT_ADULT_MESSAGE =
  'Your photo and video consent is decided by your guardian until you are 18. From your 18th birthday you record it yourself here.';

export const NOT_OWN_LOGIN_MESSAGE =
  'Only the athlete, signed in on their own account, can record their own photo and video consent.';

export class AthleteNotAdultError extends ForbiddenError {
  constructor() {
    super(ATHLETE_NOT_ADULT_MESSAGE, 'ATHLETE_NOT_ADULT');
  }
}

export interface OwnConsentWriteParams {
  organizationId: string;
  athleteId: string;
  /** The signed-in account; must be this athlete's own login. */
  recordedByAccountId: string;
}

async function writeOwnConsent(
  params: OwnConsentWriteParams,
  decision: { status: 'signed' | 'withdrawn'; coversVideo: boolean; publicUseAllowed: boolean },
  transaction?: QueryExecutor,
): Promise<string> {
  const write = async (client: QueryExecutor) => {
    await lockConsentSet(client, params.organizationId, params.athleteId, 'exclusive');

    const { rows: athletes } = await client.query<{ full_name: string; dob: string | null }>(
      `select full_name, to_char(dob, 'YYYY-MM-DD') as dob from pilot.athletes
        where organization_id = $1 and athlete_id = $2 and deleted_at is null`,
      [params.organizationId, params.athleteId],
    );
    const athlete = athletes[0];
    if (!athlete) throw new NotFoundError('Athlete not found.');

    const { rows: logins } = await client.query<{ account_id: string }>(
      `select account_id from pilot.accounts
        where account_id = $1 and organization_id = $2 and athlete_id = $3
          and role = 'athlete' and deleted_at is null`,
      [params.recordedByAccountId, params.organizationId, params.athleteId],
    );
    if (logins.length === 0) throw new ForbiddenError(NOT_OWN_LOGIN_MESSAGE, 'NOT_OWN_LOGIN');

    if (!guardianLinkEnded(athlete.dob)) throw new AthleteNotAdultError();

    return upsertWaiverWithClient(client, {
      organizationId: params.organizationId,
      athleteId: params.athleteId,
      waiverType: MEDIA_CONSENT_WAIVER_TYPE,
      signedByName: athlete.full_name,
      signedByRole: ATHLETE_SELF_SIGNED_BY_ROLE,
      signedAt: new Date().toISOString(),
      consentVersion: 'v1',
      status: decision.status,
      parentId: null,
      coversVideo: decision.coversVideo,
      publicUseAllowed: decision.publicUseAllowed,
      recordedByAccountId: params.recordedByAccountId,
    });
  };
  return transaction ? write(transaction) : withTransaction(write);
}

export async function grantOwnMediaConsent(
  params: OwnConsentWriteParams & { coversVideo: boolean; publicUseAllowed: boolean },
  transaction?: QueryExecutor,
): Promise<string> {
  return writeOwnConsent(
    params,
    { status: 'signed', coversVideo: params.coversVideo, publicUseAllowed: params.publicUseAllowed },
    transaction,
  );
}

export async function withdrawOwnMediaConsent(
  params: OwnConsentWriteParams,
  transaction?: QueryExecutor,
): Promise<string> {
  return writeOwnConsent(params, { status: 'withdrawn', coversVideo: false, publicUseAllowed: false }, transaction);
}
