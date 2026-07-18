// GET /api/pilot/shadow/jobs/[jobId] — Poll Recovery Round job status
import { type NextRequest, NextResponse } from 'next/server';
import { getJobStatus } from '@/src/server/pilot/shadowJobQueue';

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ jobId: string }> },
): Promise<NextResponse> {
  const organizationId = request.headers.get('x-org-id');

  if (!organizationId) {
    return NextResponse.json({ error: 'Missing x-org-id header' }, { status: 401 });
  }

  const { jobId } = await context.params;
  if (!jobId) {
    return NextResponse.json({ error: 'Missing jobId' }, { status: 400 });
  }

  const job = await getJobStatus(jobId, organizationId);

  if (!job) {
    return NextResponse.json({ error: 'Job not found' }, { status: 404 });
  }

  return NextResponse.json(job);
}
