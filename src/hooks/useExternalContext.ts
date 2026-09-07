'use client';

import { useEffect } from 'react';
import { useSkyGuard } from '@/store/useSkyGuard';
import type { ExternalContext, RadarMeta } from '@/types';

/**
 * Fetches live external context once on mount and then on a slow interval.
 *
 * Every failure mode ends the same way: the store keeps whatever it last had,
 * the status flips to `error`, and the UI shows "using simulation context".
 * The dashboard never blanks and never blocks on the network.
 */

const REFRESH_MS = 5 * 60_000;

interface NetworkResponse {
  status: 'live' | 'error';
  message?: string;
  contexts: ExternalContext[];
}

export function useExternalContext() {
  const mode = useSkyGuard((s) => s.mode);
  const radarEnabled = useSkyGuard((s) => s.settings.radarEnabled);
  const setExternal = useSkyGuard((s) => s.setExternal);
  const setExternalLoading = useSkyGuard((s) => s.setExternalLoading);
  const setRadar = useSkyGuard((s) => s.setRadar);

  const wantsExternal = mode !== 'simulation';

  useEffect(() => {
    if (!wantsExternal) {
      setExternal([], 'error', 'Simulation mode — external providers are not contacted.');
      return;
    }

    let cancelled = false;

    const load = async () => {
      setExternalLoading();
      try {
        const res = await fetch('/api/weather/network', { cache: 'no-store' });
        if (!res.ok) throw new Error(`Request failed with ${res.status}`);
        const data = (await res.json()) as NetworkResponse;
        if (cancelled) return;
        setExternal(
          data.contexts ?? [],
          data.status === 'live' ? 'live' : 'error',
          data.message ?? null,
        );
      } catch (error) {
        if (cancelled) return;
        setExternal(
          [],
          'error',
          error instanceof Error ? error.message : 'External weather context unavailable',
        );
      }
    };

    void load();
    const id = window.setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [wantsExternal, setExternal, setExternalLoading]);

  useEffect(() => {
    if (!wantsExternal || !radarEnabled) {
      setRadar(null, radarEnabled ? null : 'Radar layer disabled in settings.');
      return;
    }

    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch('/api/radar', { cache: 'no-store' });
        const data = (await res.json()) as RadarMeta & { message?: string };
        if (cancelled) return;
        setRadar(
          data.status === 'live' ? data : null,
          data.status === 'live' ? null : (data.message ?? 'Radar unavailable'),
        );
      } catch (error) {
        if (cancelled) return;
        setRadar(null, error instanceof Error ? error.message : 'Radar unavailable');
      }
    };

    void load();
    const id = window.setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [wantsExternal, radarEnabled, setRadar]);
}

/** Drives the simulation clock forward so the console feels live. */
export function useSimulationClock() {
  const mount = useSkyGuard((s) => s.mount);
  const tick = useSkyGuard((s) => s.tick);
  const liveUpdates = useSkyGuard((s) => s.settings.liveUpdates);

  useEffect(() => {
    mount();
  }, [mount]);

  useEffect(() => {
    if (!liveUpdates) return;
    const id = window.setInterval(tick, 60_000);
    return () => window.clearInterval(id);
  }, [liveUpdates, tick]);
}
