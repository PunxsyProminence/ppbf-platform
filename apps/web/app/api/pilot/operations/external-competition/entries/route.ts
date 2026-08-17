import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { ValidationError } from '@/src/server/pilot/errors';
import { hiddenNotFound, jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import {
  COMPETITION_READ_ROLES,
  COMPETITION_WRITE_ROLES,
  addCompetitionEntry,
  isCompetitionEntryResult,
  listCompetitionEntries,
  recordEntryResult,
  withdrawCompetitionEntry,
} from '@/src/server/pilot/externalCompetition';

export const runtime = 'nodejs';

// External-competition skeleton: athlete entries. The entry is a LINK --
// athlete names come through the org-scoped join in externalCompetition.ts,
// never copied. Competition and athlete ids from another organization are
// hidden not-founds.

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...COMPETITION_READ_ROLES]);

    const competitionId = request.nextUrl.searchParams.get('competition_id')?.trim();
    if (!competitionId) throw new ValidationError('Missing competition_id.');

    const items = await listCompetitionEntries(principal.organizationId, competitionId);
    return NextResponse.json({ items });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...COMPETITION_WRITE_ROLES]);

    const body = (await request.json()) as {
      competition_id?: string;
      athlete_id?: string;
    };

    if (!body.competition_id?.trim()) throw new ValidationError('Missing competition_id.');
    if (!body.athlete_id?.trim()) throw new ValidationError('Missing athlete_id.');

    const item = await addCompetitionEntry({
      organizationId: principal.organizationId,
      competitionId: body.competition_id.trim(),
      athleteId: body.athlete_id.trim(),
      createdByAccountId: principal.accountId,
    });

    if (!item) return hiddenNotFound();
    return NextResponse.json({ item });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('COMPETITION_DUPLICATE_ENTRY')) {
      return NextResponse.json(
        { ok: false, error: 'This athlete is already entered in this competition.' },
        { status: 409 },
      );
    }
    return jsonError(error);
  }
}

// Two distinct PATCH shapes on one route, same field name (`status`) the
// sibling competitions/seasons routes already use for their own status
// transitions: `status: 'withdrawn'` withdraws the entry; `result` records
// its outcome (owner decision 2026-08-16: won / lost / draw / no_contest,
// and a LOSS REQUIRES A LESSON -- refused here with the reason, and refused
// by the database constraint beneath. The lesson is the point: "one
// hard-fought loss is worth a thousand easy victories."). The two never
// overlap: withdrawal touches status only, result recording never touches
// status.
export async function PATCH(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...COMPETITION_WRITE_ROLES]);

    const body = (await request.json()) as {
      entry_id?: string;
      status?: string;
      result?: string;
      lesson_note?: string;
    };
    if (!body.entry_id?.trim()) throw new ValidationError('Missing entry_id.');
    const entryId = body.entry_id.trim();

    if (body.status !== undefined) {
      if (body.status !== 'withdrawn') {
        throw new ValidationError("status must be 'withdrawn'.");
      }

      const withdrawn = await withdrawCompetitionEntry({
        organizationId: principal.organizationId,
        entryId,
      });
      // A missing/foreign entry_id and an already-withdrawn entry are the
      // same CAS miss (see withdrawCompetitionEntry) -- reported alike as
      // hidden-not-found, the same collapse recordEntryResult below already
      // makes for its own CAS miss.
      if (!withdrawn) return hiddenNotFound();

      await writePilotAuditEvent({
        event_type: 'update',
        actor_account_id: principal.accountId,
        actor_role: principal.role,
        organization_id: principal.organizationId,
        entity_type: 'external_competition_entry',
        entity_id: entryId,
        details: { action: 'withdraw' },
      });
      return NextResponse.json({ item: { entry_id: entryId, status: 'withdrawn' } });
    }

    if (!isCompetitionEntryResult(body.result)) {
      throw new ValidationError("result must be 'won', 'lost', 'draw', or 'no_contest'.");
    }

    const item = await recordEntryResult({
      organizationId: principal.organizationId,
      entryId,
      result: body.result,
      lessonNote: body.lesson_note,
    });
    if (!item) return hiddenNotFound();

    await writePilotAuditEvent({
      event_type: 'update',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: principal.organizationId,
      entity_type: 'external_competition_entry',
      entity_id: item.entry_id,
      details: { action: 'record_result', result: item.result, has_lesson: item.lesson_note.length > 0 },
    });
    return NextResponse.json({ item });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('COMPETITION_LOSS_NEEDS_LESSON')) {
      return NextResponse.json(
        { ok: false, error: 'A loss cannot be recorded without its lesson. What did it teach?' },
        { status: 400 },
      );
    }
    return jsonError(error);
  }
}
