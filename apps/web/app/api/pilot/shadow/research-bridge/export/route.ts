import { NextResponse, type NextRequest } from 'next/server';

import {
  requireResearchBridgeAccess,
  ResearchBridgeAccessError,
} from '@/src/server/pilot/researchBridgeAuth';
import { buildResearchBridgeExport } from '@/src/server/pilot/researchBridgeExport';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const { organizationId } = await requireResearchBridgeAccess(request);
    const payload = await buildResearchBridgeExport(organizationId);
    return NextResponse.json(payload, {
      headers: {
        'cache-control': 'private, no-store, max-age=0',
        'x-content-type-options': 'nosniff',
      },
    });
  } catch (error) {
    if (error instanceof ResearchBridgeAccessError) {
      return NextResponse.json({ ok: false, error: error.message }, { status: error.status });
    }
    return NextResponse.json({ ok: false, error: 'Research bridge export failed' }, { status: 500 });
  }
}
