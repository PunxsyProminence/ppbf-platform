import { NextResponse, type NextRequest } from 'next/server';

import { getAthleteById } from '@/src/server/pilot/entities';
import { guardianAthleteIds } from '@/src/server/pilot/guardianAccess';
import { callerParentIdSet, checkGuardianMediaConsent, MEDIA_CONSENT_WAIVER_TYPE } from '@/src/server/pilot/guardianConsent';
import { jsonError, requirePrincipal, requireRole } from '@/src/server/pilot/http';
import { getSubjectIdentity } from '@/src/server/pilot/profileDb';
import { getGuardianGateSummary } from '@/src/server/pilot/safetyGateMatrix';
import { getActiveTrainingHold, type TrainingHoldRow, type TrainingHoldScope } from '@/src/server/pilot/trainingHolds';
import {
  getAthleteWaiverStatus,
  normalizeWaiverStatusText,
  TRACKED_WAIVER_TYPES,
  type WaiverStatus,
} from '@/src/server/pilot/waiverCompliance';

export const runtime = 'nodejs';

/** photo_media's vocabulary is the waiver one plus 'photo_only': every
 *  guardian signed, and at least one drew the line at video. It is a reading
 *  of the consent rows, not a stored status, so it is not in WAIVER_STATUSES. */
type PhotoMediaStatus = WaiverStatus | 'photo_only';

/**
 * Capability #84: THE GUARDIAN'S SAFETY ROLLUP.
 *
 * Before this route, a guardian had zero visibility into whether their own
 * child was under an active training hold or how they stood against the
 * organization's safety gates -- both already exist and are already
 * readable by staff (training-holds/route.ts, safetyGateMatrix.ts), but no
 * guardian-facing surface aggregated them. Every value here mirrors the
 * SAME athlete-safe projection training-holds/route.ts's `athleteFacing()`
 * already builds for the athlete themselves (reason_text/reason_category
 * never leave the server) and getGuardianGateSummary's own doc comment
 * (gate outcome and name only, never reason/metadata) -- a guardian reads
 * exactly what their child would read, never staff detail.
 *
 * Deliberately excludes pilot.safety_escalations entirely: an
 * 'athlete_voice' escalation exists because a child typed something into
 * the feedback box, and escalationLadder.ts's own doctrine is that this
 * must never reach a surface the athlete's own guardian can read (a
 * guardian may be exactly who a child is disclosing about, or leaking
 * "an escalation exists" at all could itself be unsafe). The per-guardian
 * photo consent breakdown is not embedded either -- it has its own page
 * (/parent/consent, T-008), which is where it is changed. Only one word about
 * it appears here: the photo_media status below, taken from the same check.
 *
 * Owner decision, 2026-08-19: placed_by_name is now included here too, kept
 * in lockstep with training-holds/route.ts's own athleteFacing() so a
 * guardian reads the exact same point-of-contact name their child does.
 *
 * WAIVER STATUS, added for the loop this route could not close.
 *
 * competitionSafetyGates.ts GATE 3 refuses to enter a child in ANY competition
 * -- wrestling season or external -- unless their travel waiver reads
 * 'signed'. Every competition is treated as travel, deliberately, because the
 * skeletons store `location` as free text with no home/away flag.
 *
 * The only person who can sign that waiver is the guardian, and no surface
 * told them. /parent/consent covers photo_media and nothing else;
 * /admin/waiver-status is organization-admin. So a child could be blocked from
 * every competition indefinitely for want of a document their guardian did not
 * know was outstanding, with the refusal going only to the admin who attempted
 * the entry.
 *
 * What is disclosed is a status from waiverCompliance's four-value vocabulary
 * (photo_media adds 'photo_only', see PhotoMediaStatus) and nothing else -- no signer name, no signed_at, no consent_version, and
 * above all no `notes`, which is the staff column #793 removed from the
 * guardian projection of pilot.waivers for the reason recorded there. A
 * guardian learns which of their own forms are outstanding; they learn nothing
 * about who signed what or what staff wrote about it.
 *
 * All four tracked types rather than travel alone: a list of outstanding forms
 * that silently omits one reads as complete when it is not.
 *
 * PHOTO_MEDIA IS READ THROUGH THE REAL CONSENT CHECK, NOT THE NEWEST ROW.
 * general, medical_release and travel are the newest row for the type, which
 * is exactly what their gates read (getAthleteWaiverStatus). photo_media is
 * not gated that way: media approval and /parent/consent use
 * checkGuardianMediaConsent, which needs EVERY linked guardian's own latest
 * row to read signed and ignores rows with no parent_id (a paper form an
 * admin entered at /admin/consent). Reading the newest row from anyone here
 * let this page say Signed while /parent/consent said "Consent needed" and
 * approval refused -- after a staff-entered form, or when one guardian signed
 * after the other withdrew. So photo_media reads 'signed' only when that
 * check passes. Otherwise it reads THIS guardian's own latest answer
 * (withdrawn or declined), and 'missing' for anything else -- including a
 * guardian who signed while another has not, because consent is not on file.
 * Another guardian's answer is not reported as this one's; /parent/consent
 * is where the per-guardian picture lives.
 */
interface AthleteFacingHold {
  scope: TrainingHoldScope;
  athlete_explanation: string;
  lift_condition_text: string;
  placed_at: string;
  expires_at: string | null;
  placed_by_name: string;
}

async function athleteFacing(organizationId: string, hold: TrainingHoldRow): Promise<AthleteFacingHold> {
  const placer = await getSubjectIdentity(organizationId, hold.placed_by_account_id);
  return {
    scope: hold.scope,
    athlete_explanation: hold.athlete_explanation,
    lift_condition_text: hold.lift_condition_text,
    placed_at: hold.placed_at,
    expires_at: hold.expires_at,
    placed_by_name: placer?.fullName ?? hold.placed_by_account_id,
  };
}

/** photo_media for one athlete, as the gate that uses it reads it (see
 *  PHOTO_MEDIA above). ownParentIds is every pilot.parents row this account
 *  backs: one account can back a different row per child, so "you" is a
 *  membership test, the same one /parent/consent uses. */
async function photoMediaStatusFor(
  organizationId: string,
  athleteId: string,
  ownParentIds: Set<string>,
): Promise<PhotoMediaStatus> {
  const consent = await checkGuardianMediaConsent(organizationId, athleteId);
  if (consent.ok) {
    // Signed by everyone, but not for video (audit CL-B11): a guardian who
    // ticked photos only, or a purged guardian whose photo-only choice still
    // stands, means the video gate refuses -- the same test
    // assertConsentCoversVideo makes (coversVideo === false on a signed row;
    // covers_video is NOT NULL, so within ok that is the only refusal).
    // Reporting that as plain "signed" told a family video was cleared when
    // it was not.
    const excludesVideo = [...consent.perGuardian, ...consent.retained]
      .some((guardian) => guardian.coversVideo === false);
    return excludesVideo ? 'photo_only' : 'signed';
  }

  // A purged former guardian's withdrawal still refuses (owner, 2026-10-05:
  // the "no" is kept), and no current guardian can be shown as its author.
  // Read as withdrawn, since that is what every media gate reads; "missing"
  // would tell the family the gym has no form on file when it has a refusal.
  if (consent.retained.some((guardian) => normalizeWaiverStatusText(guardian.status) === 'withdrawn')) {
    return 'withdrawn';
  }

  const own = consent.perGuardian
    .filter((guardian) => ownParentIds.has(guardian.parentId))
    .map((guardian) => normalizeWaiverStatusText(guardian.status));
  // A withdrawal outranks a decline, and either outranks nothing on file, if
  // an account somehow backs two guardian rows for the same child.
  if (own.includes('withdrawn')) return 'withdrawn';
  if (own.includes('declined')) return 'declined';
  return 'missing';
}

/** Every tracked waiver type for one athlete, as the four-value vocabulary.
 *  Absence is 'missing', which is a status rather than "fine". general,
 *  medical_release and travel use getAthleteWaiverStatus, the reading the
 *  competition gate itself uses; photo_media uses the media consent check.
 *  Either way the guardian reads what the gate for that document reads. */
async function waiverStatusesFor(
  organizationId: string,
  athleteId: string,
  ownParentIds: Set<string>,
): Promise<Record<string, WaiverStatus | PhotoMediaStatus>> {
  const entries = await Promise.all(
    TRACKED_WAIVER_TYPES.map(async (waiverType) => [
      waiverType,
      waiverType === MEDIA_CONSENT_WAIVER_TYPE
        ? await photoMediaStatusFor(organizationId, athleteId, ownParentIds)
        : await getAthleteWaiverStatus(organizationId, athleteId, waiverType),
    ] as const),
  );
  return Object.fromEntries(entries);
}

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['parent']);

    const [athleteIds, ownParentIds] = await Promise.all([
      guardianAthleteIds(principal.organizationId, principal.accountId),
      callerParentIdSet(principal.organizationId, principal.accountId),
    ]);

    const items = await Promise.all(
      athleteIds.map(async (athleteId) => {
        const [athlete, hold, gates, waivers] = await Promise.all([
          getAthleteById(principal.organizationId, athleteId),
          getActiveTrainingHold(principal.organizationId, athleteId),
          getGuardianGateSummary(principal.organizationId, athleteId),
          /* Narrow per-athlete reads (three newest-row reads and one media
             consent check) rather than the org-wide rollup.
             getOrganizationWaiverStatus's own header says why: a gate "must
             not read (or hold in memory, or risk logging) every other child's
             consent state" to answer one child's question. That applies with
             more force here, where the caller is a guardian. */
          waiverStatusesFor(principal.organizationId, athleteId, ownParentIds),
        ]);

        return {
          athlete_id: athleteId,
          athlete_name: athlete?.full_name ?? null,
          hold: hold ? await athleteFacing(principal.organizationId, hold) : null,
          gates: gates.map((gate) => ({
            gate_key: gate.gate_key,
            name: gate.name,
            category: gate.category,
            outcome: gate.outcome,
            evaluated_at: gate.evaluated_at,
          })),
          waivers,
        };
      }),
    );

    return NextResponse.json({ ok: true, items });
  } catch (error) {
    return jsonError(error);
  }
}
