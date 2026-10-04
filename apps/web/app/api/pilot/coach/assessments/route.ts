import { NextResponse, type NextRequest } from 'next/server';

import { gymDayIso } from '@/src/lib/gymTime';
import { assertActorCanAccessAthlete, requireRole } from '@/src/server/pilot/access';
import {
  PPBF_ASSESSMENT_PROTOCOLS,
  SKILL_RATING_LEVELS,
  ensurePpbfAssessmentProtocols,
  listAthleteAssessmentHistory,
  recordJumpResult,
  recordSkillRatings,
} from '@/src/server/pilot/assessmentResults';
import { ValidationError } from '@/src/server/pilot/errors';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { SKILL_FAMILY_IDS, SKILL_FAMILY_NAMES } from '@/src/server/pilot/skillFamilies';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Jump test and coach skill ratings for ONE athlete (map items 7-8).
//
// GATE: the same pair every athlete write uses -- a staff role, then
// assertActorCanAccessAthlete (coach of record or live coverage; an
// organization admin reaches the organization's live athletes). The
// organization is always the principal's own; there is no organization_id
// parameter. Soft-deleted athletes are refused by the gate and again by the
// module.
//
// OWN RECORD ONLY. GET takes exactly one athlete_id and returns that athlete's
// history. There is no roster-wide read, no comparison and no combined score.

const ASSESSMENT_ROLES = ['coach', 'organization_admin', 'admin'] as const;

function requireAthleteId(value: unknown): string {
  const athleteId = typeof value === 'string' ? value.trim() : '';
  if (!athleteId) throw new ValidationError('Missing athlete_id.');
  return athleteId;
}

function catalog() {
  return {
    jump_protocols: PPBF_ASSESSMENT_PROTOCOLS
      .filter((p) => p.measure_kind === 'physical_test')
      .map((p) => ({ protocol_id: p.protocol_id, name: p.name, summary: p.protocol_summary, equipment: p.equipment_needed })),
    skill_families: SKILL_FAMILY_IDS.map((id) => ({ skill_family_id: id, name: SKILL_FAMILY_NAMES[id] })),
    rating_levels: SKILL_RATING_LEVELS,
  };
}

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...ASSESSMENT_ROLES]);
    const athleteId = requireAthleteId(request.nextUrl.searchParams.get('athlete_id'));
    await assertActorCanAccessAthlete(principal, athleteId);

    await ensurePpbfAssessmentProtocols(principal.organizationId);
    const history = await listAthleteAssessmentHistory(principal.organizationId, athleteId);
    return NextResponse.json(
      { ok: true, ...catalog(), history },
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...ASSESSMENT_ROLES]);

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') throw new ValidationError('The request body must be JSON.');
    const athleteId = requireAthleteId(body.athlete_id);
    await assertActorCanAccessAthlete(principal, athleteId);

    const today = gymDayIso();
    if (!today) throw new Error('Unable to resolve the gym date.');
    const writer = { organizationId: principal.organizationId, accountId: principal.accountId, role: principal.role };

    await ensurePpbfAssessmentProtocols(principal.organizationId);

    if (body.kind === 'jump') {
      const entry = await recordJumpResult(writer, {
        athleteId,
        protocolId: body.protocol_id,
        valueCm: body.value_cm,
        administeredOn: body.administered_on,
        note: body.note,
        today,
      });
      return NextResponse.json({ ok: true, recorded: [entry] }, { status: 201 });
    }
    if (body.kind === 'skill_ratings') {
      const entries = await recordSkillRatings(writer, {
        athleteId,
        ratings: body.ratings,
        administeredOn: body.administered_on,
        note: body.note,
        today,
      });
      return NextResponse.json({ ok: true, recorded: entries }, { status: 201 });
    }
    throw new ValidationError("kind must be 'jump' or 'skill_ratings'.", 'ASSESSMENT_KIND_INVALID');
  } catch (error) {
    return jsonError(error);
  }
}
