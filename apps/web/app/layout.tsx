import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";
import GlobalRoleHeader from "@/components/GlobalRoleHeader";
import PlateVariantGround from "@/components/PlateVariantGround";
import { ThemeProvider } from "@/components/ThemeProvider";
import { OrganizationProfileProvider } from "@/components/OrganizationProfileProvider";
import {
  getOperatingOrganizationProfile,
  getOperatingOrganizationProfileOrNull,
  OrganizationProfileUnavailableError,
} from "@/src/server/pilot/organizationProfileStore";

/* Golden-era pass: every face is now served from files in this repo — no
   Google Fonts fetch at build time or run time. That matches the design
   system's own doctrine (the gym floor renders with no network) and unbreaks
   builds on machines that cannot reach fonts.googleapis.com. Oswald here is
   the same variable file the design system ships; Roboto Condensed and Geist
   Mono are the Fontsource latin variable builds. Alfa Slab One, Special Elite
   and Caveat ride in through the ppbf.css import chain to legacy/legacy-fonts.css @font-face. */
const tacticalDisplay = localFont({
  src: "./fonts/oswald-var.woff2",
  variable: "--font-tactical-display",
  weight: "400 700",
});

const tacticalBody = localFont({
  src: "./fonts/roboto-condensed-var.woff2",
  variable: "--font-tactical-body",
  weight: "100 900",
});

const geistMono = localFont({
  src: "./fonts/geist-mono-var.woff2",
  variable: "--font-geist-mono",
  weight: "100 900",
});

/* metadataBase: without it Next resolves og:image and twitter:image against
   localhost:3000, which is what production served until now. www is the
   public homepage (Jason, 2026-10-03: "Www.punxsyprominence.org is the public
   page that will be the home page"). The address, the short name in the title
   and the legal name all come from the gym's stored profile (lane L31,
   #1469); the website is a required https origin there, so `new URL` holds. */
/* RENDERED PER REQUEST. The metadata reads the stored profile, and the image
   build has no database to read it from, so nothing under this layout is
   prerendered at build time. The read is cached in-process for 60 seconds
   (organizationProfileStore.ts). */
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  let gym;
  try {
    gym = await getOperatingOrganizationProfile();
  } catch (error) {
    // Every page sits under this layout, sign-in included. If the profile
    // cannot be read (production, no row, no database, nothing cached), the
    // pages that state the gym's facts refuse on their own; the rest keep
    // working under a plain title that carries none of them. (Line comments:
    // fontTokenScope.test.ts strips block comments with a pattern that a
    // block comment opening a brace-delimited block would carry too far.)
    if (error instanceof OrganizationProfileUnavailableError) {
      return { title: { default: "Platform", template: "%s" } };
    }
    throw error;
  }
  return {
    // Validated on save (organizationProfileWrite.ts); if a stored value still cannot be
    // parsed, the pages go on without a metadata base rather than fail.
    ...(URL.canParse(gym.url) ? { metadataBase: new URL(gym.url) } : {}),
    title: {
      default: `${gym.shortName} Platform`,
      template: `%s | ${gym.shortName} Platform`,
    },
    description: `${gym.legalName} ecosystem platform.`,
  };
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // The gym's profile for every browser component under this layout (print
  // sheets, the interest form, the wall, the names board, photo captions).
  const gym = await getOperatingOrganizationProfileOrNull();
  return (
    /* THE FONT VARIABLES BELONG ON <html>, NOT ON <body>, AND THE DIFFERENCE
       WAS NOT COSMETIC. globals.css declares --font-stencil, --font-body,
       --font-mono, --font-ui and --font-data on `:root` -- which IS this
       element -- in terms of these three. While they were set one element
       lower, all five resolved to the guaranteed-invalid value, and every rule
       written as a `font:` shorthand naming one of them threw away its SIZE,
       WEIGHT and LINE-HEIGHT along with the family: .t-eyebrow asked for 11px,
       .t-label 11px, .t-data 13px, .badge 11px, .stat-val 39.3px, and all of
       them rendered at the body's 15px instead. Measured on the coach
       workspace before this change, 68 of 139 text elements sat at exactly
       15px and a panel heading rendered one pixel larger than its own
       paragraph, which is why the type had no hierarchy and the gym's own
       faces never reached the screen. */
    <html
      lang="en"
      className={`${tacticalDisplay.variable} ${tacticalBody.variable} ${geistMono.variable}`}
    >
      <body className="antialiased">
        <ThemeProvider>
          {/* The route-derived plate variant is marked here and nowhere else.
              78 surfaces paint a room class of their own and 73 of those are
              server components that cannot know their own route, so the
              attribute goes on one client ancestor of all of them rather than
              on 78 elements. It generates no box (display: contents), so this
              is a hook over the building, not a container around it -- see the
              component, and the PLATES section of design-system/ppbf.css for
              the cascade half. */}
          <PlateVariantGround>
            <OrganizationProfileProvider profile={gym}>
              <GlobalRoleHeader />
              {children}
            </OrganizationProfileProvider>
          </PlateVariantGround>
        </ThemeProvider>
      </body>
    </html>
  );
}
