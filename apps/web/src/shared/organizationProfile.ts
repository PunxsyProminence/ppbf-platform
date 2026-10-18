/**
 * THE SHAPE OF THE GYM'S PROFILE (issue #1469; lane L31).
 *
 * The profile itself is stored once, in pilot.organization_profiles (with the
 * legal name from pilot.organizations.organization_name), and read by
 * src/server/pilot/organizationProfileStore.ts. Server pages read it there;
 * browser components get it from the root layout through
 * components/OrganizationProfileProvider.tsx. No copy of any gym's facts
 * lives in code.
 *
 * PPBF's row was seeded by the organization-profiles migration from the
 * constant that used to live here, whose sources were: legal name and EIN --
 * PA Articles of Incorporation (file 0013779917, 3/22/2024), IRS CP 575 E and
 * Letter 947 (04/11/2024); addresses -- Jason, 2026-10-03. The private office
 * address is deliberately not published.
 */
export interface OrganizationProfile {
  /** The public name, as the gym writes it ("&"). */
  brand: string;
  /** The incorporated name ("and"). */
  legalName: string;
  /** The short name the gym uses on its own screens. */
  shortName: string;
  /** The name as its copy says it in running text ("Punxsy Prominence uses..."). */
  commonName: string;
  ein: string;
  url: string;
  domain: string;
  email: string;
  donationsEmail: string;
  grantsEmail: string;
  established: string;
  /** The town the gym is in, as its copy names it. */
  town: string;
  /** The communities it serves, as its copy names them. */
  serviceArea: string;
  /** The same, in the shorter form the structured data and facts list use. */
  serviceAreaShort: string;
  physical: {
    street: string;
    city: string;
    region: string;
    postalCode: string;
  };
  mailing: string;
  /** The head coach, as the homepage and its staff card name them. */
  headCoachName: string;
}

/** "<street>, <city>, <region> <postal code>" */
export function physicalAddressLine(profile: OrganizationProfile): string {
  // Only the parts the profile gives: a street with no city prints as the street, not "9 Kiln Road, ,  ".
  const regionLine = [profile.physical.region, profile.physical.postalCode].filter(Boolean).join(' ');
  return [profile.physical.street, profile.physical.city, regionLine].filter(Boolean).join(', ');
}
