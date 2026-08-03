// Next.js instrumentation hook -- runs once per server start.
//
// This is where the SHADOW job worker comes to life. It is OFF by default:
// the loop starts only when the deployment sets PPBF_SHADOW_WORKER_ENABLED
// to exactly 'true', so no environment gains a background processor by
// surprise. Cadence comes from PPBF_SHADOW_WORKER_INTERVAL_SECONDS
// (default 30, clamped 5-600).
//
// The loop's housekeeping slot carries the platform's retention work: purging
// terminal job rows and archiving SHADOW chat audit rows out of Postgres. Both
// are cheap and neither is urgent, so they ride the tick rather than a
// schedule of their own; the archival sweep enforces its own daily floor.
//
// It is also where the platform's fail-closed configuration checks run, ahead of
// anything else -- see assertStartupConfiguration.
//
// Everything is imported dynamically inside the nodejs-runtime branch:
// instrumentation is also evaluated for the edge runtime, where pg and the
// rest of the server stack must never be pulled into the bundle.

/**
 * Configuration that must hold before this process serves a single request.
 *
 * Both checks were written as part of the security pass but nothing ever called
 * them, so they protected nothing at runtime -- an exported function that throws
 * is not a guard until something invokes it. They run here, ahead of the worker
 * branch below, so they apply whether or not the SHADOW worker is enabled.
 *
 * On failure the process is EXITED rather than left to a thrown error. A throw
 * out of register() depends on how the framework treats instrumentation errors,
 * and the one outcome that must not happen is a server that logged a fatal
 * misconfiguration and then carried on serving -- that is worse than no check,
 * because the log implies the check is holding. Exiting fails the container's
 * health gate instead, which is what "must not start" has to mean in practice.
 *
 * Neither check can fire on a correctly configured deployment:
 *   - PPBF_DURABLE_RATE_LIMIT=true is set by deploy-production.yml and
 *     deploy-staging.yml, so this asserts existing config rather than demanding
 *     new config.
 *   - PPBF_POSTGRES_DISABLE_SSL only trips the second check outside NODE_ENV=test,
 *     and resolveSslConfig already ignores the flag outside test -- so such a
 *     deployment was failing at its first query anyway. This moves that failure to
 *     boot, where it is legible.
 */
async function assertStartupConfiguration(): Promise<void> {
  const { validateDurableRateLimitConfiguration } = await import('./src/server/pilot/rateLimit');
  const { validateSslConfiguration } = await import('./src/server/pilot/db');

  try {
    validateSslConfiguration();
    validateDurableRateLimitConfiguration();
  } catch (error) {
    console.error('FATAL: refusing to start on an unsafe configuration', {
      reason: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  }
}

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') {
    return;
  }

  await assertStartupConfiguration();

  const { isShadowWorkerEnabled, resolveShadowWorkerIntervalMs, startShadowJobWorker } = await import(
    './src/server/pilot/shadowJobWorker'
  );

  if (!isShadowWorkerEnabled()) {
    return;
  }

  const { processNextShadowJob } = await import('./src/server/pilot/shadowJobProcessor');
  const { purgeTerminalShadowJobs } = await import('./src/server/pilot/shadowJobQueue');
  const { sweepQuarantinedVideos } = await import('./src/server/pilot/videoScanSweep');
  const { createShadowArchivalSweep } = await import('./src/server/pilot/shadowArchival');
  const intervalMs = resolveShadowWorkerIntervalMs();
  const sweepShadowAudit = createShadowArchivalSweep();
  const handle = startShadowJobWorker({
    processOne: () => processNextShadowJob(),
    intervalMs,
    // Promotes quarantined uploads that clear every configured scan gate
    // (#49). No-ops entirely when no gate is configured, so this is inert
    // until PPBF_VIDEO_CONTENT_SCAN / PPBF_VIDEO_MALWARE_SCAN are set.
    sweep: async () => {
      const result = await sweepQuarantinedVideos();
      if (result.scanned > 0) {
        console.log('SHADOW video scan sweep', {
          scanned: result.scanned,
          promoted: result.promoted,
          blocked: result.blocked,
        });
      }
    },
    housekeeping: async () => {
      // The archival sweep resolves its own failures, so it goes first: the
      // job purge is the half that can throw, and audit retention must not
      // depend on it succeeding.
      const archival = await sweepShadowAudit();
      if (archival.result?.success) {
        console.log('SHADOW chat audit archival', {
          archived: archival.result.archivedCount,
          aggregatedMonths: archival.result.aggregatedMonths,
        });
      } else if (archival.result) {
        console.error('SHADOW chat audit archival failed', { error: archival.result.error });
      }

      const purged = await purgeTerminalShadowJobs();
      if (purged > 0) console.log('SHADOW job retention sweep', { purged });
    },
  });

  if (handle) {
    console.log('SHADOW job worker started', { intervalMs });
  }
}
