import type { MetadataRoute } from "next";

/* The public homepage only. App routes are behind sign-in and are not listed. */
export default function sitemap(): MetadataRoute.Sitemap {
  return [{ url: "https://punxsyprominence.org/" }];
}
