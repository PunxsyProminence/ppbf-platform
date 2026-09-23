import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";
import GlobalRoleHeader from "@/components/GlobalRoleHeader";
import PlateVariantGround from "@/components/PlateVariantGround";
import { ThemeProvider } from "@/components/ThemeProvider";

/* Golden-era pass: every face is now served from files in this repo — no
   Google Fonts fetch at build time or run time. That matches the design
   system's own doctrine (the gym floor renders with no network) and unbreaks
   builds on machines that cannot reach fonts.googleapis.com. Oswald here is
   the same variable file the design system ships; Roboto Condensed and Geist
   Mono are the Fontsource latin variable builds. Alfa Slab One, Special Elite
   and Caveat ride in through ppbf.css → fonts.css @font-face as before. */
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

export const metadata: Metadata = {
  title: {
    default: "PPBF Platform",
    template: "%s | PPBF Platform",
  },
  description: "Punxsy Prominence Boxing and Fitness ecosystem platform.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
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
            <GlobalRoleHeader />
            {children}
          </PlateVariantGround>
        </ThemeProvider>
      </body>
    </html>
  );
}
