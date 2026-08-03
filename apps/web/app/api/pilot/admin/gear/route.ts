import { NextResponse, type NextRequest } from 'next/server';

import { isOrganizationAdminRole, requireRole } from '@/src/server/pilot/access';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import {
  gearMargin,
  gearValidationError,
  listGearForOrganization,
  upsertGearProduct,
  type GearProductInput,
} from '@/src/server/pilot/gearCatalog';

export const runtime = 'nodejs';

/**
 * The gym's own view of its equipment catalogue: what it paid, what it charges,
 * and what is on public sale.
 *
 * ORGANIZATION ADMIN ONLY, gym from the session. The wholesale cost is the
 * gym's negotiated position with a supplier -- not the platform owner's to
 * read across gyms, and not a coach's either. The same boundary the PIN
 * directory and the roster import hold, for a different reason: this one is
 * commercial confidence rather than a child's credentials.
 *
 * The board's Treasurer reads margin through the board summary, which is
 * organization-level aggregate and carries no athlete data -- not through this
 * route.
 */

function toCents(value: unknown): number {
  // Accepts cents as an integer, because a form that sends "12.99" and a server
  // that multiplies by 100 is how a catalogue acquires off-by-one-cent prices
  // (12.99 * 100 is 1298.9999999999998). The client does the conversion once,
  // deliberately, and sends whole cents.
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    return NaN;
  }
  return value;
}

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['organization_admin']);
    if (!isOrganizationAdminRole(principal.role)) {
      throw new Error('Forbidden: role not allowed');
    }

    const products = await listGearForOrganization(principal.organizationId);

    return NextResponse.json({
      ok: true,
      organization_id: principal.organizationId,
      items: products.map((product) => ({ ...product, ...gearMargin(product) })),
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

    const input: GearProductInput = {
      product_id: String(body.product_id ?? '').trim(),
      name: String(body.name ?? '').trim(),
      description: String(body.description ?? '').trim(),
      category: String(body.category ?? '').trim(),
      wholesale_cost_cents: toCents(body.wholesale_cost_cents),
      retail_price_cents: toCents(body.retail_price_cents),
      listed_publicly: body.listed_publicly === true,
      availability: String(body.availability ?? 'in_stock').trim(),
      checkout_url: String(body.checkout_url ?? '').trim(),
    };

    const invalid = gearValidationError(input);
    if (invalid) {
      throw new Error(invalid);
    }

    await upsertGearProduct(principal.organizationId, input);

    // Listing a product publicly is the consequential act here -- it is the
    // moment a price becomes visible outside the gym -- so the audit records
    // that flag explicitly rather than only that a row changed. The cost is
    // NOT written into the audit detail: audit events are read on screens with
    // wider audiences than this route has.
    await writePilotAuditEvent({
      event_type: 'update',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: principal.organizationId,
      entity_type: 'gear_product',
      entity_id: input.product_id,
      details: {
        action: 'gear_product_saved',
        listed_publicly: input.listed_publicly,
        availability: input.availability,
        has_checkout_link: input.checkout_url !== '',
      },
    });

    return NextResponse.json({ ok: true, product_id: input.product_id });
  } catch (error) {
    return jsonError(error);
  }
}
