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
    <html lang="en">
      <body
        className={`${tacticalDisplay.variable} ${tacticalBody.variable} ${geistMono.variable} antialiased`}
      >
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
