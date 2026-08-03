import { NextResponse, type NextRequest } from 'next/server';

import { jsonError } from '@/src/server/pilot/http';
import { listPublicGear, listPublicStores } from '@/src/server/pilot/gearCatalog';

export const runtime = 'nodejs';

/**
 * The public gear store. No session, no principal, no cookie.
 *
 * This is the only route in the platform that answers an anonymous caller with
 * organization data, so it is written to be boring on purpose:
 *
 *   - It reads. There is no POST here and there never should be. #111 removed
 *     a route that let an anonymous request run DDL, and the rate limiter was
 *     still creating a table from the unauthenticated login path last night.
 *     An anonymous endpoint on this platform gets exactly one verb.
 *
 *   - It selects PUBLIC_FIELDS only, in gearCatalog.ts. The wholesale cost is
 *     never fetched, so there is nothing here to accidentally serialise. The
 *     gym's supplier terms are not the public's to see.
 *
 *   - It names the gym. There is no default organization and no "the" store:
 *     every gym has its own catalogue, its own suppliers and its own prices.
 *     Without ?organization_id it returns the index of gyms that have a store,
 *     which is what makes this multi-store rather than one store wearing a
 *     gym's name.
 *
 * It deliberately holds NO athlete data of any kind. There is no join here to
 * anything about a child, and there must never be one -- this is the single
 * surface on the platform that answers without asking who is calling.
 */
export async function GET(request: NextRequest) {
  try {
    const organizationId = request.nextUrl.searchParams.get('organization_id')?.trim() || '';

    if (!organizationId) {
      const stores = await listPublicStores();
      const publicStores = stores.map((store) => ({
        organization_id: store.organization_id,
        organization_name: store.organization_name,
        listed_product_count: store.listed_product_count,
      }));
      return NextResponse.json({ ok: true, stores: publicStores });
    }

    const products = await listPublicGear(organizationId);

    // A gym with no listed products and a gym that does not exist answer
    // identically, on purpose. Distinguishing them would turn this into a
    // probe for which organization ids are real, to a caller who has not
    // identified themselves.
    const publicProducts = products.map((product) => ({
      product_id: product.product_id,
      name: product.name,
      description: product.description,
      category: product.category,
      retail_price_cents: product.retail_price_cents,
      availability: product.availability,
      checkout_url: product.checkout_url,
    }));
    return NextResponse.json({ ok: true, organization_id: organizationId, products: publicProducts });
  } catch (error) {
    return jsonError(error);
  }
}
