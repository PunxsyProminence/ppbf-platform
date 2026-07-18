// GET /api/pilot/shadow/jobs/[jobId] — Poll Recovery Round job status
import { type NextRequest, NextResponse } from 'next/server';
import { requirePrincipal, jsonError } from '@/src/server/pilot/http';
import { getJobStatus } from '@/src/server/pilot/shadowJobQueue';

export const runtime = 'nodejs';

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ jobId: string }> },
): Promise<NextResponse> {
  try {
    const principal = await requirePrincipal(request);
    const { jobId } = await context.params;
    if (!jobId) {
      return NextResponse.json({ error: 'Missing jobId' }, { status: 400 });
    }
    const job = await getJobStatus(jobId, principal.organizationId);
    if (!job) {
      return NextResponse.json({ error: 'Job not found' }, { status: 404 });
    }
    return NextResponse.json(job);
  } catch (error) {
    return jsonError(error);
  }
}
