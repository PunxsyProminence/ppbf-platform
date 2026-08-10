import { NextResponse, type NextRequest } from 'next/server';

import { isOrganizationAdminRole, requireRole } from '@/src/server/pilot/access';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import {
  countProductsByVendor,
  credentialFieldError,
  gearVendorValidationError,
  listVendorsForOrganization,
  upsertGearVendor,
  type GearVendorInput,
} from '@/src/server/pilot/gearVendors';

export const runtime = 'nodejs';

/**
 * The gym's supplier accounts: who it buys from, on what account, on what
 * terms, and who to call.
 *
 * ORGANIZATION ADMIN ONLY, gym from the session. Same boundary and same reason
 * as the wholesale cost next door in /api/pilot/admin/gear: an account number
 * and a negotiated discount tier are the gym's commercial position, not the
 * platform owner's to read across gyms and not a coach's either. The
 * organization is taken from the principal and never from the request, so a
 * caller cannot name someone else's gym.
 *
 * NOTHING HERE IS PUBLIC. There is no counterpart under /api/public. The brand
 * a shopper sees is gear_products.brand, which the public store already
 * selects; it is a different column with a different audience, and this route
 * is not the place it comes from.
 *
 * NO PASSWORDS. A body offering one is refused with an explanation rather than
 * having the field quietly dropped -- an admin told "Saved" would reasonably
 * believe the platform is holding it and stop keeping it anywhere else.
 */

function toNetTermsDays(value: unknown): number | null {
  // Null and empty both mean "not recorded", which is a different fact from
  // "due on receipt" and must not be flattened to 0. Anything else that is not
  // a finite number becomes NaN and is refused by validation with a message
  // that says so, rather than being silently coerced.
  if (value === null || value === undefined || value === '') {
    return null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  return NaN;
}

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['organization_admin']);
    if (!isOrganizationAdminRole(principal.role)) {
      throw new Error('Forbidden: role not allowed');
    }

    const [vendors, counts] = await Promise.all([
      listVendorsForOrganization(principal.organizationId),
      countProductsByVendor(principal.organizationId),
    ]);

    const productCounts = new Map(counts.map((row) => [row.vendor_id, row.product_count]));

    return NextResponse.json({
      ok: true,
      organization_id: principal.organizationId,
      vendors: vendors.map((vendor) => ({
        ...vendor,
        product_count: productCounts.get(vendor.vendor_id) ?? 0,
      })),
    });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['organization_admin']);
    if (!isOrganizationAdminRole(principal.role)) {
      throw new Error('Forbidden: role not allowed');
    }

    const body = (await request.json()) as Record<string, unknown>;

    // Before anything is read out of the body, so a password is refused rather
    // than dropped on the floor by a parse that has no field for it.
    const credential = credentialFieldError(body);
    if (credential) {
      throw new Error(credential);
    }

    const input: GearVendorInput = {
      vendor_id: String(body.vendor_id ?? '').trim(),
      vendor_name: String(body.vendor_name ?? '').trim(),
      account_number: String(body.account_number ?? '').trim(),
      discount_tier: String(body.discount_tier ?? '').trim(),
      net_terms_days: toNetTermsDays(body.net_terms_days),
      portal_url: String(body.portal_url ?? '').trim(),
      rep_name: String(body.rep_name ?? '').trim(),
      rep_email: String(body.rep_email ?? '').trim(),
      rep_phone: String(body.rep_phone ?? '').trim(),
      notes: String(body.notes ?? '').trim(),
      // Explicit !== false rather than === true: a vendor is active unless the
      // form says otherwise, and a body that omits the field should not
      // silently retire a supplier.
      active: body.active !== false,
    };

    const invalid = gearVendorValidationError(input);
    if (invalid) {
      throw new Error(invalid);
    }

    await upsertGearVendor(principal.organizationId, input);

    // The account number, the discount tier, the terms and the rep's contact
    // details are NOT written into the audit detail. Audit events are read on
    // screens with wider audiences than this route has, and the whole point of
    // this table is that those four facts stay inside it. What is recorded is
    // that the record changed, which supplier it was, and whether the gym is
    // still buying from them.
    await writePilotAuditEvent({
      event_type: 'update',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: principal.organizationId,
      entity_type: 'gear_vendor',
      entity_id: input.vendor_id,
      details: {
        action: 'gear_vendor_saved',
        active: input.active,
        has_account_number: input.account_number !== '',
        has_portal_link: input.portal_url !== '',
        has_rep_contact: input.rep_name !== '' || input.rep_email !== '' || input.rep_phone !== '',
      },
    });

    return NextResponse.json({ ok: true, vendor_id: input.vendor_id });
  } catch (error) {
    return jsonError(error);
  }
}
