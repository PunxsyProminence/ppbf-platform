import type { MetadataRoute } from "next";

/* The public front page and its privacy notice. App routes are behind sign-in
   and are not listed. */
export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: "https://www.punxsyprominence.org/" },
    { url: "https://www.punxsyprominence.org/privacy" },
  ];
}
