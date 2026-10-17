// GET /api/pilot/parent/athlete-messages -- what the gym's staff wrote to the
// guardian's children, read-only (#1542, FC-06 Q-2, ruled B: for youth,
// guardians receive a copy of athlete messages).
//
// Parent only. The scope is guardianAthleteIds, resolved on this request: the
// children linked to this guardian now, leaving out a child aged 18 or over
// (guardian access goes dormant at 18) and a deleted record. Staff names only,
// no account ids (OD-2026-10-06-025). Separate from the parent's own messages
// (/api/pilot/parent/messages): these are words to the child, shown as
// "Sent to your athlete". in_scope is how many children that scope holds, so
// the page can show nothing at all to a guardian with no child under 18
// linked, rather than tell them nothing was sent.
import { NextResponse, type NextRequest } from 'next/server';

import { listGuardianCopiesOfAthleteMessages } from '@/src/server/pilot/athleteCoachMessages';
import { guardianAthleteIds } from '@/src/server/pilot/guardianAccess';
import { jsonError, requirePrincipal, requireRole } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['parent']);

    const athleteIds = await guardianAthleteIds(principal.organizationId, principal.accountId);
    const items = await listGuardianCopiesOfAthleteMessages(principal.organizationId, athleteIds);
    return NextResponse.json({ ok: true, items, in_scope: athleteIds.length });
  } catch (error) {
    return jsonError(error);
  }
}
