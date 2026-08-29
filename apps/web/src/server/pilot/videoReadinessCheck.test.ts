/**
 * Contract tests for the video-readiness dispatch check.
 *
 * WHAT IS BEING GUARDED. pilot-check-video-readiness.mjs answers "can a
 * quarantined video promote in this environment at all", which is the question
 * that decides whether the calibration connector has any input. It answers it
 * from three variables read off the deployed Container App, and it must do two
 * things that no amount of reading can confirm: apply the SAME rule the running
 * app applies, and never let an environment value reach its output.
 *
 * HOW IT RUNS. The script is real ESM that imports TypeScript modules directly
 * (Node strips the types), and the default jest runner has no ESM loader --
 * `npm test` does not pass --experimental-vm-modules. So each case is evaluated
 * in one real node child process, the same loader the check itself runs under.
 * That is shadowLibraryManifest.test.ts's pattern, for the same reason.
 *
 * The child is given an env containing PATH and nothing else, so every
 * PPBF_ variable it sees is one a case put there. That is not tidiness: one of
 * the cases below asserts the check ignores unprefixed variables, and it would
 * assert nothing if the parent's environment leaked in.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';

import { buildPilotOpsReadinessReport } from './pilotOpsReadiness';

const WEB_ROOT = path.resolve(__dirname, '../../..');
const SCRIPT = path.join(WEB_ROOT, 'scripts/pilot-check-video-readiness.mjs');

/**
 * A value shaped like the things a Container App's environment really holds.
 * Not a real credential -- the point is that a distinctive string can be
 * grepped for in the output, and the check is only safe if it never appears.
 */
const SECRET_SHAPED =
  'Server=tcp:fake.postgres.database.azure.com;Password=NOT-A-REAL-SECRET-8f3a2b71;';

interface Run {
  status: number;
  output: string;
}

function runCheck(overrides: Record<string, string>): Run {
  // Cast because this project's ProcessEnv declares NODE_ENV as required, and
  // handing the child a NODE_ENV it was not given would weaken the case below
  // that asserts unprefixed variables are ignored. PATH plus the case's own
  // variables is deliberately the whole environment.
  const env = { PATH: process.env.PATH ?? '', ...overrides } as unknown as NodeJS.ProcessEnv;
  const result = spawnSync(process.execPath, [SCRIPT], { env, encoding: 'utf8' });
  if (result.error) throw result.error;
  return { status: result.status ?? -1, output: `${result.stdout}${result.stderr}` };
}

/** The prefixed variables the workflow's collection step writes. */
function collected(options: {
  malware?: string | 'secretref' | null;
  content?: string | 'secretref' | null;
  worker?: string | 'secretref' | null;
  target?: string;
}): Record<string, string> {
  const env: Record<string, string> = {
    PPBF_CHECK_APP_ENV_READ: '1',
    PPBF_CHECK_APP_TARGET: options.target ?? 'app-ppbf-staging',
  };
  const bind = (name: string, setting: string | null | undefined) => {
    if (setting === undefined || setting === null) {
      env[`PPBF_CHECK_APP_BINDING_${name}`] = 'absent';
      return;
    }
    if (setting === 'secretref') {
      env[`PPBF_CHECK_APP_BINDING_${name}`] = 'secretref';
      return;
    }
    env[`PPBF_CHECK_APP_BINDING_${name}`] = 'value';
    env[`PPBF_CHECK_APP_VALUE_${name}`] = setting;
  };
  bind('PPBF_VIDEO_MALWARE_SCAN', options.malware);
  bind('PPBF_VIDEO_CONTENT_SCAN', options.content);
  bind('PPBF_SHADOW_WORKER_ENABLED', options.worker);
  return env;
}

const MALWARE_ON = 'defender_index_tags';
const CONTENT_ON = 'vision';

describe('video-readiness reports the deployed promotion path', () => {
  test('both gates off and the worker off: no promotion path', () => {
    const run = runCheck(collected({}));
    expect(run.status).toBe(0);
    expect(run.output).toContain('malware gate (PPBF_VIDEO_MALWARE_SCAN): NOT CONFIGURED');
    expect(run.output).toContain('content gate (PPBF_VIDEO_CONTENT_SCAN): NOT CONFIGURED');
    expect(run.output).toContain('scan worker (PPBF_SHADOW_WORKER_ENABLED): NOT ENABLED');
    expect(run.output).toContain('PILOT VIDEO READINESS: NO PROMOTION PATH CONFIGURED');
  });

  test('malware gate only, worker on: promotion path configured', () => {
    const run = runCheck(collected({ malware: MALWARE_ON, worker: 'true' }));
    expect(run.status).toBe(0);
    expect(run.output).toContain('malware gate (PPBF_VIDEO_MALWARE_SCAN): CONFIGURED');
    expect(run.output).toContain('content gate (PPBF_VIDEO_CONTENT_SCAN): NOT CONFIGURED');
    expect(run.output).toContain('scan worker (PPBF_SHADOW_WORKER_ENABLED): ENABLED');
    expect(run.output).toContain('Configured gate(s): malware.');
    expect(run.output).toContain('PILOT VIDEO READINESS: PROMOTION PATH CONFIGURED');
  });

  test('content gate only, worker on: promotion path configured', () => {
    const run = runCheck(collected({ content: CONTENT_ON, worker: 'true' }));
    expect(run.status).toBe(0);
    expect(run.output).toContain('content gate (PPBF_VIDEO_CONTENT_SCAN): CONFIGURED');
    expect(run.output).toContain('Configured gate(s): content.');
    expect(run.output).toContain('PILOT VIDEO READINESS: PROMOTION PATH CONFIGURED');
  });

  test('both gates on, worker on: both gates are named in order', () => {
    const run = runCheck(collected({ malware: MALWARE_ON, content: CONTENT_ON, worker: 'true' }));
    expect(run.status).toBe(0);
    expect(run.output).toContain('Configured gate(s): malware, content.');
    expect(run.output).toContain('PILOT VIDEO READINESS: PROMOTION PATH CONFIGURED');
  });

  test('both gates on but the worker off: no promotion path', () => {
    // The case the report exists for. Configuring a gate reads like finishing
    // the job, and it is half of it: instrumentation.ts returns before starting
    // the sweep when the worker is off, so nothing ever asks the gate.
    const run = runCheck(collected({ malware: MALWARE_ON, content: CONTENT_ON }));
    expect(run.status).toBe(0);
    expect(run.output).toContain('malware gate (PPBF_VIDEO_MALWARE_SCAN): CONFIGURED');
    expect(run.output).toContain('content gate (PPBF_VIDEO_CONTENT_SCAN): CONFIGURED');
    expect(run.output).toContain('scan worker (PPBF_SHADOW_WORKER_ENABLED): NOT ENABLED');
    expect(run.output).toContain('AUTOMATIC PROMOTION IS NOT POSSIBLE HERE');
    expect(run.output).toContain('PILOT VIDEO READINESS: NO PROMOTION PATH CONFIGURED');
  });

  test('a value that is not the exact mode does not configure a gate', () => {
    // resolveVideoScanConfig accepts one literal per gate. A near miss is off,
    // and a report that rounded it up would say a gate exists where the running
    // app has none.
    const run = runCheck(collected({ malware: 'defender', content: 'gpt-5-vision', worker: 'yes' }));
    expect(run.status).toBe(0);
    expect(run.output).toContain('malware gate (PPBF_VIDEO_MALWARE_SCAN): NOT CONFIGURED');
    expect(run.output).toContain('content gate (PPBF_VIDEO_CONTENT_SCAN): NOT CONFIGURED');
    expect(run.output).toContain('scan worker (PPBF_SHADOW_WORKER_ENABLED): NOT ENABLED');
  });

  test('the target Container App is named in the report', () => {
    const run = runCheck(collected({ target: 'app-ppbf-production' }));
    expect(run.output).toContain('Container App: app-ppbf-production');
  });

  test('what the report does not claim is printed with the answer', () => {
    // Reporting configuration and letting a reader hear "video is working" is
    // the failure this whole family of checks keeps being written to avoid, so
    // the limits travel in the same log block as the verdict rather than in a
    // runbook nobody opens.
    const run = runCheck(collected({ malware: MALWARE_ON, worker: 'true' }));
    expect(run.output).toContain('WHAT THIS DOES NOT TELL YOU');
    expect(run.output).toContain('It reports CONFIGURATION, not history.');
    expect(run.output).toContain('POST /api/pilot/video/[videoId]/release');
  });
});

describe('video-readiness never reports a value it read', () => {
  test('a secret-shaped value reaches no part of the rendered report', () => {
    // The load-bearing case. Every variable carries the same distinctive
    // string, so if any output path prints, echoes, or reflects a value --
    // a state line, a reason, a gate list, a diagnostic -- it lands here.
    const run = runCheck(
      collected({ malware: SECRET_SHAPED, content: SECRET_SHAPED, worker: SECRET_SHAPED }),
    );
    expect(run.status).toBe(0);
    expect(run.output).not.toContain(SECRET_SHAPED);
    expect(run.output).not.toContain('NOT-A-REAL-SECRET-8f3a2b71');
    expect(run.output).not.toContain('Password');
    // ... and it still answered, so the absence above is a redacted-by-design
    // report rather than a crash that printed nothing.
    expect(run.output).toContain('PILOT VIDEO READINESS: NO PROMOTION PATH CONFIGURED');
  });

  test('a secret-shaped value reaches no part of the refusal path either', () => {
    // The refusal prints a different function's text, so it needs its own case:
    // an error path that interpolated what it had been handed would be missed
    // by every assertion above.
    const run = runCheck({
      ...collected({ malware: SECRET_SHAPED, content: SECRET_SHAPED, worker: SECRET_SHAPED }),
      PPBF_CHECK_APP_ENV_READ: '',
    });
    expect(run.status).toBe(1);
    expect(run.output).not.toContain(SECRET_SHAPED);
    expect(run.output).not.toContain('NOT-A-REAL-SECRET-8f3a2b71');
    expect(run.output).toContain('PILOT VIDEO READINESS COULD NOT RUN');
  });

  test('a secret reference is reported as unreadable, never dereferenced', () => {
    const run = runCheck(collected({ content: 'secretref', worker: 'true' }));
    expect(run.status).toBe(0);
    expect(run.output).toContain('content gate (PPBF_VIDEO_CONTENT_SCAN): UNKNOWN');
    expect(run.output).toContain('UNREADABLE: PPBF_VIDEO_CONTENT_SCAN');
    // Nothing readable is on, but one variable could not be read, so the
    // negative conclusion is withheld rather than asserted.
    expect(run.output).toContain('PILOT VIDEO READINESS: UNDETERMINED');
    expect(run.output).not.toContain('NO PROMOTION PATH CONFIGURED');
  });
});

describe('video-readiness describes the app, never the machine it runs on', () => {
  test('unprefixed variables in the process environment are ignored', () => {
    // The failure mode worth more than any other here: a check that falls back
    // to the runner's own environment reports CI's configuration as the
    // deployment's, and reads exactly like a real answer. The child is told the
    // app sets nothing while its own process environment says every gate is on.
    const run = runCheck({
      ...collected({}),
      PPBF_VIDEO_MALWARE_SCAN: MALWARE_ON,
      PPBF_VIDEO_CONTENT_SCAN: CONTENT_ON,
      PPBF_SHADOW_WORKER_ENABLED: 'true',
    });
    expect(run.status).toBe(0);
    expect(run.output).toContain('malware gate (PPBF_VIDEO_MALWARE_SCAN): NOT CONFIGURED');
    expect(run.output).toContain('content gate (PPBF_VIDEO_CONTENT_SCAN): NOT CONFIGURED');
    expect(run.output).toContain('scan worker (PPBF_SHADOW_WORKER_ENABLED): NOT ENABLED');
    expect(run.output).toContain('PILOT VIDEO READINESS: NO PROMOTION PATH CONFIGURED');
  });

  test('an unread environment refuses instead of reporting', () => {
    const run = runCheck({ PPBF_CHECK_APP_TARGET: 'app-ppbf-staging' });
    expect(run.status).toBe(1);
    expect(run.output).toContain('PILOT VIDEO READINESS COULD NOT RUN');
    expect(run.output).toContain('PPBF_CHECK_APP_ENV_READ');
    expect(run.output).not.toContain('PILOT VIDEO READINESS: ');
  });

  test('an unnamed target refuses instead of reporting', () => {
    const run = runCheck({ ...collected({}), PPBF_CHECK_APP_TARGET: '' });
    expect(run.status).toBe(1);
    expect(run.output).toContain('PILOT VIDEO READINESS COULD NOT RUN');
    expect(run.output).toContain('PPBF_CHECK_APP_TARGET');
  });

  test('a missing binding refuses instead of assuming the variable is unset', () => {
    // "The collection step did not say" and "the app does not set it" are
    // different facts with the same appearance, and only one of them is an
    // answer. Guessing between them is how a partial read becomes a confident
    // report.
    const partial = collected({ malware: MALWARE_ON, worker: 'true' });
    delete partial.PPBF_CHECK_APP_BINDING_PPBF_VIDEO_CONTENT_SCAN;
    const run = runCheck(partial);
    expect(run.status).toBe(1);
    expect(run.output).toContain('PILOT VIDEO READINESS COULD NOT RUN');
    expect(run.output).toContain('PPBF_CHECK_APP_BINDING_PPBF_VIDEO_CONTENT_SCAN');
  });

  test('an unrecognised binding refuses instead of being treated as absent', () => {
    const run = runCheck({
      ...collected({}),
      PPBF_CHECK_APP_BINDING_PPBF_VIDEO_CONTENT_SCAN: 'maybe',
    });
    expect(run.status).toBe(1);
    expect(run.output).toContain('PILOT VIDEO READINESS COULD NOT RUN');
  });
});

describe('the check and the app say the same thing about the same environment', () => {
  // WHY THIS EXISTS. The RULE is shared by import: the script calls
  // videoScanPolicy.ts's resolveVideoScanConfig / isVideoScanConfigured /
  // enabledScanGates and shadowJobWorker.ts's isShadowWorkerEnabled, the same
  // functions buildPilotOpsReadinessReport calls, so the two cannot disagree
  // about what "configured" means.
  //
  // The WORDING could not be shared the same way. pilotOpsReadiness.ts is not
  // importable from a plain .mjs -- its dependency chain uses extensionless
  // specifiers that Node's resolver will not follow -- so the two reason
  // strings are reproduced in the script. This pins the copy to the original:
  // reword either reason in pilotOpsReadiness.ts and this reds, instead of the
  // deployment quietly having two reports that describe it differently.
  const CASES: Array<[string, Record<string, string | undefined>]> = [
    ['nothing configured', {}],
    ['malware only', { PPBF_VIDEO_MALWARE_SCAN: MALWARE_ON, PPBF_SHADOW_WORKER_ENABLED: 'true' }],
    ['content only', { PPBF_VIDEO_CONTENT_SCAN: CONTENT_ON, PPBF_SHADOW_WORKER_ENABLED: 'true' }],
    [
      'both gates',
      {
        PPBF_VIDEO_MALWARE_SCAN: MALWARE_ON,
        PPBF_VIDEO_CONTENT_SCAN: CONTENT_ON,
        PPBF_SHADOW_WORKER_ENABLED: 'true',
      },
    ],
    ['gates on, worker off', { PPBF_VIDEO_MALWARE_SCAN: MALWARE_ON, PPBF_VIDEO_CONTENT_SCAN: CONTENT_ON }],
  ];

  test.each(CASES)('%s: both reports use the same two sentences', (_name, appEnv) => {
    const expected = buildPilotOpsReadinessReport(appEnv);
    const run = runCheck(
      collected({
        malware: appEnv.PPBF_VIDEO_MALWARE_SCAN ?? null,
        content: appEnv.PPBF_VIDEO_CONTENT_SCAN ?? null,
        worker: appEnv.PPBF_SHADOW_WORKER_ENABLED ?? null,
      }),
    );
    expect(run.status).toBe(0);
    expect(run.output).toContain(`videoScan: ${expected.videoScan.reason}`);
    expect(run.output).toContain(`shadowWorker: ${expected.shadowWorker.reason}`);
  });

  test.each(CASES)('%s: both reports agree on the booleans', (_name, appEnv) => {
    const expected = buildPilotOpsReadinessReport(appEnv);
    const run = runCheck(
      collected({
        malware: appEnv.PPBF_VIDEO_MALWARE_SCAN ?? null,
        content: appEnv.PPBF_VIDEO_CONTENT_SCAN ?? null,
        worker: appEnv.PPBF_SHADOW_WORKER_ENABLED ?? null,
      }),
    );
    expect(run.output).toContain(
      `scan worker (PPBF_SHADOW_WORKER_ENABLED): ${expected.shadowWorker.enabled ? 'ENABLED' : 'NOT ENABLED'}`,
    );
    expect(run.output).toContain(
      `malware gate (PPBF_VIDEO_MALWARE_SCAN): ${expected.videoScan.gates.includes('malware') ? 'CONFIGURED' : 'NOT CONFIGURED'}`,
    );
    expect(run.output).toContain(
      `content gate (PPBF_VIDEO_CONTENT_SCAN): ${expected.videoScan.gates.includes('content') ? 'CONFIGURED' : 'NOT CONFIGURED'}`,
    );
  });
});
