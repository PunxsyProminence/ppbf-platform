import { NextResponse, type NextRequest } from 'next/server';

import { createProgressionGap, getAthleteGaps } from '@/src/server/pilot/progression';
import { requirePrincipal, requireRole, jsonError } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['coach', 'admin', 'organization_admin', 'athlete']);

    const athleteId = request.nextUrl.searchParams.get('athlete_id');
    const status = request.nextUrl.searchParams.get('status');

    if (!athleteId) {
      throw new Error('Missing athlete_id');
    }

    const gaps = await getAthleteGaps(principal.organizationId, athleteId, status || undefined);

    return NextResponse.json({ items: gaps });
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
