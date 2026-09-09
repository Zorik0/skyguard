import type {
  Anomaly,
  MaintenanceTask,
  SensorHealth,
  SensorSpec,
  SensorType,
  Severity,
  Station,
} from '@/types';
import { clamp, DAY, HOUR, mean, MINUTE, round, slope, stdev } from '@/lib/utils';
import { makeRng } from '@/lib/rng';
import { readingValue, type StationSeries } from '@/lib/neighbours';
import { twinValue } from '@/lib/physics/rules';
import { SENSOR_LABELS, SENSOR_UNITS } from '@/lib/simulation/stations';

/**
 * Sensor-health scoring.
 *
 * A score is only useful if you can see what took it away, so health is built
 * as 100 minus a list of named penalties, and that list travels with the score
 * into the UI.
 *
 * ─── Why subtraction rather than a model ─────────────────────────────────
 *
 * "Sensor health: 62/100" is useless on its own — an operator cannot act on
 * it, argue with it, or plan around it. So every score in this file starts at
 * 100 and has named amounts taken off:
 *
 *   100
 *    -18  calibration 47 days overdue
 *    -12  drifting +0.31 °C/week against peers
 *     -8  three anomalies in the last 24 hours
 *   ────
 *     62  →  and the list above is what the UI actually shows
 *
 * The operator now knows the score, the reasons, and which one to fix first.
 * A trained model might produce a better-calibrated number, but nobody could
 * schedule an engineer from it — and scheduling the engineer is the point.
 */

/**
 * Bands turn a number into a decision. 74 and 76 are not meaningfully
 * different measurements, but "minor degradation" and "healthy" are different
 * actions, and a band boundary is where the argument about the threshold
 * belongs — visible, in one place, rather than scattered through the UI.
 */
export const HEALTH_BANDS: {
  min: number;
  max: number;
  band: SensorHealth['band'];
  label: string;
}[] = [
  { min: 80, max: 100, band: 'healthy', label: 'Healthy' },
  { min: 60, max: 79, band: 'minor', label: 'Minor degradation' },
  { min: 40, max: 59, band: 'warning', label: 'Warning' },
  { min: 20, max: 39, band: 'critical', label: 'Critical' },
  { min: 0, max: 19, band: 'failed', label: 'Failed / unreliable' },
];

export function bandFor(score: number): SensorHealth['band'] {
  return HEALTH_BANDS.find((b) => score >= b.min)?.band ?? 'failed';
}

export function bandLabel(band: SensorHealth['band']): string {
  return HEALTH_BANDS.find((b) => b.band === band)?.label ?? 'Unknown';
}

/** Instruments that are calibrated against a reference standard. */
const CALIBRATED_TYPES: SensorType[] = [
  'temperature', 'humidity', 'pressure', 'wind_speed', 'rainfall',
];

const DRIFT_UNIT_PER_WEEK: Partial<Record<SensorType, string>> = {
  temperature: '°C/week',
  humidity: '%RH/week',
  pressure: 'hPa/week',
  wind_speed: 'm/s per week',
  rainfall: 'mm/week',
};

export function computeSensorHealth(
  station: Station,
  sensor: SensorSpec,
  series: StationSeries,
  anomalies: Anomaly[],
  now: number,
  stepMs: number,
  seed: number,
  /** Offset and trend against neighbouring stations. */
  measuredDrift?: { offset: number; ratePerWeek: number; significant: boolean },
): SensorHealth {
  const factors: SensorHealth['factors'] = [];
  const { raw, twin } = series;
  const type = sensor.type;

  const mine = anomalies.filter((a) => a.stationId === station.id && a.sensorType === type);

  // --- Anomaly frequency ---------------------------------------------------
  const weighted = mine.reduce(
    (acc, a) => acc + (a.severity === 'critical' ? 3 : a.severity === 'high' ? 2 : a.severity === 'warning' ? 1 : 0.4),
    0,
  );
  const anomalyPenalty = clamp(weighted * 7, 0, 42);
  if (anomalyPenalty > 0.5) {
    factors.push({
      label: 'Anomaly frequency',
      penalty: round(anomalyPenalty, 1),
      detail: `${mine.length} anomal${mine.length === 1 ? 'y' : 'ies'} on this channel in the last 24 hours.`,
    });
  }

  // --- Calibration age -----------------------------------------------------
  // Battery packs and telemetry modems are serviced, not calibrated against a
  // reference standard, so an "overdue calibration" penalty is meaningless for
  // them and would quietly depress their scores forever.
  const ageDays = Math.round((now - sensor.lastCalibratedAt) / DAY);
  const ratio = ageDays / sensor.calibrationIntervalDays;
  const calibrationPenalty = CALIBRATED_TYPES.includes(type)
    ? clamp((ratio - 0.85) * 40, 0, 22)
    : 0;
  if (calibrationPenalty > 0.5) {
    factors.push({
      label: 'Calibration age',
      penalty: round(calibrationPenalty, 1),
      detail: `${ageDays} days since calibration against a ${sensor.calibrationIntervalDays}-day interval.`,
    });
  }

  // --- Drift against the digital twin --------------------------------------
  let drift = 0;
  let driftRate = 0;
  let driftSignificant = false;
  let noise = 0;
  let missingRate = 0;
  const values: number[] = [];
  const residuals: number[] = [];
  let missing = 0;

  for (let i = 0; i < raw.length; i++) {
    if (!raw[i].received) {
      missing++;
      continue;
    }
    const v = readingValue(raw[i], type);
    if (v === null) continue;
    values.push(v);
    const tv = twinValue(twin[i], type);
    if (tv !== null) residuals.push(v - tv);
  }
  missingRate = raw.length ? missing / raw.length : 0;

  if (residuals.length > 30) {
    // Drift is measured against the neighbouring stations where possible —
    // that is how a real network separates a drifting probe from a change in
    // the weather. The digital twin is the fallback when a station has no
    // usable peers.
    if (measuredDrift !== undefined) {
      drift = measuredDrift.offset;
      driftRate = measuredDrift.ratePerWeek;
      driftSignificant = measuredDrift.significant;
    } else {
      // No usable peers — fall back to the digital twin as the reference.
      drift = mean(residuals);
      driftRate = slope(residuals) * ((7 * DAY) / stepMs);
    }
    const offset = Math.abs(mean(residuals));
    const tolerance =
      type === 'temperature' ? 1.2 : type === 'humidity' ? 4 : type === 'pressure' ? 1 : 2;
    const driftPenalty = clamp((offset / tolerance) * 14, 0, 26);
    if (driftPenalty > 0.5) {
      factors.push({
        label: 'Drift from expected',
        penalty: round(driftPenalty, 1),
        detail: `Mean offset of ${round(mean(residuals), 2)} ${SENSOR_UNITS[type]} against the digital twin.`,
      });
    }
  }

  // --- Short-term noise ----------------------------------------------------
  if (values.length > 60) {
    const recent = values.slice(-Math.round((60 * MINUTE) / stepMs));
    const reference = values.slice(0, Math.round((3 * HOUR) / stepMs));
    const rSd = stdev(recent);
    const refSd = Math.max(stdev(reference), 1e-6);
    noise = round(rSd, 3);
    const ratioN = rSd / refSd;
    const noisePenalty = clamp((ratioN - 1.8) * 9, 0, 18);
    if (noisePenalty > 0.5) {
      factors.push({
        label: 'Measurement noise',
        penalty: round(noisePenalty, 1),
        detail: `Recent variance is ${round(ratioN, 1)}× the earlier reference period.`,
      });
    }
  }

  // --- Missing observations ------------------------------------------------
  const missingPenalty = clamp(missingRate * 120, 0, 28);
  if (missingPenalty > 0.5) {
    factors.push({
      label: 'Missing observations',
      penalty: round(missingPenalty, 1),
      detail: `${round(missingRate * 100, 1)}% of expected packets did not arrive.`,
    });
  }

  // --- Corrections applied -------------------------------------------------
  const correctionCount = mine.filter((a) => a.correction && a.correction.confidence > 0).length;
  const correctionPenalty = clamp(correctionCount * 6, 0, 16);
  if (correctionPenalty > 0.5) {
    factors.push({
      label: 'Corrections applied',
      penalty: round(correctionPenalty, 1),
      detail: `${correctionCount} reading${correctionCount === 1 ? '' : 's'} required a quality-controlled estimate.`,
    });
  }

  factors.sort((a, b) => b.penalty - a.penalty);
  const totalPenalty = factors.reduce((a, f) => a + f.penalty, 0);
  const score = clamp(Math.round(100 - totalPenalty), 0, 100);
  const band = bandFor(score);

  // Historical trend. The 24-hour window is all the telemetry we hold, so the
  // longer trends are reconstructed deterministically from the sensor seed and
  // labelled as estimates wherever they are shown.
  const rng = makeRng(`health:${sensor.id}:${seed}`);
  const decayPressure = clamp((100 - score) / 100, 0, 1);
  const trend7d = round(-decayPressure * (3 + rng() * 7) + (rng() - 0.4) * 2, 1);
  const trend30d = round(trend7d * (2.4 + rng() * 1.6), 1);

  // Failure risk blends the current score with how fast it is falling.
  const failureRisk30d = clamp(
    Math.round(
      (100 - score) * 0.62 +
        Math.abs(Math.min(0, trend7d)) * 3.6 +
        Math.abs(driftRate) * 2,
    ),
    0,
    99,
  );

  return {
    sensorId: sensor.id,
    stationId: station.id,
    type,
    score,
    band,
    trend7d,
    trend30d,
    calibrationAgeDays: ageDays,
    anomalyCount: mine.length,
    correctionCount,
    drift: round(drift, 2),
    driftUnit: `${SENSOR_UNITS[type]} vs peers`,
    driftRate: round(driftRate, 2),
    driftRateUnit: DRIFT_UNIT_PER_WEEK[type] ?? `${SENSOR_UNITS[type]}/week`,
    driftRateSignificant: driftSignificant,
    noise,
    missingRate: round(missingRate, 4),
    failureRisk30d,
    recommendation: recommendFor(
      band, type, ageDays, sensor.calibrationIntervalDays, failureRisk30d,
      factors[0]?.label ?? null,
    ),
    factors,
  };
}

function recommendFor(
  band: SensorHealth['band'],
  type: SensorType,
  ageDays: number,
  interval: number,
  risk: number,
  dominantFactor: string | null,
): string {
  const label = SENSOR_LABELS[type].toLowerCase();
  if (band === 'failed') return `Replace the ${label} sensor at the earliest opportunity — readings are unreliable.`;

  // A large standing offset from the peer network is a calibration problem
  // whatever the overall score says — recommending "keep watching" for a probe
  // that is visibly reading wrong would be the wrong advice.
  if (dominantFactor === 'Drift from expected') {
    return `Recalibrate the ${label} sensor against a reference standard — it holds a persistent offset from neighbouring stations.`;
  }
  if (dominantFactor === 'Missing observations') {
    return `Investigate the telemetry path for this station — a share of expected packets is not arriving.`;
  }
  if (dominantFactor === 'Measurement noise') {
    return `Inspect the ${label} wiring and enclosure seals for moisture ingress; variance has risen above this channel's baseline.`;
  }
  if (band === 'critical') {
    const noun = CALIBRATED_TYPES.includes(type) ? 'sensor' : 'subsystem';
    return risk > 70
      ? `Replace the ${label} ${noun} during the next maintenance visit (estimated ${risk}% failure risk within 30 days).`
      : `Inspect the ${label} ${noun} and its wiring on site within 7 days.`;
  }
  // Only instruments that are calibrated against a standard get calibration
  // advice; a modem or a battery pack is inspected and replaced instead.
  const calibrated = CALIBRATED_TYPES.includes(type);

  // A near-certain failure estimate outranks the band. A channel scoring in the
  // warning range while heading for failure should not read as routine.
  if (risk >= 85) {
    return `Replace the ${label} ${calibrated ? 'sensor' : 'subsystem'} at the next maintenance visit — estimated ${risk}% chance of failure within 30 days.`;
  }

  if (band === 'warning') {
    return calibrated && ageDays > interval
      ? `Recalibrate the ${label} sensor within 14 days — it is ${ageDays - interval} days past its interval.`
      : `Schedule an inspection of the ${label} ${calibrated ? 'sensor' : 'subsystem'} within 14 days.`;
  }
  if (band === 'minor') {
    return calibrated && ageDays > interval * 0.9
      ? `Plan recalibration of the ${label} sensor at the next scheduled visit.`
      : `Continue monitoring; no intervention required yet.`;
  }
  return 'No action required. Sensor is performing within specification.';
}

/** Overall station health is the weakest link, softened by the average. */
export function stationHealthScore(sensors: SensorHealth[]): number {
  if (!sensors.length) return 100;
  const min = Math.min(...sensors.map((s) => s.score));
  const avg = mean(sensors.map((s) => s.score));
  return Math.round(min * 0.55 + avg * 0.45);
}

const PRIORITY_BY_BAND: Record<SensorHealth['band'], Severity> = {
  failed: 'critical',
  critical: 'critical',
  warning: 'high',
  minor: 'warning',
  healthy: 'info',
};

/**
 * Predictive maintenance queue, derived from the same health scores rather
 * than from a separate invented list.
 */
export function buildMaintenanceTasks(
  stations: Station[],
  healthByStation: Map<string, SensorHealth[]>,
  anomalies: Anomaly[],
  now: number,
): MaintenanceTask[] {
  const tasks: MaintenanceTask[] = [];
  const technicians = ['R. Okafor', 'M. Lindqvist', 'A. Bhatt', 'J. Moreau', 'S. Tanaka'];

  for (const station of stations) {
    const health = healthByStation.get(station.id) ?? [];
    for (const h of health) {
      if (h.band === 'healthy') continue;
      const sensor = station.sensors.find((s) => s.id === h.sensorId);
      const priority = PRIORITY_BY_BAND[h.band];
      const dueDays = priority === 'critical' ? 2 : priority === 'high' ? 7 : 21;
      const rng = makeRng(`task:${h.sensorId}`);
      const r = rng();
      const status: MaintenanceTask['status'] =
        priority === 'critical' ? 'open' : r < 0.25 ? 'assigned' : r < 0.4 ? 'scheduled' : r < 0.5 ? 'in_progress' : 'open';

      tasks.push({
        id: `MT-${station.id.slice(4)}${h.type.slice(0, 2).toUpperCase()}`,
        stationId: station.id,
        sensorId: h.sensorId,
        sensorType: h.type,
        priority,
        title: `${station.id} ${SENSOR_LABELS[h.type].toLowerCase()} — ${bandLabel(h.band).toLowerCase()}`,
        action: h.recommendation,
        reason: h.factors.length
          ? `${h.factors[0].label}: ${h.factors[0].detail}`
          : `Health score ${h.score}/100.`,
        status,
        assignee: status === 'open' ? null : technicians[Math.floor(rng() * technicians.length)],
        dueAt: now + dueDays * DAY,
        createdAt: now - Math.floor(rng() * 3) * DAY,
        estimatedHours: sensor?.type === 'pressure' ? 1.5 : 2.5,
      });
    }
  }

  const order: Record<Severity, number> = { critical: 0, high: 1, warning: 2, info: 3 };
  return tasks.sort((a, b) => order[a.priority] - order[b.priority] || a.stationId.localeCompare(b.stationId));
}
