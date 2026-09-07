import type { SensorType } from '@/types';
import { HOUR, MINUTE } from '@/lib/utils';

/**
 * Everything that perturbs the baseline simulation is an event. Meteorological
 * events change the *truth* (and therefore propagate across the network the
 * way real weather does); hardware events change only what a station reports.
 */
export type EventKind =
  | 'temp_spike'
  | 'humidity_drift'
  | 'frozen_sensor'
  | 'sensor_noise'
  | 'battery_failure'
  | 'comms_outage'
  | 'cold_front'
  | 'heat_wave'
  | 'pressure_drop'
  | 'rain_event';

export const METEOROLOGICAL_KINDS: EventKind[] = [
  'cold_front',
  'heat_wave',
  'pressure_drop',
  'rain_event',
];

export interface SimEvent {
  id: string;
  kind: EventKind;
  /** Network events move across the map; station events are local hardware. */
  scope: 'network' | 'station';
  stationId?: string;
  sensorType?: SensorType;
  startAt: number;
  /** Milliseconds. Use Number.POSITIVE_INFINITY for an unresolved fault. */
  duration: number;
  magnitude: number;
  /**
   * For faults that pin rather than offset. A shorted resistance probe reads
   * near the top of its range regardless of ambient, so the raw value is an
   * absolute target rather than an offset from truth.
   */
  targetValue?: number;
  label: string;
  /** True when an operator injected it from the Demo Incident controls. */
  injected: boolean;
}

export function isMeteorological(kind: EventKind) {
  return METEOROLOGICAL_KINDS.includes(kind);
}

export interface InjectableScenario {
  kind: EventKind;
  label: string;
  description: string;
  scope: 'network' | 'station';
  sensorType?: SensorType;
  defaultMagnitude: number;
  defaultDuration: number;
  /** Shown in the "Run demo incident" launcher as a headline scenario. */
  featured?: string;
}

export const INJECTABLE_SCENARIOS: InjectableScenario[] = [
  {
    kind: 'temp_spike',
    label: 'Inject temperature spike',
    description:
      'Drives the temperature probe far above the physically plausible rate of change while every other channel stays put.',
    scope: 'station',
    sensorType: 'temperature',
    defaultMagnitude: 28,
    defaultDuration: Number.POSITIVE_INFINITY,
    featured: 'Broken temperature probe',
  },
  {
    kind: 'humidity_drift',
    label: 'Inject humidity drift',
    description:
      'Slow calibration drift on the humidity probe — invisible minute to minute, obvious against neighbours.',
    scope: 'station',
    sensorType: 'humidity',
    defaultMagnitude: 0.24,
    defaultDuration: Number.POSITIVE_INFINITY,
    featured: 'Humidity sensor drift',
  },
  {
    kind: 'frozen_sensor',
    label: 'Freeze sensor',
    description: 'The channel latches on its last value and stops responding.',
    scope: 'station',
    sensorType: 'temperature',
    defaultMagnitude: 0,
    defaultDuration: Number.POSITIVE_INFINITY,
  },
  {
    kind: 'sensor_noise',
    label: 'Inject excessive noise',
    description: 'Variance climbs sharply — typically a failing connector or damp terminal block.',
    scope: 'station',
    sensorType: 'temperature',
    defaultMagnitude: 2.4,
    defaultDuration: 6 * HOUR,
  },
  {
    kind: 'battery_failure',
    label: 'Simulate battery failure',
    description: 'Pack voltage collapses; packet loss follows as the modem browns out.',
    scope: 'station',
    sensorType: 'battery',
    defaultMagnitude: 1,
    defaultDuration: Number.POSITIVE_INFINITY,
    featured: 'Battery degradation',
  },
  {
    kind: 'comms_outage',
    label: 'Simulate communications outage',
    description: 'Packets stop arriving entirely. Sensors are probably fine — the link is not.',
    scope: 'station',
    sensorType: 'comms',
    defaultMagnitude: 1,
    defaultDuration: 90 * MINUTE,
    featured: 'Communications failure',
  },
  {
    kind: 'cold_front',
    label: 'Simulate cold front',
    description:
      'A genuine frontal passage sweeping north-west to south-east: temperature down, humidity up, pressure trough, wind shift.',
    scope: 'network',
    defaultMagnitude: 7.5,
    defaultDuration: 5 * HOUR,
    featured: 'Approaching cold front',
  },
  {
    kind: 'heat_wave',
    label: 'Simulate heat wave',
    description: 'Network-consistent warming with falling humidity — every station moves together.',
    scope: 'network',
    defaultMagnitude: 8,
    defaultDuration: 10 * HOUR,
  },
  {
    kind: 'pressure_drop',
    label: 'Simulate pressure drop',
    description: 'Deep synoptic pressure fall across the whole network.',
    scope: 'network',
    defaultMagnitude: 11,
    defaultDuration: 6 * HOUR,
  },
  {
    kind: 'rain_event',
    label: 'Simulate rainfall event',
    description: 'Precipitation with the humidity and dew-point response that should accompany it.',
    scope: 'network',
    defaultMagnitude: 1,
    defaultDuration: 3 * HOUR,
  },
];

export const FEATURED_SCENARIOS = INJECTABLE_SCENARIOS.filter((s) => s.featured);
