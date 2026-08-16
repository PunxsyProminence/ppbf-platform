import { NextResponse, type NextRequest } from 'next/server';

import { deriveCredentialBand, listStaffCredentialStatus } from '@/src/server/pilot/clearanceRegister';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { staffDisplayName } from '@/src/server/pilot/profileDb';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/pilot/staff-credentials -- credential STATUS, broadly visible.
 *
 * The product owner asked for this by name: "parents/athletes should be
 * able to see the staff are well-trained and certified." So unlike every
 * other route in this feature, this one is NOT role-restricted beyond
 * requiring a session -- matching /api/pilot/wall-of-names's own reasoning,
 * which is the existing broadly-visible precedent this route follows: every
 * role that can sign in may read it, and that is safe because of what the
 * payload IS rather than because of who is asking.
 *
 * What the payload is: a name, a role, and a band (current / expiring_soon
 * / expired / missing / submitted / revoked / not_required) per clearance
 * type. It never carries document_ref, verified_by_account_id or
 * verification_note -- listStaffCredentialStatus does not even select those
 * columns, so there is no field here to forget to drop.
 */
export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);

    const rows = await listStaffCredentialStatus(principal.organizationId);

    const byAccount = new Map<string, {
      account_id: string;
      display_name: string;
      role: string;
      credentials: Array<{ clearance_type_id: string; clearance_name: string; band: string; expires_on: string | null }>;
    }>();

    for (const row of rows) {
      let entry = byAccount.get(row.account_id);
      if (!entry) {
        entry = {
          account_id: row.account_id,
          display_name: staffDisplayName(row.login_email, row.account_id),
          role: row.role,
          credentials: [],
        };
        byAccount.set(row.account_id, entry);
      }
      entry.credentials.push({
        clearance_type_id: row.clearance_type_id,
        clearance_name: row.clearance_name,
        band: deriveCredentialBand(row.status, row.expires_on),
        // expires_on is shown for a currently-held credential only -- once
        // the disclosure is "this is expiring/expired", the date is what
        // makes that a useful fact rather than a bare label.
        expires_on: row.expires_on,
      });
    }

    return NextResponse.json({
      ok: true,
      staff: [...byAccount.values()],
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return jsonError(error);
  }
}
