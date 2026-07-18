// /api/pilot/shadow/video-analysis/route.ts
// Video Analysis Job Enqueue & Status Check
// Phase 3 Scaffolding: Ready for Phase 4 Computer Vision integration (Aug 22, 2026)

import { NextRequest, NextResponse } from 'next/server';
import { requirePrincipal } from '@/src/server/pilot/http';
import { requireRole } from '@/src/server/pilot/access';
import { query, queryOne } from '@/src/server/pilot/db';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface VideoAnalysisRequest {
  videoUrl: string;       // URL or file path to video
  athleteId?: string;     // Target athlete for analysis
  analysisType?: 'pose' | 'technique' | 'biomechanics' | 'full'; // Type of analysis (default: full)
  timestamp?: string;     // Session timestamp for context
}

export interface VideoAnalysisResponse {
  ok: boolean;
  jobId: string;
  status: 'queued' | 'processing' | 'completed' | 'failed';
  message: string;
  estimatedDuration?: number; // seconds
  phase4Placeholder?: string;
}

// ─── POST: Enqueue Video Analysis ──────────────────────────────────────────

export async function POST(req: NextRequest): Promise<NextResponse<VideoAnalysisResponse>> {
  try {
    const principal = requirePrincipal(req);
    requireRole(principal, ['coach', 'admin', 'organization_admin', 'platform_owner']);

    const body = (await req.json()) as VideoAnalysisRequest;
    if (!body.videoUrl) {
      return NextResponse.json(
        {
          ok: false,
          jobId: '',
          status: 'failed',
          message: 'videoUrl is required',
        },
        { status: 400 },
      );
    }

    // Insert job into shadow_jobs queue
    const jobId = `job-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    await query(
      `INSERT INTO pilot.shadow_jobs (
         job_id, organization_id, account_id, session_type,
         input, status, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())`,
      [
        jobId,
        principal.organizationId,
        principal.userId,
        'video_analysis',
        JSON.stringify({
          videoUrl: body.videoUrl,
          athleteId: body.athleteId ?? null,
          analysisType: body.analysisType ?? 'full',
          timestamp: body.timestamp ?? new Date().toISOString(),
        }),
        'pending',
      ],
    );

    return NextResponse.json({
      ok: true,
      jobId,
      status: 'queued',
      message: 'Video analysis job queued. Phase 4 (Aug 22, 2026) will add Computer Vision analysis.',
      estimatedDuration: 120,
      phase4Placeholder: 'Pose estimation, technique scoring, and error detection coming in Phase 4',
    });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        jobId: '',
        status: 'failed',
        message: `Error: ${err instanceof Error ? err.message : 'Unknown error'}`,
      },
      { status: 500 },
    );
  }
}

// ─── GET: Check Video Analysis Job Status ────────────────────────────────────

export async function GET(req: NextRequest): Promise<NextResponse<VideoAnalysisResponse>> {
  try {
    const principal = requirePrincipal(req);
    const jobId = req.nextUrl.searchParams.get('jobId');

    if (!jobId) {
      return NextResponse.json(
        {
          ok: false,
          jobId: '',
          status: 'failed',
          message: 'jobId query parameter is required',
        },
        { status: 400 },
      );
    }

    const job = await queryOne<{
      job_id: string;
      status: string;
      output: string | null;
      error: string | null;
    }>(
      `SELECT job_id, status, output, error
       FROM pilot.shadow_jobs
       WHERE job_id = $1 AND organization_id = $2`,
      [jobId, principal.organizationId],
    );

    if (!job) {
      return NextResponse.json(
        {
          ok: false,
          jobId,
          status: 'failed',
          message: 'Job not found',
        },
        { status: 404 },
      );
    }

    return NextResponse.json({
      ok: true,
      jobId: job.job_id,
      status: (job.status as 'queued' | 'processing' | 'completed' | 'failed') ?? 'pending',
      message:
        job.status === 'completed'
          ? 'Video analysis complete. Phase 4 will return pose, technique, and biomechanics insights.'
          : job.status === 'failed'
            ? `Video analysis failed: ${job.error}`
            : 'Video analysis in progress (Phase 4 feature)',
      phase4Placeholder: 'Results available after Phase 4 Computer Vision integration',
    });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        jobId: '',
        status: 'failed',
        message: `Error: ${err instanceof Error ? err.message : 'Unknown error'}`,
      },
      { status: 500 },
    );
  }
}
