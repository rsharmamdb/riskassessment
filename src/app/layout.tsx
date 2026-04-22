import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";
import CommandPalette from "@/components/CommandPalette";
import AppNav from "@/components/AppNav";
import BrandLogo from "@/components/BrandLogo";
import { BRAND_NAME, BRAND_TAGLINE } from "@/lib/brand";

export const metadata: Metadata = {
  title: BRAND_NAME,
  description:
    "Analyze support cases and account signals to surface risk patterns, summarize impact, and prepare review-ready internal recommendations.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-ink-950 text-ink-100 antialiased font-sans">
        <header className="sticky top-0 z-10 border-b border-ink-700 bg-[#0D1424]">
          <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-5">
            <Link href="/" className="flex items-center gap-2.5 group">
              <BrandLogo className="h-9 w-9 flex-shrink-0 overflow-hidden rounded-full" />
              <div>
                <div className="text-[14px] font-semibold leading-tight text-ink-100 transition-colors group-hover:text-accent-400">
                  {BRAND_NAME}
                </div>
                <div className="text-[11px] leading-tight text-ink-400">
                  {BRAND_TAGLINE}
                </div>
              </div>
            </Link>
            <AppNav />
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-5 py-6">{children}</main>
        <CommandPalette />
      </body>
    </html>
  );
}
