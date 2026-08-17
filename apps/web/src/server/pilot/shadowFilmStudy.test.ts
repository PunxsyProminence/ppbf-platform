import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  analyzeFramesWithVision,
  buildExtractFramesArgs,
  buildSceneFramesArgs,
  buildSynthesizeClipArgs,
  buildThumbnailFramesArgs,
  buildTileFramesArgs,
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
} from './shadowFilmStudy';
import { execFile } from 'node:child_process';

jest.mock('node:child_process', () => ({
  execFile: jest.fn(),
}));

const mockExecFile = jest.mocked(execFile) as unknown as jest.Mock;

const ENABLED_ENV = {
  AZURE_AI_ENDPOINT: 'https://example.cognitiveservices.azure.com/',
  AZURE_AI_KEY: 'key-123',
  AZURE_AI_VISION_DEPLOYMENT_NAME: 'gpt-5-vision-shadow',
};

const JPEG = Buffer.from('fake-jpeg-bytes');

function succeedExecFile(): void {
  mockExecFile.mockImplementation((...args: unknown[]) => {
    const callback = args[args.length - 1] as (err: unknown, out: { stdout: string; stderr: string }) => void;
    callback(null, { stdout: '', stderr: '' });
  });
}

afterEach(() => {
  jest.resetAllMocks();
});

describe('sampling policy constants', () => {
  // These ARE the cost model (#103): a change here changes per-video spend
  // and must be an owner decision on the issue, not a drive-by edit.
  test('one frame every 2 seconds, capped at 90 frames (a 3-minute clip)', () => {
    expect(FILM_STUDY_FRAME_INTERVAL_SECONDS).toBe(2);
    expect(FILM_STUDY_MAX_FRAMES_PER_JOB).toBe(90);
    expect(FILM_STUDY_FRAME_INTERVAL_SECONDS * FILM_STUDY_MAX_FRAMES_PER_JOB).toBe(180);
  });
});

describe('vision configuration gating', () => {
  test('OFF by default: any missing variable disables vision', () => {
    expect(isFilmStudyVisionConfigured({})).toBe(false);
    expect(isFilmStudyVisionConfigured({ ...ENABLED_ENV, AZURE_AI_VISION_DEPLOYMENT_NAME: undefined })).toBe(false);
    expect(isFilmStudyVisionConfigured({ ...ENABLED_ENV, AZURE_AI_ENDPOINT: '  ' })).toBe(false);
    expect(isFilmStudyVisionConfigured({ ...ENABLED_ENV, AZURE_AI_KEY: '' })).toBe(false);
  });

  test('ON only when deployment, endpoint, and key are all present', () => {
    expect(isFilmStudyVisionConfigured(ENABLED_ENV)).toBe(true);
    expect(getVisionDeploymentName(ENABLED_ENV)).toBe('gpt-5-vision-shadow');
  });
});

describe('ffmpeg argument builders', () => {
  test('synthesize uses lavfi testsrc2 with the requested duration', () => {
    const args = buildSynthesizeClipArgs('/tmp/x/clip.mp4', 12);
    expect(args).toContain('lavfi');
    expect(args.some((value) => value.includes('testsrc2') && value.includes('duration=12'))).toBe(true);
    expect(args[args.length - 1]).toBe('/tmp/x/clip.mp4');
  });

  test('extract samples at fps=1/interval and caps frame count', () => {
    const args = buildExtractFramesArgs('/tmp/x/clip.mp4', '/tmp/x/frame-%03d.jpg', 2, 90);
    expect(args).toContain('fps=1/2');
    const framesFlag = args.indexOf('-frames:v');
    expect(framesFlag).toBeGreaterThan(-1);
    expect(args[framesFlag + 1]).toBe('90');
  });

  test('non-integer or out-of-bounds numbers are refused, never interpolated', () => {
    expect(() => buildSynthesizeClipArgs('/tmp/c.mp4', 0)).toThrow('SHADOW_FILM_INPUT_INVALID');
    expect(() => buildSynthesizeClipArgs('/tmp/c.mp4', 61)).toThrow('SHADOW_FILM_INPUT_INVALID');
    expect(() => buildSynthesizeClipArgs('/tmp/c.mp4', 2.5)).toThrow('SHADOW_FILM_INPUT_INVALID');
    expect(() => buildExtractFramesArgs('/tmp/c.mp4', '/tmp/f-%03d.jpg', 0, 10)).toThrow('SHADOW_FILM_INPUT_INVALID');
    expect(() => buildExtractFramesArgs('/tmp/c.mp4', '/tmp/f-%03d.jpg', 2, FILM_STUDY_MAX_FRAMES_PER_JOB + 1))
      .toThrow('SHADOW_FILM_INPUT_INVALID');
  });
});

describe('ffmpeg execution wrappers', () => {
  test('a missing ffmpeg binary reports SHADOW_FILM_FFMPEG_MISSING', async () => {
    mockExecFile.mockImplementation((...args: unknown[]) => {
      const callback = args[args.length - 1] as (err: unknown) => void;
      callback(Object.assign(new Error('spawn ffmpeg ENOENT'), { code: 'ENOENT' }));
    });
    await expect(synthesizeTestClip({ directory: os.tmpdir(), durationSeconds: 12 }))
      .rejects.toThrow('SHADOW_FILM_FFMPEG_MISSING');
  });

  test('a failing ffmpeg run reports SHADOW_FILM_FFMPEG_FAILED', async () => {
    mockExecFile.mockImplementation((...args: unknown[]) => {
      const callback = args[args.length - 1] as (err: unknown) => void;
      callback(Object.assign(new Error('exit 1'), { code: 1 }));
    });
    await expect(synthesizeTestClip({ directory: os.tmpdir(), durationSeconds: 12 }))
      .rejects.toThrow('SHADOW_FILM_FFMPEG_FAILED');
  });

  test('extraction that produces zero frames is a failure, not a success', async () => {
    succeedExecFile();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'film-test-'));
    try {
      await expect(extractFrames({ clipPath: path.join(dir, 'clip.mp4'), directory: dir }))
        .rejects.toThrow('SHADOW_FILM_FFMPEG_FAILED');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('extraction returns the produced frames sorted', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'film-test-'));
    mockExecFile.mockImplementation((...args: unknown[]) => {
      const callback = args[args.length - 1] as (err: unknown, out: { stdout: string; stderr: string }) => void;
      Promise.all([
        fs.writeFile(path.join(dir, 'frame-002.jpg'), 'b'),
        fs.writeFile(path.join(dir, 'frame-001.jpg'), 'a'),
      ]).then(() => callback(null, { stdout: '', stderr: '' }), (error) => callback(error, { stdout: '', stderr: '' }));
    });
    try {
      const result = await extractFrames({ clipPath: path.join(dir, 'clip.mp4'), directory: dir });
      expect(result.framePaths).toEqual([
        path.join(dir, 'frame-001.jpg'),
        path.join(dir, 'frame-002.jpg'),
      ]);
      expect(result.extractMs).toBeGreaterThanOrEqual(0);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('alternative extraction strategies', () => {
  // Every strategy spends the same budget: no builder may accept more than
  // FILM_STUDY_MAX_FRAMES_PER_JOB, so adopting one is never a cost increase.
  test('strategy defaults preserve the stated cost model', () => {
    // One representative frame per 60 source frames = one per 2 seconds at
    // the 30fps the synthesized clip uses — the interval policy, kept.
    expect(FILM_STUDY_THUMBNAIL_WINDOW_FRAMES).toBe(60);
    // 3×3 cells at the 2-second interval: 90 sampled frames become 10 images.
    expect(FILM_STUDY_TILE_COLUMNS * FILM_STUDY_TILE_ROWS).toBe(9);
    expect(FILM_STUDY_SCENE_THRESHOLD_PERCENT).toBe(30);
  });

  test('thumbnail selects per-window representatives with vfr sync', () => {
    const args = buildThumbnailFramesArgs('/tmp/x/clip.mp4', '/tmp/x/thumb-%03d.jpg', 60, 90);
    expect(args).toContain('thumbnail=n=60');
    const vsync = args.indexOf('-vsync');
    expect(vsync).toBeGreaterThan(-1);
    expect(args[vsync + 1]).toBe('vfr');
    const framesFlag = args.indexOf('-frames:v');
    expect(args[framesFlag + 1]).toBe('90');
  });

  test('tile caps output tiles so sampled frames never exceed the budget', () => {
    const args = buildTileFramesArgs('/tmp/x/clip.mp4', '/tmp/x/tile-%03d.jpg', 2, 3, 3, 90);
    expect(args).toContain('fps=1/2,scale=480:-2,tile=3x3');
    const framesFlag = args.indexOf('-frames:v');
    // 90 frames / 9 cells = 10 tiles, not 90 tiles of 9 frames each.
    expect(args[framesFlag + 1]).toBe('10');
  });

  test('a budget too small for one full tile is refused, not exceeded', () => {
    expect(() => buildTileFramesArgs('/tmp/c.mp4', '/tmp/t-%03d.jpg', 2, 3, 3, 8))
      .toThrow('SHADOW_FILM_INPUT_INVALID');
  });

  test('scene selection includes frame 0 and formats the threshold from a validated integer', () => {
    const args = buildSceneFramesArgs('/tmp/x/clip.mp4', '/tmp/x/scene-%03d.jpg', 30, 90);
    expect(args).toContain("select='eq(n,0)+gt(scene,0.30)'");
    expect(buildSceneFramesArgs('/tmp/c.mp4', '/tmp/s-%03d.jpg', 5, 10))
      .toContain("select='eq(n,0)+gt(scene,0.05)'");
  });

  test('out-of-bounds strategy parameters are refused, never interpolated', () => {
    expect(() => buildThumbnailFramesArgs('/tmp/c.mp4', '/tmp/t-%03d.jpg', 1, 10))
      .toThrow('SHADOW_FILM_INPUT_INVALID');
    expect(() => buildThumbnailFramesArgs('/tmp/c.mp4', '/tmp/t-%03d.jpg', 60, FILM_STUDY_MAX_FRAMES_PER_JOB + 1))
      .toThrow('SHADOW_FILM_INPUT_INVALID');
    expect(() => buildTileFramesArgs('/tmp/c.mp4', '/tmp/t-%03d.jpg', 2, 1, 3, 90))
      .toThrow('SHADOW_FILM_INPUT_INVALID');
    expect(() => buildTileFramesArgs('/tmp/c.mp4', '/tmp/t-%03d.jpg', 2, 3, 5, 90))
      .toThrow('SHADOW_FILM_INPUT_INVALID');
    expect(() => buildSceneFramesArgs('/tmp/c.mp4', '/tmp/s-%03d.jpg', 0, 90))
      .toThrow('SHADOW_FILM_INPUT_INVALID');
    expect(() => buildSceneFramesArgs('/tmp/c.mp4', '/tmp/s-%03d.jpg', 100, 90))
      .toThrow('SHADOW_FILM_INPUT_INVALID');
  });

  test('each strategy collects only its own filename prefix', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'film-test-'));
    mockExecFile.mockImplementation((...args: unknown[]) => {
      const callback = args[args.length - 1] as (err: unknown, out: { stdout: string; stderr: string }) => void;
      Promise.all([
        fs.writeFile(path.join(dir, 'frame-001.jpg'), 'interval'),
        fs.writeFile(path.join(dir, 'thumb-002.jpg'), 'rep-b'),
        fs.writeFile(path.join(dir, 'thumb-001.jpg'), 'rep-a'),
        fs.writeFile(path.join(dir, 'tile-001.jpg'), 'mosaic'),
        fs.writeFile(path.join(dir, 'scene-001.jpg'), 'cut'),
      ]).then(() => callback(null, { stdout: '', stderr: '' }), (error) => callback(error, { stdout: '', stderr: '' }));
    });
    try {
      const clipPath = path.join(dir, 'clip.mp4');
      const representative = await extractRepresentativeFrames({ clipPath, directory: dir });
      expect(representative.framePaths).toEqual([
        path.join(dir, 'thumb-001.jpg'),
        path.join(dir, 'thumb-002.jpg'),
      ]);
      const tiled = await extractTiledFrames({ clipPath, directory: dir });
      expect(tiled.framePaths).toEqual([path.join(dir, 'tile-001.jpg')]);
      const scene = await extractSceneFrames({ clipPath, directory: dir });
      expect(scene.framePaths).toEqual([path.join(dir, 'scene-001.jpg')]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('a strategy producing zero frames is a failure, not a success', async () => {
    succeedExecFile();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'film-test-'));
    try {
      await expect(extractRepresentativeFrames({ clipPath: path.join(dir, 'clip.mp4'), directory: dir }))
        .rejects.toThrow('SHADOW_FILM_FFMPEG_FAILED');
      await expect(extractSceneFrames({ clipPath: path.join(dir, 'clip.mp4'), directory: dir }))
        .rejects.toThrow('SHADOW_FILM_FFMPEG_FAILED');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('analyzeFramesWithVision', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  function mockFetchResponse(body: unknown, ok = true, status = 200): jest.Mock {
    const json = jest.fn().mockResolvedValue(body);
    const fetchMock = jest.fn().mockResolvedValue({ ok, status, json });
    global.fetch = fetchMock as unknown as typeof fetch;
    return fetchMock;
  }

  test('refuses to run unconfigured', async () => {
    await expect(analyzeFramesWithVision({ frames: [JPEG], prompt: 'p', env: {} }))
      .rejects.toThrow('SHADOW_FILM_VISION_UNCONFIGURED');
  });

  test('refuses empty and oversized frame batches', async () => {
    await expect(analyzeFramesWithVision({ frames: [], prompt: 'p', env: ENABLED_ENV }))
      .rejects.toThrow('SHADOW_FILM_INPUT_INVALID');
    await expect(analyzeFramesWithVision({ frames: [Buffer.alloc(0)], prompt: 'p', env: ENABLED_ENV }))
      .rejects.toThrow('SHADOW_FILM_INPUT_INVALID');
  });

  test('sends frames as data URIs with no temperature and a reasoning-safe token budget', async () => {
    const fetchMock = mockFetchResponse({
      choices: [{ message: { content: 'two frames, pattern shifted' } }],
      usage: {
        prompt_tokens: 900,
        completion_tokens: 350,
        completion_tokens_details: { reasoning_tokens: 256 },
      },
    });

    const result = await analyzeFramesWithVision({
      frames: [JPEG, JPEG],
      prompt: 'Describe the difference between frames.',
      env: ENABLED_ENV,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(url).toContain('/openai/deployments/gpt-5-vision-shadow/chat/completions');
    const body = JSON.parse(init.body);
    // Measured fact (§6): reasoning deployments 400 on any non-default
    // temperature, so the key must be absent entirely.
    expect('temperature' in body).toBe(false);
    expect(body.max_completion_tokens).toBe(4096);
    expect(body.messages).toHaveLength(1);
    const content = body.messages[0].content;
    expect(content[0]).toEqual({ type: 'text', text: 'Describe the difference between frames.' });
    expect(content).toHaveLength(3);
    expect(content[1].image_url.url.startsWith('data:image/jpeg;base64,')).toBe(true);

    expect(result.content).toBe('two frames, pattern shifted');
    expect(result.promptTokens).toBe(900);
    expect(result.completionTokens).toBe(350);
    expect(result.reasoningTokens).toBe(256);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  test('provider error status is reported by code and the body is never read', async () => {
    const json = jest.fn();
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 429, json }) as unknown as typeof fetch;
    await expect(analyzeFramesWithVision({ frames: [JPEG], prompt: 'p', env: ENABLED_ENV }))
      .rejects.toThrow('SHADOW_AI_PROVIDER_ERROR');
    expect(json).not.toHaveBeenCalled();
  });

  test('missing usage yields nulls, not fabricated counts', async () => {
    mockFetchResponse({ choices: [{ message: { content: 'ok' } }] });
    const result = await analyzeFramesWithVision({ frames: [JPEG], prompt: 'p', env: ENABLED_ENV });
    expect(result.promptTokens).toBeNull();
    expect(result.completionTokens).toBeNull();
    expect(result.reasoningTokens).toBeNull();
  });

  test('empty content is SHADOW_AI_EMPTY_RESPONSE', async () => {
    mockFetchResponse({ choices: [{ message: { content: '   ' } }] });
    await expect(analyzeFramesWithVision({ frames: [JPEG], prompt: 'p', env: ENABLED_ENV }))
      .rejects.toThrow('SHADOW_AI_EMPTY_RESPONSE');
  });

  test('network failure is SHADOW_AI_PROVIDER_UNAVAILABLE', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch;
    await expect(analyzeFramesWithVision({ frames: [JPEG], prompt: 'p', env: ENABLED_ENV }))
      .rejects.toThrow('SHADOW_AI_PROVIDER_UNAVAILABLE');
  });
});
