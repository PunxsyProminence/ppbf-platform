import { NextResponse, type NextRequest } from 'next/server';

import { isOrganizationAdminRole, requireRole } from '@/src/server/pilot/access';
import { query } from '@/src/server/pilot/db';
import { jsonError, requireMicrosoftAuthenticatedPrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

interface AthletePinDirectoryRow {
  athlete_id: string;
  full_name: string;
  dob: string;
  account_id: string | null;
  account_active: boolean | null;
  has_pin: boolean;
  account_updated_at: string | null;
}

export async function GET(request: NextRequest) {
  try {
    const principal = await requireMicrosoftAuthenticatedPrincipal(request);
    // Athlete credentials sit outside the platform-owner tier, the same
    // boundary session revocation and PIN reset hold: Omega gathers data and
    // supports organization admins rather than holding the keys to a child's
    // account. This route returns every athlete's name in the organization,
    // which is precisely what access.ts refuses that role everywhere else.
    requireRole(principal, ['organization_admin']);
    if (!isOrganizationAdminRole(principal.role)) {
      throw new Error('Forbidden: role not allowed');
    }

    const rows = await query<AthletePinDirectoryRow>(
      `select
         ath.athlete_id,
         ath.full_name,
         -- Carried so the add-athlete form can warn that a child with this
         -- name and this date of birth is already on the roster. Name alone
         -- is not enough to act on -- two Alex Johnsons in one gym is
         -- ordinary -- and the duplicate that actually hurts is the same
         -- child entered twice under two ids, whose sessions and goals then
         -- can never be added together. Same role, same organization, and
         -- the same audience that already receives every child's name here.
         ath.dob::text as dob,
         acc.account_id,
         acc.active_flag as account_active,
         (acc.pin_hash is not null) as has_pin,
         acc.updated_at::text as account_updated_at
       from pilot.athletes ath
       left join pilot.accounts acc
         on acc.organization_id = ath.organization_id
        and acc.athlete_id = ath.athlete_id
        and acc.role = 'athlete'
       where ath.organization_id = $1
       order by ath.full_name asc`,
      [principal.organizationId],
    );

    return NextResponse.json({
      ok: true,
      items: rows,
    });
  } catch (error) {
    return jsonError(error);
  }
}
