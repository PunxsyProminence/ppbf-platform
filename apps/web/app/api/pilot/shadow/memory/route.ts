import { NextRequest, NextResponse } from 'next/server';

import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { submitMemoryCorrection } from '@/src/server/pilot/shadowConversations';

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    const body = await request.json() as {
      factKey?: unknown;
      correctedValue?: unknown;
      action?: unknown;
    };
    if (typeof body.factKey !== 'string' || !body.factKey.trim()) {
      return NextResponse.json({ error: 'Missing SHADOW memory fact key' }, { status: 400 });
    }
    if (body.action !== 'replace' && body.action !== 'forget') {
      return NextResponse.json({ error: 'Unsupported SHADOW memory action' }, { status: 400 });
    }
    if (body.correctedValue !== undefined && typeof body.correctedValue !== 'string') {
      return NextResponse.json({ error: 'Invalid correctedValue' }, { status: 400 });
    }

    const correctionId = await submitMemoryCorrection({
      actor: principal,
      factKey: body.factKey,
      correctedValue: body.correctedValue,
      action: body.action,
    });
    return NextResponse.json({
      success: true,
      correctionId,
      status: 'pending_review',
    }, { status: 202 });
  } catch (error) {
    return jsonError(error);
  }
}
