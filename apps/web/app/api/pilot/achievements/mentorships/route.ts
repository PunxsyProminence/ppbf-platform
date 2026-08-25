import { NextResponse, type NextRequest } from 'next/server';

import { assertActorCanAccessAthlete, requireRole } from '@/src/server/pilot/access';
import {
  InvalidAchievementInput,
  MentorshipAlreadyOpenError,
  createMentorship,
  endMentorship,
  getMentorshipById,
  listMentorshipsForAthlete,
} from '@/src/server/pilot/achievements';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

/**
 * MENTORSHIP — who is mentoring whom, visible on both sides.
 *
 * THE READ IS ONE ATHLETE'S OWN PAIRINGS, in both directions. Asking for
 * somebody's mentorships requires the same authorization as asking for anything
 * else about them, which means a mentee's name reaches only people already
 * entitled to see that mentee.
 *
 * PAIRING IS A COACH'S CALL. An athlete cannot appoint themselves anyone's
 * mentor and cannot nominate a peer: self-declared mentorship is a status
 * claim, and status claims between kids are the thing this whole system avoids.
 *
 * A CLOSED PAIRING IS HISTORY, NOT A FAILURE. DELETE closes with an end date;
 * there is no outcome field and no reason field anywhere in the table, so
 * nothing here can record that a mentorship went badly.
 */

const MENTORSHIP_READER_ROLES = ['coach', 'organization_admin', 'admin', 'athlete', 'parent'] as const;
const MENTORSHIP_WRITER_ROLES = ['coach', 'organization_admin', 'admin'] as const;

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...MENTORSHIP_READER_ROLES]);

    const athleteId = request.nextUrl.searchParams.get('athlete_id');
    if (!athleteId) {
      throw new Error('Missing athlete_id');
    }

    await assertActorCanAccessAthlete(principal, athleteId);

    const items = await listMentorshipsForAthlete(principal.organizationId, athleteId);
    return NextResponse.json({ ok: true, items });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...MENTORSHIP_WRITER_ROLES]);

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

    const mentorAthleteId = typeof body.mentor_athlete_id === 'string' ? body.mentor_athlete_id.trim() : '';
    const menteeAthleteId = typeof body.mentee_athlete_id === 'string' ? body.mentee_athlete_id.trim() : '';
    if (!mentorAthleteId || !menteeAthleteId) {
      throw new Error('Missing mentor_athlete_id or mentee_athlete_id');
    }

    // BOTH ends are authorized separately. A pairing puts each person's name on
    // the other's screen, so entitlement to one of them is not entitlement to
    // publish the other.
    await assertActorCanAccessAthlete(principal, mentorAthleteId);
    await assertActorCanAccessAthlete(principal, menteeAthleteId);

    const mentorship = await createMentorship({
      organizationId: principal.organizationId,
      mentorAthleteId,
      menteeAthleteId,
      createdByAccountId: principal.accountId,
      note: typeof body.note === 'string' ? body.note : '',
    });

    await writePilotAuditEvent({
      event_type: 'create',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: principal.organizationId,
      entity_type: 'mentorship',
      entity_id: mentorship.mentorship_id,
      details: { mentor_athlete_id: mentorAthleteId, mentee_athlete_id: menteeAthleteId },
    });

    return NextResponse.json({ ok: true, mentorship }, { status: 201 });
  } catch (error) {
    if (error instanceof MentorshipAlreadyOpenError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof InvalidAchievementInput) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return jsonError(error);
  }
}

/** Closes a pairing. The row stays; only an end date is added. */
export async function DELETE(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...MENTORSHIP_WRITER_ROLES]);

    const mentorshipId = request.nextUrl.searchParams.get('mentorship_id');
    if (!mentorshipId) {
      throw new Error('Missing mentorship_id');
    }

    // Resolve and authorize the mentorship's athlete BEFORE mutating it.
    // endMentorship writes the end date first and returns the row after, so
    // authorizing on its result was too late -- a writer with no relationship
    // to the athlete could end the pairing and only then be refused, with the
    // row already changed. The mentor_athlete_id binding is set at creation
    // and never reassigned, so a read-then-write here is safe.
    const existing = await getMentorshipById(principal.organizationId, mentorshipId);
    if (!existing) {
      throw new Error('Not found');
    }
    await assertActorCanAccessAthlete(principal, existing.mentor_athlete_id);

    const mentorship = await endMentorship(principal.organizationId, mentorshipId);
    if (!mentorship) {
      throw new Error('Not found');
    }

    await writePilotAuditEvent({
      event_type: 'update',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: principal.organizationId,
      entity_type: 'mentorship',
      entity_id: mentorship.mentorship_id,
      details: { ended_on: mentorship.ended_on },
    });

    return NextResponse.json({ ok: true, mentorship });
  } catch (error) {
    return jsonError(error);
  }
}
