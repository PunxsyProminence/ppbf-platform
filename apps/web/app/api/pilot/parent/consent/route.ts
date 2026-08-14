import { NextResponse, type NextRequest } from 'next/server';

import {
  callerParentIdSet,
  grantMediaConsent,
  listConsentForGuardian,
  resolveActingParent,
  withdrawMediaConsent,
} from '@/src/server/pilot/guardianConsent';
import { getAthleteById } from '@/src/server/pilot/entities';
import { guardianAthleteIds } from '@/src/server/pilot/guardianAccess';
import { suppressPublishedMediaForAthlete } from '@/src/server/pilot/publication';
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

    const [items, ownParentIds] = await Promise.all([
      listConsentForGuardian(principal.organizationId, principal.accountId),
      // A SET, not a single "the" parent_id: a guardian of more than one
      // child can legitimately be backed by a different pilot.parents row
      // per child (see resolveActingParent's own header for why picking
      // just one was a real bug). Membership-tested per row below, so every
      // one of this account's own guardian rows reads as "you", not just
      // whichever row an arbitrary "first" pick happened to land on.
      callerParentIdSet(principal.organizationId, principal.accountId),
    ]);

    // The child's name, not just the id: a guardian of more than one child
    // deciding consent against a raw athlete_id is guessing which child
    // they are acting on -- on the surface whose withdraw now retracts
    // published media. Their own linked children's names are already shown
    // to them on the parent hub; this discloses nothing new.
    const athleteNames = new Map(
      await Promise.all(
        items.map(async ({ athleteId }) => {
          const athlete = await getAthleteById(principal.organizationId, athleteId);
          return [athleteId, athlete?.full_name ?? null] as const;
        }),
      ),
    );

    return NextResponse.json({
      ok: true,
      items: items.map(({ athleteId, consent }) => ({
        athlete_id: athleteId,
        athlete_name: athleteNames.get(athleteId) ?? null,
        consent_ok: consent.ok,
        guardian_count: consent.guardianIds.length,
        missing_guardian_count: consent.missingParentIds.length,
        per_guardian: consent.perGuardian.map((g) => ({
          parent_id: g.parentId,
          you: ownParentIds.has(g.parentId),
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

      // One guardian's withdrawal invalidates consent, and content already
      // published must become non-distributable immediately (owner decision
      // 2026-08-14) -- so the sweep runs here, in the withdrawal request,
      // not on a timer. Unlike an audit row, a failed sweep is a SAFETY
      // action that did not happen: it must surface loudly, never be
      // swallowed. The withdrawal itself is already committed either way;
      // retrying the withdrawal re-runs the sweep, and the compliance
      // console's manual Retract lever is the operator fallback.
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
        // The failure itself must be durably auditable: without this row, an
        // auditor cannot distinguish "withdrawal with no published media"
        // from "withdrawal whose suppression failed". Best-effort like every
        // audit write -- the 500 below carries the operational signal either
        // way.
        await auditConsentEvent({
          event_type: 'update',
          actor_account_id: principal.accountId,
          actor_role: principal.role,
          organization_id: principal.organizationId,
          entity_type: 'guardian_media_consent',
          entity_id: athleteId,
          details: {
            action: 'consent_withdrawal_suppression_failed',
            parent_id: actingParent.parentId,
            ...(code ? { code } : {}),
          },
          shadow_mirror: false,
        });
        return NextResponse.json(
          {
            ok: false,
            error: 'Your consent withdrawal was recorded, but suppressing already-published media failed. Withdraw again to retry, or contact your organization admin.',
            athlete_id: athleteId,
            decision,
          },
          { status: 500 },
        );
      }

      // The withdrawal and each resulting suppression are independently
      // auditable: one consent_withdrawn event above, one retraction event
      // per affected publication here.
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
            parent_id: actingParent.parentId,
          },
          shadow_mirror: false,
        });
      }

      return NextResponse.json({
        ok: true,
        athlete_id: athleteId,
        decision,
        retracted_publication_ids: suppressedPublicationIds,
      });
    }

    return NextResponse.json({ ok: true, athlete_id: athleteId, decision });
  } catch (error) {
    return jsonError(error);
  }
}
