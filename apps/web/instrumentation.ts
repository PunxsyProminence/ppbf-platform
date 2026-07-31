// Next.js instrumentation hook -- runs once per server start.
//
// This is where the SHADOW job worker comes to life. It is OFF by default:
// the loop starts only when the deployment sets PPBF_SHADOW_WORKER_ENABLED
// to exactly 'true', so no environment gains a background processor by
// surprise. Cadence comes from PPBF_SHADOW_WORKER_INTERVAL_SECONDS
// (default 30, clamped 5-600).
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
  const intervalMs = resolveShadowWorkerIntervalMs();
  const handle = startShadowJobWorker({
    processOne: () => processNextShadowJob(),
    intervalMs,
    housekeeping: async () => {
      const purged = await purgeTerminalShadowJobs();
      if (purged > 0) console.log('SHADOW job retention sweep', { purged });
    },
  });

  if (handle) {
    console.log('SHADOW job worker started', { intervalMs });
  }
}
