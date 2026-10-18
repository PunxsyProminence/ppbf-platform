import { NextResponse, type NextRequest } from 'next/server';

import { assertActorCanAccessAthlete, requireRole } from '@/src/server/pilot/access';
import {
  listBehaviourObservations,
  recordBehaviourObservation,
  type ContextRef,
  type SessionRef,
} from '@/src/server/pilot/behaviourObservations';
import { hiddenNotFound, jsonError, requirePrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

// A coach's report of what an athlete did in a drill (lane L49). Staff only
// (Jason 2026-10-18 Q2, "A: Staff only"): these are coaching records about
// children, and no athlete, parent or public surface reads them. Every
// athlete_id goes through assertActorCanAccessAthlete, and an athlete the
// caller may not reach answers exactly as one that does not exist.
//
// The route records and lists what coaches wrote. It evaluates nothing: the
// pattern and lesson evaluators read these rows later, and only under a bar a
// gym admin has ratified with its citations (Q3).

const OBSERVATION_ROLES = ['coach', 'organization_admin', 'admin'] as const;

/** A non-empty string, or undefined. */
const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);

/** Exactly one of a run or a day. */
function sessionFrom(body: Record<string, unknown>): SessionRef | null {
  const runId = text(body.sessionRunId);
  const date = text(body.sessionDate);
  if (runId && !date) return { runId };
  if (date && !runId) return { date };
  return null;
}

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
    requireRole(principal, [...OBSERVATION_ROLES]);
    const athleteId = request.nextUrl.searchParams.get('athleteId');
    if (!athleteId || athleteId.length > 300) {
      return NextResponse.json({ ok: false, error: 'athleteId is required.' }, { status: 400 });
    }
    try {
      await assertActorCanAccessAthlete(principal, athleteId);
    } catch {
      return hiddenNotFound();
    }
    const observations = await listBehaviourObservations(principal.organizationId, athleteId);
    return NextResponse.json({ ok: true, observations });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...OBSERVATION_ROLES]);
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const athleteId = text(body.athleteId);
    const behaviourKey = text(body.behaviourKey);
    const session = sessionFrom(body);
    const context = contextFrom(body);
    if (!athleteId || athleteId.length > 300 || !behaviourKey || !session || !context) {
      return NextResponse.json({
        ok: false,
        error: 'athleteId, behaviourKey, one of sessionRunId or sessionDate, and one of drillId, blockId or attemptContext are required.',
      }, { status: 400 });
    }
    try {
      await assertActorCanAccessAthlete(principal, athleteId);
    } catch {
      return hiddenNotFound();
    }
    const observation = await recordBehaviourObservation({
      organizationId: principal.organizationId,
      athleteId,
      behaviourKey,
      observerAccountId: principal.accountId,
      authorRole: principal.role,
      session,
      context,
      trainingAttemptId: text(body.trainingAttemptId),
      sameMomentAs: text(body.sameMomentAs),
      taskConstraint: text(body.taskConstraint) ?? '',
      fatigueContext: text(body.fatigueContext),
      polarity: text(body.polarity) ?? '',
      attributionTarget: text(body.attributionTarget) ?? '',
      attributionCertainty: text(body.attributionCertainty) ?? '',
      viewQuality: text(body.viewQuality),
      note: text(body.note),
      observedAt: text(body.observedAt),
    });
    return NextResponse.json({ ok: true, observation }, { status: 201 });
  } catch (error) {
    return jsonError(error);
  }
}
