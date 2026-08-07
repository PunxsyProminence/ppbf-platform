import { NextResponse, type NextRequest } from 'next/server';

import {
  grantMediaConsent,
  listConsentForGuardian,
  resolveActingParent,
  withdrawMediaConsent,
} from '@/src/server/pilot/guardianConsent';
import { guardianAthleteIds } from '@/src/server/pilot/guardianAccess';
import { hiddenNotFound, jsonError, requirePrincipal, requireRole } from '@/src/server/pilot/http';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { sanitizedSqlState } from '@/src/server/pilot/db';

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

/**
 * T-008: THE GUARDIAN'S OWN SIDE OF MEDIA CONSENT.
 *
 * Every write here is scoped to the signed-in guardian's OWN linked
 * athletes (guardianAthleteIds) -- a parent may grant or withdraw consent
 * for their own child and nobody else's, checked before any write, not
 * inferred from a caller-supplied athlete_id being merely well-formed.
 *
 * Grant and withdraw are both just new pilot.waivers rows (append-only,
 * same shape admin/consent/page.tsx already uses) -- see
 * guardianConsent.ts's own header for why this reuses that table instead of
 * a new one.
 */
export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['parent']);

    const [items, actingParent] = await Promise.all([
      listConsentForGuardian(principal.organizationId, principal.accountId),
      resolveActingParent(principal.organizationId, principal.accountId),
    ]);

    return NextResponse.json({
      ok: true,
      items: items.map(({ athleteId, consent }) => ({
        athlete_id: athleteId,
        consent_ok: consent.ok,
        guardian_count: consent.guardianIds.length,
        missing_guardian_count: consent.missingParentIds.length,
        per_guardian: consent.perGuardian.map((g) => ({
          parent_id: g.parentId,
          // Whether THIS row is the signed-in guardian's own -- the page
          // needs to know which guardian it is rendering controls for, not
          // just "some guardian has an opinion" (an athlete can have more
          // than one).
          you: actingParent?.parentId === g.parentId,
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

    const actingParent = await resolveActingParent(principal.organizationId, principal.accountId);
    if (!actingParent) {
      // This account is linked to the athlete via guardian_links but has no
      // pilot.parents row of its own to write consent as -- a data
      // inconsistency, not a caller error, so it must not read as "missing".
      throw new Error('Unsupported: no guardian record on file for this account');
    }

    if (decision === 'grant') {
      const coversVideo = body?.covers_video !== false;
      const publicUseAllowed = body?.public_use_allowed === true;
      await grantMediaConsent({
        organizationId: principal.organizationId,
        athleteId,
        parentId: actingParent.parentId,
        signedByName: actingParent.fullName,
        coversVideo,
        publicUseAllowed,
      });
      await auditConsentEvent({
        event_type: 'consent_granted',
        actor_account_id: principal.accountId,
        actor_role: principal.role,
        organization_id: principal.organizationId,
        entity_type: 'guardian_media_consent',
        entity_id: athleteId,
        details: { parent_id: actingParent.parentId, covers_video: coversVideo, public_use_allowed: publicUseAllowed },
        shadow_mirror: false,
      });
    } else {
      await withdrawMediaConsent({
        organizationId: principal.organizationId,
        athleteId,
        parentId: actingParent.parentId,
        signedByName: actingParent.fullName,
      });
      await auditConsentEvent({
        event_type: 'consent_withdrawn',
        actor_account_id: principal.accountId,
        actor_role: principal.role,
        organization_id: principal.organizationId,
        entity_type: 'guardian_media_consent',
        entity_id: athleteId,
        details: { parent_id: actingParent.parentId },
        shadow_mirror: false,
      });
    }

    return NextResponse.json({ ok: true, athlete_id: athleteId, decision });
  } catch (error) {
    return jsonError(error);
  }
}
