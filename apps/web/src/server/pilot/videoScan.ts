// videoScan.ts — collects the scan signals that videoScanPolicy composes into
// a promote/quarantine decision (#49).
//
// Split from the policy on purpose: everything here touches the network (blob
// storage, the vision deployment) and nothing here decides anything. The rules
// live in videoScanPolicy.ts, where they are testable without either.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { downloadPilotVideoFile, getPilotVideoBlobTags } from './blob';
import {
  analyzeFramesWithVision,
  extractFrames,
  isFilmStudyVisionConfigured,
} from './shadowFilmStudy';
import {
  decideVideoScanOutcome,
  parseContentScreenVerdict,
  type ContentVerdict,
  type MalwareVerdict,
  type VideoScanConfig,
  type VideoScanOutcome,
} from './videoScanPolicy';

// The screen asks a different question than Film Study, so it samples
// differently: wide and cheap, not dense. One frame every 10 seconds, 12
// frames max -- enough to characterize a two-minute clip, a fraction of the
// 90-frame Film Study budget. Film Study still samples densely afterwards;
// paying twice is the cost of scanning BEFORE analyzing, which is the order
// that matters.
export const VIDEO_SCAN_FRAME_INTERVAL_SECONDS = 10;
export const VIDEO_SCAN_MAX_FRAMES = 12;

const VIDEO_SCAN_MAX_COMPLETION_TOKENS = 1_024;

// Defender for Storage writes its verdict here. The key is Microsoft's, not
// ours, and is matched case-insensitively with whitespace collapsed because it
// is a display-shaped string we do not control.
const DEFENDER_TAG_KEY = 'malware scanning scan result';
const DEFENDER_CLEAN_VALUE = 'no threats found';
const DEFENDER_MALICIOUS_VALUE = 'malicious';

/**
 * The content screen prompt.
 *
 * Written as a POSITIVE attestation -- the model must affirm the footage is
 * ordinary boxing training -- rather than as a list of prohibited things.
 * Enumerating what is forbidden fails open on everything nobody thought to
 * enumerate; requiring an affirmative "this is ordinary training footage"
 * fails closed on anything unexpected, which is the direction this platform
 * needs when the subject is video of minors.
 *
 * It is a screen, not a certified detector, and the platform never claims
 * otherwise: scan_detail records which gates ran so nobody reading a 'ready'
 * video can mistake this for more than it is.
 */
export const VIDEO_CONTENT_SCREEN_PROMPT = [
  'You are a content safety screen for a youth boxing gym video platform.',
  'The images are frames sampled from a single uploaded video.',
  '',
  'Reply with exactly one of these tokens on the FIRST LINE, alone:',
  'SCAN_PASS - every frame is ordinary boxing training or competition footage:',
  '  clothed people in gym, ring, or athletic attire, training, sparring,',
  '  competing, coaching, or watching boxing activity.',
  'SCAN_FAIL - any frame shows nudity, sexual content, a person undressed',
  '  beyond ordinary athletic attire, graphic injury, or material unrelated to',
  '  boxing that does not belong on a youth sports platform.',
  'SCAN_UNCERTAIN - you cannot determine this from these frames for any reason,',
  '  including frames that are too dark, blurred, or empty to judge.',
  '',
  'You may add one short line after the token. Do not identify, name, describe,',
  'or speculate about any individual person.',
  '',
  'Answer SCAN_PASS only if every frame is clearly ordinary boxing content.',
  'When in doubt, answer SCAN_UNCERTAIN.',
].join('\n');

function normalizeTagText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Read the malware verdict a real scanner left on the blob.
 *
 * Never returns 'clean' by inference. An unrecognized value is 'unavailable',
 * not 'clean' -- if Microsoft renames a tag value, this platform must stop
 * promoting videos, not start promoting them unscanned.
 */
export async function readMalwareVerdict(blobPath: string): Promise<MalwareVerdict> {
  let tags: Record<string, string>;
  try {
    tags = await getPilotVideoBlobTags(blobPath);
  } catch {
    return 'unavailable';
  }

  const entry = Object.entries(tags).find(([key]) => normalizeTagText(key) === DEFENDER_TAG_KEY);
  if (!entry) {
    // No tag at all is the normal state between upload and the scanner
    // running, so this is 'not scanned yet' rather than an error.
    return 'not_scanned_yet';
  }

  const value = normalizeTagText(entry[1]);
  if (value === DEFENDER_CLEAN_VALUE) return 'clean';
  if (value === DEFENDER_MALICIOUS_VALUE) return 'malicious';
  return 'unavailable';
}

/**
 * Run the vision content screen over a sparse frame sample.
 *
 * Returns null when no verdict could be obtained at all (vision unconfigured,
 * provider down, ffmpeg failed, video unreadable). Null is NOT 'uncertain':
 * uncertain is a judgment the model made and routes to a human, whereas null
 * means the screen did not run and the caller should try again later.
 *
 * Frames live only in a per-scan temp directory and are deleted in the finally
 * block, matching the Film Study retention rule (#103 prerequisite 3). Nothing
 * here writes a frame to blob storage or logs frame content.
 */
export async function runContentScreen(blobPath: string): Promise<ContentVerdict | null> {
  if (!isFilmStudyVisionConfigured()) {
    return null;
  }

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ppbf-video-scan-'));
  try {
    const bytes = await downloadPilotVideoFile(blobPath);
    const clipPath = path.join(workDir, 'clip');
    await fs.writeFile(clipPath, bytes);

    const { framePaths } = await extractFrames({
      clipPath,
      directory: workDir,
      intervalSeconds: VIDEO_SCAN_FRAME_INTERVAL_SECONDS,
      maxFrames: VIDEO_SCAN_MAX_FRAMES,
    });
    const frames = await Promise.all(framePaths.map((framePath) => fs.readFile(framePath)));

    const analysis = await analyzeFramesWithVision({
      frames,
      prompt: VIDEO_CONTENT_SCREEN_PROMPT,
      maxCompletionTokens: VIDEO_SCAN_MAX_COMPLETION_TOKENS,
    });

    return parseContentScreenVerdict(analysis.content);
  } catch (error) {
    // Log the code only. The message may carry a blob path; the frames and the
    // model's prose must never reach a log line.
    console.error('SHADOW video content screen failed', {
      errorCode: error instanceof Error ? error.message : 'UNKNOWN',
    });
    return null;
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

export interface VideoScanResult extends VideoScanOutcome {
  malware: MalwareVerdict | null;
  content: ContentVerdict | null;
  durationMs: number;
}

/**
 * Collect every enabled gate's signal and hand them to the policy.
 *
 * A disabled gate is not consulted at all -- no blob read, no vision call --
 * and reports null, which the policy already knows not to count as a pass.
 */
export async function scanVideoSession(params: {
  blobPath: string;
  attempts: number;
  config: VideoScanConfig;
  maxAttempts?: number;
}): Promise<VideoScanResult> {
  const start = Date.now();
  const { config } = params;

  const malware = config.malware === 'off' ? null : await readMalwareVerdict(params.blobPath);
  const content = config.content === 'off' ? null : await runContentScreen(params.blobPath);

  const outcome = decideVideoScanOutcome({
    config,
    signals: {
      ...(malware === null ? {} : { malware }),
      ...(content === null ? {} : { content }),
    },
    attempts: params.attempts,
    maxAttempts: params.maxAttempts,
  });

  return { ...outcome, malware, content, durationMs: Date.now() - start };
}
