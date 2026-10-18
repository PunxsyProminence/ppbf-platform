import { NextResponse, type NextRequest } from 'next/server';

import { assertAthleteBelongsToOrganization, requireRole } from '@/src/server/pilot/access';
import {
  grantOwnMediaConsent,
  withdrawOwnMediaConsent,
} from '@/src/server/pilot/athleteMediaConsent';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import type { PilotPrincipal } from '@/src/server/pilot/auth';
import { queryOne, sanitizedSqlState } from '@/src/server/pilot/db';
import { PilotError, ValidationError } from '@/src/server/pilot/errors';
import { guardianLinkEnded } from '@/src/server/pilot/guardianAccess';
import {
  ownConsentCoversNewPublication,
  readOwnMediaConsent,
  type QueryExecutor,
} from '@/src/server/pilot/guardianConsent';
import { jsonError, requireOptionalBoolean, requirePrincipal } from '@/src/server/pilot/http';
import { recordMediaConsentAndSuppress } from '@/src/server/pilot/publication';

export const runtime = 'nodejs';

/*
 * THE ADULT ATHLETE'S OWN PHOTO AND VIDEO CONSENT (OD-2026-10-08-015).
 *
 * Athlete role only, and only their own record: the athlete id is the one
 * bound to their session, there is no athlete_id parameter, and the writer
 * re-checks inside its transaction that the signed-in account is that
 * athlete's own login (athleteMediaConsent.ts). Same shape as athlete/cycle.
 * Only an athlete who is 18 or older on the gym's day can record; a minor's
 * media consent stays with their guardians and this answers 403 with that
 * reason.
 *
 * A withdrawal, or a grant that leaves the athlete photo-only, takes their
 * already-published video down in the same transaction -- the rule a
 * guardian's withdrawal (owner decision 2026-08-14) and photo-only grant
 * (Jason 2026-10-05, "A: Retract (Recommended)") already follow, through the
 * same publication.ts recordMediaConsentAndSuppress.
 */

const ENTITY_TYPE = 'athlete_media_consent';

async function requireOwnAthleteId(principal: PilotPrincipal): Promise<string> {
  if (!principal.athleteId) throw new ValidationError('This account is not linked to an athlete record.');
  // A session that outlived the athlete's deletion carries the same id; the
  // live row is required too (OD-2026-09-29-002 item 10).
  await assertAthleteBelongsToOrganization(principal.organizationId, principal.athleteId);
  return principal.athleteId;
}

// A lost audit row must not tell the athlete their decision failed when it
// committed: the same non-fatal doctrine as parent/consent.
async function auditEvent(event: Parameters<typeof writePilotAuditEvent>[0]): Promise<void> {
  try {
    await writePilotAuditEvent(event);
  } catch (error) {
    const rawCode = error && typeof error === 'object' && 'code' in error ? (error as { code: unknown }).code : undefined;
    const code = sanitizedSqlState(rawCode);
    console.error({ event: 'athlete-media-consent-audit-write-failed', ...(code ? { code } : {}) });
  }
}

function event(
  principal: PilotPrincipal,
  athleteId: string,
  eventType: Parameters<typeof writePilotAuditEvent>[0]['event_type'],
  entityType: string,
  entityId: string,
  details: Record<string, unknown>,
): Parameters<typeof writePilotAuditEvent>[0] {
  return {
    event_type: eventType,
    actor_account_id: principal.accountId,
    actor_role: principal.role,
    organization_id: principal.organizationId,
    entity_type: entityType,
    entity_id: entityId,
    details: entityType === ENTITY_TYPE ? details : { ...details, athlete_id: athleteId },
    shadow_mirror: false,
  };
}

const SWEEPS = {
  withdrawn: {
    reason: 'athlete_consent_withdrawn',
    failedAction: 'consent_withdrawal_suppression_failed',
    retractedAction: 'publication_retracted_on_athlete_consent_withdrawal',
  },
  photo_only: {
    reason: 'athlete_consent_photo_only',
    failedAction: 'consent_photo_only_suppression_failed',
    retractedAction: 'publication_retracted_on_athlete_consent_photo_only',
  },
} as const;

/** null: the write and the takedown rolled back together; nothing changed. */
async function recordWithSweep(
  principal: PilotPrincipal,
  athleteId: string,
  cause: keyof typeof SWEEPS,
  write: (transaction: QueryExecutor) => Promise<string>,
  consentEvent: Parameters<typeof writePilotAuditEvent>[0],
): Promise<string[] | null> {
  const sweep = SWEEPS[cause];
  let publicationIds: string[];
  try {
    ({ publicationIds } = await recordMediaConsentAndSuppress({
      organizationId: principal.organizationId,
      athleteId,
      suppressedByAccountId: principal.accountId,
      reason: sweep.reason,
      write,
      exclusiveConsentSet: true,
    }));
  } catch (error) {
    // A refusal of the write itself (not an adult, not the own login) is not
    // a failed sweep: it reaches jsonError as the 403 it is.
    if (error instanceof PilotError) throw error;
    const rawCode = error && typeof error === 'object' && 'code' in error ? (error as { code: unknown }).code : undefined;
    const code = sanitizedSqlState(rawCode);
    console.error({ event: 'athlete-media-consent-suppression-failed', cause, ...(code ? { code } : {}) });
    await auditEvent(event(principal, athleteId, 'update', ENTITY_TYPE, athleteId, {
      action: sweep.failedAction,
      rolled_back: true,
      ...(code ? { code } : {}),
    }));
    return null;
  }
  await auditEvent(consentEvent);
  for (const publicationId of publicationIds) {
    await auditEvent(event(principal, athleteId, 'update', 'video_publication', publicationId, { action: sweep.retractedAction }));
  }
  return publicationIds;
}

// Never cached: a consent decision on what may be a shared tablet.
const NO_STORE = { 'Cache-Control': 'private, no-store' };

// Refusals too: "you are under 18" is still about the person holding the tablet.
function noStore(response: NextResponse): NextResponse {
  response.headers.set('Cache-Control', 'private, no-store');
  return response;
}

async function view(organizationId: string, athleteId: string, extra: Record<string, unknown> = {}) {
  const athlete = await queryOne<{ dob: string | null }>(
    `select to_char(dob, 'YYYY-MM-DD') as dob from pilot.athletes
      where organization_id = $1 and athlete_id = $2 and deleted_at is null`,
    [organizationId, athleteId],
  );
  const isAdult = athlete !== null && guardianLinkEnded(athlete.dob);
  const own = isAdult ? await readOwnMediaConsent(organizationId, athleteId) : null;
  return NextResponse.json(
    {
      is_adult: isAdult,
      consent: own && {
        status: own.status,
        covers_video: own.coversVideo,
        public_use_allowed: own.publicUseAllowed,
        recorded_at: own.signedAt,
      },
      counts_for_new_publication: isAdult && ownConsentCoversNewPublication(own),
      ...extra,
    },
    { headers: NO_STORE },
  );
}

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['athlete']);
    const athleteId = await requireOwnAthleteId(principal);
    return await view(principal.organizationId, athleteId);
  } catch (error) {
    return noStore(jsonError(error));
  }
}

/** { decision: 'grant', covers_video?, public_use_allowed? } or { decision: 'withdraw' }. */
export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['athlete']);
    const athleteId = await requireOwnAthleteId(principal);
    const organizationId = principal.organizationId;
    const base = { organizationId, athleteId, recordedByAccountId: principal.accountId };

    const body = ((await request.json().catch(() => null)) ?? {}) as Record<string, unknown>;
    if (body.decision === 'grant') {
      // Absent takes the documented default (photo and video, gym-only use),
      // as on the guardian's form; present must be a real boolean.
      const coversVideo = requireOptionalBoolean(body.covers_video, 'covers_video', true);
      const publicUseAllowed = requireOptionalBoolean(body.public_use_allowed, 'public_use_allowed', false);
      const grant = { ...base, coversVideo, publicUseAllowed };
      const granted = event(principal, athleteId, 'consent_granted', ENTITY_TYPE, athleteId, {
        covers_video: coversVideo,
        public_use_allowed: publicUseAllowed,
      });
      if (!coversVideo) {
        const retracted = await recordWithSweep(principal, athleteId, 'photo_only', (tx) => grantOwnMediaConsent(grant, tx), granted);
        if (retracted === null) {
          return NextResponse.json(
            { ok: false, error: 'Your consent for photos only was not recorded: it is saved together with taking down your already-published video, and that did not complete. Nothing was changed. Try again, or ask your gym admin.' },
            { status: 500, headers: NO_STORE },
          );
        }
        return await view(organizationId, athleteId, { ok: true, retracted_publication_ids: retracted });
      }
      await grantOwnMediaConsent(grant);
      await auditEvent(granted);
      return await view(organizationId, athleteId, { ok: true });
    }
    if (body.decision === 'withdraw') {
      const withdrawn = event(principal, athleteId, 'consent_withdrawn', ENTITY_TYPE, athleteId, {});
      const retracted = await recordWithSweep(principal, athleteId, 'withdrawn', (tx) => withdrawOwnMediaConsent(base, tx), withdrawn);
      if (retracted === null) {
        return NextResponse.json(
          { ok: false, error: 'Your withdrawal was not recorded: it is saved together with taking down your already-published media, and that did not complete. Nothing was changed. Withdraw again to retry, or ask your gym admin.' },
          { status: 500, headers: NO_STORE },
        );
      }
      return await view(organizationId, athleteId, { ok: true, retracted_publication_ids: retracted });
    }
    throw new ValidationError('decision must be grant or withdraw.');
  } catch (error) {
    return noStore(jsonError(error));
  }
}
