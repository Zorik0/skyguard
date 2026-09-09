'use client';

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type {
  Alert,
  DataMode,
  ExternalContext,
  IncidentStatus,
  MaintenanceStatus,
  RadarMeta,
} from '@/types';
import { DAY, HOUR, MINUTE } from '@/lib/utils';
import type { EventKind, SimEvent } from '@/lib/simulation/events';
import { INJECTABLE_SCENARIOS } from '@/lib/simulation/events';
import { DEMO_STORY } from '@/lib/simulation/baseline';

/**
 * Application state.
 *
 * Deliberately small. It holds the *inputs* to the simulation (clock, seed,
 * injected events, sensitivity) and the operator's own decisions (incident
 * statuses, acknowledgements, settings) — never derived data. Everything a
 * screen displays is recomputed from these inputs by `buildWorld`, which is
 * what guarantees that no two screens can disagree about the network.
 *
 * ─── The rule: store inputs, never outputs ───────────────────────────────
 *
 * IN THE STORE                        NOT IN THE STORE
 * the clock, the seed                 the telemetry
 * injected scenarios                  the anomalies
 * the sensitivity dial                the incidents, alerts, health scores
 * which incidents were acknowledged   anything `buildWorld` can derive
 * unit and display preferences
 *
 * Storing derived data is the classic dashboard bug: the anomaly list gets
 * cached in state, something updates the telemetry without updating the list,
 * and now two screens disagree with no single place to look. Keeping only
 * inputs makes that class of bug unrepresentable — there is nowhere to put a
 * stale copy.
 *
 * Zustand is a small state library: `create()` returns a hook, components
 * subscribe with a selector such as `useSkyGuard((s) => s.now)`, and only
 * components whose selected slice actually changed re-render. The `persist`
 * middleware mirrors part of the state to `localStorage`, so your unit
 * preferences and acknowledgements survive a page reload.
 */

export interface Settings {
  temperatureUnit: 'C' | 'F';
  windUnit: 'ms' | 'kmh' | 'kt' | 'mph';
  pressureUnit: 'hPa' | 'inHg';
  defaultStationId: string;
  /** 0–100; scales every physics threshold at once. */
  sensitivity: number;
  neighbourRadiusKm: number;
  correctionPolicy: 'automatic' | 'review' | 'off';
  alertThresholds: { warning: number; high: number; critical: number };
  provider: 'open-meteo';
  radarEnabled: boolean;
  liveUpdates: boolean;
  reducedAnimation: boolean;
  density: 'compact' | 'normal' | 'comfortable';
}

export const DEFAULT_SETTINGS: Settings = {
  temperatureUnit: 'C',
  windUnit: 'ms',
  pressureUnit: 'hPa',
  defaultStationId: DEMO_STORY.faultStationId,
  sensitivity: 50,
  neighbourRadiusKm: 120,
  correctionPolicy: 'automatic',
  alertThresholds: { warning: 38, high: 62, critical: 82 },
  provider: 'open-meteo',
  radarEnabled: true,
  liveUpdates: true,
  reducedAnimation: false,
  density: 'normal',
};

export interface Notification {
  id: string;
  title: string;
  body: string;
  t: number;
  severity: 'info' | 'warning' | 'high' | 'critical';
  read: boolean;
  href?: string;
}

interface SkyGuardState {
  /** Set once on the client so the simulation clock never differs between
   *  server and client render. */
  mounted: boolean;
  now: number;
  seed: number;
  mode: DataMode;
  injectedEvents: SimEvent[];
  selectedStationId: string;
  /** RAW vs QUALITY-CONTROLLED lens, applied globally. */
  cleaned: boolean;
  settings: Settings;

  external: Map<string, ExternalContext>;
  externalStatus: 'idle' | 'loading' | 'live' | 'error';
  externalMessage: string | null;
  externalFetchedAt: number | null;
  radar: RadarMeta | null;
  radarMessage: string | null;

  /** Operator decisions, layered over the derived world. */
  incidentStatus: Record<string, IncidentStatus>;
  alertState: Record<string, Alert['state']>;
  maintenanceStatus: Record<string, MaintenanceStatus>;
  operatorNotes: Record<string, string>;

  notifications: Notification[];
  commandPaletteOpen: boolean;
  /** Minutes back from now for the historical playback scrubber. */
  playbackOffsetMinutes: number;

  mount: () => void;
  tick: () => void;
  setMode: (mode: DataMode) => void;
  selectStation: (id: string) => void;
  setCleaned: (cleaned: boolean) => void;
  updateSettings: (patch: Partial<Settings>) => void;
  injectScenario: (kind: EventKind, stationId?: string) => string | null;
  restoreStation: (stationId: string) => void;
  clearInjected: () => void;
  setExternal: (
    contexts: ExternalContext[],
    status: 'live' | 'error',
    message: string | null,
  ) => void;
  setExternalLoading: () => void;
  setRadar: (radar: RadarMeta | null, message: string | null) => void;
  setIncidentStatus: (id: string, status: IncidentStatus) => void;
  setAlertState: (id: string, state: Alert['state']) => void;
  setMaintenanceStatus: (id: string, status: MaintenanceStatus) => void;
  setOperatorNote: (id: string, note: string) => void;
  pushNotification: (n: Omit<Notification, 'id' | 'read'>) => void;
  markNotificationsRead: () => void;
  dismissNotification: (id: string) => void;
  setCommandPaletteOpen: (open: boolean) => void;
  setPlaybackOffset: (minutes: number) => void;
}

/** Round to the sample interval so the clock never lands mid-sample. */
function alignClock(t: number) {
  return Math.floor(t / MINUTE) * MINUTE;
}

let injectionCounter = 0;

export const useSkyGuard = create<SkyGuardState>()(
  persist(
    (set, get) => ({
      mounted: false,
      // Server render uses a fixed epoch; the real clock arrives on mount.
      now: 0,
      seed: 20260907,
      mode: 'hybrid',
      injectedEvents: [],
      selectedStationId: DEMO_STORY.faultStationId,
      cleaned: false,
      settings: DEFAULT_SETTINGS,

      external: new Map(),
      externalStatus: 'idle',
      externalMessage: null,
      externalFetchedAt: null,
      radar: null,
      radarMessage: null,

      incidentStatus: {},
      alertState: {},
      maintenanceStatus: {},
      operatorNotes: {},

      notifications: [],
      commandPaletteOpen: false,
      playbackOffsetMinutes: 0,

      mount: () => {
        if (get().mounted) return;
        set({ mounted: true, now: alignClock(Date.now()) });
      },

      tick: () => {
        const next = alignClock(Date.now());
        if (next !== get().now) set({ now: next });
      },

      setMode: (mode) => set({ mode }),
      selectStation: (selectedStationId) => set({ selectedStationId }),
      setCleaned: (cleaned) => set({ cleaned }),

      updateSettings: (patch) =>
        set((state) => ({ settings: { ...state.settings, ...patch } })),

      injectScenario: (kind, stationId) => {
        const scenario = INJECTABLE_SCENARIOS.find((s) => s.kind === kind);
        if (!scenario) return null;
        const { now, selectedStationId } = get();
        const target = scenario.scope === 'station' ? (stationId ?? selectedStationId) : undefined;
        const id = `INJ-${++injectionCounter}-${kind}`;

        const event: SimEvent = {
          id,
          kind,
          scope: scenario.scope,
          stationId: target,
          sensorType: scenario.sensorType,
          // Meteorological systems are placed far enough back that they have
          // already reached part of the network — an operator wants to see
          // propagation, not wait for it.
          startAt:
            scenario.scope === 'network'
              ? now - 4 * HOUR
              : kind === 'humidity_drift'
                ? now - 40 * DAY
                : now - 25 * MINUTE,
          duration: scenario.defaultDuration,
          magnitude: scenario.defaultMagnitude,
          label: scenario.label,
          injected: true,
        };

        set((state) => ({
          injectedEvents: [...state.injectedEvents, event],
          mode: 'demo',
          selectedStationId: target ?? state.selectedStationId,
        }));
        return id;
      },

      restoreStation: (stationId) =>
        set((state) => ({
          injectedEvents: state.injectedEvents.filter(
            (e) => !(e.scope === 'station' && e.stationId === stationId),
          ),
        })),

      clearInjected: () => set({ injectedEvents: [], mode: 'hybrid' }),

      setExternalLoading: () =>
        set((state) => ({
          externalStatus: state.externalStatus === 'live' ? 'live' : 'loading',
        })),

      setExternal: (contexts, status, message) =>
        set({
          external: new Map(contexts.map((c) => [c.stationId, c])),
          externalStatus: status,
          externalMessage: message,
          externalFetchedAt: Date.now(),
        }),

      setRadar: (radar, radarMessage) => set({ radar, radarMessage }),

      setIncidentStatus: (id, status) =>
        set((state) => ({ incidentStatus: { ...state.incidentStatus, [id]: status } })),

      setAlertState: (id, alertStateValue) =>
        set((state) => ({ alertState: { ...state.alertState, [id]: alertStateValue } })),

      setMaintenanceStatus: (id, status) =>
        set((state) => ({ maintenanceStatus: { ...state.maintenanceStatus, [id]: status } })),

      setOperatorNote: (id, note) =>
        set((state) => ({ operatorNotes: { ...state.operatorNotes, [id]: note } })),

      pushNotification: (n) =>
        set((state) => ({
          notifications: [
            { ...n, id: `N-${Date.now()}-${state.notifications.length}`, read: false },
            ...state.notifications,
          ].slice(0, 40),
        })),

      markNotificationsRead: () =>
        set((state) => ({
          notifications: state.notifications.map((n) => ({ ...n, read: true })),
        })),

      dismissNotification: (id) =>
        set((state) => ({ notifications: state.notifications.filter((n) => n.id !== id) })),

      setCommandPaletteOpen: (commandPaletteOpen) => set({ commandPaletteOpen }),
      setPlaybackOffset: (playbackOffsetMinutes) => set({ playbackOffsetMinutes }),
    }),
    {
      name: 'skyguard.v1',
      storage: createJSONStorage(() => localStorage),
      // Only operator preferences and decisions survive a reload. Derived data
      // and the simulation clock are always rebuilt from scratch.
      partialize: (state) => ({
        settings: state.settings,
        selectedStationId: state.selectedStationId,
        cleaned: state.cleaned,
        mode: state.mode,
        incidentStatus: state.incidentStatus,
        alertState: state.alertState,
        maintenanceStatus: state.maintenanceStatus,
        operatorNotes: state.operatorNotes,
      }),
      // Persistence must never be able to break a first paint.
      skipHydration: false,
      version: 1,
    },
  ),
);

export const selectSettings = (s: SkyGuardState) => s.settings;
export const selectNow = (s: SkyGuardState) => s.now;
