import { sweepQuarantinedVideos } from './videoScanSweep';
import { scanVideoSession } from './videoScan';
import { claimNextVideoSessionForScan, settleVideoSessionScan } from './videoSessions';
import { emitShadowEvent } from './shadowEvents';
import { fileEscalation } from './escalationLadder';

jest.mock('./videoScan', () => ({ scanVideoSession: jest.fn() }));
jest.mock('./videoSessions', () => {
  // Only the two database functions are doubled. scanRetryBackoffSeconds and
  // isTerminalScanDecision are pure and are used FOR REAL here, so a backoff or
  // terminality bug shows up in this suite instead of being mocked away -- the
  // mistake the tierToSessionType double made in #128.
  const actual = jest.requireActual('./videoSessions');
  return {
    ...actual,
    claimNextVideoSessionForScan: jest.fn(),
    settleVideoSessionScan: jest.fn(),
  };
});
jest.mock('./shadowEvents', () => ({ emitShadowEvent: jest.fn() }));
jest.mock('./escalationLadder', () => ({ fileEscalation: jest.fn() }));

const mockedScan = scanVideoSession as jest.MockedFunction<typeof scanVideoSession>;
const mockedClaim = claimNextVideoSessionForScan as jest.MockedFunction<typeof claimNextVideoSessionForScan>;
const mockedSettle = settleVideoSessionScan as jest.MockedFunction<typeof settleVideoSessionScan>;
const mockedEmit = emitShadowEvent as jest.MockedFunction<typeof emitShadowEvent>;
const mockedFileEscalation = fileEscalation as jest.MockedFunction<typeof fileEscalation>;

const CONTENT_ON = { PPBF_VIDEO_CONTENT_SCAN: 'vision' };

const CLAIM = {
  video_session_id: 'vs-1',
  organization_id: 'org-1',
  athlete_id: 'ath-1',
  blob_path: 'org-1/vs-1/clip.mp4',
  status: 'quarantined',
  scan_attempts: 1,
};

function scanResult(overrides: Partial<Awaited<ReturnType<typeof scanVideoSession>>>) {
  return {
    decision: 'retry' as const,
    gatesEnabled: ['content'],
    gatesPassed: [],
    reason: 'SCAN_VERDICT_PENDING',
    malware: null,
    content: null,
    durationMs: 5,
    ...overrides,
  };
}

beforeEach(() => {
  mockedScan.mockReset();
  mockedClaim.mockReset();
  mockedSettle.mockReset();
  mockedEmit.mockReset();
  mockedFileEscalation.mockReset();
  mockedSettle.mockResolvedValue(true);
  mockedEmit.mockResolvedValue(undefined);
  mockedFileEscalation.mockResolvedValue({} as Awaited<ReturnType<typeof fileEscalation>>);
});

describe('sweepQuarantinedVideos', () => {
  test('does no database work at all when no gate is configured', async () => {
    // The important half of this is `claim` never being called. An
    // unconfigured environment must not burn a scan attempt per worker tick on
    // every quarantined video it will never be able to promote.
    const result = await sweepQuarantinedVideos({ env: {} });

    expect(result).toEqual({ scanned: 0, promoted: 0, blocked: 0, skippedReason: 'not_configured' });
    expect(mockedClaim).not.toHaveBeenCalled();
    expect(mockedScan).not.toHaveBeenCalled();
    expect(mockedSettle).not.toHaveBeenCalled();
  });

  test('reports nothing due when the queue is empty', async () => {
    mockedClaim.mockResolvedValue(null);
    const result = await sweepQuarantinedVideos({ env: CONTENT_ON });
    expect(result).toMatchObject({ scanned: 0, skippedReason: 'nothing_due' });
  });

  test('a pass promotes the video to ready and records the gates', async () => {
    mockedClaim.mockResolvedValueOnce(CLAIM).mockResolvedValue(null);
    mockedScan.mockResolvedValue(scanResult({
      decision: 'promote',
      gatesPassed: ['content'],
      reason: 'ALL_GATES_PASSED',
      content: 'pass',
    }));

    const result = await sweepQuarantinedVideos({ env: CONTENT_ON });

    expect(result).toMatchObject({ scanned: 1, promoted: 1, blocked: 0 });
    expect(mockedSettle).toHaveBeenCalledWith(expect.objectContaining({
      videoSessionId: 'vs-1',
      scanState: 'passed',
      nextStatus: 'ready',
      terminal: true,
      retryInSeconds: 0,
    }));
  });

  test('a malware hit marks the video infected and files a high-severity escalation', async () => {
    mockedClaim.mockResolvedValueOnce(CLAIM).mockResolvedValue(null);
    mockedScan.mockResolvedValue(scanResult({
      decision: 'infected', reason: 'MALWARE_DETECTED', malware: 'malicious',
    }));

    const result = await sweepQuarantinedVideos({ env: CONTENT_ON });

    expect(result).toMatchObject({ scanned: 1, promoted: 0, blocked: 1 });
    expect(mockedSettle).toHaveBeenCalledWith(expect.objectContaining({
      scanState: 'infected', nextStatus: 'infected', terminal: true,
    }));
    expect(mockedFileEscalation).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: 'org-1',
      sourceType: 'video_scan',
      sourceId: 'vs-1',
      athleteId: 'ath-1',
      severity: 'high',
      triggeredBy: 'system',
      metadata: expect.objectContaining({ video_session_id: 'vs-1', decision: 'infected', reason: 'MALWARE_DETECTED' }),
    }));
  });

  test('a refusal and an uncertain verdict both leave status alone and escalate at their own severity', async () => {
    for (const [decision, scanState, severity] of [
      ['blocked', 'blocked', 'critical'],
      ['needs_human_review', 'needs_human_review', 'moderate'],
    ] as const) {
      mockedSettle.mockClear();
      mockedFileEscalation.mockClear();
      mockedClaim.mockReset().mockResolvedValueOnce(CLAIM).mockResolvedValue(null);
      mockedScan.mockResolvedValue(scanResult({ decision, reason: 'X' }));

      await sweepQuarantinedVideos({ env: CONTENT_ON });

      // nextStatus null is what keeps the row quarantined -- the state all
      // three readers already refuse.
      expect(mockedSettle).toHaveBeenCalledWith(expect.objectContaining({
        scanState, nextStatus: null, terminal: true,
      }));
      // The escalation ladder is the surface this closes: a blocked or
      // needs_human_review video used to be visible only on the video-review
      // page's own filtered list.
      expect(mockedFileEscalation).toHaveBeenCalledWith(expect.objectContaining({
        sourceType: 'video_scan',
        athleteId: 'ath-1',
        severity,
        triggeredBy: 'system',
      }));
    }
  });

  test('does not escalate a promoted video', async () => {
    mockedClaim.mockResolvedValueOnce(CLAIM).mockResolvedValue(null);
    mockedScan.mockResolvedValue(scanResult({ decision: 'promote', gatesPassed: ['content'] }));

    await sweepQuarantinedVideos({ env: CONTENT_ON });

    expect(mockedFileEscalation).not.toHaveBeenCalled();
  });

  test('does not escalate a non-terminal retry', async () => {
    mockedClaim.mockResolvedValueOnce(CLAIM).mockResolvedValue(null);
    mockedScan.mockResolvedValue(scanResult({ decision: 'retry' }));

    await sweepQuarantinedVideos({ env: CONTENT_ON });

    expect(mockedFileEscalation).not.toHaveBeenCalled();
  });

  test('skips escalation for a blocked/infected video with no athlete_id (unattributed team upload)', async () => {
    // pilot.safety_escalations.athlete_id is not-null with a foreign key to
    // pilot.athletes -- an unattributed upload has nothing to file against.
    mockedClaim.mockResolvedValueOnce({ ...CLAIM, athlete_id: null }).mockResolvedValue(null);
    mockedScan.mockResolvedValue(scanResult({ decision: 'blocked', reason: 'CONTENT_SCREEN_REFUSED' }));

    const result = await sweepQuarantinedVideos({ env: CONTENT_ON });

    expect(result).toMatchObject({ scanned: 1, blocked: 1 });
    expect(mockedFileEscalation).not.toHaveBeenCalled();
  });

  test('a retry backs off instead of re-scanning at worker cadence', async () => {
    mockedClaim.mockResolvedValueOnce({ ...CLAIM, scan_attempts: 3 }).mockResolvedValue(null);
    mockedScan.mockResolvedValue(scanResult({ decision: 'retry' }));

    await sweepQuarantinedVideos({ env: CONTENT_ON });

    // Real scanRetryBackoffSeconds: 30 * 2^(3-1) = 120.
    expect(mockedSettle).toHaveBeenCalledWith(expect.objectContaining({
      scanState: 'pending', nextStatus: null, terminal: false, retryInSeconds: 120,
    }));
  });

  test('only terminal decisions emit an event', async () => {
    mockedClaim.mockResolvedValueOnce(CLAIM).mockResolvedValue(null);
    mockedScan.mockResolvedValue(scanResult({ decision: 'retry' }));
    await sweepQuarantinedVideos({ env: CONTENT_ON });
    expect(mockedEmit).not.toHaveBeenCalled();

    mockedClaim.mockReset().mockResolvedValueOnce(CLAIM).mockResolvedValue(null);
    mockedScan.mockResolvedValue(scanResult({ decision: 'promote', gatesPassed: ['content'] }));
    await sweepQuarantinedVideos({ env: CONTENT_ON });

    expect(mockedEmit).toHaveBeenCalledWith(expect.objectContaining({
      eventName: 'video.scan_settled',
      entityId: 'vs-1',
      // An automated verdict is attributed to nobody. Naming a human here
      // would credit a person who never saw the video.
      actorAccountId: null,
      actorRole: null,
    }));
  });

  test('the model\'s prose about the footage never reaches the database', async () => {
    mockedClaim.mockResolvedValueOnce(CLAIM).mockResolvedValue(null);
    mockedScan.mockResolvedValue(scanResult({
      decision: 'promote', gatesPassed: ['content'], content: 'pass',
    }));

    await sweepQuarantinedVideos({ env: CONTENT_ON });

    const detail = mockedSettle.mock.calls[0][0].detail;
    // Verdict enums and gate names only -- nothing describing what is in the
    // frames, which for this platform means video of a minor.
    expect(Object.keys(detail).sort()).toEqual([
      'attempts', 'content_verdict', 'decision', 'duration_ms',
      'gates_enabled', 'gates_passed', 'malware_verdict', 'reason', 'scanned_at',
    ]);
    expect(detail.content_verdict).toBe('pass');
  });

  test('a failed event write does not undo the verdict or stop the sweep', async () => {
    mockedClaim.mockResolvedValueOnce(CLAIM).mockResolvedValue(null);
    mockedScan.mockResolvedValue(scanResult({ decision: 'promote', gatesPassed: ['content'] }));
    mockedEmit.mockRejectedValue(new Error('events table unavailable'));

    const result = await sweepQuarantinedVideos({ env: CONTENT_ON });

    expect(result).toMatchObject({ scanned: 1, promoted: 1 });
    expect(mockedSettle).toHaveBeenCalledTimes(1);
  });

  test('scans at most maxScans videos per sweep', async () => {
    mockedClaim.mockResolvedValue(CLAIM);
    mockedScan.mockResolvedValue(scanResult({ decision: 'promote', gatesPassed: ['content'] }));

    const result = await sweepQuarantinedVideos({ env: CONTENT_ON, maxScans: 3 });

    expect(result.scanned).toBe(3);
    expect(mockedClaim).toHaveBeenCalledTimes(3);
  });

  test('passes the claim\'s attempt count to the scan, not zero', async () => {
    // The attempt budget only works if the count survives the round trip; a
    // hardcoded 0 here would make SCAN_VERDICT_NEVER_ARRIVED unreachable and
    // retry a silent scanner forever.
    mockedClaim.mockResolvedValueOnce({ ...CLAIM, scan_attempts: 7 }).mockResolvedValue(null);
    mockedScan.mockResolvedValue(scanResult({ decision: 'retry' }));

    await sweepQuarantinedVideos({ env: CONTENT_ON });

    expect(mockedScan).toHaveBeenCalledWith(expect.objectContaining({
      attempts: 7, blobPath: 'org-1/vs-1/clip.mp4',
    }));
  });
});
