import type { MetadataRoute } from "next";

/* The public homepage is the only page meant for search engines. /names,
   /print and /wall carry their own noindex in their metadata; every other
   route sits behind sign-in. */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: "/" },
    sitemap: "https://punxsyprominence.org/sitemap.xml",
  };
}
