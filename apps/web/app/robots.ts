import type { MetadataRoute } from "next";

import { getOperatingOrganizationProfile } from "@/src/server/pilot/organizationProfileStore";

/* Crawlers may request any path (the brief: allow /). The sitemap lists only
   the public homepage; /names, /print and /wall carry their own noindex, and
   the app routes sit behind sign-in, so a crawler gets the login page. */
/* Per request: it reads the stored profile, which the image build cannot. */
export const dynamic = "force-dynamic";

export default async function robots(): Promise<MetadataRoute.Robots> {
  const gym = await getOperatingOrganizationProfile();
  return {
    rules: { userAgent: "*", allow: "/" },
    sitemap: `${gym.url}/sitemap.xml`,
  };
}
