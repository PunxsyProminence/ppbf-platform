/**
 * THE GYM'S PUBLIC IDENTITY, STATED ONCE (issue #1469, N9-01).
 *
 * Every surface that names the gym -- the public homepage, print sheets, the
 * public interest form, and (N9-01B) the wall, the names board, the sign-in
 * email and SHADOW's prompt -- reads it from here instead of carrying its own
 * copy. Jason, A-Q22 (OD-2026-10-08-006): a second gym is planned for, "but
 * the build stays one-gym" (ruling 8); the overwatch reading names exactly
 * this: stop hard-coding PPBF's name and address.
 *
 * ONE GYM TODAY. There is one profile, and every caller gets it. Nothing here
 * onboards, switches or provisions an organization (N9-01-Q1 A). When a
 * second gym is real, this becomes a read keyed by organization; the callers
 * already ask through currentOrganizationProfile(), so they do not change.
 *
 * The facts are PPBF's registry facts, moved here from app/page.tsx as they
 * were. Sources: legal name and EIN -- PA Articles of Incorporation (file
 * 0013779917, 3/22/2024), IRS CP 575 E and Letter 947 (04/11/2024);
 * addresses -- Jason, 2026-10-03 ("220 N Jefferson is the physical address",
 * "the PO box is the office mailing address"). The private office address is
 * deliberately not published, here or in comments.
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
}

const PPBF: OrganizationProfile = {
  brand: 'Punxsy Prominence Boxing & Fitness',
  legalName: 'Punxsy Prominence Boxing and Fitness',
  shortName: 'PPBF',
  commonName: 'Punxsy Prominence',
  ein: '99-2073622',
  url: 'https://www.punxsyprominence.org',
  domain: 'punxsyprominence.org',
  email: 'admin@punxsyprominence.org',
  donationsEmail: 'treasurer@punxsyprominence.org',
  grantsEmail: 'grants@punxsyprominence.org',
  established: '2024',
  town: 'Punxsutawney',
  serviceArea: 'Punxsutawney and surrounding rural western Pennsylvania communities',
  serviceAreaShort: 'Punxsutawney and surrounding rural Pennsylvania communities',
  physical: {
    street: '220 N Jefferson St',
    city: 'Punxsutawney',
    region: 'PA',
    postalCode: '15767',
  },
  mailing: 'PO Box 54, Big Run, PA 15715',
};

/** The current gym's profile. One gym today (A-Q22 ruling 8). */
export function currentOrganizationProfile(): OrganizationProfile {
  return PPBF;
}

/** "220 N Jefferson St, Punxsutawney, PA 15767" */
export function physicalAddressLine(profile: OrganizationProfile): string {
  return `${profile.physical.street}, ${profile.physical.city}, ${profile.physical.region} ${profile.physical.postalCode}`;
}
