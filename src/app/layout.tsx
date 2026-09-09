/**
 * Root layout — the HTML shell wrapped around every page.
 *
 * ─── How Next.js App Router routing works ────────────────────────────────
 *
 * Routes come from the folder structure under `src/app`, not from a router
 * configuration file:
 *
 *   src/app/page.tsx               →  /
 *   src/app/anomalies/page.tsx     →  /anomalies
 *   src/app/stations/[id]/page.tsx →  /stations/AWS-007   ([id] is a parameter)
 *   src/app/api/radar/route.ts     →  /api/radar          (a server endpoint)
 *
 * `layout.tsx` wraps every page beneath it and does NOT re-render when the
 * route changes, which is why the sidebar keeps its scroll position as you
 * navigate.
 *
 * This file is a Server Component — note the absence of `'use client'` at the
 * top. It runs only on the server, ships no JavaScript to the browser, and
 * therefore cannot use hooks or event handlers. Files that need `useState`,
 * `useEffect` or an `onClick` opt in with `'use client'` at the top, as
 * `AppShell` does.
 */
import type { Metadata, Viewport } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import './globals.css';
import { AppShell } from '@/components/layout/AppShell';

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
});

const mono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-mono-face',
  display: 'swap',
});

export const metadata: Metadata = {
  title: {
    default: 'SkyGuard — AWS Network Operations',
    template: '%s · SkyGuard',
  },
  description:
    'Intelligent operations and data-quality platform for automatic weather station networks. Detects abnormal readings, decides whether they are real weather or hardware faults, estimates corrected values, and recommends maintenance.',
  applicationName: 'SkyGuard',
};

export const viewport: Viewport = {
  themeColor: '#0a0e13',
  colorScheme: 'dark',
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${inter.variable} ${mono.variable}`}>
      <body className="antialiased">
        {/*
          Skip link: the first thing a keyboard or screen-reader user reaches.
          It is visually hidden (`sr-only`) until focused, at which point
          `focus:not-sr-only` reveals it — so a keyboard user can jump straight
          past the sidebar to the content instead of tabbing through every
          navigation item on every page.
        */}
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-[100] focus:rounded-[3px] focus:border focus:border-line focus:bg-raised focus:px-3 focus:py-2 focus:text-[12px]"
        >
          Skip to main content
        </a>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
