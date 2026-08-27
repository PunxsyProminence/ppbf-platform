import { NextResponse, type NextRequest } from 'next/server';

import { assertActorCanAccessAthlete, requireRole } from '@/src/server/pilot/access';
import { getAthleteIntelligence } from '@/src/server/pilot/athleteIntelligence';
import { ValidationError } from '@/src/server/pilot/errors';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

// Athlete Intelligence read model. Read-only staff surface over ONE athlete:
// the latest value of every formula output, their attempts ledger, the
// controlled-versus-live transfer readout, and the Film Study material a coach
// has accepted or corrected. Nothing here writes, scores, ranks, or decides.
//
// TWO GATES, IN ORDER, AND THE SECOND IS THE ONE THAT MATTERS. The role check
// says a coach may read an athlete's intelligence; it does not say WHICH
// athlete's. athlete_id is caller-supplied, so assertActorCanAccessAthlete --
// the standing authority, same as transfer-check and training-attempts --
// decides that second question. It is called ONCE, before any read, and it
// refuses platform_owner and board by name and fails closed on a role it does
// not recognize.
//
// Without it, any coach in the organization reads any athlete's formula
// results, attempt history and Film Study through this route.
//
// The organization is the principal's own and is never taken from the request:
// there is no organization_id parameter here, by design.
//
// Roles are the staff set. Whether an athlete or a guardian should read SHADOW
// formula internals and vision-model observation text about themselves is a
// policy question with an owner, and it is not answered here by leaving the
// list open.

const ATHLETE_INTELLIGENCE_ROLES = ['coach', 'organization_admin', 'admin'] as const;

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...ATHLETE_INTELLIGENCE_ROLES]);

    const athleteId = request.nextUrl.searchParams.get('athlete_id')?.trim();
    if (!athleteId) throw new ValidationError('Missing athlete_id.');
    await assertActorCanAccessAthlete(principal, athleteId);

    const intelligence = await getAthleteIntelligence({
      organizationId: principal.organizationId,
      athleteId,
    });
    return NextResponse.json(intelligence);
  } catch (error) {
    return jsonError(error);
  }
}
