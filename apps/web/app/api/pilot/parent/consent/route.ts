import { NextResponse, type NextRequest } from 'next/server';

import {
  callerParentIdSet,
  grantMediaConsent,
  listConsentForGuardian,
  resolveActingParent,
  withdrawMediaConsent,
  type QueryExecutor,
} from '@/src/server/pilot/guardianConsent';
import { getAthleteById } from '@/src/server/pilot/entities';
import { guardianAthleteIds } from '@/src/server/pilot/guardianAccess';
import { recordMediaConsentAndSuppress } from '@/src/server/pilot/publication';
import { hiddenNotFound, jsonError, requireOptionalBoolean, requirePrincipal, requireRole } from '@/src/server/pilot/http';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { sanitizedSqlState } from '@/src/server/pilot/db';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

export const runtime = 'nodejs';

// A lost audit row must not tell a guardian their consent decision failed
// when it in fact committed -- same non-fatal-audit doctrine as
// training-holds' auditHoldEvent and video-compliance's auditComplianceEvent.
async function auditConsentEvent(event: Parameters<typeof writePilotAuditEvent>[0]): Promise<void> {
  try {
    await writePilotAuditEvent(event);
  } catch (error) {
    const rawCode = error && typeof error === 'object' && 'code' in error ? (error as { code: unknown }).code : undefined;
    const code = sanitizedSqlState(rawCode);
    console.error({
      event: 'guardian-consent-audit-write-failed',
      consent_event_type: event.event_type,
      ...(code ? { code } : {}),
    });
  }
}

/*
 * THE SUPPRESSION SWEEP, for both consent changes that take published video
 * down: a withdrawal (owner decision 2026-08-14) and a grant that leaves this
 * guardian photo-only (Jason, 2026-10-05: "A: Retract (Recommended)"; every
 * publication is video). The staff writer (admin/athlete-consent) runs the same sweep.
 *
 * THE CONSENT CHANGE AND THE SWEEP COMMIT TOGETHER OR NOT AT ALL
 * (publication.ts recordMediaConsentAndSuppress). Before, the consent row
 * committed first and the sweep ran in a second transaction, so a failed sweep
 * left a photo-only or withdrawn consent on file with the video still live.
 * Now a failure rolls both back: the consent is what it was, the video is what
 * it was, and the caller answers a loud 500 saying nothing was recorded.
 * A failure is still logged and durably audited here (that row is written
 * outside the rolled-back transaction, so an auditor can see the attempt).
 * On success the consent event is audited, then each retracted publication.
 */
const SWEEPS = {
  withdrawn: {
    reason: 'guardian_consent_withdrawn',
    failedEvent: 'consent-withdrawal-suppression-failed',
    failedAction: 'consent_withdrawal_suppression_failed',
    retractedAction: 'publication_retracted_on_consent_withdrawal',
  },
  photo_only: {
    reason: 'guardian_consent_photo_only',
    failedEvent: 'consent-photo-only-suppression-failed',
    failedAction: 'consent_photo_only_suppression_failed',
    retractedAction: 'publication_retracted_on_consent_photo_only',
  },
} as const;

async function recordConsentChangeWithSweep(
  principal: PilotPrincipal,
  athleteId: string,
  parentId: string,
  cause: keyof typeof SWEEPS,
  write: (transaction: QueryExecutor) => Promise<string>,
  consentEvent: Parameters<typeof writePilotAuditEvent>[0],
): Promise<{ waiverId: string; publicationIds: string[] } | null> {
  const sweep = SWEEPS[cause];
  let result: { waiverId: string; publicationIds: string[] };
  try {
    result = await recordMediaConsentAndSuppress({
      organizationId: principal.organizationId,
      athleteId,
      suppressedByAccountId: principal.accountId,
      reason: sweep.reason,
      write,
    });
  } catch (error) {
    const rawCode = error && typeof error === 'object' && 'code' in error ? (error as { code: unknown }).code : undefined;
    const code = sanitizedSqlState(rawCode);
    console.error({ event: sweep.failedEvent, athlete_id: athleteId, ...(code ? { code } : {}) });
    await auditConsentEvent({
      event_type: 'update',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: principal.organizationId,
      entity_type: 'guardian_media_consent',
      entity_id: athleteId,
      details: { action: sweep.failedAction, parent_id: parentId, rolled_back: true, ...(code ? { code } : {}) },
      shadow_mirror: false,
    });
    return null;
  }

  await auditConsentEvent(consentEvent);
  for (const publicationId of result.publicationIds) {
    await auditConsentEvent({
      event_type: 'update',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: principal.organizationId,
      entity_type: 'video_publication',
      entity_id: publicationId,
      details: { action: sweep.retractedAction, athlete_id: athleteId, parent_id: parentId },
      shadow_mirror: false,
    });
  }
  return result;
}

type ConsentDecision = 'grant' | 'withdraw';

const DECISIONS = new Set<ConsentDecision>(['grant', 'withdraw']);

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['parent']);

    const body = (await request.json().catch(() => null)) as
      | { athlete_id?: unknown; decision?: unknown; covers_video?: unknown; public_use_allowed?: unknown }
      | null;
    const athleteId = typeof body?.athlete_id === 'string' ? body.athlete_id.trim() : '';
    const rawDecision: unknown = body?.decision;

    if (!athleteId) {
      throw new Error('Missing athlete_id');
    }
    if (!DECISIONS.has(rawDecision as ConsentDecision)) {
      throw new Error('Unsupported decision: expected "grant" or "withdraw"');
    }
    const decision = rawDecision as ConsentDecision;

    // The one authorization check this route exists to make: this account
    // must actually be a guardian of this athlete. A caller-supplied
    // athlete_id being well-formed proves nothing about who it belongs to.
    const ownAthleteIds = await guardianAthleteIds(principal.organizationId, principal.accountId);
    if (!ownAthleteIds.includes(athleteId)) {
      return hiddenNotFound();
    }

    // Athlete-scoped: resolves the specific pilot.parents row this account
    // holds THAT IS a real guardian_links guardian of athleteId, never just
    // "the account's first parent row" (see resolveActingParent's header).
    const actingParent = await resolveActingParent(principal.organizationId, principal.accountId, athleteId);
    if (!actingParent) {
      // The ownAthleteIds check above already confirmed this account guards
      // athleteId through SOME parent row -- reaching here means that
      // parent row exists in guardian_links but not in pilot.parents (or
      // isn't linked to this specific account), a data inconsistency, not a
      // caller error, so it must not read as "missing consent".
      throw new Error('Unsupported: no guardian record on file for this account');
    }

    if (decision === 'grant') {
      // ABSENT TAKES THE DOCUMENTED DEFAULT; PRESENT MUST BE A REAL BOOLEAN.
      //
      // covers_video defaulting to true when omitted is deliberate and
      // unchanged -- /api/pilot/video/[videoId]'s consent gate is built on
      // photo-only being an affirmative act rather than an absence, and the
      // column defaults to true for the same reason.
      //
      // The rule itself, and the string-"false" defect that made it strict,
      // now live with requireOptionalBoolean in http.ts -- shared with the
      // admin/coach writer, which records the same two columns read by the
      // same gate.
      const coversVideo = requireOptionalBoolean(body?.covers_video, 'covers_video', true);
      const publicUseAllowed = requireOptionalBoolean(body?.public_use_allowed, 'public_use_allowed', false);
      const grant = {
        organizationId: principal.organizationId,
        athleteId,
        parentId: actingParent.parentId,
        signedByName: actingParent.fullName,
        recordedByAccountId: principal.accountId,
        coversVideo,
        publicUseAllowed,
      };
      const grantedEvent: Parameters<typeof writePilotAuditEvent>[0] = {
        event_type: 'consent_granted',
        actor_account_id: principal.accountId,
        actor_role: principal.role,
        organization_id: principal.organizationId,
        entity_type: 'guardian_media_consent',
        entity_id: athleteId,
        details: { parent_id: actingParent.parentId, covers_video: coversVideo, public_use_allowed: publicUseAllowed },
        shadow_mirror: false,
      };

      // Photo-only means this athlete's video is no longer covered, so
      // already-published video comes down in this same request -- in the
      // same transaction as the consent row (recordConsentChangeWithSweep).
      if (coversVideo === false) {
        const changed = await recordConsentChangeWithSweep(
          principal,
          athleteId,
          actingParent.parentId,
          'photo_only',
          (transaction) => grantMediaConsent(grant, transaction),
          grantedEvent,
        );
        if (changed === null) {
          return NextResponse.json(
            {
              ok: false,
              error: 'Your consent for photos only was not recorded, because taking down already-published video failed. Nothing was changed. Submit it again to retry, or contact your organization admin.',
              athlete_id: athleteId,
              decision,
            },
            { status: 500 },
          );
        }
        return NextResponse.json({ ok: true, athlete_id: athleteId, decision, retracted_publication_ids: changed.publicationIds });
      }

      await grantMediaConsent(grant);
      await auditConsentEvent(grantedEvent);
    } else {
      // One guardian's withdrawal invalidates consent, and content already
      // published must become non-distributable immediately (owner decision
      // 2026-08-14) -- so the sweep runs here, in the withdrawal request and
      // in the withdrawal's own transaction, not on a timer. See
      // recordConsentChangeWithSweep for its failure contract.
      const changed = await recordConsentChangeWithSweep(
        principal,
        athleteId,
        actingParent.parentId,
        'withdrawn',
        (transaction) =>
          withdrawMediaConsent(
            {
              organizationId: principal.organizationId,
              athleteId,
              parentId: actingParent.parentId,
              signedByName: actingParent.fullName,
              recordedByAccountId: principal.accountId,
            },
            transaction,
          ),
        {
          event_type: 'consent_withdrawn',
          actor_account_id: principal.accountId,
          actor_role: principal.role,
          organization_id: principal.organizationId,
          entity_type: 'guardian_media_consent',
          entity_id: athleteId,
          details: { parent_id: actingParent.parentId },
          shadow_mirror: false,
        },
      );
      if (changed === null) {
        return NextResponse.json(
          {
            ok: false,
            error: 'Your consent withdrawal was not recorded, because suppressing already-published media failed. Nothing was changed. Withdraw again to retry, or contact your organization admin.',
            athlete_id: athleteId,
            decision,
          },
          { status: 500 },
        );
      }

      return NextResponse.json({
        ok: true,
        athlete_id: athleteId,
        decision,
        retracted_publication_ids: changed.publicationIds,
      });
    }

    return NextResponse.json({ ok: true, athlete_id: athleteId, decision });
  } catch (error) {
    return jsonError(error);
  }
}
