// shadowJobWorker.ts — the drain loop that makes the job queue real.
//
// For as long as this platform has existed, the queue had writers and an
// executor but no caller: jobs could be enqueued and jobs could be processed,
// and nothing ever connected the two. This module is that connection. It runs
// INSIDE the already-deployed server process (started from instrumentation.ts
// when PPBF_SHADOW_WORKER_ENABLED=true), so it carries no credentials of its
// own -- per-job authority lives in the processor, which re-validates the
// enqueuing actor against the live database on every claim. Turning the
// worker off strands no requests: the chat route refuses to enqueue async
// session types while the flag is off (503, exactly as before this existed).
//
// Concurrency is handled at the database, not here: claimNextJob uses
// FOR UPDATE SKIP LOCKED plus lease tokens, so overlapping drains -- a second
// replica, an ops call to the jobs/process route mid-tick -- can never claim
// the same job twice.

import type { JobProcessorResult } from './shadowJobProcessor';

export const DEFAULT_WORKER_INTERVAL_SECONDS = 30;
const MIN_WORKER_INTERVAL_SECONDS = 5;
const MAX_WORKER_INTERVAL_SECONDS = 600;
const DEFAULT_MAX_JOBS_PER_TICK = 5;

export function isShadowWorkerEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.PPBF_SHADOW_WORKER_ENABLED === 'true';
}

export function resolveShadowWorkerIntervalMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.PPBF_SHADOW_WORKER_INTERVAL_SECONDS;
  const parsed = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
  const seconds = Number.isFinite(parsed)
    ? Math.min(MAX_WORKER_INTERVAL_SECONDS, Math.max(MIN_WORKER_INTERVAL_SECONDS, Math.trunc(parsed)))
    : DEFAULT_WORKER_INTERVAL_SECONDS;
  return seconds * 1000;
}

export interface ShadowJobWorkerHandle {
  stop: () => void;
}

interface StartOptions {
  processOne: () => Promise<JobProcessorResult>;
  intervalMs: number;
  maxJobsPerTick?: number;
  onError?: (error: unknown) => void;
}

// Hot reload in dev re-runs module initialization; a plain module-level flag
// would be reset with it and stack a second loop. The guard therefore lives
// on globalThis, keyed by symbol, surviving module re-evaluation.
const WORKER_STARTED_KEY = Symbol.for('ppbf.shadowJobWorker.started');

export function startShadowJobWorker(options: StartOptions): ShadowJobWorkerHandle | null {
  const holder = globalThis as { [WORKER_STARTED_KEY]?: boolean };
  if (holder[WORKER_STARTED_KEY]) {
    return null;
  }
  holder[WORKER_STARTED_KEY] = true;

  const maxJobsPerTick = options.maxJobsPerTick ?? DEFAULT_MAX_JOBS_PER_TICK;
  const onError = options.onError ?? ((error: unknown) => {
    // Job-level failures never throw (the processor records them on the job
    // row); reaching here means infrastructure trouble, e.g. the database
    // being unreachable. Log the class, never payload content.
    console.error('SHADOW job worker tick failed', {
      errorClass: error instanceof Error ? error.name : typeof error,
    });
  });

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  // A chained setTimeout rather than setInterval: a tick that runs long (a
  // 95-second Heavy Bag generation) must delay the next tick, not overlap it.
  const scheduleNext = () => {
    if (stopped) return;
    timer = setTimeout(() => { void tick(); }, options.intervalMs);
    // Never hold the process open just to poll an empty queue.
    timer.unref?.();
  };

  const tick = async () => {
    try {
      for (let processedCount = 0; processedCount < maxJobsPerTick; processedCount += 1) {
        if (stopped) return;
        const result = await options.processOne();
        if (!result.processed) break;
      }
    } catch (error) {
      onError(error);
    } finally {
      scheduleNext();
    }
  };

  scheduleNext();

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      holder[WORKER_STARTED_KEY] = false;
    },
  };
}
