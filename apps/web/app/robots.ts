import type { MetadataRoute } from "next";

/* Crawlers may request any path (the brief: allow /). The sitemap lists only
   the public homepage; /names, /print and /wall carry their own noindex, and
   the app routes sit behind sign-in, so a crawler gets the login page. */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: "/" },
    sitemap: "https://www.punxsyprominence.org/sitemap.xml",
  };
}
