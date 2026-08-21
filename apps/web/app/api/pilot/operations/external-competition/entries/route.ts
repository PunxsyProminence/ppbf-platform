import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { assertAthleteMayBeEnteredInCompetition } from '@/src/server/pilot/competitionSafetyGates';
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
// never copied. A competition id from another organization is a hidden
// not-found; an athlete id this actor may not act on is refused by the safety
// gate below instead (403), whose message reads the same for an athlete who
// does not exist, one in another gym, and one who is simply not this coach's
// -- so the status change discloses nothing the hidden not-found was hiding.
//
// The entries READ stays org-wide for coaches by design, and is not a gap:
// athletes/list records the doctrine ("a coach plans a floor and picks up
// cover across the whole gym") and already lets any coach read every athlete's
// name and gym status org-wide, restricting only dob and emergency contact. An
// entry row exposes a name, an entry status and a result -- nothing about the
// child's body or family. Full gate list: competitionSafetyGates.ts and
// docs/capabilities/GATES.md §9.

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

    const competitionId = body.competition_id.trim();
    const athleteId = body.athlete_id.trim();

    // The three safety gates, before the entry exists: this actor's standing
    // with this child, an active hold covering contact, and the guardian's
    // travel consent. An entry is the moment a child is committed to competing
    // somewhere else, and until now it was committed on a role string alone.
    // Run BEFORE the competition lookup inside addCompetitionEntry so no entry
    // row can be created down any path that skipped them. Each refusal is a
    // typed PilotError, so jsonError surfaces it verbatim with its own status
    // and this handler needs no extra catch arm -- see
    // competitionSafetyGates.ts for why all three refuse rather than warn.
    await assertAthleteMayBeEnteredInCompetition({
      actor: principal,
      athleteId,
      kind: 'external_competition',
      contextId: competitionId,
    });

    const item = await addCompetitionEntry({
      organizationId: principal.organizationId,
      competitionId,
      athleteId,
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

// Result capture (owner decision 2026-08-16): won / lost / draw /
// no_contest per entry, and a LOSS REQUIRES A LESSON -- refused here with
// the reason, and refused by the database constraint beneath. The lesson
// is the point: "one hard-fought loss is worth a thousand easy victories."
//
// Withdrawal shares this PATCH: a `status` field transitions the entry to
// 'withdrawn' (mirroring the {id, status} shape the competition/season
// status routes already use), while a `result` field keeps recording a
// result on an entered athlete.
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

    if (body.status !== undefined) {
      if (body.status !== 'withdrawn') {
        throw new ValidationError("status must be 'withdrawn'.");
      }

      const item = await withdrawCompetitionEntry({
        organizationId: principal.organizationId,
        entryId: body.entry_id.trim(),
      });
      if (!item) return hiddenNotFound();

      await writePilotAuditEvent({
        event_type: 'update',
        actor_account_id: principal.accountId,
        actor_role: principal.role,
        organization_id: principal.organizationId,
        entity_type: 'external_competition_entry',
        entity_id: item.entry_id,
        details: { action: 'withdraw' },
      });
      return NextResponse.json({ item });
    }

    if (!isCompetitionEntryResult(body.result)) {
      throw new ValidationError("result must be 'won', 'lost', 'draw', or 'no_contest'.");
    }

    const item = await recordEntryResult({
      organizationId: principal.organizationId,
      entryId: body.entry_id.trim(),
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
