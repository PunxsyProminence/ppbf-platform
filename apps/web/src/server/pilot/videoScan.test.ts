import {
  readMalwareVerdict,
  runContentScreen,
  scanVideoSession,
  VIDEO_CONTENT_SCREEN_PROMPT,
  VIDEO_SCAN_MAX_FRAMES,
  VIDEO_SCAN_VISION_TIMEOUT_MS,
} from './videoScan';
import { getPilotVideoBlobTags, downloadPilotVideoFile } from './blob';
import { analyzeFramesWithVision, extractFrames, isFilmStudyVisionConfigured } from './shadowFilmStudy';

jest.mock('./blob', () => ({
  getPilotVideoBlobTags: jest.fn(),
  downloadPilotVideoFile: jest.fn(),
}));
jest.mock('./shadowFilmStudy', () => ({
  ...jest.requireActual('./shadowFilmStudy'),
  analyzeFramesWithVision: jest.fn(),
  extractFrames: jest.fn(),
  isFilmStudyVisionConfigured: jest.fn(() => false),
}));

const mockedTags = getPilotVideoBlobTags as jest.MockedFunction<typeof getPilotVideoBlobTags>;

describe('readMalwareVerdict', () => {
  beforeEach(() => {
    mockedTags.mockReset();
  });

  test('reads Defender for Storage\'s verdict off the blob', async () => {
    mockedTags.mockResolvedValue({ 'Malware Scanning scan result': 'No threats found' });
    await expect(readMalwareVerdict('org/vs/clip.mp4')).resolves.toBe('clean');

    mockedTags.mockResolvedValue({ 'Malware Scanning scan result': 'Malicious' });
    await expect(readMalwareVerdict('org/vs/clip.mp4')).resolves.toBe('malicious');
  });

  test('tolerates casing and spacing in the key and value', async () => {
    // The tag name is Microsoft's display-shaped string, not ours. Matching it
    // rigidly would silently degrade to "no verdict" if they change the case.
    mockedTags.mockResolvedValue({ 'MALWARE  SCANNING   SCAN RESULT': '  no threats FOUND ' });
    await expect(readMalwareVerdict('org/vs/clip.mp4')).resolves.toBe('clean');
  });

  test('no tag means not scanned yet, which is not clean', async () => {
    mockedTags.mockResolvedValue({});
    await expect(readMalwareVerdict('org/vs/clip.mp4')).resolves.toBe('not_scanned_yet');

    // Other tags present, but not the scan result.
    mockedTags.mockResolvedValue({ Environment: 'staging' });
    await expect(readMalwareVerdict('org/vs/clip.mp4')).resolves.toBe('not_scanned_yet');
  });

  test('an unrecognized verdict value is unavailable, NEVER clean', async () => {
    // If Microsoft renames a value, this platform must stop promoting videos
    // rather than start promoting unscanned ones.
    for (const value of ['', 'unknown', 'scan skipped', 'No threats found (cached)', 'clean']) {
      mockedTags.mockResolvedValue({ 'Malware Scanning scan result': value });
      await expect(readMalwareVerdict('org/vs/clip.mp4')).resolves.toBe('unavailable');
    }
  });

  test('a storage failure is unavailable, not clean', async () => {
    mockedTags.mockRejectedValue(new Error('network'));
    await expect(readMalwareVerdict('org/vs/clip.mp4')).resolves.toBe('unavailable');
  });
});

describe('content screen prompt', () => {
  test('demands an affirmative token and forbids describing people', () => {
    // The prompt is the safety surface for the content gate, so its load-
    // bearing clauses are asserted rather than left to review.
    expect(VIDEO_CONTENT_SCREEN_PROMPT).toContain('SCAN_PASS');
    expect(VIDEO_CONTENT_SCREEN_PROMPT).toContain('SCAN_FAIL');
    expect(VIDEO_CONTENT_SCREEN_PROMPT).toContain('SCAN_UNCERTAIN');
    expect(VIDEO_CONTENT_SCREEN_PROMPT).toMatch(/FIRST LINE/);
    expect(VIDEO_CONTENT_SCREEN_PROMPT).toMatch(/when in doubt, answer SCAN_UNCERTAIN/i);
    expect(VIDEO_CONTENT_SCREEN_PROMPT).toMatch(/Do not identify, name, describe/i);
  });

  test('the screen samples far more cheaply than Film Study', () => {
    // Scanning runs on every upload; Film Study runs when a coach asks. If
    // these ever converged the platform would pay the dense-sampling cost
    // twice for every video that is never analyzed.
    expect(VIDEO_SCAN_MAX_FRAMES).toBeLessThan(90);
  });
});

describe('scanVideoSession — skipContentScreen (guardian consent missing)', () => {
  const mockedDownload = downloadPilotVideoFile as jest.MockedFunction<typeof downloadPilotVideoFile>;

  beforeEach(() => {
    mockedTags.mockReset();
    mockedDownload.mockReset();
  });

  test('does not touch the network at all, and reports content as null rather than making the gate disappear', async () => {
    // Regression for PR #465 (found independently by Codex and Copilot):
    // skipContentScreen must leave the content gate ENABLED in the returned
    // gatesEnabled list -- it is a "no verdict yet" signal, not a "this gate
    // does not exist" one. Collapsing the two, on an environment with malware
    // scanning off (both deploy workflows leave it unset), would zero out
    // gatesEnabled entirely and resolve to 'hold' -- a state the claim query
    // never reclaims, so a video would stop being scanned forever even after
    // the guardian later consents.
    const result = await scanVideoSession({
      blobPath: 'org-1/vs-1/clip.mp4',
      attempts: 0,
      config: { malware: 'off', content: 'vision' },
      skipContentScreen: true,
    });

    expect(mockedDownload).not.toHaveBeenCalled();
    expect(result.content).toBeNull();
    expect(result.gatesEnabled).toEqual(['content']);
    expect(result.decision).not.toBe('hold');
    // 'retry' (reclaimable, backs off, re-checks consent next attempt) is the
    // expected outcome on the first few attempts; either way, never 'hold'.
    expect(['retry', 'needs_human_review']).toContain(result.decision);
  });

  test('a genuinely unconfigured environment still resolves to hold -- skipContentScreen only matters when a gate is actually enabled', async () => {
    const result = await scanVideoSession({
      blobPath: 'org-1/vs-1/clip.mp4',
      attempts: 0,
      config: { malware: 'off', content: 'off' },
      skipContentScreen: true,
    });

    expect(result.decision).toBe('hold');
  });
});

/*
 * REVIEWER B ON #1369: the guard the sweep passes wraps the vision call
 * itself, after the frames are cut, so a consent change landing during the
 * download and ffmpeg is still seen. A guard answer of null means "do not
 * send": no vision call, and content stays null (the pending/retry path).
 */
describe('runContentScreen — the guard around the vision call', () => {
  const mockedDownload = downloadPilotVideoFile as jest.MockedFunction<typeof downloadPilotVideoFile>;
  const mockedVision = analyzeFramesWithVision as jest.MockedFunction<typeof analyzeFramesWithVision>;
  const mockedExtract = extractFrames as jest.MockedFunction<typeof extractFrames>;
  const mockedConfigured = isFilmStudyVisionConfigured as jest.MockedFunction<typeof isFilmStudyVisionConfigured>;

  beforeEach(() => {
    mockedDownload.mockReset();
    mockedVision.mockReset();
    mockedExtract.mockReset();
    mockedConfigured.mockReset();
    mockedConfigured.mockReturnValue(true);
    mockedDownload.mockResolvedValue(Buffer.from('clip'));
    mockedExtract.mockResolvedValue({ framePaths: [] } as unknown as Awaited<ReturnType<typeof extractFrames>>);
    mockedVision.mockResolvedValue({ content: 'SCAN_PASS' } as Awaited<ReturnType<typeof analyzeFramesWithVision>>);
  });

  test('a guard that refuses stops the call after the frames are cut', async () => {
    const order: string[] = [];
    mockedExtract.mockImplementation(async () => {
      order.push('frames');
      return { framePaths: [] } as unknown as Awaited<ReturnType<typeof extractFrames>>;
    });
    const result = await runContentScreen('org-1/vs-1/clip.mp4', {
      guardVisionCall: async () => { order.push('guard'); return null; },
    });

    expect(order).toEqual(['frames', 'guard']);
    expect(mockedVision).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  test('a guard that allows makes the call inside it, with the scan timeout', async () => {
    const order: string[] = [];
    mockedVision.mockImplementation(async () => {
      order.push('vision');
      return { content: 'SCAN_PASS' } as Awaited<ReturnType<typeof analyzeFramesWithVision>>;
    });
    const result = await runContentScreen('org-1/vs-1/clip.mp4', {
      guardVisionCall: async (send) => { order.push('guard-in'); const out = await send(); order.push('guard-out'); return out; },
    });

    expect(order).toEqual(['guard-in', 'vision', 'guard-out']);
    expect(result).toBe('pass');
    expect(mockedVision).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: VIDEO_SCAN_VISION_TIMEOUT_MS }));
  });

  test('scanVideoSession hands the guard through', async () => {
    const result = await scanVideoSession({
      blobPath: 'org-1/vs-1/clip.mp4',
      attempts: 0,
      config: { malware: 'off', content: 'vision' },
      guardVisionCall: async () => null,
    });

    expect(mockedVision).not.toHaveBeenCalled();
    expect(result.content).toBeNull();
    expect(result.decision).not.toBe('hold');
  });
});
