import type { Metadata } from "next";
import { Oswald, Roboto_Condensed, Geist_Mono } from "next/font/google";
import "./globals.css";
import GlobalRoleHeader from "@/components/GlobalRoleHeader";
import { ThemeProvider } from "@/components/ThemeProvider";

const tacticalDisplay = Oswald({
  variable: "--font-tactical-display",
  subsets: ["latin"],
  weight: ["400", "500", "700"],
});

const tacticalBody = Roboto_Condensed({
  variable: "--font-tactical-body",
  subsets: ["latin"],
  weight: ["400", "700"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
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
    <html
      lang="en"
      className={`${tacticalDisplay.variable} ${tacticalBody.variable} ${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <body className="min-h-full flex flex-col">
        <ThemeProvider>
          <GlobalRoleHeader />
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}
