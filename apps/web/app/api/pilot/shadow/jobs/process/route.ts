// POST /api/pilot/shadow/jobs/process — manual drain of the SHADOW job queue.
//
// The routine drain is the in-process worker loop (see instrumentation.ts and
// shadowJobWorker.ts); this route remains for operations -- draining on
// demand, or an external scheduler in an environment where the in-process
// worker is not enabled. Claims and executes at most one job per invocation.
//
// Protected: the operator key in PPBF_PILOT_BOOTSTRAP_KEY (read from either
// accepted header name and compared in constant time by bootstrapKeyMatches),
// or an interactive platform_owner session. Note the limited
// blast radius by design: even with the key, a caller can only cause work
// already enqueued by authenticated users to be processed under the
// enqueuer's re-validated authority -- the processor grants the caller
// nothing of its own.
import { NextResponse, type NextRequest } from 'next/server';

import { jsonError } from '@/src/server/pilot/http';
import { bootstrapKeyMatches } from '@/src/server/pilot/security';
import { isValidJobType, processNextShadowJob } from '@/src/server/pilot/shadowJobProcessor';
import type { JobType } from '@/src/server/pilot/shadowJobQueue';

export const runtime = 'nodejs';
export const maxDuration = 60; // Allow up to 60s for heavy reasoning tasks

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!bootstrapKeyMatches(request.headers, process.env.PPBF_PILOT_BOOTSTRAP_KEY)) {
    // Session fallback for interactive operations.
    try {
      const { requirePrincipal } = await import('@/src/server/pilot/http');
      const { requireRole } = await import('@/src/server/pilot/access');
      const principal = await requirePrincipal(request);
      requireRole(principal, ['platform_owner']);
    } catch {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  const url = new URL(request.url);
  const requestedType = url.searchParams.get('type');
  if (requestedType && !isValidJobType(requestedType)) {
    return NextResponse.json({ error: 'Invalid job type' }, { status: 400 });
  }

  try {
    const result = await processNextShadowJob((requestedType as JobType | null) ?? undefined);
    return NextResponse.json(result);
  } catch (error) {
    return jsonError(error);
  }
}
