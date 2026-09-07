'use client';

import { useMemo } from 'react';
import { useSkyGuard } from '@/store/useSkyGuard';
import { buildWorld, type World } from '@/lib/world';
import type { Alert, Incident, MaintenanceTask } from '@/types';

/**
 * Derive the world from the store's inputs.
 *
 * `buildWorld` regenerates 24 hours of telemetry for twelve stations and runs
 * the full detection pipeline over it — roughly 200 ms. That is cheap enough
 * to do on a clock tick but far too expensive to repeat on every render, so
 * results are memoised against the exact inputs that produced them.
 */

const cache = new Map<string, World>();
const CACHE_LIMIT = 3;

function worldKey(
  now: number,
  seed: number,
  eventIds: string,
  sensitivity: number,
  includeBaseline: boolean,
  externalKey: string,
) {
  return [now, seed, eventIds, sensitivity, includeBaseline, externalKey].join('|');
}

export function useWorld(): World | null {
  const mounted = useSkyGuard((s) => s.mounted);
  const now = useSkyGuard((s) => s.now);
  const seed = useSkyGuard((s) => s.seed);
  const mode = useSkyGuard((s) => s.mode);
  const injectedEvents = useSkyGuard((s) => s.injectedEvents);
  const sensitivity = useSkyGuard((s) => s.settings.sensitivity);
  const external = useSkyGuard((s) => s.external);
  const externalFetchedAt = useSkyGuard((s) => s.externalFetchedAt);

  return useMemo(() => {
    if (!mounted || !now) return null;

    // Simulation mode is the "no external dependencies at all" path: the
    // station network still tells its full story, but nothing is fetched.
    const useExternal = mode !== 'simulation';
    const eventIds = injectedEvents.map((e) => e.id).join(',');
    const key = worldKey(
      now,
      seed,
      eventIds,
      sensitivity,
      true,
      useExternal ? String(externalFetchedAt ?? 0) : 'none',
    );

    const hit = cache.get(key);
    if (hit) return hit;

    const world = buildWorld({
      now,
      seed,
      injectedEvents,
      sensitivity,
      external: useExternal ? external : new Map(),
      includeBaseline: true,
    });

    cache.set(key, world);
    if (cache.size > CACHE_LIMIT) {
      cache.delete(cache.keys().next().value as string);
    }
    return world;
  }, [mounted, now, seed, mode, injectedEvents, sensitivity, external, externalFetchedAt]);
}

/**
 * The world with the operator's own decisions layered on top.
 *
 * Acknowledgements, incident statuses and maintenance progress are operator
 * state, not simulation output — they survive a clock tick, which recomputes
 * everything else from scratch.
 */
export interface ResolvedWorld extends World {
  incidents: Incident[];
  alerts: Alert[];
  maintenance: MaintenanceTask[];
}

export function useResolvedWorld(): ResolvedWorld | null {
  const world = useWorld();
  const incidentStatus = useSkyGuard((s) => s.incidentStatus);
  const alertState = useSkyGuard((s) => s.alertState);
  const maintenanceStatus = useSkyGuard((s) => s.maintenanceStatus);

  return useMemo(() => {
    if (!world) return null;
    return {
      ...world,
      incidents: world.incidents.map((i) =>
        incidentStatus[i.id] ? { ...i, status: incidentStatus[i.id] } : i,
      ),
      alerts: world.alerts.map((a) =>
        alertState[a.id] ? { ...a, state: alertState[a.id] } : a,
      ),
      maintenance: world.maintenance.map((m) =>
        maintenanceStatus[m.id] ? { ...m, status: maintenanceStatus[m.id] } : m,
      ),
    };
  }, [world, incidentStatus, alertState, maintenanceStatus]);
}

/** The currently selected station's snapshot, with a safe fallback. */
export function useSelectedStation() {
  const world = useResolvedWorld();
  const selectedStationId = useSkyGuard((s) => s.selectedStationId);
  return useMemo(() => {
    if (!world) return null;
    return world.snapshotById.get(selectedStationId) ?? world.snapshots[0] ?? null;
  }, [world, selectedStationId]);
}
