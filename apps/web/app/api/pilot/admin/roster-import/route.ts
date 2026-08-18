import { NextResponse, type NextRequest } from 'next/server';

import { isOrganizationAdminRole, requireRole } from '@/src/server/pilot/access';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import {
  applyRosterImport,
  parseRosterCsv,
  planRosterImport,
} from '@/src/server/pilot/rosterImport';

export const runtime = 'nodejs';

/**
 * Loading a roster from a spreadsheet.
 *
 * ORGANIZATION ADMIN ONLY, and the gym comes from the session. The same
 * boundary the PIN directory and athlete accounts hold: creating this gym's
 * children is the gym's own administrator's act. A body-supplied
 * organization_id is not read at all here, so there is nothing to get wrong.
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
    requireRole(principal, ['organization_admin']);
    if (!isOrganizationAdminRole(principal.role)) {
      throw new Error('Forbidden: role not allowed');
    }

    const body = (await request.json()) as { csv?: string; commit?: boolean };
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

    const plan = await planRosterImport(principal.organizationId, parsed.rows);

    if (!commit) {
      return NextResponse.json({ ok: true, committed: false, ...plan });
    }

    const result = await applyRosterImport(principal.organizationId, parsed.rows, plan, principal.accountId);

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
