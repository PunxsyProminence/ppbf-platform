import { NextResponse, type NextRequest } from 'next/server';

import { assertActorCanAccessAthlete } from '@/src/server/pilot/access';
import { createProgressionGap, getAthleteGaps } from '@/src/server/pilot/progression';
import { requirePrincipal, requireRole, jsonError } from '@/src/server/pilot/http';
import { familyGapDescription } from '@/src/server/pilot/progressionSuggestions';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['coach', 'admin', 'organization_admin', 'athlete', 'parent']);

    const athleteId = request.nextUrl.searchParams.get('athlete_id');
    const status = request.nextUrl.searchParams.get('status');

    if (!athleteId) {
      throw new Error('Missing athlete_id');
    }

    await assertActorCanAccessAthlete(principal, athleteId);

    const gaps = await getAthleteGaps(principal.organizationId, athleteId, status || undefined);
    // Athletes and parents read the family wording (Jason 2026-10-05); staff
    // read the stored text. Detection fields never leave the server.
    const familyReader = principal.role === 'athlete' || principal.role === 'parent';
    const items = gaps.map(({ detected_from, detection_data, ...gap }) => ({
      ...gap,
      gap_description: familyReader
        ? familyGapDescription({ gap_description: gap.gap_description, detected_from, detection_data })
        : gap.gap_description,
    }));

    return NextResponse.json({ items });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['coach', 'admin', 'organization_admin']);

    const body = (await request.json()) as {
      athlete_id?: string;
      gap_type?: string;
      gap_description?: string;
      severity?: string;
      detected_from?: string;
      detected_from_id?: string;
      detection_data?: Record<string, unknown>;
    };

    if (!body.athlete_id || !body.gap_type || !body.gap_description) {
      throw new Error('Missing athlete_id, gap_type, or gap_description');
    }

    await assertActorCanAccessAthlete(principal, body.athlete_id);

    const gap = await createProgressionGap({
      organizationId: principal.organizationId,
      athleteId: body.athlete_id,
      coachAccountId: principal.accountId,
      gapType: body.gap_type,
      gapDescription: body.gap_description,
      severity: body.severity || 'medium',
      detectedFrom: body.detected_from || 'manual_observation',
      detectedFromId: body.detected_from_id,
      detectionData: body.detection_data,
    });

    return NextResponse.json(gap, { status: 201 });
  } catch (error) {
    return jsonError(error);
  }
}
