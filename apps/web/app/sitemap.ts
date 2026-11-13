import type { MetadataRoute } from "next";

import { getOperatingOrganizationProfile } from "@/src/server/pilot/organizationProfileStore";

/* The public front page, its privacy notice and the donation refund policy.
   App routes are behind sign-in and are not listed. */
/* Per request: it reads the stored profile, which the image build cannot. */
export const dynamic = "force-dynamic";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const gym = await getOperatingOrganizationProfile();
  return [{ url: `${gym.url}/` }, { url: `${gym.url}/privacy` }, { url: `${gym.url}/refund-policy` }];
}
