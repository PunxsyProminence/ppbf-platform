import { NextResponse, type NextRequest } from 'next/server';

import { assertAthleteBelongsToOrganization, requireRole } from '@/src/server/pilot/access';
import { ValidationError } from '@/src/server/pilot/errors';
import { hiddenNotFound, jsonError, requirePrincipal } from '@/src/server/pilot/http';
import {
  getSparringSymptomToday,
  getSymptomFlagSettings,
  recordSparringSymptomReport,
} from '@/src/server/pilot/sparringSymptoms';
import {
  SPARRING_SYMPTOM_CONTEXTS,
  SPARRING_SYMPTOM_KEYS,
  isSparringSymptom,
  isSparringSymptomContext,
} from '@/src/shared/sparringSymptoms';

export const runtime = 'nodejs';

// The sparring symptom flag (Jason 2026-10-18, "Sparring symptom flag (Rec.)").
// SELF ONLY, like /api/pilot/athlete/check-in: the athlete acts on their own
// record via the athlete id bound to their session; there is no athlete_id
// parameter, and no other role has a path here. Staff learn of a flag through
// the escalation it files (to the athlete's coach, Jason: "Their coach"), not
// through this route.

async function requireOwnAthleteId(principal: { organizationId: string; athleteId?: string | null }): Promise<string> {
  if (!principal.athleteId) throw new ValidationError('This account is not linked to an athlete record.');
  // A session that outlived the athlete's deletion carries the same id; the
  // live row is required too (OD-2026-09-29-002 item 10).
  await assertAthleteBelongsToOrganization(principal.organizationId, principal.athleteId);
  return principal.athleteId;
}

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['athlete']);
    const athleteId = await requireOwnAthleteId(principal);

    const [today, settings] = await Promise.all([
      getSparringSymptomToday(principal.organizationId, athleteId),
      getSymptomFlagSettings(principal.organizationId),
    ]);
    return NextResponse.json({
      after_sparring: today.afterSparring,
      next_day: today.nextDay,
      after_sparring_due: today.afterSparringDue,
      next_day_due: today.nextDayDue,
      protocol_text: settings.protocolText,
      recipient_role: settings.recipientRole,
    }, { headers: { 'cache-control': 'private, no-store' } });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['athlete']);
    const athleteId = await requireOwnAthleteId(principal);

    const body = ((await request.json().catch(() => null)) ?? {}) as Record<string, unknown>;
    if (!isSparringSymptomContext(body.context)) {
      throw new ValidationError(`context must be one of ${SPARRING_SYMPTOM_CONTEXTS.join(', ')}.`);
    }
    // An empty list is a real answer: "None of these".
    if (!Array.isArray(body.symptoms) || body.symptoms.length > 50 || !body.symptoms.every(isSparringSymptom)) {
      throw new ValidationError(`symptoms must be a list of ${SPARRING_SYMPTOM_KEYS.join(', ')} (empty for none).`);
    }

    const result = await recordSparringSymptomReport({
      organizationId: principal.organizationId,
      athleteId,
      accountId: principal.accountId,
      context: body.context,
      symptoms: body.symptoms,
    });
    if (!result) return hiddenNotFound();

    const settings = await getSymptomFlagSettings(principal.organizationId);
    return NextResponse.json({
      item: result.report,
      added_symptoms: result.addedSymptoms,
      flagged: result.flagged,
      protocol_text: settings.protocolText,
      recipient_role: settings.recipientRole,
    }, { headers: { 'cache-control': 'private, no-store' } });
  } catch (error) {
    return jsonError(error);
  }
}
