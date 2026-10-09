import { NextResponse, type NextRequest } from 'next/server';

import {
  checkGuardianMediaConsent,
  grantMediaConsent,
  GuardianLinkEndedError,
  guardianDisplayName,
  listOrganizationConsentStatus,
  withdrawMediaConsent,
  type QueryExecutor,
} from '@/src/server/pilot/guardianConsent';
import { assertAthleteBelongsToOrganization } from '@/src/server/pilot/access';
import { recordMediaConsentAndSuppress } from '@/src/server/pilot/publication';
import {
  hiddenNotFound,
  jsonError,
  requireOptionalBoolean,
  requirePrincipal,
  requireRole,
} from '@/src/server/pilot/http';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { sanitizedSqlState } from '@/src/server/pilot/db';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

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

// THE 18 RULE'S REFUSAL IS AUDITED WHERE THE CONSENT WRITES ARE (OD-2026-10-07-008:
// the guardian link goes dormant at 18). guardianConsent.ts refuses the write
// by name; this writes the one audit row for it and lets the refusal reach
// jsonError as the 403 it is. Any other error passes through untouched.
async function auditGuardianLinkEnded(
  principal: PilotPrincipal,
  athleteId: string,
  parentId: string,
  error: unknown,
): Promise<void> {
  if (!(error instanceof GuardianLinkEndedError)) return;
  await auditConsentEvent({
    event_type: 'update',
    actor_account_id: principal.accountId,
    actor_role: principal.role,
    organization_id: principal.organizationId,
    entity_type: 'guardian_media_consent',
    entity_id: athleteId,
    details: { action: 'guardian_link_ended', parent_id: parentId },
    shadow_mirror: false,
  });
}

/*
 * THE SUPPRESSION SWEEP, for both consent changes that take published video
 * down: a withdrawal (owner decision 2026-08-14) and a grant that leaves this
 * guardian photo-only (Jason, 2026-10-05: "A: Retract (Recommended)"; every
 * publication is video). The guardian's own console (parent/consent) runs the same sweep.
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
    // Not a failed sweep: the write itself was refused before anything ran.
    await auditGuardianLinkEnded(principal, athleteId, parentId, error);
    if (error instanceof GuardianLinkEndedError) throw error;
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
 *   1. the athlete is in the caller's organization -- ORG-WIDE FOR EVERY ROLE
 *      THAT REACHES HERE, coach included. This deliberately does NOT go
 *      through assertActorCanAccessAthlete, whose coach branch narrows to the
 *      coach of record plus live coverage grants. That narrowing is right for
 *      reading an athlete's training record and wrong here, by owner decision:
 *      whoever is handed the paper at the door records it, and the audit this
 *      screen is attached to is itself org-wide, so scoping the write but not
 *      the read would offer a coach a button that 403s on most of the rows in
 *      front of them. Role admission is the gate above; this check is tenancy.
 *   2. the parent_id names a REAL linked guardian of THIS athlete. This one is
 *      not optional: writeMediaConsentUnderLock deliberately does not block on
 *      a missing link row (a guardian whose link was removed must still be
 *      able to put a withdrawal on file), so without this check a typo either
 *      writes a permanently invisible waiver or trips the waivers->parents
 *      foreign key and surfaces as an opaque 500.
 *
 * THE TWO REFUSALS ARE NOT THE SAME SHAPE, and that is worth knowing before
 * relying on one: an athlete outside the caller's organization is refused 403
 * by check 1, while a parent_id that does not guard a reachable athlete is
 * refused 404 by check 2. Check 1 already establishes tenancy, so check 2's
 * 404 cannot be used to probe for athletes in another organization.
 */
export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['admin', 'organization_admin', 'coach']);

    const rows = await listOrganizationConsentStatus(principal.organizationId);
    const guardianNames = new Map(
      rows.flatMap((row) => row.guardians.map((g) => [g.parentId, g] as const)),
    );

    return NextResponse.json({
      ok: true,
      items: rows.map((row) => {
        const missing = new Set(row.consent.missingParentIds);
        return {
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
            parent_name: guardianNames.get(g.parentId)?.fullName ?? g.parentId,
            // false = a name on paper with no login (OD-2026-10-07-009): the
            // desk labels them, since nothing can be emailed to this guardian.
            has_login: guardianNames.get(g.parentId)?.hasLogin ?? false,
            status: g.status,
            /* THE ANSWER, not the raw word, so no client has to re-derive it.
               Whether a stored status counts as consent is one rule, applied
               once, on the server -- the same normalisation the consent gates
               use. A screen that compared this status itself would be a second
               copy of that rule, which is exactly the drift that once let one
               reader treat a padded ' Signed ' as a signature and another treat
               it as nothing. */
            consented: !missing.has(g.parentId),
            covers_video: g.coversVideo,
            public_use_allowed: g.publicUseAllowed,
            signed_at: g.signedAt,
          })),
        };
      }),
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

    /*
     * The date printed on the paper, when the entrant types one.
     *
     * VALIDATED BY SHAPE AND BY THE CALENDAR, not by Date.parse alone. The
     * string is stored raw and re-parsed by Postgres's own `timestamptz` input
     * function, which is stricter than V8's: V8 rolls an out-of-range day over
     * ("2026-02-30" becomes March 2) while Postgres rejects it. Accepting what
     * V8 accepts would therefore either store a DIFFERENT day than the one on
     * the form, or reach the column and surface as the opaque 500 this guard
     * exists to prevent. So the day is checked against the calendar by reading
     * it back out of the parsed instant.
     */
    let signedAt: string | undefined;
    if (body?.signed_at !== undefined) {
      const raw = body.signed_at;
      const shape = typeof raw === 'string' ? /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.exec(raw) : null;
      const parsed = shape ? new Date(raw as string) : null;
      const roundTrips =
        parsed !== null &&
        Number.isFinite(parsed.getTime()) &&
        parsed.getUTCFullYear() === Number(shape![1]) &&
        parsed.getUTCMonth() + 1 === Number(shape![2]) &&
        parsed.getUTCDate() === Number(shape![3]);
      if (!roundTrips) {
        throw new Error('Unsupported signed_at: must be an ISO 8601 UTC timestamp naming a real calendar day');
      }
      signedAt = raw as string;
    }

    let notes: string | undefined;
    if (body?.notes !== undefined) {
      if (typeof body.notes !== 'string') {
        throw new Error('Unsupported notes: must be text');
      }
      notes = body.notes;
    }

    // Check 1: tenancy, org-wide for every role the gate above admits. See
    // the header for why this is not assertActorCanAccessAthlete.
    await assertAthleteBelongsToOrganization(principal.organizationId, athleteId);

    // Check 2: is parent_id actually a linked guardian of this athlete. See
    // the header for why this cannot be skipped.
    const consent = await checkGuardianMediaConsent(principal.organizationId, athleteId);
    if (!consent.guardianIds.includes(parentId)) {
      return hiddenNotFound();
    }

    // One name, one row. The org-wide map exists for the audit, which resolves
    // hundreds of athletes in a page; a writer holding a single parent_id has
    // no reason to read the whole roster's guardians to render one word. The
    // foreign key from guardian_links onto pilot.parents means every id that
    // passed check 2 has a row; the coalesce is defensiveness, not a state to
    // build anything on.
    const signedByName = (await guardianDisplayName(principal.organizationId, parentId)) ?? parentId;

    if (decision === 'grant') {
      // NO SPECIAL CASE FOR REVERSING A WITHDRAWAL, deliberately. Owner
      // decision: staff may record a later signature over an earlier
      // withdrawal. pilot.waivers is append-only and "current" is the newest
      // row per guardian, so this is an ordinary write -- and the route must
      // not grow a guard against it.
      const grant = {
        organizationId: principal.organizationId,
        athleteId,
        parentId,
        signedByName,
        recordedByAccountId: principal.accountId,
        coversVideo,
        publicUseAllowed,
        signedAt,
        notes,
      };
      const grantedEvent: Parameters<typeof writePilotAuditEvent>[0] = {
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
      };

      // Staff recording a photo-only consent does exactly what the guardian
      // recording it does: already-published video comes down now, in the
      // same transaction as the consent row.
      if (coversVideo === false) {
        const changed = await recordConsentChangeWithSweep(
          principal,
          athleteId,
          parentId,
          'photo_only',
          (transaction) => grantMediaConsent(grant, transaction),
          grantedEvent,
        );
        if (changed === null) {
          return NextResponse.json(
            {
              ok: false,
              error:
                'The photo-only consent was not recorded: it is saved together with taking down already-published video, and that did not complete. Nothing was changed. Record it again to retry, or contact your organization admin.',
              athlete_id: athleteId,
              parent_id: parentId,
              decision,
            },
            { status: 500 },
          );
        }
        return NextResponse.json({
          ok: true,
          athlete_id: athleteId,
          parent_id: parentId,
          decision,
          waiver_id: changed.waiverId,
          retracted_publication_ids: changed.publicationIds,
        });
      }

      let waiverId: string;
      try {
        waiverId = await grantMediaConsent(grant);
      } catch (error) {
        await auditGuardianLinkEnded(principal, athleteId, parentId, error);
        throw error;
      }
      await auditConsentEvent(grantedEvent);

      return NextResponse.json({
        ok: true,
        athlete_id: athleteId,
        parent_id: parentId,
        decision,
        waiver_id: waiverId,
      });
    }

    // A WITHDRAWAL RECORDED BY STAFF DOES EXACTLY WHAT A GUARDIAN'S OWN DOES.
    // Owner decision: the two must not diverge, or the same fact produces two
    // different outcomes depending on who typed it. So the suppression sweep
    // runs here too, in the withdrawal's own transaction, with the same
    // contract as the guardian route: a failed sweep is a safety action that
    // did not happen and must surface loudly, never be swallowed -- and it
    // takes the withdrawal down with it, so nothing is half-recorded.
    const changed = await recordConsentChangeWithSweep(
      principal,
      athleteId,
      parentId,
      'withdrawn',
      (transaction) =>
        withdrawMediaConsent(
          {
            organizationId: principal.organizationId,
            athleteId,
            parentId,
            signedByName,
            recordedByAccountId: principal.accountId,
            signedAt,
            notes,
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
        details: { parent_id: parentId },
        shadow_mirror: false,
      },
    );
    if (changed === null) {
      return NextResponse.json(
        {
          ok: false,
          error:
            'The withdrawal was not recorded: it is saved together with taking down already-published media, and that did not complete. Nothing was changed. Withdraw again to retry, or contact your organization admin.',
          athlete_id: athleteId,
          parent_id: parentId,
          decision,
        },
        { status: 500 },
      );
    }

    return NextResponse.json({
      ok: true,
      athlete_id: athleteId,
      parent_id: parentId,
      decision,
      waiver_id: changed.waiverId,
      retracted_publication_ids: changed.publicationIds,
    });
  } catch (error) {
    return jsonError(error);
  }
}
