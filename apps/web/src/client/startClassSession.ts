// The one way a coach screen starts a session (lane U2-6a; the start existed
// twice, in Session Plans' startDelivery and the coach home's one-tap start in
// CoachFloorFocus). It POSTs /api/pilot/session-scripts/runs -- the route that
// decides everything -- and says back what the server answered, in kinds a
// screen can word. It decides nothing itself and retries nothing.
//
// THE ONE-LIVE-PER-COACH REFUSAL IS A RECOVERY, NOT AN ERROR. The route refuses
// a second live session (SESSION_RUN_ALREADY_LIVE). The honest answer is the
// session the server says is running, so this reads it -- never retrying the
// start, never pretending nothing is live. If that read fails too, the caller
// is told so ('already_live' with run null) and says the session could not be
// loaded.

import { apiBase } from '@/lib/apiBase';
import type { LiveSessionScriptRun } from '@/src/server/pilot/sessionScriptRuns';
import type { ClassPlanView } from '@/src/shared/sessionClassChoice';

export type StartClassSessionOutcome =
  /**
   * The server started it; this is the run it returned. classPlan, for a start of the class's own
   * plan: the plan as the server resolved it at the start (null: the class has none).
   */
  | { readonly kind: 'started'; readonly run: LiveSessionScriptRun; readonly classPlan?: ClassPlanView | null }
  /** The coach already had a live session; run is it, or null when it could not be read. */
  | { readonly kind: 'already_live'; readonly run: LiveSessionScriptRun | null }
  /** The server refused. code is its error code, message its own words, when it sent them. */
  | { readonly kind: 'refused'; readonly code: string | null; readonly message: string | null }
  /** No answer arrived: nothing is known to have started. */
  | { readonly kind: 'network' };

/** The coach's own live session, or null when there is none. Throws when it cannot be read. */
export async function fetchOwnLiveRun(): Promise<LiveSessionScriptRun | null> {
  const response = await fetch(`${apiBase()}/api/pilot/session-scripts/runs`, { method: 'GET', credentials: 'include' });
  if (!response.ok) throw new Error('live-run');
  const payload = (await response.json()) as { run?: LiveSessionScriptRun | null };
  return payload.run ?? null;
}

/**
 * Start a session: with a plan (scriptId) or plain (null), tied to a class
 * (classId) or open gym (null). classPlan: the class's own plan instead, which
 * the server resolves at the start (class_plan; Codex P1 on #2241). Exactly one
 * POST per call.
 */
export async function startClassSession(input: {
  readonly scriptId: string | null;
  readonly classId: string | null;
  readonly classPlan?: boolean;
}): Promise<StartClassSessionOutcome> {
  const classPlan = input.classPlan === true && input.classId !== null;
  let response: Response;
  try {
    response = await fetch(`${apiBase()}/api/pilot/session-scripts/runs`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...(input.scriptId && !classPlan ? { script_id: input.scriptId } : {}),
        ...(input.classId ? { class_id: input.classId } : {}),
        ...(classPlan ? { class_plan: true } : {}),
      }),
    });
  } catch {
    return { kind: 'network' };
  }

  const payload = (await response.json().catch(() => ({}))) as {
    run?: LiveSessionScriptRun;
    class_plan?: ClassPlanView | null;
    error?: string;
    message?: string;
  };

  if (response.ok && payload.run) {
    return classPlan
      ? { kind: 'started', run: payload.run, classPlan: payload.class_plan ?? null }
      : { kind: 'started', run: payload.run };
  }

  if (payload.error === 'SESSION_RUN_ALREADY_LIVE') {
    const run = await fetchOwnLiveRun().catch(() => null);
    return { kind: 'already_live', run };
  }

  return {
    kind: 'refused',
    code: typeof payload.error === 'string' ? payload.error : null,
    message: typeof payload.message === 'string' ? payload.message : null,
  };
}

/**
 * Session Plans' words for a start that did not open a session (the wording it
 * had before lane U2-6a, unchanged). The class refusals -- not today,
 * cancelled, not yours, another session runs it -- and a superseded plan are
 * worded by the route (session-scripts/runs/route.ts), so its text is shown.
 */
export function startRefusalWords(outcome: StartClassSessionOutcome): string {
  switch (outcome.kind) {
    case 'started':
      return '';
    case 'network':
      return 'Network error -- no session was started.';
    case 'already_live':
      return outcome.run
        ? ''
        : 'The server reports a session already in progress, but it could not be loaded. Reload this page to recover it.';
    case 'refused':
      if (outcome.code === 'SESSION_SCRIPT_HAS_NO_BLOCKS') {
        return 'This plan has no blocks, so there is nothing to deliver. It stays start-disabled until blocks exist.';
      }
      if (outcome.code === 'SESSION_SCRIPT_NOT_FOUND') return 'That plan could not be found, so no session was started.';
      if (outcome.code === 'SESSION_SCRIPT_SUPERSEDED') {
        return outcome.message ?? 'This plan has been replaced by a newer version, so no session was started.';
      }
      return outcome.message ?? `The server refused to start the session${outcome.code ? `: ${outcome.code}` : '.'}`;
  }
}
