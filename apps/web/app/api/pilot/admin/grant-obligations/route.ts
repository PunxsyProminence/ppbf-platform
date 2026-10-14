import { NextResponse, type NextRequest } from 'next/server';

import { escapeCsvField } from '@/app/api/pilot/admin/export/roster/csv';
import { formatGymDateTime, gymDayIso } from '@/src/lib/gymTime';
import { requireRole } from '@/src/server/pilot/access';
import { ValidationError } from '@/src/server/pilot/errors';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import {
  createGrantObligation,
  grantObligationsReport,
  type GrantObligationRow,
  type GrantReportState,
  isGrantObligationStatus,
  isGrantObligationType,
  listGrantObligations,
  updateGrantObligationStatus,
} from '@/src/server/pilot/grantObligations';

export const runtime = 'nodejs';

// Internal grant-obligation ledger. Admin-only in both directions: these are
// the organization's commitments to funders, not program records -- no coach,
// athlete, parent, or board access in v1 (the board's compliance view can
// grow a read later as its own decision). Nothing here touches athlete data;
// the table structurally has none (see the migration header).
const GRANT_ROLES = ['organization_admin', 'admin'] as const;

const REPORT_STATES: readonly GrantReportState[] = ['open', 'settled', 'all'];

/** A calendar day, YYYY-MM-DD, that is a real date. */
function calendarDay(raw: string | null, field: string): string | undefined {
  if (raw === null) return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  const real = match
    && new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))).toISOString().slice(0, 10) === raw;
  if (!real) {
    throw new ValidationError(`${field} must be a date as YYYY-MM-DD.`);
  }
  return raw;
}

/*
 * THE OBLIGATIONS REPORT AS CSV (RP-03). Internal, for the organization admin
 * (Q3 default A). The facts only -- grant, funder, type, what is due, when, its
 * status and when it was settled -- and no notes (Q4 default A). Overdue is a
 * derived display fact: an open or in-progress obligation whose due date is
 * before today's gym day (Q2 default A); a settled one is never overdue. The
 * cells go through the roster export's escapeCsvField (quoted, formula-guarded),
 * and the file starts with a UTF-8 byte order mark for Excel.
 */
function obligationsCsv(rows: readonly GrantObligationRow[], today: string, heading: string): string {
  const header = ['Grant', 'Funder', 'Type', 'Description', 'Due', 'Status', 'Settled (gym time)', 'Overdue'];
  const lines = [
    [heading],
    header,
    ...rows.map((row) => [
      row.grant_name,
      row.funder_name,
      row.obligation_type,
      row.description,
      row.due_date,
      row.status,
      row.completed_at ? formatGymDateTime(row.completed_at) ?? '' : '',
      (row.status === 'open' || row.status === 'in_progress') && row.due_date < today ? 'yes' : '',
    ]),
  ];
  return `\uFEFF${lines.map((cells) => cells.map(escapeCsvField).join(',')).join('\r\n')}\r\n`;
}

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...GRANT_ROLES]);

    const status = request.nextUrl.searchParams.get('status');
    if (status !== null && !isGrantObligationStatus(status)) {
      throw new ValidationError('Unknown status filter.');
    }

    // The report (RP-03): format=csv with a state and an optional due range.
    const format = request.nextUrl.searchParams.get('format');
    if (format !== null) {
      if (format !== 'csv') {
        throw new ValidationError('Unknown format: only csv.');
      }
      if (status !== null) {
        throw new ValidationError('The report filters by state (open, settled or all), not by one status.');
      }
      const state = (request.nextUrl.searchParams.get('state') ?? 'all') as GrantReportState;
      if (!REPORT_STATES.includes(state)) {
        throw new ValidationError('Unknown report state: open, settled or all.');
      }
      const dueFrom = calendarDay(request.nextUrl.searchParams.get('from'), 'from');
      const dueTo = calendarDay(request.nextUrl.searchParams.get('to'), 'to');
      if (dueFrom && dueTo && dueFrom > dueTo) {
        throw new ValidationError('from must be on or before to.');
      }
      const today = gymDayIso(Date.now()) ?? new Date().toISOString().slice(0, 10);
      const rows = await grantObligationsReport(principal.organizationId, { dueFrom, dueTo, state });
      const range = `${dueFrom ?? 'any'} to ${dueTo ?? 'any'}`;
      const heading = `Grant obligations, ${state}, due ${range}, as of ${today} (gym day)`;
      return new NextResponse(obligationsCsv(rows, today, heading), {
        status: 200,
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="grant-obligations_${state}_${today}.csv"`,
          'Cache-Control': 'no-store',
        },
      });
    }

    const items = await listGrantObligations(
      principal.organizationId,
      status ? { status } : {},
    );
    return NextResponse.json({ items });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...GRANT_ROLES]);

    const body = (await request.json()) as {
      grant_name?: string;
      funder_name?: string;
      obligation_type?: string;
      description?: string;
      due_date?: string;
      notes?: string;
    };

    if (!body.grant_name?.trim() || !body.description?.trim()) {
      throw new ValidationError('Missing grant_name or description.');
    }
    if (!isGrantObligationType(body.obligation_type)) {
      throw new ValidationError('Unknown obligation_type.');
    }
    if (!body.due_date || !/^\d{4}-\d{2}-\d{2}$/.test(body.due_date)) {
      throw new ValidationError('due_date must be YYYY-MM-DD.');
    }

    const item = await createGrantObligation({
      organizationId: principal.organizationId,
      grantName: body.grant_name.trim(),
      funderName: body.funder_name?.trim(),
      obligationType: body.obligation_type,
      description: body.description.trim(),
      dueDate: body.due_date,
      notes: body.notes,
      createdByAccountId: principal.accountId,
    });

    return NextResponse.json({ item });
  } catch (error) {
    return jsonError(error);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...GRANT_ROLES]);

    const body = (await request.json()) as {
      obligation_id?: string;
      status?: string;
      notes?: string;
    };

    if (!body.obligation_id) throw new ValidationError('Missing obligation_id.');
    if (!isGrantObligationStatus(body.status)) throw new ValidationError('Unknown status.');

    const item = await updateGrantObligationStatus({
      organizationId: principal.organizationId,
      obligationId: body.obligation_id,
      status: body.status,
      notes: body.notes,
    });

    if (!item) {
      return NextResponse.json({ ok: false, error: 'Not found.' }, { status: 404 });
    }
    return NextResponse.json({ item });
  } catch (error) {
    return jsonError(error);
  }
}
