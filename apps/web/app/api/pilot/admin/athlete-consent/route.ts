import { NextResponse, type NextRequest } from 'next/server';

import {
  checkGuardianMediaConsent,
  grantMediaConsent,
  listOrganizationConsentStatus,
  listOrganizationGuardianNames,
  withdrawMediaConsent,
} from '@/src/server/pilot/guardianConsent';
import { assertActorCanAccessAthlete } from '@/src/server/pilot/access';
import { suppressPublishedMediaForAthlete } from '@/src/server/pilot/publication';
import {
  hiddenNotFound,
  jsonError,
  requireOptionalBoolean,
  requirePrincipal,
  requireRole,
} from '@/src/server/pilot/http';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { sanitizedSqlState } from '@/src/server/pilot/db';

export const runtime = 'nodejs';

// A lost audit row must not tell a caller their consent decision failed when
// it in fact committed -- same non-fatal-audit doctrine as the guardian's own
// route, which this mirrors deliberately rather than inventing a second shape.
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

type ConsentDecision = 'grant' | 'withdraw';

const DECISIONS = new Set<ConsentDecision>(['grant', 'withdraw']);

/**
 * T-008: THE ORG-WIDE CONSENT AUDIT, AND THE STAFF-SIDE CONSENT WRITER.
 *
 * GET is the audit: every athlete in the organization with their current
 * guardian media-consent status -- including athletes with zero linked
 * guardians, which is itself the finding someone auditing this needs to see
 * (checkGuardianMediaConsent treats that as "unverifiable", not vacuously
 * satisfied). See guardianConsent.ts for the full reasoning.
 *
 * POST RECORDS A SIGNATURE THAT HAPPENED ON PAPER. Owner decision: guardian
 * consent for this club is collected on signed forms held in the gym office,
 * so the platform needs a way to record that the paper EXISTS. It does not
 * move consent into the app and it does not replace the form; the row it
 * writes is the same append-only pilot.waivers row the guardian's own console
 * writes, through the same lock, read by the same gates.
 *
 * REACHABLE BY admin, organization_admin AND coach (owner decision). Both
 * verbs take the same roles: a coach who can see the audit can act on it,
 * because the split where one role diagnoses and another fixes is how a
 * finding sits unactioned.
 *
 * THE WRITER MAKES TWO AUTHORIZATION CHECKS, both required and in this order:
 *   1. assertActorCanAccessAthlete -- the caller may act on this athlete at
 *      all. platform_owner and board are refused outright by that function.
 *   2. the parent_id names a REAL linked guardian of THIS athlete. This one is
 *      not optional: writeMediaConsentUnderLock deliberately does not block on
 *      a missing link row (a guardian whose link was removed must still be
 *      able to put a withdrawal on file), so without this check a typo either
 *      writes a permanently invisible waiver or trips the waivers->parents
 *      foreign key and surfaces as an opaque 500.
 * A parent_id that is not a guardian of this athlete returns the same 404 as
 * an athlete that does not exist, matching the guardian route.
 */
export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['admin', 'organization_admin', 'coach']);

    const rows = await listOrganizationConsentStatus(principal.organizationId);
    const guardianNames = new Map(
      rows.flatMap((row) => row.guardians.map((g) => [g.parentId, g.fullName] as const)),
    );

    return NextResponse.json({
      ok: true,
      items: rows.map((row) => ({
        athlete_id: row.athleteId,
        athlete_name: row.athleteName,
        consent_ok: row.consent.ok,
        guardian_count: row.consent.guardianIds.length,
        missing_guardian_count: row.consent.missingParentIds.length,
        per_guardian: row.consent.perGuardian.map((g) => ({
          parent_id: g.parentId,
          // The name is what makes the picker usable: choosing which guardian
          // a paper form belongs to from a list of opaque ids is how the wrong
          // guardian gets recorded.
          parent_name: guardianNames.get(g.parentId) ?? g.parentId,
          status: g.status,
          covers_video: g.coversVideo,
          public_use_allowed: g.publicUseAllowed,
          signed_at: g.signedAt,
        })),
      })),
    });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['admin', 'organization_admin', 'coach']);

    const body = (await request.json().catch(() => null)) as
      | {
          athlete_id?: unknown;
          parent_id?: unknown;
          decision?: unknown;
          covers_video?: unknown;
          public_use_allowed?: unknown;
          signed_at?: unknown;
          notes?: unknown;
        }
      | null;

    const athleteId = typeof body?.athlete_id === 'string' ? body.athlete_id.trim() : '';
    const parentId = typeof body?.parent_id === 'string' ? body.parent_id.trim() : '';
    const rawDecision: unknown = body?.decision;

    if (!athleteId) {
      throw new Error('Missing athlete_id');
    }
    if (!parentId) {
      throw new Error('Missing parent_id');
    }
    if (!DECISIONS.has(rawDecision as ConsentDecision)) {
      throw new Error('Unsupported decision: expected "grant" or "withdraw"');
    }
    const decision = rawDecision as ConsentDecision;

    // Same rule as the guardian's own console, from the same helper: absent
    // takes the documented default, present must be a real boolean, and the
    // string "false" is refused rather than read as consent.
    const coversVideo = requireOptionalBoolean(body?.covers_video, 'covers_video', true);
    const publicUseAllowed = requireOptionalBoolean(body?.public_use_allowed, 'public_use_allowed', false);

    // The date printed on the paper, when the entrant types one. Validated
    // rather than passed through: an unparseable string would reach a
    // `timestamptz not null` column and surface as an opaque 500.
    let signedAt: string | undefined;
    if (body?.signed_at !== undefined) {
      if (typeof body.signed_at !== 'string' || !Number.isFinite(new Date(body.signed_at).getTime())) {
        throw new Error('Unsupported signed_at: must be an ISO 8601 date');
      }
      signedAt = body.signed_at;
    }

    let notes: string | undefined;
    if (body?.notes !== undefined) {
      if (typeof body.notes !== 'string') {
        throw new Error('Unsupported notes: must be text');
      }
      notes = body.notes;
    }

    // Check 1: may this caller act on this athlete at all.
    await assertActorCanAccessAthlete(principal, athleteId);

    // Check 2: is parent_id actually a linked guardian of this athlete. See
    // the header for why this cannot be skipped.
    const consent = await checkGuardianMediaConsent(principal.organizationId, athleteId);
    if (!consent.guardianIds.includes(parentId)) {
      return hiddenNotFound();
    }

    const guardianNames = await listOrganizationGuardianNames(principal.organizationId);
    // The foreign key from guardian_links onto pilot.parents means every id
    // that passed check 2 has a name; the coalesce is defensiveness, not a
    // state to build anything on.
    const signedByName = guardianNames.get(parentId) ?? parentId;

    if (decision === 'grant') {
      // NO SPECIAL CASE FOR REVERSING A WITHDRAWAL, deliberately. Owner
      // decision: staff may record a later signature over an earlier
      // withdrawal. pilot.waivers is append-only and "current" is the newest
      // row per guardian, so this is an ordinary write -- and the route must
      // not grow a guard against it.
      const waiverId = await grantMediaConsent({
        organizationId: principal.organizationId,
        athleteId,
        parentId,
        signedByName,
        recordedByAccountId: principal.accountId,
        coversVideo,
        publicUseAllowed,
        signedAt,
        notes,
      });

      await auditConsentEvent({
        event_type: 'consent_granted',
        // WHO ENTERED IT LIVES HERE, not in the waiver row. This is why
        // recording a paper signature needed no schema change: actor_account_id
        // and actor_role are on every audit row, so a staff-entered consent is
        // already separable from a guardian's own without the stored consent
        // meaning two different things to the gates that read it.
        actor_account_id: principal.accountId,
        actor_role: principal.role,
        organization_id: principal.organizationId,
        entity_type: 'guardian_media_consent',
        entity_id: athleteId,
        details: { parent_id: parentId, covers_video: coversVideo, public_use_allowed: publicUseAllowed },
        shadow_mirror: false,
      });

      return NextResponse.json({
        ok: true,
        athlete_id: athleteId,
        parent_id: parentId,
        decision,
        waiver_id: waiverId,
      });
    }

    const waiverId = await withdrawMediaConsent({
      organizationId: principal.organizationId,
      athleteId,
      parentId,
      signedByName,
      recordedByAccountId: principal.accountId,
      signedAt,
      notes,
    });

    await auditConsentEvent({
      event_type: 'consent_withdrawn',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: principal.organizationId,
      entity_type: 'guardian_media_consent',
      entity_id: athleteId,
      details: { parent_id: parentId },
      shadow_mirror: false,
    });

    // A WITHDRAWAL RECORDED BY STAFF DOES EXACTLY WHAT A GUARDIAN'S OWN DOES.
    // Owner decision: the two must not diverge, or the same fact produces two
    // different outcomes depending on who typed it. So the suppression sweep
    // runs here too, in the request, with the same contract as the guardian
    // route: a failed sweep is a safety action that did not happen and must
    // surface loudly, never be swallowed. The withdrawal itself is already
    // committed either way; withdrawing again re-runs the sweep.
    let suppressedPublicationIds: string[];
    try {
      suppressedPublicationIds = await suppressPublishedMediaForAthlete({
        organizationId: principal.organizationId,
        athleteId,
        suppressedByAccountId: principal.accountId,
        reason: 'guardian_consent_withdrawn',
      });
    } catch (error) {
      const rawCode = error && typeof error === 'object' && 'code' in error ? (error as { code: unknown }).code : undefined;
      const code = sanitizedSqlState(rawCode);
      console.error({ event: 'consent-withdrawal-suppression-failed', athlete_id: athleteId, ...(code ? { code } : {}) });
      await auditConsentEvent({
        event_type: 'update',
        actor_account_id: principal.accountId,
        actor_role: principal.role,
        organization_id: principal.organizationId,
        entity_type: 'guardian_media_consent',
        entity_id: athleteId,
        details: {
          action: 'consent_withdrawal_suppression_failed',
          parent_id: parentId,
          ...(code ? { code } : {}),
        },
        shadow_mirror: false,
      });
      return NextResponse.json(
        {
          ok: false,
          error:
            'The withdrawal was recorded, but suppressing already-published media failed. Withdraw again to retry, or contact your organization admin.',
          athlete_id: athleteId,
          parent_id: parentId,
          decision,
          waiver_id: waiverId,
        },
        { status: 500 },
      );
    }

    for (const publicationId of suppressedPublicationIds) {
      await auditConsentEvent({
        event_type: 'update',
        actor_account_id: principal.accountId,
        actor_role: principal.role,
        organization_id: principal.organizationId,
        entity_type: 'video_publication',
        entity_id: publicationId,
        details: {
          action: 'publication_retracted_on_consent_withdrawal',
          athlete_id: athleteId,
          parent_id: parentId,
        },
        shadow_mirror: false,
      });
    }

    return NextResponse.json({
      ok: true,
      athlete_id: athleteId,
      parent_id: parentId,
      decision,
      waiver_id: waiverId,
      retracted_publication_ids: suppressedPublicationIds,
    });
  } catch (error) {
    return jsonError(error);
  }
}
