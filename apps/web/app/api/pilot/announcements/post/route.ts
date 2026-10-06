import { NextResponse, type NextRequest } from 'next/server';

import {
  createAnnouncement,
  isAllowedAnnouncementRole,
  isAnnouncementKind,
  isAnnouncementPlacement,
  type AnnouncementAuthorRole,
} from '@/src/server/pilot/announcements';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { getBoardSeatLabel, listSeatsForAccount } from '@/src/server/pilot/boardSeats';
import { jsonError, requireStaffSessionPrincipal } from '@/src/server/pilot/http';
import type { PilotRole } from '@/src/server/pilot/contracts';

export const runtime = 'nodejs';

// The author role written onto an announcement is a public claim about who is
// speaking for the club, so it is constrained by the caller's session role
// rather than taken from the request body. Board seats are finer-grained than
// PilotRole, so a board principal may still pick which seat it is posting as --
// but only a seat pilot.board_seats says it holds (outright or as a
// co-holder), and no other role can claim one. Before CL-A8 any board member
// could sign as any seat, e.g. the treasurer as `board-president`, on a notice
// the public wall serves unauthenticated.
async function resolveAuthorRole(
  principal: { role: PilotRole; organizationId: string; accountId: string },
  requested: string,
): Promise<AnnouncementAuthorRole | null> {
  const principalRole = principal.role;
  if (principalRole === 'coach') {
    return 'coach';
  }

  if (principalRole === 'platform_owner' || principalRole === 'organization_admin' || principalRole === 'admin') {
    return 'admin';
  }

  if (principalRole === 'board') {
    if (!isAllowedAnnouncementRole(requested) || !requested.startsWith('board-')) {
      return null;
    }
    const seats = await listSeatsForAccount(principal.organizationId, principal.accountId);
    if (seats.some((item) => `board-${item.seat}` === requested)) {
      return requested;
    }
    // Name the seats they CAN sign as. /notices offers only held seats, but a
    // stale page or another client may still send one, and a bare refusal
    // would not tell a treasurer what to pick.
    throw new Error(
      seats.length === 0
        ? 'Forbidden: you hold no board seat, so you cannot post as one'
        : `Forbidden: you may post only as a board seat you hold (${seats.map((item) => getBoardSeatLabel(item.seat)).join(', ')})`,
    );
  }

  return null;
}

// An unset bound stays null: NULL means "no bound", and a reader treats it as
// always-on in that direction. Coercing a blank field to now() would backdate
// the window to whenever the form happened to be submitted.
function parseScheduleBound(raw: unknown, field: string): string | null {
  if (raw === undefined || raw === null || raw === '') {
    return null;
  }

  if (typeof raw !== 'string') {
    throw new Error(`Unsupported ${field}`);
  }

  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) {
    throw new Error(`Unsupported ${field}`);
  }

  return new Date(parsed).toISOString();
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requireStaffSessionPrincipal(request);
    const body = (await request.json()) as {
      message?: string;
      author_name?: string;
      author_role?: string;
      placement?: string;
      kind?: string;
      starts_at?: string | null;
      ends_at?: string | null;
    };

    const organizationId = principal.organizationId;
    const message = body.message?.trim() || '';
    const authorName = body.author_name?.trim() || '';
    const authorRole = await resolveAuthorRole(principal, body.author_role?.trim() || '');
    const placement = body.placement?.trim() || 'gym_notices';
    const kind = body.kind?.trim() || 'notice';
    const startsAt = parseScheduleBound(body.starts_at, 'starts_at');
    const endsAt = parseScheduleBound(body.ends_at, 'ends_at');

    if (!message) {
      throw new Error('Missing message');
    }

    if (!authorName) {
      throw new Error('Missing author_name');
    }

    if (!authorRole) {
      throw new Error('Forbidden: role not allowed to post announcements');
    }

    if (!isAnnouncementPlacement(placement)) {
      throw new Error('Unsupported placement');
    }

    if (!isAnnouncementKind(kind)) {
      throw new Error('Unsupported kind');
    }

    if (startsAt && endsAt && Date.parse(endsAt) <= Date.parse(startsAt)) {
      throw new Error('Unsupported schedule window: ends_at must be after starts_at');
    }

    const announcement = await createAnnouncement({
      organizationId,
      message,
      authorName,
      authorRole,
      placement,
      kind,
      startsAt,
      endsAt,
    });

    await writePilotAuditEvent({
      event_type: 'create',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: organizationId,
      entity_type: 'announcement',
      entity_id: announcement.announcement_id,
      details: {
        author_name: authorName,
        author_role: authorRole,
        placement,
        kind,
      },
    });

    return NextResponse.json({ ok: true, organization_id: organizationId, announcement });
  } catch (error) {
    return jsonError(error);
  }
}
