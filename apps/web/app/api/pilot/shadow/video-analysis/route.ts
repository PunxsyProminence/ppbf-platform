// SHADOW video analysis remains unavailable until an approved, validated
// computer-vision processor exists. The route fails closed and never creates
// a placeholder job that could later be mistaken for a real analysis.

import { NextRequest, NextResponse } from 'next/server';

import { assertActorCanAccessAthlete, requireRole } from '@/src/server/pilot/access';
import { hiddenNotFound, isUuid, jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { getJobStatusForActor } from '@/src/server/pilot/shadowJobQueue';

export interface VideoAnalysisRequest {
  videoUrl: string;
  athleteId?: string;
  analysisType?: 'pose' | 'technique' | 'biomechanics' | 'full';
  timestamp?: string;
}

export interface VideoAnalysisResponse {
  ok: boolean;
  jobId: string;
  status: 'queued' | 'processing' | 'completed' | 'failed' | 'unavailable';
  message: string;
  reason?: string;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const principal = await requirePrincipal(req);
    requireRole(principal, ['coach', 'admin', 'organization_admin', 'platform_owner']);

    const body = (await req.json().catch(() => ({}))) as Partial<VideoAnalysisRequest>;
    if (typeof body.videoUrl !== 'string' || !body.videoUrl.trim()) {
      return NextResponse.json({
        ok: false,
        jobId: '',
        status: 'failed',
        message: 'videoUrl is required',
      } satisfies VideoAnalysisResponse, { status: 400 });
    }

    if (body.athleteId) {
      await assertActorCanAccessAthlete(principal, body.athleteId);
    }

    return NextResponse.json({
      ok: false,
      jobId: '',
      status: 'unavailable',
      message: 'Video analysis is not available yet. No analysis job was created.',
      reason: 'VIDEO_ANALYSIS_PROCESSOR_UNAVAILABLE',
    } satisfies VideoAnalysisResponse, { status: 503 });
  } catch (error) {
    return jsonError(error);
  }
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const principal = await requirePrincipal(req);
    const jobId = req.nextUrl.searchParams.get('jobId');
    if (!jobId) {
      return NextResponse.json({
        ok: false,
        jobId: '',
        status: 'failed',
        message: 'jobId query parameter is required',
      } satisfies VideoAnalysisResponse, { status: 400 });
    }
    if (!isUuid(jobId)) return hiddenNotFound();

    const job = await getJobStatusForActor(jobId, principal);
    if (!job || job.sessionType !== 'film_study') {
      return NextResponse.json({
        ok: false,
        jobId,
        status: 'failed',
        message: 'Job not found',
      } satisfies VideoAnalysisResponse, { status: 404 });
    }

    const status: VideoAnalysisResponse['status'] =
      job.status === 'pending'
        ? 'queued'
        : job.status === 'running'
          ? 'processing'
          : job.status === 'completed'
            ? 'completed'
            : 'failed';

    return NextResponse.json({
      ok: job.status === 'completed',
      jobId: job.jobId,
      status,
      message:
        job.status === 'completed'
          ? 'Video analysis job completed.'
          : job.status === 'failed' || job.status === 'cancelled'
            ? 'Video analysis job did not complete.'
            : 'Video analysis job is still processing.',
      ...(job.error ? { reason: job.error } : {}),
    } satisfies VideoAnalysisResponse);
  } catch (error) {
    return jsonError(error);
  }
}
