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
