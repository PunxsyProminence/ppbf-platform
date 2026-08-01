import {
  DEFAULT_MAX_SCAN_ATTEMPTS,
  decideVideoScanOutcome,
  enabledScanGates,
  isVideoScanConfigured,
  parseContentScreenVerdict,
  resolveVideoScanConfig,
  scanStateForDecision,
  videoStatusForDecision,
  type VideoScanConfig,
} from './videoScanPolicy';

const BOTH: VideoScanConfig = { malware: 'defender_index_tags', content: 'vision' };
const CONTENT_ONLY: VideoScanConfig = { malware: 'off', content: 'vision' };
const MALWARE_ONLY: VideoScanConfig = { malware: 'defender_index_tags', content: 'off' };
const NONE: VideoScanConfig = { malware: 'off', content: 'off' };

describe('resolveVideoScanConfig', () => {
  test('both gates default to off', () => {
    expect(resolveVideoScanConfig({})).toEqual(NONE);
  });

  test('only the exact mode tokens enable a gate', () => {
    expect(resolveVideoScanConfig({
      PPBF_VIDEO_MALWARE_SCAN: 'defender_index_tags',
      PPBF_VIDEO_CONTENT_SCAN: 'vision',
    })).toEqual(BOTH);

    // Anything else is off. 'true' and 'on' are the plausible mistakes, and
    // reading them as "enabled" would name a scanner that does not exist.
    for (const value of ['true', 'on', 'yes', '1', 'enabled', 'defender', '']) {
      expect(resolveVideoScanConfig({
        PPBF_VIDEO_MALWARE_SCAN: value,
        PPBF_VIDEO_CONTENT_SCAN: value,
      })).toEqual(NONE);
    }
  });

  test('whitespace around a valid token is tolerated', () => {
    expect(resolveVideoScanConfig({ PPBF_VIDEO_CONTENT_SCAN: '  vision  ' })).toEqual(CONTENT_ONLY);
  });
});

describe('isVideoScanConfigured / enabledScanGates', () => {
  test('reports what is on', () => {
    expect(isVideoScanConfigured(NONE)).toBe(false);
    expect(isVideoScanConfigured(CONTENT_ONLY)).toBe(true);
    expect(enabledScanGates(BOTH)).toEqual(['malware', 'content']);
    expect(enabledScanGates(MALWARE_ONLY)).toEqual(['malware']);
    expect(enabledScanGates(NONE)).toEqual([]);
  });
});

describe('parseContentScreenVerdict', () => {
  test('accepts the exact tokens, case-insensitively, with surrounding whitespace', () => {
    expect(parseContentScreenVerdict('SCAN_PASS')).toBe('pass');
    expect(parseContentScreenVerdict('  scan_pass  \nBoxing training footage.')).toBe('pass');
    expect(parseContentScreenVerdict('SCAN_FAIL\nFrame 3 is not training footage.')).toBe('fail');
  });

  test('a token buried in prose is NOT a pass', () => {
    // The whole reason this is a first-line exact match rather than a
    // substring search: every string below contains the characters "SCAN_PASS"
    // and none of them is the model saying the video is fine.
    expect(parseContentScreenVerdict('I cannot answer SCAN_PASS for these frames.')).toBe('uncertain');
    expect(parseContentScreenVerdict('Not a SCAN_PASS.')).toBe('uncertain');
    expect(parseContentScreenVerdict('The options were SCAN_PASS, SCAN_FAIL, SCAN_UNCERTAIN.')).toBe('uncertain');
  });

  test('anything unrecognized is uncertain, never pass', () => {
    expect(parseContentScreenVerdict('')).toBe('uncertain');
    expect(parseContentScreenVerdict('   ')).toBe('uncertain');
    expect(parseContentScreenVerdict('SCAN_UNCERTAIN')).toBe('uncertain');
    expect(parseContentScreenVerdict('OK')).toBe('uncertain');
    expect(parseContentScreenVerdict('{"verdict":"pass"}')).toBe('uncertain');
  });
});

describe('decideVideoScanOutcome', () => {
  test('with no gate configured it holds and never promotes', () => {
    // The rejected option (c) -- auto-promote on upload -- would show up here
    // as a 'promote' with an empty gate list. It must be unreachable.
    const outcome = decideVideoScanOutcome({ config: NONE, signals: {}, attempts: 0 });
    expect(outcome.decision).toBe('hold');
    expect(outcome.reason).toBe('NO_SCANNER_CONFIGURED');
    expect(outcome.gatesPassed).toEqual([]);
  });

  test('an unconfigured environment does not promote even when signals look clean', () => {
    // Signals can be present while the gate is off (a stale caller, a future
    // refactor). The gate list, not the signal, decides.
    const outcome = decideVideoScanOutcome({
      config: NONE,
      signals: { malware: 'clean', content: 'pass' },
      attempts: 0,
    });
    expect(outcome.decision).toBe('hold');
  });

  test('every enabled gate passing promotes', () => {
    expect(decideVideoScanOutcome({
      config: CONTENT_ONLY, signals: { content: 'pass' }, attempts: 0,
    })).toMatchObject({ decision: 'promote', reason: 'ALL_GATES_PASSED', gatesPassed: ['content'] });

    expect(decideVideoScanOutcome({
      config: BOTH, signals: { malware: 'clean', content: 'pass' }, attempts: 0,
    })).toMatchObject({ decision: 'promote', gatesPassed: ['malware', 'content'] });
  });

  test('a passing gate does not cover for a silent one', () => {
    // THE case this module exists to get right. Content says pass, malware has
    // not reported. Promoting here would serve a video no antivirus has seen
    // while the platform recorded that malware scanning was enabled.
    const outcome = decideVideoScanOutcome({
      config: BOTH,
      signals: { malware: 'not_scanned_yet', content: 'pass' },
      attempts: 0,
    });
    expect(outcome.decision).toBe('retry');
    expect(outcome.reason).toBe('SCAN_VERDICT_PENDING');
    expect(outcome.gatesPassed).toEqual(['content']);
  });

  test('a malware hit outranks a content pass', () => {
    expect(decideVideoScanOutcome({
      config: BOTH, signals: { malware: 'malicious', content: 'pass' }, attempts: 0,
    })).toMatchObject({ decision: 'infected', reason: 'MALWARE_DETECTED' });
  });

  test('a content refusal blocks and does not retry', () => {
    expect(decideVideoScanOutcome({
      config: BOTH, signals: { malware: 'clean', content: 'fail' }, attempts: 0,
    })).toMatchObject({ decision: 'blocked', reason: 'CONTENT_SCREEN_REFUSED' });
  });

  test('uncertainty routes to a human rather than either extreme', () => {
    expect(decideVideoScanOutcome({
      config: BOTH, signals: { malware: 'clean', content: 'uncertain' }, attempts: 0,
    })).toMatchObject({ decision: 'needs_human_review', reason: 'CONTENT_SCREEN_UNCERTAIN' });
  });

  test('an unreadable signal retries and says so', () => {
    expect(decideVideoScanOutcome({
      config: MALWARE_ONLY, signals: { malware: 'unavailable' }, attempts: 0,
    })).toMatchObject({ decision: 'retry', reason: 'SCAN_SIGNAL_UNAVAILABLE' });
  });

  test('a missing signal retries', () => {
    expect(decideVideoScanOutcome({
      config: CONTENT_ONLY, signals: {}, attempts: 0,
    })).toMatchObject({ decision: 'retry', reason: 'SCAN_VERDICT_PENDING' });
  });

  test('a verdict that never arrives ends at human review, not at promotion', () => {
    const outcome = decideVideoScanOutcome({
      config: BOTH,
      signals: { malware: 'not_scanned_yet', content: 'pass' },
      attempts: DEFAULT_MAX_SCAN_ATTEMPTS - 1,
    });
    expect(outcome.decision).toBe('needs_human_review');
    expect(outcome.reason).toBe('SCAN_VERDICT_NEVER_ARRIVED');
  });

  test('retries continue right up to the last attempt', () => {
    const outcome = decideVideoScanOutcome({
      config: BOTH,
      signals: { malware: 'not_scanned_yet' },
      attempts: DEFAULT_MAX_SCAN_ATTEMPTS - 2,
    });
    expect(outcome.decision).toBe('retry');
  });

  test('no combination of non-affirmative signals ever promotes', () => {
    // Exhaustive sweep of the signal space against every gate configuration.
    // A future edit that adds a verdict value and forgets the composition
    // rules fails here rather than in production.
    const malwareValues = ['clean', 'malicious', 'not_scanned_yet', 'unavailable', undefined] as const;
    const contentValues = ['pass', 'fail', 'uncertain', undefined] as const;

    for (const config of [NONE, CONTENT_ONLY, MALWARE_ONLY, BOTH]) {
      for (const malware of malwareValues) {
        for (const content of contentValues) {
          const outcome = decideVideoScanOutcome({
            config,
            signals: {
              ...(malware === undefined ? {} : { malware }),
              ...(content === undefined ? {} : { content }),
            },
            attempts: 0,
          });

          if (outcome.decision !== 'promote') continue;

          // If it promoted, every enabled gate must have affirmatively passed.
          expect(enabledScanGates(config).length).toBeGreaterThan(0);
          if (config.malware !== 'off') expect(malware).toBe('clean');
          if (config.content !== 'off') expect(content).toBe('pass');
        }
      }
    }
  });
});

describe('decision to persisted state', () => {
  test('only promote and infected move video status', () => {
    expect(videoStatusForDecision('promote')).toBe('ready');
    expect(videoStatusForDecision('infected')).toBe('infected');
    // Everything else leaves the row quarantined, which every reader refuses.
    expect(videoStatusForDecision('blocked')).toBeNull();
    expect(videoStatusForDecision('needs_human_review')).toBeNull();
    expect(videoStatusForDecision('retry')).toBeNull();
    expect(videoStatusForDecision('hold')).toBeNull();
  });

  test('every decision maps to a scan_state the migration allows', () => {
    // Mirrors video_sessions_scan_state_check. Adding a decision without
    // widening the constraint would fail at settle time with the verdict
    // already computed and nowhere to put it.
    const allowed = new Set([
      'pending', 'scanning', 'passed', 'infected', 'blocked', 'needs_human_review', 'unconfigured',
    ]);
    for (const decision of ['promote', 'infected', 'blocked', 'needs_human_review', 'retry', 'hold'] as const) {
      expect(allowed.has(scanStateForDecision(decision))).toBe(true);
    }
  });
});
