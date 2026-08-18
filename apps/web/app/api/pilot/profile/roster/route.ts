import { NextResponse, type NextRequest } from 'next/server';

import { isOrganizationAdminRole, requireRole } from '@/src/server/pilot/access';
import { query } from '@/src/server/pilot/db';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { getAccountProfiles } from '@/src/server/pilot/profileDb';
import { initialsFor, normalizeCorner } from '@/src/server/pilot/profileIdentity';
import { decidePortrait, decideRingName, normalizePhotoReviewState } from '@/src/server/pilot/profileVisibility';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RosterRow {
  athlete_id: string;
  account_id: string | null;
  full_name: string;
  dob: string | null;
  coach_id: string;
}

/**
 * A coach's roster, with faces.
 *
 * The roster this replaces was a column of names. A coach who works with twenty
 * people recognises them by face long before they read a name, and a list of
 * strings makes the person on the tablet do a lookup the room already did for
 * them.
 *
 * TWO THINGS THIS ROUTE DELIBERATELY DOES NOT CARRY.
 *
 * Readiness, injury flags and attendance: the coach roster component already
 * documents that none of those has a backend feed and that fabricating them is
 * a safety bug, not a cosmetic one. This route does not invent them either.
 *
 * And no photograph of an athlete this coach is not the coach of. The
 * per-athlete decision runs for every row -- a coach browsing the organization
 * roster gets plates for the children who are not theirs, which is the same
 * answer the single-portrait route gives, produced by the same function.
 */
export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['coach', 'organization_admin', 'admin']);

    const url = new URL(request.url);
    // Default to the coach's own athletes. `scope=organization` is available to
    // an organization admin and to a coach who genuinely needs the whole list,
    // and it changes WHICH ROWS come back -- never what may be seen on one.
    const wholeOrganization = url.searchParams.get('scope') === 'organization';

    // `a.deleted_at is null` on both branches, and it is not a performance
    // filter. A withdrawn athlete is soft-deleted: the row stays for the
    // retention window so the purge can run against it later, which means
    // every read path has to exclude it or the withdrawal never reaches the
    // screen. Without this the roster kept a child who had left the gym --
    // name, date of birth and portrait -- in front of every coach for two
    // years after the family asked to be removed. The retention migration
    // indexes for exactly this predicate
    // (idx_athletes_active_org ... where deleted_at is null) because the
    // active-record path is meant to be every read.
    const rows = wholeOrganization
      ? await query<RosterRow>(
        `select a.athlete_id, acc.account_id, a.full_name, a.dob, a.coach_id
           from pilot.athletes a
           left join pilot.accounts acc
             on acc.organization_id = a.organization_id and acc.athlete_id = a.athlete_id
          where a.organization_id = $1
            and a.deleted_at is null
          order by a.full_name asc`,
        [principal.organizationId],
      )
      : await query<RosterRow>(
        `select a.athlete_id, acc.account_id, a.full_name, a.dob, a.coach_id
           from pilot.athletes a
           left join pilot.accounts acc
             on acc.organization_id = a.organization_id and acc.athlete_id = a.athlete_id
          where a.organization_id = $1 and a.coach_id = $2
            and a.deleted_at is null
          order by a.full_name asc`,
        [principal.organizationId, principal.accountId],
      );

    const accountIds = rows.map((row) => row.account_id).filter((id): id is string => Boolean(id));
    const profiles = await getAccountProfiles(principal.organizationId, accountIds);
    const now = new Date();

    const items = rows.map((row) => {
      const profile = row.account_id ? profiles.get(row.account_id) : undefined;
      // The relationship is known without a query here: this coach is the coach
      // of record for this athlete, or they are not. An admin viewing the
      // organization scope is 'organization_staff', which decidePortrait
      // refuses for a minor -- the plate, deliberately, for the person who runs
      // the gym as much as for anyone else.
      const relationship = row.coach_id === principal.accountId && principal.role === 'coach'
        ? 'coach_of_subject' as const
        : isOrganizationAdminRole(principal.role) || principal.role === 'coach'
          ? 'organization_staff' as const
          : 'none' as const;

      const subject = {
        accountId: row.account_id ?? row.athlete_id,
        isAthlete: true,
        dob: row.dob,
        hasPhoto: Boolean(profile?.photoBlobPath),
        photoReviewState: normalizePhotoReviewState(profile?.photoReviewState),
        nickname: profile?.nickname ?? null,
        nicknameClearedAt: profile?.nicknameClearedAt ?? null,
      };

      const portrait = decidePortrait(subject, relationship, now);

      return {
        athlete_id: row.athlete_id,
        account_id: row.account_id,
        full_name: row.full_name,
        initials: initialsFor(row.full_name),
        ring_name: decideRingName(subject, relationship, now),
        corner: normalizeCorner(profile?.corner),
        photo_available: portrait.show === 'photo' && Boolean(row.account_id),
        is_mine: row.coach_id === principal.accountId,
      };
    });

    return NextResponse.json({ ok: true, items }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return jsonError(error);
  }
}
