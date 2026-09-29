import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import {
  applyRosterImport,
  assignBlankCoachTo,
  parseRosterCsv,
  planRosterImport,
} from '@/src/server/pilot/rosterImport';

export const runtime = 'nodejs';

/**
 * Loading a roster from a spreadsheet.
 *
 * ORGANIZATION ADMINS AND COACHES, each into their OWN gym only (Jason,
 * 2026-09-29, "9d. B", OD-2026-09-29-002 item 9d). The gym comes from the
 * session. A body that names a different organization is refused rather than
 * silently redirected, the same as the activation-code route, so a wrong
 * caller fails loudly instead of writing somewhere it did not mean to. The
 * platform owner is not in the role list and stays out (OD-2026-09-28-005).
 *
 * WHO A ROW'S COACH MAY BE (Jason, 2026-09-29, "3B", recorded under
 * OD-2026-09-29-002 item 9d). Any active coach of the importing gym, for a
 * coach importer exactly as for an admin; the check lives in
 * planRosterImport, so the preview and Add enforce it together. A blank
 * Coach cell means the coach loading the file when a coach loads it; from an
 * admin it is a row that cannot be added, because every athlete needs one.
 *
 * The audit event records the session's own role, so a coach's import reads
 * 'coach', never an admin role.
 *
 * DRY RUN IS THE DEFAULT. A caller that omits `commit` gets the plan and
 * nothing is written. Loading forty real children off a spreadsheet is not an
 * action anyone should discover the shape of afterwards, and the preview is
 * produced by the same planning function the commit then uses -- not a second
 * implementation that can disagree with it.
 *
 * A CAP, AND IT SAYS SO. 500 rows per file. It exists so a pasted wrong file
 * cannot spend minutes inserting; it is not a limit anyone should hit, and the
 * refusal names the number rather than truncating silently, because a silent
 * truncation of a roster is children missing from the gym with nothing to say
 * they were ever in the file.
 */
const MAX_ROWS = 500;

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['organization_admin', 'coach']);
    if (!principal.organizationId) {
      throw new Error('Forbidden: no organization on this session');
    }

    const body = (await request.json()) as { csv?: string; commit?: boolean; organization_id?: unknown };
    const requestedOrganizationId = body.organization_id === undefined || body.organization_id === null
      ? ''
      : String(body.organization_id).trim();
    if (requestedOrganizationId && requestedOrganizationId !== principal.organizationId) {
      throw new Error('Forbidden: cannot act on another organization');
    }

    const csv = typeof body.csv === 'string' ? body.csv : '';
    const commit = body.commit === true;

    if (!csv.trim()) {
      throw new Error('Missing csv');
    }

    const parsed = parseRosterCsv(csv);
    if (parsed.fatal) {
      throw new Error(parsed.fatal);
    }
    if (parsed.rows.length > MAX_ROWS) {
      // "Unsupported" so jsonError answers 400 rather than masking a bad file
      // as an internal error.
      throw new Error(
        `Unsupported file: it has ${parsed.rows.length} rows and this accepts ${MAX_ROWS} at a time. `
        + 'Split it rather than letting part of it through.',
      );
    }

    // The SAME rows go to planning and to apply, so a filled-in coach is the
    // one the preview checked and the one that is written.
    const rows = principal.role === 'coach'
      ? assignBlankCoachTo(parsed.rows, principal.accountId)
      : parsed.rows;

    const plan = await planRosterImport(principal.organizationId, rows);

    if (!commit) {
      return NextResponse.json({ ok: true, committed: false, ...plan });
    }

    const result = await applyRosterImport(principal.organizationId, rows, plan, principal.accountId);

    // Audited as one event naming counts and the ids created, not one event per
    // athlete: forty rows would otherwise bury every other event of that
    // evening, and the question anyone asks later is "who loaded the roster and
    // what arrived", which this answers.
    await writePilotAuditEvent({
      event_type: 'create',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: principal.organizationId,
      entity_type: 'roster_import',
      entity_id: `${result.counts.create}-created`,
      details: {
        action: 'roster_import',
        created: result.counts.create,
        skipped_existing: result.counts.skip_exists,
        rejected: result.counts.reject,
        created_athlete_ids: result.rows
          .filter((row) => row.outcome === 'create')
          .map((row) => row.athlete_id),
      },
    });

    return NextResponse.json({ ok: true, committed: true, ...result });
  } catch (error) {
    return jsonError(error);
  }
}
