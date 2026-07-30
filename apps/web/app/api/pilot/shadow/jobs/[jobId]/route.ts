// GET /api/pilot/shadow/jobs/[jobId] — Poll Recovery Round job status
import { type NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/src/server/pilot/access';
import { hiddenNotFound, isUuid, requirePrincipal, jsonError } from '@/src/server/pilot/http';
import { getJobStatusForActor } from '@/src/server/pilot/shadowJobQueue';

export const runtime = 'nodejs';

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ jobId: string }> },
): Promise<NextResponse> {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [
      'admin',
      'coach',
      'athlete',
      'parent',
      'organization_admin',
      'staff',
      'volunteer',
      'platform_owner',
    ]);
    const { jobId } = await context.params;
    if (!isUuid(jobId)) return hiddenNotFound();
    const job = await getJobStatusForActor(jobId, principal);
    if (!job) {
      return NextResponse.json({ error: 'Job not found' }, { status: 404 });
    }
    return NextResponse.json(job);
  } catch (error) {
    return jsonError(error);
  }
}
