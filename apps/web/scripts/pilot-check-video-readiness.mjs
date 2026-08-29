import { fileURLToPath } from 'node:url';

import {
  enabledScanGates,
  isVideoScanConfigured,
  resolveVideoScanConfig,
} from '../src/server/pilot/videoScanPolicy.ts';
import { isShadowWorkerEnabled } from '../src/server/pilot/shadowJobWorker.ts';

/**
 * Read-only report on whether the DEPLOYED app can promote a quarantined video
 * -- the one operational question in this family that is not in the database.
 *
 * WHY IT EXISTS. pilot.video_sessions rows are born 'quarantined' and every
 * reader requires 'ready'; calibration/projects.ts pins CLIPPABLE_VIDEO_STATUS
 * to 'ready', so the calibration connector has no input until something
 * promotes a row. videoScanPolicy.ts is the promotion authority and states the
 * invariant plainly: "If no gate is configured, nothing is promoted -- ever."
 * Auto-promote-on-upload was rejected by the owner. So the automatic path
 * needs PPBF_VIDEO_MALWARE_SCAN or PPBF_VIDEO_CONTENT_SCAN set AND
 * PPBF_SHADOW_WORKER_ENABLED=true, because instrumentation.ts returns before
 * starting the sweep when the worker is off.
 *
 * pilotOpsReadiness.ts already computes exactly this and words it well, but it
 * is reachable only at /api/pilot/ops/readiness -- an admin-authenticated route
 * on the deployed app. Every other operational question here is answerable by a
 * read-only dispatch. This one was not, so nobody could determine whether the
 * calibration connector has any input in staging or production without holding
 * an admin session.
 *
 * WHAT IT READS, AND WHY IT CANNOT READ A SECRET. The answer lives in the
 * deployed Container App's environment, not in Postgres, so run-checks.yml
 * reads three NAMED environment entries off the target-named Container App with
 * `az containerapp show` and hands this script the result. That command is the
 * ARM resource GET; secret VALUES come from a separate listSecrets operation
 * (which is what `az containerapp secret show` calls, and what the same
 * workflow uses for the connection string). This check never calls it. An entry
 * bound with `secretref:` therefore arrives as a binding KIND and no value at
 * all, and is reported as UNREADABLE rather than guessed at.
 *
 * NO VALUE CAN REACH THE OUTPUT, STRUCTURALLY. buildVideoReadinessReport is the
 * only function that sees an observed value, and it returns booleans, gate
 * names and fixed prose. renderVideoReadinessReport is handed that report and
 * never the observed environment, so it has no value to print even by mistake.
 * videoReadinessCheck.test.ts pushes a secret-shaped value through the whole
 * path and asserts it is absent from the rendered lines.
 *
 * IT DOES NOT READ THE RUNNER'S OWN ENVIRONMENT. Reporting the CI runner's
 * config as though it were the app's would be worse than no check at all, so
 * the observed values arrive under a PPBF_CHECK_APP_ prefix that nothing else
 * sets, they are collected into a fresh object rather than read from
 * process.env by name, and a run whose collection step did not happen refuses
 * to report instead of quietly answering about the runner. That refusal is also
 * what makes the workflow's conditional collection step safe: a skipped step
 * cannot produce a confident wrong answer, only a refusal.
 *
 * THIS IS A REPORT, NOT A GATE -- see the exit-code note at the bottom.
 *
 * TO RUN IT BY HAND, export the collected variables yourself, e.g.
 *
 *   PPBF_CHECK_APP_ENV_READ=1 \
 *   PPBF_CHECK_APP_TARGET=app-ppbf-staging \
 *   PPBF_CHECK_APP_BINDING_PPBF_VIDEO_MALWARE_SCAN=absent \
 *   PPBF_CHECK_APP_BINDING_PPBF_VIDEO_CONTENT_SCAN=value \
 *   PPBF_CHECK_APP_VALUE_PPBF_VIDEO_CONTENT_SCAN=vision \
 *   PPBF_CHECK_APP_BINDING_PPBF_SHADOW_WORKER_ENABLED=value \
 *   PPBF_CHECK_APP_VALUE_PPBF_SHADOW_WORKER_ENABLED=true \
 *   npm run pilot:check-video-readiness
 *
 * It touches no database and holds no connection string, so unlike its twelve
 * siblings it opens no READ ONLY transaction -- there is nothing for one to
 * wrap. checkDispatchCoverage.test.ts exempts it from that assertion by name
 * and replaces it with a stricter one: this file must not import pg and must
 * not name a connection string.
 */

/**
 * The three flags that decide whether a quarantined video can promote on its
 * own. Named here, and asked for by name in the workflow, so the collection
 * step cannot return anything else -- there is no query in this check that
 * could match a connection string, an API key or a client secret.
 */
export const OBSERVED_VARIABLES = [
  'PPBF_VIDEO_MALWARE_SCAN',
  'PPBF_VIDEO_CONTENT_SCAN',
  'PPBF_SHADOW_WORKER_ENABLED',
];

const ENV_READ_MARKER = 'PPBF_CHECK_APP_ENV_READ';
const TARGET_VARIABLE = 'PPBF_CHECK_APP_TARGET';
const BINDING_PREFIX = 'PPBF_CHECK_APP_BINDING_';
const VALUE_PREFIX = 'PPBF_CHECK_APP_VALUE_';

/** How the Container App holds a variable. 'secretref' is never dereferenced. */
const BINDINGS = ['value', 'secretref', 'absent'];

/**
 * Collect the observed environment out of the prefixed variables.
 *
 * Returns a refusal rather than a report when the marker is missing. That is
 * the whole defence against answering about the runner: without it this would
 * fall through to "nothing is set", which is indistinguishable from a correctly
 * observed unconfigured app and is exactly the wrong answer to be confident
 * about.
 */
export function readObservedEnvironment(processEnv) {
  if (processEnv[ENV_READ_MARKER] !== '1') {
    return {
      ok: false,
      reason:
        `${ENV_READ_MARKER} is not set, so the target Container App's environment was not read. `
        + 'Refusing to report -- the only thing this process could describe is the machine it is '
        + 'running on, and reporting the runner\'s configuration as the deployed app\'s would be '
        + 'worse than no answer.',
    };
  }

  const target = processEnv[TARGET_VARIABLE]?.trim();
  if (!target) {
    return {
      ok: false,
      reason:
        `${TARGET_VARIABLE} is empty, so this report could not say which Container App it `
        + 'describes. An answer that does not name its target is how a staging reading gets '
        + 'quoted about production.',
    };
  }

  const values = {};
  const bindings = {};
  for (const name of OBSERVED_VARIABLES) {
    const binding = processEnv[`${BINDING_PREFIX}${name}`];
    if (!BINDINGS.includes(binding)) {
      return {
        ok: false,
        reason:
          `${BINDING_PREFIX}${name} is missing or is not one of ${BINDINGS.join(', ')}, so the `
          + 'collection step did not report how the app holds this variable. Refusing to guess.',
      };
    }
    bindings[name] = binding;
    // Only a plain 'value' binding carries a value. 'secretref' deliberately
    // arrives without one -- see UNREADABLE below -- and 'absent' has none.
    if (binding === 'value') {
      values[name] = processEnv[`${VALUE_PREFIX}${name}`] ?? '';
    }
  }

  return { ok: true, observed: { target, values, bindings } };
}

/**
 * Compose the report.
 *
 * The RULE comes from videoScanPolicy.ts's own exported functions and the
 * worker's own isShadowWorkerEnabled, not from a copy of them here, so this
 * check and the running app cannot drift into disagreeing about what
 * "configured" means. The WORDING is pilotOpsReadiness.ts's, reproduced
 * because that module is not importable from a plain .mjs (its dependency
 * chain uses extensionless specifiers that Node's resolver cannot follow);
 * videoReadinessCheck.test.ts pins each string against
 * buildPilotOpsReadinessReport for the same environment, so a reword there
 * reds this build rather than silently producing two reports that say
 * different things about one deployment.
 *
 * This is the only function that sees an observed value, and every field it
 * returns is a boolean, a gate name, a variable name or fixed prose.
 */
export function buildVideoReadinessReport(observed) {
  const { target, values, bindings } = observed;

  const config = resolveVideoScanConfig(values);
  const scanConfigured = isVideoScanConfigured(config);
  const gates = enabledScanGates(config);
  const workerEnabled = isShadowWorkerEnabled(values);

  // A gate bound to a secret reference cannot be resolved without reading a
  // secret value, which this check does not do. Reporting it as "off" would be
  // a guess wearing a boolean, so it is reported as its own state.
  const unreadable = OBSERVED_VARIABLES.filter((name) => bindings[name] === 'secretref');
  const absent = OBSERVED_VARIABLES.filter((name) => bindings[name] === 'absent');

  // Both halves are required, and each is necessary for a different reason: no
  // gate means videoScanPolicy.ts decides 'hold' forever, and no worker means
  // instrumentation.ts never starts the sweep that would ask it.
  const automaticPromotionPossible = scanConfigured && workerEnabled;

  return {
    target,
    malwareGateConfigured: gates.includes('malware'),
    contentGateConfigured: gates.includes('content'),
    scanConfigured,
    gates,
    workerEnabled,
    unreadable,
    absent,
    automaticPromotionPossible,
    // Derived from the boolean above rather than recomputed, so the plain
    // answer and the rendered verdict cannot disagree. A NEGATIVE conclusion is
    // only sound when every variable that could overturn it was readable: one
    // secret-reference binding makes "nothing is configured" a guess, so the
    // verdict says UNDETERMINED instead of reporting an absence it did not
    // observe. A POSITIVE conclusion needs no such caveat, because something
    // readable is already switched on.
    verdict: automaticPromotionPossible
      ? 'configured'
      : unreadable.length > 0
        ? 'undetermined'
        : 'not_configured',
    videoScanReason: scanConfigured
      ? `Configured gate(s): ${gates.join(', ')}. A quarantined video promotes once every enabled gate passes and the worker is running.`
      : 'Neither PPBF_VIDEO_MALWARE_SCAN nor PPBF_VIDEO_CONTENT_SCAN is set -- quarantined videos can never promote.',
    shadowWorkerReason: workerEnabled
      ? 'PPBF_SHADOW_WORKER_ENABLED=true -- background jobs, the video scan sweep, and retention housekeeping run on a tick.'
      : 'PPBF_SHADOW_WORKER_ENABLED is not "true" -- queued async jobs (Film Study, etc.) will never drain, and the video scan sweep never runs.',
  };
}

/**
 * Render the report.
 *
 * Takes the REPORT and never the observed environment. That is not a style
 * choice: it means no formatting mistake in this function can print an
 * environment value, because this function has never been handed one.
 */
export function renderVideoReadinessReport(report) {
  // An unreadable variable never renders as an OFF state. "NOT CONFIGURED"
  // beside "UNREADABLE" for the same variable is a report contradicting itself,
  // and the half an operator remembers is the confident half.
  const state = (name, on, onWord, offWord) =>
    report.unreadable.includes(name) ? 'UNKNOWN' : on ? onWord : offWord;
  const lines = [
    'Video promotion readiness',
    '=========================',
    `Container App: ${report.target}`,
    '',
    `malware gate (PPBF_VIDEO_MALWARE_SCAN): ${state('PPBF_VIDEO_MALWARE_SCAN', report.malwareGateConfigured, 'CONFIGURED', 'NOT CONFIGURED')}`,
    `content gate (PPBF_VIDEO_CONTENT_SCAN): ${state('PPBF_VIDEO_CONTENT_SCAN', report.contentGateConfigured, 'CONFIGURED', 'NOT CONFIGURED')}`,
    `scan worker (PPBF_SHADOW_WORKER_ENABLED): ${state('PPBF_SHADOW_WORKER_ENABLED', report.workerEnabled, 'ENABLED', 'NOT ENABLED')}`,
    '',
    `videoScan: ${report.videoScanReason}`,
    `shadowWorker: ${report.shadowWorkerReason}`,
    '',
  ];

  if (report.absent.length > 0) {
    lines.push(`Not set on this app at all: ${report.absent.join(', ')}`);
  }
  if (report.unreadable.length > 0) {
    lines.push(
      `UNREADABLE: ${report.unreadable.join(', ')} is bound to a secret reference. This check `
      + 'never reads a secret value, so its setting is UNKNOWN here, and the state and reason '
      + 'lines above claim nothing about it. Read it from /api/pilot/ops/readiness on the '
      + 'deployed app.',
    );
  }
  if (report.absent.length > 0 || report.unreadable.length > 0) {
    lines.push('');
  }

  lines.push(
    report.verdict === 'configured'
      ? 'AUTOMATIC PROMOTION IS POSSIBLE HERE. A quarantined upload that clears every configured '
        + 'gate becomes status=ready, which is what the calibration connector needs as input.'
      : report.verdict === 'undetermined'
        ? 'UNDETERMINED. Nothing readable switches the promotion path on, but a variable above is '
          + 'bound to a secret reference, so this check cannot say the path is off either.'
        : 'AUTOMATIC PROMOTION IS NOT POSSIBLE HERE. No upload will reach status=ready on its own, '
          + 'so the calibration connector has no input in this environment.',
  );
  lines.push('');
  lines.push('WHAT THIS DOES NOT TELL YOU');
  lines.push(
    '  * It reports CONFIGURATION, not history. It does not say that any video has actually '
    + 'promoted, that any gate ever returned a verdict, or that a scanner behind a configured '
    + 'gate is reachable.',
  );
  lines.push(
    '  * It reads the app definition, not a running process. It does not prove the deployed '
    + 'revision serving traffic started with these values.',
  );
  lines.push(
    '  * The automatic sweep is not the only route to status=ready. '
    + 'POST /api/pilot/video/[videoId]/release is a human attestation path governed by '
    + 'videoReleasePolicy.ts, and this check observes no part of it.',
  );
  lines.push('=========================');
  lines.push(
    report.verdict === 'configured'
      ? 'PILOT VIDEO READINESS: PROMOTION PATH CONFIGURED'
      : report.verdict === 'undetermined'
        ? 'PILOT VIDEO READINESS: UNDETERMINED'
        : 'PILOT VIDEO READINESS: NO PROMOTION PATH CONFIGURED',
  );

  return lines;
}

export function run(processEnv) {
  const collected = readObservedEnvironment(processEnv);
  if (!collected.ok) {
    return { ok: false, lines: ['PILOT VIDEO READINESS COULD NOT RUN', collected.reason] };
  }
  return { ok: true, lines: renderVideoReadinessReport(buildVideoReadinessReport(collected.observed)) };
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  const result = run(process.env);
  for (const line of result.lines) {
    (result.ok ? console.log : console.error)(line);
  }
  // EXIT CODE: this is a REPORT, not a GATE, and the distinction is the one
  // run-checks.yml's header already draws. A gate exits non-zero when a human
  // must decide something. An unconfigured scan gate is not that: it is the
  // deliberate, owner-chosen default, and it is the CORRECT state for an
  // environment doing no video work. Exiting non-zero on it would paint every
  // `all` run against such an environment red forever, which trains an
  // operator to read red as normal and buries the gates that mean something.
  // So the answer is in the log, exactly like seed-identity and runtime-claims,
  // and zero says only "it ran".
  //
  // Non-zero is reserved for the one thing that IS broken: the environment was
  // not read, so there is no answer at all. That is a failed run, not a
  // finding, and it must never be quiet.
  process.exit(result.ok ? 0 : 1);
}
