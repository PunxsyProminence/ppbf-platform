// POST /api/pilot/shadow/film-study/diagnostic — the Film Study measurement
// probe (#103), not the feature.
//
// #103 requires measured facts BEFORE the executor is written: in-container
// frame-extraction time and real vision-call latency/token spend. This route
// produces exactly those numbers on a deployed revision: it synthesizes a
// deterministic test clip with ffmpeg IN THIS CONTAINER, extracts frames at
// the stated sampling policy, and — when the vision deployment is configured
// — times one real frames→vision call. It mutates nothing and reports
// timings and token counts only; the model's text never leaves the server.
//
// Retention is enforced here the way real Film Study must enforce it
// (#103 prerequisite 3): frames exist only in a per-request temp directory,
// deleted before the response returns, success or failure. Nothing is ever
// written to blob storage.
//
// Gated twice: admin-only roles, and PPBF_FILM_STUDY_DIAGNOSTIC_ENABLED,
// which staging sets and production does not.
import { NextResponse, type NextRequest } from 'next/server';

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { requireRole } from '@/src/server/pilot/access';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import {
  analyzeFramesWithVision,
  extractFrames,
  extractRepresentativeFrames,
  extractSceneFrames,
  extractTiledFrames,
  FILM_STUDY_FRAME_INTERVAL_SECONDS,
  FILM_STUDY_MAX_FRAMES_PER_JOB,
  FILM_STUDY_SCENE_THRESHOLD_PERCENT,
  FILM_STUDY_THUMBNAIL_WINDOW_FRAMES,
  FILM_STUDY_TILE_COLUMNS,
  FILM_STUDY_TILE_ROWS,
  getVisionDeploymentName,
  isFilmStudyVisionConfigured,
  synthesizeTestClip,
  type ExtractedFrames,
} from '@/src/server/pilot/shadowFilmStudy';

export const runtime = 'nodejs';

const CLIP_DURATION_SECONDS = 12;
const MAX_VISION_FRAMES = 6;

// The clip is a synthetic test pattern, so the prompt asks for something a
// vision model can only answer by actually looking at the images — a
// comprehension check, not a coaching question. No athlete, no minor, no
// doctrine surface.
const DIAGNOSTIC_PROMPT = 'These images are frames sampled from a synthetic video test pattern. '
  + 'In one short sentence, state how many images you received and one visible difference '
  + 'between the first and the last image.';

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = typeof value === 'number' ? Math.trunc(value) : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['platform_owner', 'organization_admin']);
    if (process.env.PPBF_FILM_STUDY_DIAGNOSTIC_ENABLED !== 'true') {
      throw new Error('Forbidden: film study diagnostic is not enabled in this environment');
    }

    const body = await request.json().catch(() => ({} as Record<string, unknown>));
    const visionFrames = clampInt(body.vision_frames, 1, MAX_VISION_FRAMES, 3);
    const includeVision = body.include_vision !== false;

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ppbf-film-diag-'));
    try {
      const clip = await synthesizeTestClip({
        directory: tempDir,
        durationSeconds: CLIP_DURATION_SECONDS,
      });
      const extraction = await extractFrames({
        clipPath: clip.clipPath,
        directory: tempDir,
        maxFrames: MAX_VISION_FRAMES,
      });
      const frameStats = await Promise.all(extraction.framePaths.map((framePath) => fs.stat(framePath)));
      const totalFrameBytes = frameStats.reduce((sum, stat) => sum + stat.size, 0);

      // Measure the alternative extraction strategies on the SAME clip so
      // their timings are comparable to the baseline above. A strategy
      // failing is a finding the diagnostic exists to surface (same stance
      // as the vision block below), not a route error. Note the synthetic
      // clip has no hard cuts, so the scene strategy's frame_count here
      // measures the guaranteed-frame-0 floor plus decode/scoring time —
      // its selectivity only shows on real footage.
      const measureStrategy = async (
        run: () => Promise<ExtractedFrames>,
      ): Promise<Record<string, unknown>> => {
        try {
          const result = await run();
          const stats = await Promise.all(result.framePaths.map((framePath) => fs.stat(framePath)));
          const totalBytes = stats.reduce((sum, stat) => sum + stat.size, 0);
          return {
            ok: true,
            extract_ms: result.extractMs,
            frame_count: result.framePaths.length,
            avg_frame_bytes: Math.round(totalBytes / result.framePaths.length),
          };
        } catch (strategyError) {
          return {
            ok: false,
            error: strategyError instanceof Error && /^SHADOW_[A-Z0-9_]{3,72}$/.test(strategyError.message)
              ? strategyError.message
              : 'SHADOW_FILM_FFMPEG_FAILED',
          };
        }
      };
      const strategies = {
        thumbnail: {
          window_frames: FILM_STUDY_THUMBNAIL_WINDOW_FRAMES,
          ...await measureStrategy(() => extractRepresentativeFrames({
            clipPath: clip.clipPath,
            directory: tempDir,
            maxFrames: MAX_VISION_FRAMES,
          })),
        },
        tile: {
          tile_columns: FILM_STUDY_TILE_COLUMNS,
          tile_rows: FILM_STUDY_TILE_ROWS,
          ...await measureStrategy(() => extractTiledFrames({
            clipPath: clip.clipPath,
            directory: tempDir,
          })),
        },
        scene: {
          threshold_percent: FILM_STUDY_SCENE_THRESHOLD_PERCENT,
          ...await measureStrategy(() => extractSceneFrames({
            clipPath: clip.clipPath,
            directory: tempDir,
            maxFrames: MAX_VISION_FRAMES,
          })),
        },
      };

      let vision: Record<string, unknown>;
      if (!includeVision || !isFilmStudyVisionConfigured()) {
        vision = { configured: isFilmStudyVisionConfigured(), attempted: false };
      } else {
        const frames = await Promise.all(
          extraction.framePaths.slice(0, visionFrames).map((framePath) => fs.readFile(framePath)),
        );
        try {
          const analysis = await analyzeFramesWithVision({ frames, prompt: DIAGNOSTIC_PROMPT });
          vision = {
            configured: true,
            attempted: true,
            ok: true,
            deployment: getVisionDeploymentName(),
            frames_sent: frames.length,
            latency_ms: analysis.latencyMs,
            prompt_tokens: analysis.promptTokens,
            completion_tokens: analysis.completionTokens,
            reasoning_tokens: analysis.reasoningTokens,
            response_chars: analysis.content.length,
          };
        } catch (visionError) {
          // A vision failure is a finding the diagnostic exists to surface,
          // not a route error: the ffmpeg numbers above are still valid and
          // still wanted.
          vision = {
            configured: true,
            attempted: true,
            ok: false,
            deployment: getVisionDeploymentName(),
            frames_sent: frames.length,
            error: visionError instanceof Error && /^SHADOW_[A-Z0-9_]{3,72}$/.test(visionError.message)
              ? visionError.message
              : 'SHADOW_FILM_VISION_FAILED',
          };
        }
      }

      const result = {
        ok: true,
        measured_at: new Date().toISOString(),
        sampling: {
          frame_interval_seconds: FILM_STUDY_FRAME_INTERVAL_SECONDS,
          max_frames_per_job: FILM_STUDY_MAX_FRAMES_PER_JOB,
        },
        ffmpeg: {
          clip_duration_seconds: CLIP_DURATION_SECONDS,
          synthesize_ms: clip.synthesizeMs,
          extract_ms: extraction.extractMs,
          frame_count: extraction.framePaths.length,
          avg_frame_bytes: Math.round(totalFrameBytes / extraction.framePaths.length),
        },
        strategies,
        vision,
      };
      console.log('SHADOW film-study diagnostic', {
        synthesize_ms: result.ffmpeg.synthesize_ms,
        extract_ms: result.ffmpeg.extract_ms,
        frame_count: result.ffmpeg.frame_count,
        vision_attempted: vision.attempted,
        vision_ok: vision.ok ?? null,
        vision_latency_ms: vision.latency_ms ?? null,
      });
      return NextResponse.json(result);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {
        console.error('SHADOW film-study diagnostic temp cleanup failed');
      });
    }
  } catch (error) {
    return jsonError(error);
  }
}
