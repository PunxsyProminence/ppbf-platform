// GET /api/pilot/shadow/jobs — List recent Recovery Round jobs for the org
// DELETE /api/pilot/shadow/jobs?jobId=xxx — Cancel a pending job
import { NextResponse, type NextRequest } from 'next/server';
import { requireRole } from '@/src/server/pilot/access';
import { isUuid, jsonError, parseSafeLimit, requirePrincipal } from '@/src/server/pilot/http';
import { cancelJobForActor, getJobsForActor } from '@/src/server/pilot/shadowJobQueue';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['admin', 'organization_admin', 'coach', 'platform_owner']);

    const url = new URL(request.url);
    const limit = parseSafeLimit(url.searchParams.get('limit'), 20, 100);
    if (limit === null) {
      return NextResponse.json({ error: 'Invalid limit' }, { status: 400 });
    }

    const jobs = await getJobsForActor(principal, limit);
    return NextResponse.json({ ok: true, jobs });
  } catch (error) {
    return jsonError(error);
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['admin', 'organization_admin', 'platform_owner']);

    const url = new URL(request.url);
    const jobId = url.searchParams.get('jobId');
    if (!jobId) {
      return NextResponse.json({ error: 'Missing jobId' }, { status: 400 });
    }
    if (!isUuid(jobId)) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const cancelled = await cancelJobForActor(jobId, principal);
    return NextResponse.json({ ok: cancelled, jobId });
  } catch (error) {
    return jsonError(error);
  }
}
