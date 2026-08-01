// videoScanPolicy.ts — the rules that decide whether an uploaded video may
// leave quarantine. Pure functions, no I/O, so every branch below is testable
// without a database, a blob account, or a vision deployment.
//
// WHY THIS EXISTS (#49). pilot.video_sessions rows are born 'quarantined' and
// every reader requires 'ready'. Nothing in the repository ever wrote 'ready',
// so a real upload landed in a state it could not leave and the Film Study
// chain (#126 gate, #128 executor) had no reachable input. The owner chose the
// scan-and-promote option over a human "mark ready" button, so this module is
// the promotion authority.
//
// THE INVARIANT, stated once: a video is promoted only when at least one gate
// is enabled AND every enabled gate returned an affirmative pass. Absence of a
// verdict is never a pass. If no gate is configured, nothing is promoted --
// ever -- which is what keeps this from quietly degrading into "auto-promote
// on upload", the option that was explicitly rejected. Every decision below
// that is not 'promote' leaves status = 'quarantined', so the failure
// direction of this whole module is "the video stays unreadable".

export type MalwareScanMode = 'defender_index_tags' | 'off';
export type ContentScanMode = 'vision' | 'off';

export interface VideoScanConfig {
  malware: MalwareScanMode;
  content: ContentScanMode;
}

/**
 * 'clean' and 'malicious' are verdicts. The other two are the ABSENCE of a
 * verdict, split apart because they mean different operational things:
 * 'not_scanned_yet' is normal for the seconds or minutes between upload and
 * the scanner running, and warrants a retry; 'unavailable' means the signal
 * could not be read at all (storage error, tags not exposed) and warrants a
 * retry too, but says something different to whoever reads scan_detail.
 * Neither is ever treated as permission to promote.
 */
export type MalwareVerdict = 'clean' | 'malicious' | 'not_scanned_yet' | 'unavailable';

/**
 * 'uncertain' is a first-class outcome, not an error. A model asked to attest
 * that footage is ordinary boxing training will sometimes be unable to say so
 * and equally unable to call it a violation -- of a dark clip, a still frame,
 * a camera pointed at the ceiling. Collapsing that into 'fail' would bury
 * genuine problems under false alarms, and collapsing it into 'pass' would
 * promote unreviewed video of a minor. It routes to a human instead.
 */
export type ContentVerdict = 'pass' | 'fail' | 'uncertain';

export interface VideoScanSignals {
  malware?: MalwareVerdict;
  content?: ContentVerdict;
}

export type VideoScanDecision =
  // Promote to 'ready'. The only decision that makes a video readable.
  | 'promote'
  // Definite malware verdict -> status 'infected'.
  | 'infected'
  // Definite content-screen refusal -> stays 'quarantined', do not retry.
  | 'blocked'
  // Uncertain -> stays 'quarantined', a human decides.
  | 'needs_human_review'
  // No verdict yet -> stays 'quarantined', try again later.
  | 'retry'
  // Nothing is configured to produce a verdict -> stays 'quarantined' forever
  // unless an operator turns a gate on. Deliberately distinct from 'retry':
  // retrying a scan that cannot exist would spin the worker every tick and
  // grow scan_attempts without bound, which is how this would LOOK like it was
  // working while never promoting anything.
  | 'hold';

export interface VideoScanOutcome {
  decision: VideoScanDecision;
  /** Gate names that were enabled for this evaluation, in a stable order. */
  gatesEnabled: string[];
  /** Gate names that returned an affirmative pass. */
  gatesPassed: string[];
  /** Stable machine reason, recorded in scan_detail and safe to log. */
  reason: string;
}

export const DEFAULT_MAX_SCAN_ATTEMPTS = 8;

export function resolveVideoScanConfig(
  env: Record<string, string | undefined> = process.env,
): VideoScanConfig {
  const malwareRaw = env.PPBF_VIDEO_MALWARE_SCAN?.trim();
  const contentRaw = env.PPBF_VIDEO_CONTENT_SCAN?.trim();

  return {
    // Both default OFF. An environment gains a promotion path only by saying
    // so explicitly -- the same posture PPBF_SHADOW_WORKER_ENABLED takes, and
    // the reason a deploy cannot start promoting video by surprise.
    malware: malwareRaw === 'defender_index_tags' ? 'defender_index_tags' : 'off',
    content: contentRaw === 'vision' ? 'vision' : 'off',
  };
}

export function isVideoScanConfigured(config: VideoScanConfig): boolean {
  return config.malware !== 'off' || config.content !== 'off';
}

export function enabledScanGates(config: VideoScanConfig): string[] {
  const gates: string[] = [];
  if (config.malware !== 'off') gates.push('malware');
  if (config.content !== 'off') gates.push('content');
  return gates;
}

/**
 * Parse the content screen's reply into a verdict.
 *
 * The model is instructed to answer with one of three exact tokens on the
 * first line. Anything else -- prose, an empty string, a refusal, a token
 * embedded mid-sentence -- is 'uncertain', never 'pass'. This is the parse
 * step where a sloppy `includes('PASS')` would have turned "I cannot say this
 * is a PASS" into a promotion.
 */
export function parseContentScreenVerdict(raw: string): ContentVerdict {
  const firstLine = raw.trim().split(/\r?\n/, 1)[0]?.trim().toUpperCase() ?? '';
  if (firstLine === 'SCAN_PASS') return 'pass';
  if (firstLine === 'SCAN_FAIL') return 'fail';
  return 'uncertain';
}

/**
 * Compose the enabled gates' signals into one decision.
 *
 * Order matters and is deliberate: a malware hit outranks everything (the file
 * is dangerous regardless of what it depicts), then a content refusal, then
 * uncertainty, then missing verdicts. Promotion is last and requires the
 * complete set.
 */
export function decideVideoScanOutcome(params: {
  config: VideoScanConfig;
  signals: VideoScanSignals;
  attempts: number;
  maxAttempts?: number;
}): VideoScanOutcome {
  const { config, signals } = params;
  const maxAttempts = params.maxAttempts ?? DEFAULT_MAX_SCAN_ATTEMPTS;
  const gatesEnabled = enabledScanGates(config);

  if (gatesEnabled.length === 0) {
    return {
      decision: 'hold',
      gatesEnabled,
      gatesPassed: [],
      reason: 'NO_SCANNER_CONFIGURED',
    };
  }

  const gatesPassed: string[] = [];
  if (config.malware !== 'off' && signals.malware === 'clean') gatesPassed.push('malware');
  if (config.content !== 'off' && signals.content === 'pass') gatesPassed.push('content');

  if (config.malware !== 'off' && signals.malware === 'malicious') {
    return { decision: 'infected', gatesEnabled, gatesPassed, reason: 'MALWARE_DETECTED' };
  }

  if (config.content !== 'off' && signals.content === 'fail') {
    return { decision: 'blocked', gatesEnabled, gatesPassed, reason: 'CONTENT_SCREEN_REFUSED' };
  }

  if (config.content !== 'off' && signals.content === 'uncertain') {
    return {
      decision: 'needs_human_review',
      gatesEnabled,
      gatesPassed,
      reason: 'CONTENT_SCREEN_UNCERTAIN',
    };
  }

  // Every enabled gate reported an affirmative pass. This is the ONLY path to
  // a readable video.
  if (gatesPassed.length === gatesEnabled.length) {
    return { decision: 'promote', gatesEnabled, gatesPassed, reason: 'ALL_GATES_PASSED' };
  }

  // Something enabled has not reported yet. Defender writes its index tag
  // asynchronously after the upload lands, so this is the expected state for a
  // fresh upload rather than a fault.
  if (params.attempts + 1 >= maxAttempts) {
    return {
      decision: 'needs_human_review',
      gatesEnabled,
      gatesPassed,
      reason: 'SCAN_VERDICT_NEVER_ARRIVED',
    };
  }

  return {
    decision: 'retry',
    gatesEnabled,
    gatesPassed,
    reason: signals.malware === 'unavailable' ? 'SCAN_SIGNAL_UNAVAILABLE' : 'SCAN_VERDICT_PENDING',
  };
}

/** The scan_state each decision writes. Kept beside the decision so the two can never drift. */
export function scanStateForDecision(decision: VideoScanDecision): string {
  switch (decision) {
    case 'promote':
      return 'passed';
    case 'infected':
      return 'infected';
    case 'blocked':
      return 'blocked';
    case 'needs_human_review':
      return 'needs_human_review';
    case 'retry':
      return 'pending';
    case 'hold':
      return 'unconfigured';
  }
}

/**
 * The video_sessions.status each decision writes, or null to leave it alone.
 *
 * Only 'promote' and 'infected' move status at all. Everything else leaves the
 * row 'quarantined', which is the state all three readers already refuse.
 */
export function videoStatusForDecision(decision: VideoScanDecision): string | null {
  if (decision === 'promote') return 'ready';
  if (decision === 'infected') return 'infected';
  return null;
}
