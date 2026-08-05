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
// Everything is imported dynamically inside the nodejs-runtime branch:
// instrumentation is also evaluated for the edge runtime, where pg and the
// rest of the server stack must never be pulled into the bundle.

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') {
    return;
  }

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
  let loggedScanUnconfigured = false;
  const handle = startShadowJobWorker({
    processOne: () => processNextShadowJob(),
    intervalMs,
    // Promotes quarantined uploads that clear every configured scan gate
    // (#49). No-ops entirely when no gate is configured, so this is inert
    // until PPBF_VIDEO_CONTENT_SCAN / PPBF_VIDEO_MALWARE_SCAN are set --
    // logged once at startup, not every tick, so an operator who forgot to
    // set either flag has one line to find instead of silence, and a
    // configured environment isn't spammed once scanning is caught up.
    sweep: async () => {
      const result = await sweepQuarantinedVideos();
      if (result.scanned > 0) {
        console.log('SHADOW video scan sweep', {
          scanned: result.scanned,
          promoted: result.promoted,
          blocked: result.blocked,
        });
      } else if (result.skippedReason === 'not_configured' && !loggedScanUnconfigured) {
        loggedScanUnconfigured = true;
        console.warn(
          'SHADOW video scan sweep: no scanner configured, quarantined videos will never promote '
          + '(set PPBF_VIDEO_MALWARE_SCAN and/or PPBF_VIDEO_CONTENT_SCAN)',
        );
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
