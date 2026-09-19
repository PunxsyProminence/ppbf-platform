import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { getDrillWithDetail, listReferenceLifecycles } from '@/src/server/pilot/drillLibraryV3';
import {
  DRILL_DIFFICULTIES,
  DrillNameTakenError,
  ReferenceDrillAlreadyPromotedError,
  isDrillDifficulty,
  promoteReferenceDrill,
} from '@/src/server/pilot/drills';
import { hiddenNotFound, jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { adoptionReadiness } from '@/src/lib/drillAdoptionReadiness';

export const runtime = 'nodejs';

// The one bridge between the two drill models -- OD-2026-09-16-001.
//
// pilot.drill_library holds the reference drills: instructional and safety
// content, seeded, read-only, canonical. pilot.drills holds the gym's own
// operational identities, and only those may be assigned. This route is how a
// coach moves a reference drill into the second set, explicitly, one drill at a
// time.
//
// WHAT IT IS NOT. Promotion is adoption, not prescription: it assigns the drill
// to nobody, creates no completion and no progression record, and touches no
// athlete. It also does not synchronize -- the reference row is pinned by
// version, and a later reference version is a different row that a coach adopts
// deliberately or not at all.
//
// WHY POST-ONLY AND ITS OWN FILE. The gate sweep in coachingContentAccess.test.ts
// asserts that drills/route.ts carries exactly two author gates, and this is a
// third write with a different shape. A separate file keeps that assertion
// meaningful; it is registered in that suite's PERMITTED_GATE_CONSTANTS so the
// role sweeps police this file too.

// The same three roles that author a drill, because promoting one IS authoring
// one: the row this writes is assignable. Declared here and asserted identical
// to the drills route's copy by coachingContentAccess.test.ts, so the two cannot
// drift apart.
//
// platform_owner reads coaching content under the reader policy and is still
// refused here. Reading a gym's drills is not authoring in that gym, and the
// read access it gained was explicit that it must not broaden writing.
const DRILL_AUTHOR_ROLES = ['coach', 'organization_admin', 'admin'] as const;

// The operational ceiling POST /api/pilot/drills already enforces. A reference
// drill may carry more cues than that; the promoted drill takes the first twelve
// in the reference's own order rather than failing, because the cue list is
// coaching emphasis and the reference keeps all of it either way.
const MAX_CUES = 12;

function requireText(raw: unknown, field: string): string {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new Error(`Missing ${field}`);
  }
  return raw.trim();
}

function conflict(message: string): NextResponse {
  return NextResponse.json({ error: message }, { status: 409 });
}

export async function POST(request: NextRequest) {
  // Kept for the catch below, which words the already-promoted refusal.
  let organizationId: string | null = null;
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...DRILL_AUTHOR_ROLES]);
    organizationId = principal.organizationId;

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const referenceDrillId = requireText(body.reference_drill_id, 'reference_drill_id');

    // The organization is the session's, never the body's. A supplied
    // organization_id is ignored rather than rejected: it is not a valid input
    // to this route in the first place, and the read below is what decides whose
    // reference drill this is.
    const reference = await getDrillWithDetail(principal.organizationId, referenceDrillId);

    // Organization-scoped read, so another gym's reference drill reads as absent.
    // Answered as a plain not-found so this route cannot be used to discover
    // which drill ids exist elsewhere.
    if (!reference) {
      return hiddenNotFound();
    }

    // A retracted or superseded reference drill is still readable -- history is
    // readable -- but it is not something a gym may newly adopt. The existing
    // promoted drills that point at it are unaffected; this only refuses a NEW
    // promotion.
    if (!reference.active) {
      return conflict('This reference drill is retracted and cannot be promoted.');
    }

    // Adoption readiness (W-D4C), enforced HERE so no client -- the coach page
    // or a direct API call -- can adopt a drill that is missing what it needs
    // to run. The page runs the same function to show the answer first. It is
    // the presence-and-governance check the data can decide, not the
    // context-aware quality gate (see drillAdoptionReadiness.ts for why).
    const readiness = adoptionReadiness(reference);
    if (!readiness.ready) {
      return NextResponse.json(
        {
          error: 'This reference drill is not ready to adopt.',
          code: 'NOT_READY_TO_ADOPT',
          missing: readiness.missing,
        },
        { status: 409 },
      );
    }

    // Both sides carry the same four-literal vocabulary, so this transfers
    // untranslated -- and is still checked, because a reference row that somehow
    // holds another value must not be silently coerced into 'intermediate'.
    if (!isDrillDifficulty(reference.difficulty)) {
      throw new Error(
        `Unsupported difficulty: one of ${DRILL_DIFFICULTIES.join(', ')}`,
      );
    }

    // THE MAPPING, and the whole of it.
    //
    // focus <- purpose: the coach surface labels the operational field "What it
    // is for", and purpose is the reference field carrying that meaning.
    // target_behavior is a different claim -- what the athlete should do
    // differently -- and is deliberately not substituted here.
    //
    // Everything else stays on the reference drill: stop rules, scale levels,
    // per-cue metadata, secondary skills, contact level, coach-authorization,
    // provenance, evidence and creator identity. The operational row has nowhere
    // to put them, and copying a subset would make the operational drill look
    // like the safety record when it is not. reference_drill_id is the link back.
    const cues = reference.cues
      .map((cue) => cue.cue_text.trim())
      .filter((cue) => cue.length > 0)
      .slice(0, MAX_CUES);

    const drill = await promoteReferenceDrill({
      organizationId: principal.organizationId,
      referenceDrillId: reference.drill_id,
      name: reference.name,
      category: reference.category,
      focus: requireText(reference.purpose, 'purpose'),
      difficulty: reference.difficulty,
      cues,
    });

    // The same evidence a hand-authored drill writes, plus the reference it came
    // from -- so the audit trail distinguishes an adopted drill from a typed one.
    await writePilotAuditEvent({
      event_type: 'create',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: principal.organizationId,
      entity_type: 'drill',
      entity_id: drill.drill_id,
      details: {
        name: drill.name,
        category: drill.category,
        difficulty: drill.difficulty,
        reference_drill_id: drill.reference_drill_id,
      },
    });

    return NextResponse.json(
      { ok: true, organization_id: principal.organizationId, drill },
      { status: 201 },
    );
  } catch (error) {
    // Two conflicts, two messages. "Already promoted" is resolved by using the
    // drill that exists; "name taken" is resolved by the coach deciding which
    // drill owns that name. A single 409 would send them to the wrong remedy.
    if (error instanceof ReferenceDrillAlreadyPromotedError) {
      // A retired adoption still holds the reference (the index is not partial
      // on active), so a second promotion is refused. Say what the coach can do
      // instead: bring the existing drill back, keeping its identity and its
      // history, rather than a message that reads as a dead end.
      const lifecycle = organizationId ? await lifecycleOf(organizationId, error.referenceDrillId) : null;
      if (lifecycle === 'retired') {
        return NextResponse.json(
          {
            error: 'This gym adopted this reference drill before and then retired it. Restore that drill instead of promoting it again.',
            code: 'PROMOTION_RETIRED_RESTORE_INSTEAD',
          },
          { status: 409 },
        );
      }
      return conflict(error.message);
    }
    if (error instanceof DrillNameTakenError) {
      return conflict(error.message);
    }
    return jsonError(error);
  }
}

// The reference's lifecycle for the session's gym, read only to word the
// already-promoted refusal. A failure here must not turn a clear 409 into a 500.
async function lifecycleOf(organizationId: string, referenceDrillId: string): Promise<string | null> {
  try {
    const lifecycles = await listReferenceLifecycles(organizationId, [referenceDrillId]);
    return lifecycles[referenceDrillId]?.state ?? null;
  } catch {
    return null;
  }
}
