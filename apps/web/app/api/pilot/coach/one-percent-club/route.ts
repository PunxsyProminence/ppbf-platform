import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import type { PilotPrincipal } from '@/src/server/pilot/auth';
import { ValidationError } from '@/src/server/pilot/errors';
import { hiddenNotFound, jsonError, requirePrincipal } from '@/src/server/pilot/http';
import {
  castVote,
  createNomination,
  getNomination,
  listMembers,
  listNominations,
  listVotes,
  withdrawNomination,
} from '@/src/server/pilot/onePercentClub';

export const runtime = 'nodejs';

// 1% Club (module 127). Owner design, verbatim: "1,2,3 with the majority of
// coach and admin on the list vote to confirm".
//
// Role split:
//   NOMINATING (path 1, 2, or 3) is open to coaches, admins, and athletes --
//   an athlete may nominate themselves or a peer. Which of the three paths a
//   nomination took is derived server-side (role, or a verified milestone),
//   never accepted from the client.
//
//   VOTING is coach/admin only, per the owner's own words: the eligible list
//   is "coach and admin", not everyone who can nominate.
//
//   VIEWING the roster, an open nomination's tally, or who voted is
//   coach/admin only. An athlete who nominates does not get a vote-count
//   view back -- there is no page here that lets a nomination read like a
//   contest in progress to the person it is about.
//
//   WITHDRAWING an open nomination is coach/admin only: reversing a
//   nomination is kept a staff action so a peer cannot un-nominate a
//   teammate.

const STAFF_ROLES = ['coach', 'organization_admin', 'admin'] as const;
const NOMINATOR_ROLES = ['coach', 'organization_admin', 'admin', 'athlete'] as const;

const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const isVoteValue = (value: unknown): value is 'yes' | 'no' => value === 'yes' || value === 'no';

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...STAFF_ROLES]);

    const nominationId = request.nextUrl.searchParams.get('nomination_id');
    if (nominationId) {
      const nomination = await getNomination(principal.organizationId, nominationId);
      if (!nomination) return hiddenNotFound();
      const votes = await listVotes(principal.organizationId, nominationId);
      return NextResponse.json({ item: nomination, votes });
    }

    const includeClosed = request.nextUrl.searchParams.get('include_closed') !== 'false';
    const [items, members] = await Promise.all([
      listNominations(principal.organizationId, includeClosed),
      listMembers(principal.organizationId),
    ]);
    return NextResponse.json({ items, members });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    const body = (await request.json()) as Record<string, unknown>;

    if (body.action === 'nominate') {
      requireRole(principal, [...NOMINATOR_ROLES]);

      const athleteId = text(body.athlete_id)?.trim();
      if (!athleteId) throw new ValidationError('nominate needs athlete_id.');

      const item = await createNomination({
        organizationId: principal.organizationId,
        athleteId,
        nominatorAccountId: principal.accountId,
        nominatorRole: principal.role,
        nominatorAthleteId: principal.athleteId,
        note: text(body.note),
        claimedMilestoneKey: text(body.milestone_key) ?? null,
      });
      if (!item) return hiddenNotFound();

      await audit(principal, 'create', item.nomination_id, {
        action: 'nominate',
        source: item.source,
        athlete_id: athleteId,
      });
      return NextResponse.json({ item });
    }

    if (body.action === 'vote') {
      requireRole(principal, [...STAFF_ROLES]);

      const nominationId = text(body.nomination_id)?.trim();
      if (!nominationId) throw new ValidationError('vote needs nomination_id.');
      if (!isVoteValue(body.vote)) throw new ValidationError("vote must be 'yes' or 'no'.");

      const result = await castVote({
        organizationId: principal.organizationId,
        nominationId,
        voterAccountId: principal.accountId,
        voterRole: principal.role,
        vote: body.vote,
      });
      if (!result) return hiddenNotFound();

      await audit(principal, 'update', nominationId, {
        action: 'vote',
        vote: body.vote,
        majority_reached: result.tally.majority_reached,
      });
      return NextResponse.json(result);
    }

    if (body.action === 'withdraw') {
      requireRole(principal, [...STAFF_ROLES]);

      const nominationId = text(body.nomination_id)?.trim();
      const reason = text(body.reason)?.trim();
      if (!nominationId) throw new ValidationError('withdraw needs nomination_id.');
      if (!reason) throw new ValidationError('A withdrawal needs a reason -- it stays on the record with it.');

      const item = await withdrawNomination({
        organizationId: principal.organizationId,
        nominationId,
        reason,
      });
      if (!item) return hiddenNotFound();

      await audit(principal, 'update', nominationId, { action: 'withdraw', reason });
      return NextResponse.json({ item });
    }

    throw new ValidationError("action must be 'nominate', 'vote', or 'withdraw'.");
  } catch (error) {
    return jsonError(error);
  }
}

async function audit(
  principal: PilotPrincipal,
  eventType: 'create' | 'update',
  entityId: string,
  details: Record<string, unknown>,
) {
  await writePilotAuditEvent({
    event_type: eventType,
    actor_account_id: principal.accountId,
    actor_role: principal.role,
    organization_id: principal.organizationId,
    entity_type: 'one_percent_nomination',
    entity_id: entityId,
    details,
  });
}
