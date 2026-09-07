import { DAY, HOUR, MINUTE } from '@/lib/utils';
import type { SimEvent } from './events';

/**
 * The scenario the platform opens with.
 *
 * Two of these exist to be read side by side, and the contrast between them is
 * the whole argument for the product:
 *
 *   AWS-007  a temperature probe that jumps 30 °C in a minute while every
 *            other channel and every neighbour stays exactly where it was.
 *
 *   AWS-033  a real cold front — temperature down, humidity up, pressure
 *            trough, wind veering — arriving at station after station in
 *            geographic order.
 *
 * One gets corrected and raises a maintenance task. The other gets published
 * untouched. Everything else here exists to give the network a realistic
 * spread of conditions around them.
 */

/** Minutes before "now" that AWS-033 sits in the frontal passage. */
const FRONT_ARRIVAL_AT_AWS033_MINUTES_AGO = 45;
/** Precomputed travel time from the front's origin to AWS-033. */
const AWS033_TRAVEL_MINUTES = 271;

export function baselineEvents(now: number): SimEvent[] {
  const frontStart = now - (AWS033_TRAVEL_MINUTES + FRONT_ARRIVAL_AT_AWS033_MINUTES_AGO) * MINUTE;

  return [
    {
      id: 'BASE-FRONT',
      kind: 'cold_front',
      scope: 'network',
      startAt: frontStart,
      duration: 6 * HOUR,
      magnitude: 7.5,
      label: 'Cold front crossing the network from the north-west',
      injected: false,
    },
    {
      id: 'BASE-AWS007-TEMP',
      kind: 'temp_spike',
      scope: 'station',
      stationId: 'AWS-007',
      sensorType: 'temperature',
      startAt: now - 38 * MINUTE,
      duration: Number.POSITIVE_INFINITY,
      magnitude: 31.8,
      // The probe pins high, the way a shorted PT1000 element actually fails.
      targetValue: 61.4,
      label: 'AWS-007 temperature probe failure',
      injected: false,
    },
    {
      id: 'BASE-AWS021-RH',
      kind: 'humidity_drift',
      scope: 'station',
      stationId: 'AWS-021',
      sensorType: 'humidity',
      // Long-standing calibration drift: 0.2 %RH per day for fifty days.
      startAt: now - 50 * DAY,
      duration: Number.POSITIVE_INFINITY,
      magnitude: 0.2,
      label: 'AWS-021 humidity probe calibration drift',
      injected: false,
    },
    {
      id: 'BASE-AWS002-COMMS',
      kind: 'comms_outage',
      scope: 'station',
      stationId: 'AWS-002',
      sensorType: 'comms',
      startAt: now - 3 * HOUR,
      duration: 75 * MINUTE,
      magnitude: 1,
      label: 'AWS-002 telemetry outage',
      injected: false,
    },
    {
      id: 'BASE-AWS029-BATT',
      kind: 'battery_failure',
      scope: 'station',
      stationId: 'AWS-029',
      sensorType: 'battery',
      startAt: now - 9 * HOUR,
      duration: Number.POSITIVE_INFINITY,
      magnitude: 0.3,
      label: 'AWS-029 battery pack degradation',
      injected: false,
    },
    {
      id: 'BASE-AWS026-WIND',
      kind: 'frozen_sensor',
      scope: 'station',
      stationId: 'AWS-026',
      sensorType: 'wind_speed',
      startAt: now - 4 * HOUR,
      duration: Number.POSITIVE_INFINITY,
      magnitude: 0,
      label: 'AWS-026 anemometer seized',
      injected: false,
    },
    {
      id: 'BASE-AWS041-NOISE',
      kind: 'sensor_noise',
      scope: 'station',
      stationId: 'AWS-041',
      sensorType: 'temperature',
      startAt: now - 5 * HOUR,
      duration: 9 * HOUR,
      magnitude: 1.7,
      label: 'AWS-041 temperature channel noise',
      injected: false,
    },
  ];
}

/** Highlighted in the UI so a first-time viewer knows where to look. */
export const DEMO_STORY = {
  faultStationId: 'AWS-007',
  weatherStationId: 'AWS-033',
};
