import { NextResponse, type NextRequest } from 'next/server';

import { jsonError } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as { pin?: string };
    const providedPin = body.pin?.trim() || '';

    const requiredPin = process.env.PPBF_OPERATOR_PIN?.trim();
    if (!requiredPin) {
      throw new Error('Server misconfiguration: PPBF_OPERATOR_PIN is required');
    }

    if (!providedPin || providedPin !== requiredPin) {
      return NextResponse.json({ error: 'Invalid PIN' }, { status: 401 });
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    return jsonError(error);
  }
}
