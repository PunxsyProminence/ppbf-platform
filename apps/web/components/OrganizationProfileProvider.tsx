'use client';

import { createContext, useContext, type ReactNode } from 'react';

import type { OrganizationProfile } from '@/src/shared/organizationProfile';

/**
 * THE GYM'S PROFILE FOR BROWSER COMPONENTS (lane L31, #1469).
 *
 * The root layout reads the stored profile once per request
 * (organizationProfileStore.ts) and hands it down here, so a print sheet, the
 * interest form, the wall and the names board name the gym from the same row
 * the server pages read, with no copy of their own. null means the profile
 * could not be read; a component then leaves out the line that would name the
 * gym rather than invent one.
 */
const OrganizationProfileContext = createContext<OrganizationProfile | null>(null);

export function OrganizationProfileProvider({
  profile,
  children,
}: {
  readonly profile: OrganizationProfile | null;
  readonly children: ReactNode;
}) {
  return <OrganizationProfileContext.Provider value={profile}>{children}</OrganizationProfileContext.Provider>;
}

/** The gym's profile, or null when it could not be read. */
export function useOrganizationProfile(): OrganizationProfile | null {
  return useContext(OrganizationProfileContext);
}
