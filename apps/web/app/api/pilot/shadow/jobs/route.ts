// GET /api/pilot/shadow/jobs — List recent Recovery Round jobs for the org
// DELETE /api/pilot/shadow/jobs?jobId=xxx — Cancel a pending job
import { NextResponse, type NextRequest } from 'next/server';
import { requireRole } from '@/src/server/pilot/access';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { getOrgJobs, cancelJob } from '@/src/server/pilot/shadowJobQueue';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['admin', 'organization_admin', 'coach', 'platform_owner']);

    const url = new URL(request.url);
    const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '20', 10), 100);

    const jobs = await getOrgJobs(principal.organizationId, limit);
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

    const cancelled = await cancelJob(jobId, principal.organizationId);
    return NextResponse.json({ ok: cancelled, jobId });
  } catch (error) {
    return jsonError(error);
  }
}
