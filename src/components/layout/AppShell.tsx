'use client';

import { useEffect, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Radar } from 'lucide-react';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';
import { CommandPalette } from './CommandPalette';
import { useSkyGuard } from '@/store/useSkyGuard';
import { useExternalContext, useSimulationClock } from '@/hooks/useExternalContext';
import { isTypingTarget, SHORTCUT_MAP } from '@/lib/navigation';

/**
 * Application shell.
 *
 * Mission Control renders without the shell — it is meant for a wall display,
 * where navigation chrome is wasted pixels.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const mounted = useSkyGuard((s) => s.mounted);
  const setPaletteOpen = useSkyGuard((s) => s.setCommandPaletteOpen);
  const paletteOpen = useSkyGuard((s) => s.commandPaletteOpen);
  const density = useSkyGuard((s) => s.settings.density);
  const reducedAnimation = useSkyGuard((s) => s.settings.reducedAnimation);

  useSimulationClock();
  useExternalContext();

  // Operator preferences that affect the whole document.
  useEffect(() => {
    document.documentElement.dataset.density = density;
    document.documentElement.dataset.motion = reducedAnimation ? 'reduced' : 'normal';
  }, [density, reducedAnimation]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen(!paletteOpen);
        return;
      }
      if (e.key === 'Escape' && paletteOpen) {
        setPaletteOpen(false);
        return;
      }
      // Single-key shortcuts must never fire while someone is typing.
      if (e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return;

      const key = e.key.toLowerCase();
      if (key === 'm') {
        e.preventDefault();
        router.push('/mission-control');
        return;
      }
      const href = SHORTCUT_MAP.get(key);
      if (href) {
        e.preventDefault();
        router.push(href);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [router, setPaletteOpen, paletteOpen]);

  const bare = pathname === '/mission-control';

  if (bare) {
    return (
      <>
        {children}
        <CommandPalette />
      </>
    );
  }

  return (
    <div className="flex h-dvh w-full overflow-hidden">
      <div className="hidden md:flex">
        <Sidebar />
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        <main
          id="main"
          className="min-h-0 flex-1 overflow-y-auto"
          aria-busy={!mounted}
        >
          {mounted ? children : <BootScreen />}
        </main>
      </div>
      <CommandPalette />
      <MobileNav />
    </div>
  );
}

/**
 * Shown until the client clock is set.
 *
 * The simulation is anchored to the browser's clock, so rendering telemetry on
 * the server would guarantee a hydration mismatch. Waiting one frame is the
 * honest fix.
 */
function BootScreen() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3">
      <Radar size={26} className="pulse text-healthy" aria-hidden />
      <p className="text-[12px] text-ink-2">Initialising station network…</p>
      <p className="max-w-sm text-center text-[10.5px] text-ink-3">
        Generating 24 hours of minute-resolution telemetry for twelve stations and
        running the detection pipeline.
      </p>
    </div>
  );
}

/** Compact navigation for small screens, where the sidebar is hidden. */
function MobileNav() {
  const setPaletteOpen = useSkyGuard((s) => s.setCommandPaletteOpen);
  return (
    <button
      type="button"
      onClick={() => setPaletteOpen(true)}
      className="fixed right-4 bottom-4 z-30 flex h-11 w-11 items-center justify-center rounded-full border border-line bg-raised text-ink shadow-lg md:hidden"
      aria-label="Open navigation and search"
    >
      <Radar size={17} aria-hidden />
    </button>
  );
}
