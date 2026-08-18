// SHADOW video analysis: enqueue a Film Study job for an already-uploaded
// video session (#103, prerequisite 4).
//
// This route failed closed for months -- deliberately, because no approved
// vision processor existed and a placeholder job could later be mistaken for
// a real analysis. Everything that refusal was waiting on is now in place:
// the vision deployment exists and is measured, ffmpeg ships in the runner
// image, the sampling policy is pinned, and the human acceptance gate landed
// BEFORE this producer so a proposal has somewhere reviewable to go.
//
// It takes a video_session_id, never a caller-supplied URL. The old
// `videoUrl` field would have let a caller point the worker at arbitrary
// bytes; the row is the authority for which blob is read and which athlete
// the analysis concerns, and athlete access is asserted against THAT athlete.
import { NextRequest, NextResponse } from 'next/server';

import { assertActorCanAccessAthlete, requireRole } from '@/src/server/pilot/access';
import { assertGuardianMediaConsent } from '@/src/server/pilot/guardianConsent';
import { hiddenNotFound, isUuid, jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { enqueueJob, getJobStatusForActor } from '@/src/server/pilot/shadowJobQueue';
import { isFilmStudyVisionConfigured } from '@/src/server/pilot/shadowFilmStudy';
import { getVideoSessionById } from '@/src/server/pilot/videoSessions';

export interface VideoAnalysisRequest {
  videoSessionId: string;
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
    // platform_owner is absent: requesting analysis of one athlete's video is
    // depth, and Omega is broader in breadth but strictly narrower in depth
    // (shadowRoleSets.ts). It matches the reviewer roles on the proposals
    // route -- whoever can ask for an observation can review one.
    requireRole(principal, ['coach', 'admin', 'organization_admin']);

    const body = (await req.json().catch(() => ({}))) as Partial<VideoAnalysisRequest>;
    const videoSessionId = typeof body.videoSessionId === 'string' ? body.videoSessionId.trim() : '';
    if (!videoSessionId) {
      return NextResponse.json({
        ok: false,
        jobId: '',
        status: 'failed',
        message: 'videoSessionId is required',
      } satisfies VideoAnalysisResponse, { status: 400 });
    }

    // Fail closed where the vision deployment is unset, BEFORE enqueueing.
    // Queueing work no executor can perform is how this platform accumulated
    // jobs that sat pending forever; the honest answer is to refuse now.
    if (!isFilmStudyVisionConfigured()) {
      return NextResponse.json({
        ok: false,
        jobId: '',
        status: 'unavailable',
        message: 'Film Study is not enabled in this environment. No analysis job was created.',
        reason: 'SHADOW_FILM_VISION_UNCONFIGURED',
      } satisfies VideoAnalysisResponse, { status: 503 });
    }

    const video = await getVideoSessionById(principal.organizationId, videoSessionId);
    if (!video) {
      return hiddenNotFound();
    }

    // The row -- not the request -- says which athlete this concerns, and the
    // access check runs against that.
    if (!video.athlete_id) {
      return NextResponse.json({
        ok: false,
        jobId: '',
        status: 'failed',
        message: 'This video is not linked to an athlete, so it cannot be analyzed.',
        reason: 'VIDEO_SESSION_HAS_NO_ATHLETE',
      } satisfies VideoAnalysisResponse, { status: 400 });
    }
    await assertActorCanAccessAthlete(principal, video.athlete_id);

    // Uploads are born 'quarantined' pending scan (#125). The worker must
    // never open an unscanned or infected file.
    if (video.status !== 'ready') {
      return NextResponse.json({
        ok: false,
        jobId: '',
        status: 'failed',
        message: `This video is '${video.status}'. Only a scanned, ready video can be analyzed.`,
        reason: 'VIDEO_SESSION_NOT_READY',
      } satisfies VideoAnalysisResponse, { status: 409 });
    }

    // T-008: 'ready' only means the content-safety scan passed -- it says
    // nothing about guardian media consent. The video-publication approval
    // path (video-compliance/route.ts, publications/publish/route.ts) has
    // gated on this same precondition since T-008; Film Study opens the same
    // footage to AI analysis and must not be a side door around that gate.
    // jsonError already turns GuardianConsentMissingError into the same 409
    // shape those routes use, so no separate catch is needed here.
    await assertGuardianMediaConsent(principal.organizationId, video.athlete_id);

    const jobId = await enqueueJob({
      jobType: 'film_study',
      organizationId: principal.organizationId,
      accountId: principal.accountId,
      subjectId: video.athlete_id,
      role: principal.role,
      inputPayload: {
        videoSessionId: video.video_session_id,
        athleteId: video.athlete_id,
        blobPath: video.blob_path,
        organizationId: principal.organizationId,
        authenticatedRole: principal.role,
        // The processor re-validates this actor at execution time; the
        // context string exists to satisfy the same trust envelope every
        // other job type carries.
        authorizedContext: `Film study requested for video session ${video.video_session_id}.`,
      },
    });

    return NextResponse.json({
      ok: true,
      jobId,
      status: 'queued',
      message: 'Film Study queued. The observation will require coach review before it is recorded.',
    } satisfies VideoAnalysisResponse, { status: 202 });
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
