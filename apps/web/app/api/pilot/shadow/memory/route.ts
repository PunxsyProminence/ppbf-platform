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

    // Applied, not queued: nothing ever reviewed the queued rows (CL-C10).
    // The answer says what was done, including when there was nothing to
    // remove, and that a replace's new value is kept but not used.
    const result = await submitMemoryCorrection({
      actor: principal,
      factKey: body.factKey,
      correctedValue: body.correctedValue,
      action: body.action,
    });
    let message: string;
    if (!result.factRemoved) {
      message = 'SHADOW had nothing remembered under that name, so nothing was removed.';
    } else if (body.action === 'replace') {
      message = 'SHADOW no longer remembers the old value. Your correction is saved with your request; SHADOW does not use it in answers.';
    } else {
      message = 'SHADOW no longer remembers this.';
    }
    return NextResponse.json({
      success: true,
      correctionId: result.correctionId,
      status: result.status,
      action: body.action,
      factRemoved: result.factRemoved,
      message,
    }, { status: 200 });
  } catch (error) {
    return jsonError(error);
  }
}
