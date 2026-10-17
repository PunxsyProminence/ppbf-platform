/**
 * THE GYM'S PROFILE, READ FROM ITS ONE STORE (lane L31, issue #1469).
 *
 * pilot.organization_profiles holds the display names, contact details,
 * addresses and head coach; pilot.organizations.organization_name holds the
 * incorporated name, the gym's name of record. Every screen that names the
 * gym reads them through here, so a change the organization admin saves is
 * what every page shows.
 *
 * WHICH GYM. The public surfaces (homepage, privacy page, site metadata,
 * robots, sitemap) have no signed-in person to resolve a gym from. They name
 * the operating organization, punxsy_prominence (OD-2026-09-28-007), and it
 * is named here once (Overwatch GO 2026-10-16, Q5: "named explicitly in one
 * place, not getPilotDefaultOrganizationId()").
 *
 * WHEN THERE IS NO ROW.
 * - Production (NODE_ENV=production): the read fails with
 *   OrganizationProfileUnavailableError. There is no code copy of the gym's
 *   facts to fall back to; a second copy is what this store replaces.
 * - Anywhere else (local dev, the e2e dev server with no database, the
 *   offline runtime whose only gym is ppbf-offline-demo, jest): the labelled
 *   DEVELOPMENT_PROFILE below, an example gym at example.org. It is not the
 *   gym's facts, so it cannot drift from them, and production never reaches it.
 *
 * CACHE. The last row read is kept for 60 seconds, and kept past that if a
 * later read fails, so a database blip does not take the public pages down.
 * It is the same source, held briefly, not a second one.
 */

import { queryOne } from '@/src/server/pilot/db';
import type { OrganizationProfile } from '@/src/shared/organizationProfile';

export const OPERATING_ORGANIZATION_ID = 'punxsy_prominence';

const CACHE_MS = 60_000;

export class OrganizationProfileUnavailableError extends Error {
  constructor(organizationId: string, cause?: unknown) {
    super(`ORGANIZATION_PROFILE_UNAVAILABLE: no profile could be read for organization ${organizationId}`);
    this.name = 'OrganizationProfileUnavailableError';
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

/** Outside production only, when there is no row or no database. Not the gym's facts. */
export const DEVELOPMENT_PROFILE: OrganizationProfile = Object.freeze({
  brand: 'Example Gym & Fitness (development profile)',
  legalName: 'Example Gym and Fitness',
  shortName: 'EXGYM',
  commonName: 'Example Gym',
  ein: '00-0000000',
  url: 'https://www.example.org',
  domain: 'example.org',
  email: 'office@example.org',
  donationsEmail: 'donate@example.org',
  grantsEmail: 'grants@example.org',
  established: '2000',
  town: 'Exampletown',
  serviceArea: 'Exampletown and the surrounding area',
  serviceAreaShort: 'Exampletown and the surrounding area',
  physical: { street: '1 Example St', city: 'Exampletown', region: 'PA', postalCode: '00000' },
  mailing: 'PO Box 1, Exampletown, PA 00000',
  headCoachName: 'Example Coach',
}) as OrganizationProfile;

interface ProfileRow {
  organization_name: string;
  brand: string;
  short_name: string;
  common_name: string;
  website_url: string;
  domain: string;
  ein: string;
  contact_email: string;
  donations_email: string;
  grants_email: string;
  established: string;
  town: string;
  service_area: string;
  service_area_short: string;
  physical_street: string;
  physical_city: string;
  physical_region: string;
  physical_postal_code: string;
  mailing_address: string;
  head_coach_name: string;
}

function toProfile(row: ProfileRow): OrganizationProfile {
  return {
    brand: row.brand,
    legalName: row.organization_name,
    shortName: row.short_name,
    commonName: row.common_name,
    ein: row.ein,
    url: row.website_url,
    domain: row.domain,
    email: row.contact_email,
    donationsEmail: row.donations_email,
    grantsEmail: row.grants_email,
    established: row.established,
    town: row.town,
    serviceArea: row.service_area,
    serviceAreaShort: row.service_area_short,
    physical: {
      street: row.physical_street,
      city: row.physical_city,
      region: row.physical_region,
      postalCode: row.physical_postal_code,
    },
    mailing: row.mailing_address,
    headCoachName: row.head_coach_name,
  };
}

const cache = new Map<string, { profile: OrganizationProfile; readAt: number }>();

/** Test seam: forget every cached row. */
export function clearOrganizationProfileCache(): void {
  cache.clear();
}

async function readRow(organizationId: string): Promise<OrganizationProfile | null> {
  const row = await queryOne<ProfileRow>(
    `select o.organization_name,
            p.brand, p.short_name, p.common_name, p.website_url, p.domain, p.ein,
            p.contact_email, p.donations_email, p.grants_email, p.established, p.town,
            p.service_area, p.service_area_short,
            p.physical_street, p.physical_city, p.physical_region, p.physical_postal_code,
            p.mailing_address, p.head_coach_name
       from pilot.organization_profiles p
       join pilot.organizations o on o.organization_id = p.organization_id
      where p.organization_id = $1`,
    [organizationId],
  );
  return row ? toProfile(row) : null;
}

export async function getOrganizationProfile(
  organizationId: string,
  options: { now?: () => number; production?: boolean } = {},
): Promise<OrganizationProfile> {
  const now = options.now ?? Date.now;
  const production = options.production ?? process.env.NODE_ENV === 'production';
  const cached = cache.get(organizationId);
  if (cached && now() - cached.readAt < CACHE_MS) return cached.profile;

  let profile: OrganizationProfile | null;
  try {
    profile = await readRow(organizationId);
  } catch (error) {
    // The last good row outlives a failed read; it is the same source, not a fallback copy.
    if (cached) return cached.profile;
    if (!production) return DEVELOPMENT_PROFILE;
    throw new OrganizationProfileUnavailableError(organizationId, error);
  }
  if (!profile) {
    if (!production) return DEVELOPMENT_PROFILE;
    throw new OrganizationProfileUnavailableError(organizationId);
  }
  cache.set(organizationId, { profile, readAt: now() });
  return profile;
}

/** The operating gym's profile, for the surfaces no signed-in person resolves (OD-2026-09-28-007). */
export function getOperatingOrganizationProfile(): Promise<OrganizationProfile> {
  return getOrganizationProfile(OPERATING_ORGANIZATION_ID);
}
