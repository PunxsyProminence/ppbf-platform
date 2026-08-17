import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { NextRequest } from 'next/server';

import { POST } from './route';
import { requirePrincipal } from '@/src/server/pilot/http';
import {
  analyzeFramesWithVision,
  extractFrames,
  extractRepresentativeFrames,
  extractSceneFrames,
  extractTiledFrames,
  isFilmStudyVisionConfigured,
  synthesizeTestClip,
} from '@/src/server/pilot/shadowFilmStudy';

jest.mock('@/src/server/pilot/http', () => ({
  ...jest.requireActual('@/src/server/pilot/http'),
  requirePrincipal: jest.fn(),
}));
jest.mock('@/src/server/pilot/shadowFilmStudy', () => ({
  ...jest.requireActual('@/src/server/pilot/shadowFilmStudy'),
  analyzeFramesWithVision: jest.fn(),
  extractFrames: jest.fn(),
  extractRepresentativeFrames: jest.fn(),
  extractSceneFrames: jest.fn(),
  extractTiledFrames: jest.fn(),
  isFilmStudyVisionConfigured: jest.fn(),
  getVisionDeploymentName: jest.fn(() => 'gpt-5-vision-shadow'),
  synthesizeTestClip: jest.fn(),
}));

const mockRequirePrincipal = jest.mocked(requirePrincipal);
const mockAnalyze = jest.mocked(analyzeFramesWithVision);
const mockExtract = jest.mocked(extractFrames);
const mockExtractRepresentative = jest.mocked(extractRepresentativeFrames);
const mockExtractScene = jest.mocked(extractSceneFrames);
const mockExtractTiled = jest.mocked(extractTiledFrames);
const mockConfigured = jest.mocked(isFilmStudyVisionConfigured);
const mockSynthesize = jest.mocked(synthesizeTestClip);

const originalFlag = process.env.PPBF_FILM_STUDY_DIAGNOSTIC_ENABLED;

let frameDir = '';

function makeRequest(body: Record<string, unknown> = {}): NextRequest {
  return new NextRequest('http://localhost/api/pilot/shadow/film-study/diagnostic', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

function principal(role: string) {
  return {
    accountId: 'account-1',
    organizationId: 'org-1',
    role,
  };
}

beforeEach(async () => {
  process.env.PPBF_FILM_STUDY_DIAGNOSTIC_ENABLED = 'true';
  mockRequirePrincipal.mockResolvedValue(principal('organization_admin') as never);
  frameDir = await fs.mkdtemp(path.join(os.tmpdir(), 'film-route-test-'));
  const frameA = path.join(frameDir, 'frame-001.jpg');
  const frameB = path.join(frameDir, 'frame-002.jpg');
  await fs.writeFile(frameA, Buffer.from('jpeg-a'));
  await fs.writeFile(frameB, Buffer.from('jpeg-b'));
  mockSynthesize.mockResolvedValue({ clipPath: path.join(frameDir, 'clip.mp4'), synthesizeMs: 150 });
  mockExtract.mockResolvedValue({ framePaths: [frameA, frameB], extractMs: 80 });
  mockExtractRepresentative.mockResolvedValue({ framePaths: [frameA, frameB], extractMs: 95 });
  mockExtractTiled.mockResolvedValue({ framePaths: [frameA], extractMs: 120 });
  mockExtractScene.mockResolvedValue({ framePaths: [frameA], extractMs: 200 });
  mockConfigured.mockReturnValue(true);
  mockAnalyze.mockResolvedValue({
    content: 'MODEL-OBSERVATION-TEXT',
    latencyMs: 42_000,
    promptTokens: 900,
    completionTokens: 400,
    reasoningTokens: 300,
  });
});

afterEach(async () => {
  jest.clearAllMocks();
  if (originalFlag === undefined) {
    delete process.env.PPBF_FILM_STUDY_DIAGNOSTIC_ENABLED;
  } else {
    process.env.PPBF_FILM_STUDY_DIAGNOSTIC_ENABLED = originalFlag;
  }
  await fs.rm(frameDir, { recursive: true, force: true });
});

describe('POST /api/pilot/shadow/film-study/diagnostic', () => {
  test('refuses when the environment flag is off, before any ffmpeg work', async () => {
    delete process.env.PPBF_FILM_STUDY_DIAGNOSTIC_ENABLED;
    const response = await POST(makeRequest());
    expect(response.status).toBe(403);
    expect(mockSynthesize).not.toHaveBeenCalled();
  });

  test('refuses non-admin roles', async () => {
    mockRequirePrincipal.mockResolvedValue(principal('coach') as never);
    const response = await POST(makeRequest());
    expect(response.status).toBe(403);
    expect(mockSynthesize).not.toHaveBeenCalled();
  });

  test('reports ffmpeg timings and a real vision measurement', async () => {
    const response = await POST(makeRequest({ vision_frames: 5 }));
    expect(response.status).toBe(200);
    const payload = await response.json();

    expect(payload.sampling).toEqual({ frame_interval_seconds: 2, max_frames_per_job: 90 });
    expect(payload.ffmpeg).toMatchObject({
      clip_duration_seconds: 12,
      synthesize_ms: 150,
      extract_ms: 80,
      frame_count: 2,
    });
    expect(payload.ffmpeg.avg_frame_bytes).toBeGreaterThan(0);
    expect(payload.vision).toMatchObject({
      configured: true,
      attempted: true,
      ok: true,
      deployment: 'gpt-5-vision-shadow',
      frames_sent: 2,
      latency_ms: 42_000,
      prompt_tokens: 900,
      completion_tokens: 400,
      reasoning_tokens: 300,
      response_chars: 'MODEL-OBSERVATION-TEXT'.length,
    });

    // Only two frames exist, so a request for five sends two real ones.
    expect(mockAnalyze).toHaveBeenCalledTimes(1);
    expect(mockAnalyze.mock.calls[0][0].frames).toHaveLength(2);

    // The model's text itself must never leave the server: counts only.
    expect(JSON.stringify(payload)).not.toContain('MODEL-OBSERVATION-TEXT');
  });

  test('measures all three alternative strategies against the same clip', async () => {
    const response = await POST(makeRequest());
    expect(response.status).toBe(200);
    const payload = await response.json();

    expect(payload.strategies.thumbnail).toMatchObject({
      window_frames: 60,
      ok: true,
      extract_ms: 95,
      frame_count: 2,
    });
    expect(payload.strategies.tile).toMatchObject({
      tile_columns: 3,
      tile_rows: 3,
      ok: true,
      extract_ms: 120,
      frame_count: 1,
    });
    expect(payload.strategies.scene).toMatchObject({
      threshold_percent: 30,
      ok: true,
      extract_ms: 200,
      frame_count: 1,
    });
    expect(payload.strategies.thumbnail.avg_frame_bytes).toBeGreaterThan(0);

    // Every strategy ran against the one synthesized clip, in the one
    // request-scoped temp directory.
    const clipPath = mockSynthesize.mock.results[0]?.value
      ? (await mockSynthesize.mock.results[0].value).clipPath
      : undefined;
    expect(mockExtractRepresentative.mock.calls[0][0].clipPath).toBe(clipPath);
    expect(mockExtractTiled.mock.calls[0][0].clipPath).toBe(clipPath);
    expect(mockExtractScene.mock.calls[0][0].clipPath).toBe(clipPath);
  });

  test('a failing strategy is a recorded finding, not a route error', async () => {
    mockExtractScene.mockRejectedValue(new Error('SHADOW_FILM_FFMPEG_FAILED'));
    const response = await POST(makeRequest());
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.strategies.scene).toMatchObject({
      ok: false,
      error: 'SHADOW_FILM_FFMPEG_FAILED',
    });
    // The baseline numbers and the other strategies are still reported.
    expect(payload.ffmpeg.frame_count).toBe(2);
    expect(payload.strategies.thumbnail.ok).toBe(true);
    expect(payload.strategies.tile.ok).toBe(true);
  });

  test('reports vision as unconfigured without attempting a call', async () => {
    mockConfigured.mockReturnValue(false);
    const response = await POST(makeRequest());
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.vision).toEqual({ configured: false, attempted: false });
    expect(mockAnalyze).not.toHaveBeenCalled();
  });

  test('a vision failure is a recorded finding, not a route error', async () => {
    mockAnalyze.mockRejectedValue(new Error('SHADOW_AI_PROVIDER_ERROR'));
    const response = await POST(makeRequest());
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.ffmpeg.frame_count).toBe(2);
    expect(payload.vision).toMatchObject({
      configured: true,
      attempted: true,
      ok: false,
      error: 'SHADOW_AI_PROVIDER_ERROR',
    });
  });

  test('a missing ffmpeg binary is a server error', async () => {
    mockSynthesize.mockRejectedValue(new Error('SHADOW_FILM_FFMPEG_MISSING'));
    const response = await POST(makeRequest());
    expect(response.status).toBe(500);
  });
});
