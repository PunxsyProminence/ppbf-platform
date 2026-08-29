import { createHash } from 'node:crypto';

import { NextResponse, type NextRequest } from 'next/server';

import { deriveCredentialBand, listStaffCredentialStatus } from '@/src/server/pilot/clearanceRegister';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { staffDisplayName } from '@/src/server/pilot/profileDb';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * A stable, non-identifying row key for one staff member.
 *
 * This follows wallDisplay.ts's wallKey() -- sha256 over
 * `${organizationId}:${id}`, hex, first 12 characters -- rather than
 * researchBridgeExport.ts's opaqueId(), because this is the same job wallKey
 * does: a key for React and for de-duplication on a payload that every
 * signed-in role may read. opaqueId() prefixes its digest and keeps 32
 * characters because it labels rows in an export that leaves the platform,
 * where a longer self-describing token earns its length; a table row on one
 * page does not.
 *
 * Stable by construction: the same (organization, account) always hashes to
 * the same value, across requests and across processes, so a client may use
 * it as a React key or to correlate rows between two reads. One-way: the
 * account id -- and therefore, per the note on GET below, the login email --
 * does not come back out of it.
 */
function staffKey(organizationId: string, accountId: string): string {
  return createHash('sha256').update(`${organizationId}:${accountId}`).digest('hex').slice(0, 12);
}

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
 * type, under an opaque per-person key. It never carries document_ref,
 * verified_by_account_id or verification_note -- listStaffCredentialStatus
 * does not select those columns.
 *
 * It DOES select account_id, and that field is not free to emit. This
 * platform's provisioning makes an account_id the staff member's work email:
 * createOrUpdateMicrosoftStaffAccount falls back to the normalised login
 * email when no account id hint is supplied
 * (`existing?.account_id || params.accountIdHint?.trim() || loginEmail`), and
 * the admin console's invite form (app/admin/people/page.tsx) sends no
 * account_id at all, so every coach, staff member, volunteer and admin
 * invited through it carries an address as an account_id. Emitting it here
 * would hand an athlete on a PIN login every staff member's work email paired
 * with their background-check status. So the payload carries staffKey() above
 * instead. display_name already reduces the address to a title-cased local
 * part (staffDisplayName in profileDb.ts) precisely so the address is not the
 * display value; keeping the raw id out of the next field along is the same
 * decision, applied where it was missed.
 */
export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);

    const rows = await listStaffCredentialStatus(principal.organizationId);

    const byAccount = new Map<string, {
      staff_key: string;
      display_name: string;
      role: string;
      credentials: Array<{ clearance_type_id: string; clearance_name: string; band: string; expires_on: string | null }>;
    }>();

    for (const row of rows) {
      let entry = byAccount.get(row.account_id);
      if (!entry) {
        entry = {
          staff_key: staffKey(principal.organizationId, row.account_id),
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
