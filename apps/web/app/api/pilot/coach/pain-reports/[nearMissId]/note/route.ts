import { NextResponse, type NextRequest } from 'next/server';

import { assertActorCanAccessAthlete, isOrganizationAdminRole, requireRole } from '@/src/server/pilot/access';
import { hiddenNotFound, jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { readPainNote } from '@/src/server/pilot/painReportNotes';
import { assertShadowRuntimeReadiness } from '@/src/server/pilot/shadowReadiness';
import { DECISION_LOOP_ROLES } from '@/src/server/pilot/shadowRoleSets';

export const runtime = 'nodejs';

const REQUIRED_TABLES = ['shadow_near_misses'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface RouteContext {
  params: Promise<{ nearMissId: string }>;
}

/**
 * "Read the note" on a pain-note escalation (DR-25; Overwatch Q12 A on #2139): one pain report's
 * note, for the escalation that points at it, with no 7-day window -- the escalation can stay open
 * after the report leaves the pain list.
 *
 * THE PAIN LIST'S GATE AND MASK, no new reader: the decision-loop roles (coach,
 * organization_admin, admin), then assertActorCanAccessAthlete for the report's own athlete. A
 * coach's read never carries a note held for admins, or the key saying one is held; that is done in
 * SQL (readPainNote). A malformed id, a missing report, another gym's, a near miss that is not a
 * pain report and a refused athlete all answer the same 404. A failure of the access check itself
 * (the database, not a refusal) surfaces as an error.
 */
export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...DECISION_LOOP_ROLES]);

    const { nearMissId } = await context.params;
    if (!UUID.test(nearMissId)) {
      return hiddenNotFound();
    }

    await assertShadowRuntimeReadiness({ requiredTables: REQUIRED_TABLES });

    const isAdmin = isOrganizationAdminRole(principal.role);
    const read = await readPainNote(principal.organizationId, nearMissId, isAdmin);
    if (!read) {
      return hiddenNotFound();
    }
    try {
      await assertActorCanAccessAthlete(principal, read.athleteId);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Forbidden')) {
        return hiddenNotFound();
      }
      throw error;
    }

    return NextResponse.json(
      { ok: true, note: read.note, ...(isAdmin ? { noteAdminOnly: read.adminOnly === true } : {}) },
      { headers: { 'cache-control': 'private, no-store' } },
    );
  } catch (error) {
    return jsonError(error);
  }
}
