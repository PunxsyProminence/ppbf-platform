import { NextResponse, type NextRequest } from 'next/server';

import { assertActorCanAccessAthlete, requireRole } from '@/src/server/pilot/access';
import type { ContextRef } from '@/src/server/pilot/behaviourObservations';
import { listOpenBehaviourWindows, openBehaviourWindow } from '@/src/server/pilot/behaviourSampleWindows';
import { hiddenNotFound, jsonError, requirePrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

// Sampled windows (lane PATTERN-1, PATTERN-1e; PunxsyProminence/ppbf-platform#2082):
// POST opens one on an athlete in a live session run; GET lists a run's open
// windows so a second coach can join one (Q2 A). Staff only, like the
// behaviour reports a window's taps become: no athlete, parent or public
// surface. Every athlete goes through assertActorCanAccessAthlete, and one the
// caller may not reach answers exactly as one that does not exist. The opener,
// role and gym are the session's, never the body's.

const WINDOW_ROLES = ['coach', 'organization_admin', 'admin'] as const;

/** A non-empty string, or undefined. */
const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);

/** Exactly one of a library drill, a session block, or a training context. */
function contextFrom(body: Record<string, unknown>): ContextRef | null {
  const drillId = text(body.drillId);
  const blockId = text(body.blockId);
  const attemptContext = text(body.attemptContext);
  if ([drillId, blockId, attemptContext].filter((value) => value !== undefined).length !== 1) return null;
  if (drillId) return { drillId };
  if (blockId) return { blockId };
  return attemptContext ? { attemptContext } : null;
}

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...WINDOW_ROLES]);
    const runId = request.nextUrl.searchParams.get('sessionRunId');
    if (!runId || runId.length > 300) {
      return NextResponse.json({ ok: false, error: 'sessionRunId is required.' }, { status: 400 });
    }
    const open = await listOpenBehaviourWindows({
      organizationId: principal.organizationId, runId, readerAccountId: principal.accountId,
    });
    const windows = [];
    for (const window of open) {
      try {
        await assertActorCanAccessAthlete(principal, window.athlete_id);
        windows.push(window);
      } catch {
        // An athlete the caller may not reach: left out, as if the window were not there.
      }
    }
    return NextResponse.json({ ok: true, windows });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...WINDOW_ROLES]);
    // A body of null, a number or a list is not a request: read as empty, refused below.
    const parsed: unknown = await request.json().catch(() => null);
    const body = (parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}) as Record<string, unknown>;
    const athleteId = text(body.athleteId);
    const behaviourKey = text(body.behaviourKey);
    const runId = text(body.sessionRunId);
    const context = contextFrom(body);
    const tooLong = [athleteId, behaviourKey, runId, text(body.drillId), text(body.blockId), text(body.attemptContext)]
      .some((value) => (value?.length ?? 0) > 300);
    if (!athleteId || tooLong || !behaviourKey || !runId || !context
        || (body.chances !== undefined && typeof body.chances !== 'number')) {
      return NextResponse.json({
        ok: false,
        error: 'athleteId, behaviourKey, sessionRunId, and one of drillId, blockId or attemptContext are required; chances is a number.',
      }, { status: 400 });
    }
    try {
      await assertActorCanAccessAthlete(principal, athleteId);
    } catch {
      return hiddenNotFound();
    }
    const window = await openBehaviourWindow({
      organizationId: principal.organizationId,
      athleteId,
      behaviourKey,
      runId,
      context,
      taskConstraint: text(body.taskConstraint) ?? '',
      chances: body.chances as number | undefined,
      openedByAccountId: principal.accountId,
      openedByRole: principal.role,
    });
    return NextResponse.json({ ok: true, window }, { status: 201 });
  } catch (error) {
    return jsonError(error);
  }
}
