import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { assertAthleteMayBeEnteredInCompetition } from '@/src/server/pilot/competitionSafetyGates';
import { ValidationError } from '@/src/server/pilot/errors';
import { hiddenNotFound, jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import {
  LEAGUE_READ_ROLES,
  LEAGUE_WRITE_ROLES,
  addLeagueRosterEntry,
  listLeagueRoster,
  withdrawLeagueRosterEntry,
} from '@/src/server/pilot/wrestlingLeague';

export const runtime = 'nodejs';

// Wrestling league skeleton: season roster. The entry is a LINK -- athlete
// names come through the org-scoped join in wrestlingLeague.ts, never copied.
// A season id from another organization is a hidden not-found; an athlete id
// this actor may not act on is refused by the safety gate below instead (403),
// with a message that reads the same for an athlete who does not exist, one in
// another gym, and one who is simply not this coach's -- so the status change
// discloses nothing the hidden not-found was hiding.
//
// The roster READ stays org-wide for coaches by design, and is not a gap:
// athletes/list records the doctrine ("a coach plans a floor and picks up
// cover across the whole gym") and already lets any coach read every
// athlete's name and gym status org-wide, restricting only dob and emergency
// contact. A roster row exposes a name and a season membership, nothing that
// list does not. See this capability's README.md for the full gate list.

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...LEAGUE_READ_ROLES]);

    const seasonId = request.nextUrl.searchParams.get('season_id')?.trim();
    if (!seasonId) throw new ValidationError('Missing season_id.');

    const items = await listLeagueRoster(principal.organizationId, seasonId);
    return NextResponse.json({ items });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...LEAGUE_WRITE_ROLES]);

    const body = (await request.json()) as {
      season_id?: string;
      athlete_id?: string;
    };

    if (!body.season_id?.trim()) throw new ValidationError('Missing season_id.');
    if (!body.athlete_id?.trim()) throw new ValidationError('Missing athlete_id.');

    const seasonId = body.season_id.trim();
    const athleteId = body.athlete_id.trim();

    // The three safety gates, before the link exists: this actor's standing
    // with this child, an active hold covering contact, and the guardian's
    // travel consent. A season roster is where this capability commits a child
    // to competing, and until now it committed them on a role string alone.
    // Run BEFORE the season lookup inside addLeagueRosterEntry so no roster
    // row can be created down any path that skipped them. Each refusal is a
    // typed PilotError, so jsonError surfaces it verbatim with its own status
    // and this handler needs no extra catch arm -- see
    // competitionSafetyGates.ts for why all three refuse rather than warn.
    await assertAthleteMayBeEnteredInCompetition({
      actor: principal,
      athleteId,
      kind: 'wrestling_league_season',
      contextId: seasonId,
    });

    const item = await addLeagueRosterEntry({
      organizationId: principal.organizationId,
      seasonId,
      athleteId,
      createdByAccountId: principal.accountId,
    });

    if (!item) return hiddenNotFound();
    return NextResponse.json({ item });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('LEAGUE_ROSTER_DUPLICATE_ENTRY')) {
      return NextResponse.json(
        { ok: false, error: 'This athlete is already on the season roster.' },
        { status: 409 },
      );
    }
    return jsonError(error);
  }
}

// Withdrawal: a `status` field transitions the roster entry to 'inactive'
// -- the only other value the type and the database CHECK constraint allow
// -- mirroring the {id, status} shape the season-status route already uses.
export async function PATCH(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...LEAGUE_WRITE_ROLES]);

    const body = (await request.json()) as {
      entry_id?: string;
      status?: string;
    };
    if (!body.entry_id?.trim()) throw new ValidationError('Missing entry_id.');
    if (body.status !== 'inactive') {
      throw new ValidationError("status must be 'inactive'.");
    }

    const item = await withdrawLeagueRosterEntry({
      organizationId: principal.organizationId,
      entryId: body.entry_id.trim(),
    });
    if (!item) return hiddenNotFound();

    await writePilotAuditEvent({
      event_type: 'update',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: principal.organizationId,
      entity_type: 'wrestling_league_roster_entry',
      entity_id: item.entry_id,
      details: { action: 'withdraw' },
    });
    return NextResponse.json({ item });
  } catch (error) {
    return jsonError(error);
  }
}
