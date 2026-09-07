import type { DetectorType, SensorType, Station } from '@/types';
import { clamp, HOUR, MINUTE, round } from '@/lib/utils';
import type { PhysicsConfig } from '@/lib/physics/rules';
import { readingValue, type StationSeries } from '@/lib/neighbours';

/**
 * Local, explainable anomaly detection.
 *
 * Every detector is a stated statistical or physical test with a threshold an
 * operator can read and change. There is no black-box score: the number that
 * comes out is a weighted sum of named tests, and the tests travel with it.
 */

/** Sensors that get a full time-series scan. */
export const SCANNED_SENSORS: SensorType[] = [
  'temperature',
  'humidity',
  'pressure',
  'wind_speed',
  'rainfall',
];

export interface DetectorHit {
  type: DetectorType;
  /** 0..1 — how strongly this detector fired. */
  strength: number;
  detail: string;
}

export interface Episode {
  stationId: string;
  sensorType: SensorType;
  startIndex: number;
  endIndex: number;
  peakIndex: number;
  detectorTypes: DetectorType[];
  hits: DetectorHit[];
  peakStrength: number;
  /** The detector that best characterises this episode. */
  dominant: DetectorType;
  /** Departure from the trailing baseline at the peak, in native units. */
  delta: number;
  baseline: number;
  value: number | null;
}

/** Prefix-sum rolling statistics — O(n) for the whole series. */
class Rolling {
  private sum: Float64Array;
  private sumSq: Float64Array;
  private count: Int32Array;

  constructor(private values: (number | null)[]) {
    const n = values.length;
    this.sum = new Float64Array(n + 1);
    this.sumSq = new Float64Array(n + 1);
    this.count = new Int32Array(n + 1);
    for (let i = 0; i < n; i++) {
      const v = values[i];
      const ok = v !== null && Number.isFinite(v);
      this.sum[i + 1] = this.sum[i] + (ok ? (v as number) : 0);
      this.sumSq[i + 1] = this.sumSq[i] + (ok ? (v as number) ** 2 : 0);
      this.count[i + 1] = this.count[i] + (ok ? 1 : 0);
    }
  }

  /** Statistics over [from, to). */
  stats(from: number, to: number) {
    const a = clamp(from, 0, this.values.length);
    const b = clamp(to, 0, this.values.length);
    const n = this.count[b] - this.count[a];
    if (n < 2) return { n, mean: NaN, sd: NaN };
    const s = this.sum[b] - this.sum[a];
    const sq = this.sumSq[b] - this.sumSq[a];
    const m = s / n;
    const varr = Math.max(0, sq / n - m * m) * (n / (n - 1));
    return { n, mean: m, sd: Math.sqrt(varr) };
  }
}

interface ScanConfig {
  physics: PhysicsConfig;
  stepMs: number;
  /** Departure in σ that counts as a detection. */
  zThreshold: number;
}

/** Per-sensor floor on the σ used for z-scores, so quiet periods do not
 *  produce enormous z values from instrument noise alone. */
const SD_FLOOR: Record<string, number> = {
  temperature: 0.28,
  humidity: 1.1,
  pressure: 0.14,
  wind_speed: 0.55,
  rainfall: 0.02,
};

/** Minimum absolute departure worth reporting at all. */
const MIN_DELTA: Record<string, number> = {
  temperature: 1.6,
  humidity: 6,
  pressure: 0.9,
  wind_speed: 3.2,
  rainfall: 0.05,
};

/**
 * Scan one sensor channel and return the episodes worth investigating.
 */
export function scanSensor(
  series: StationSeries,
  sensorType: SensorType,
  twinTolerance: number | undefined,
  cfg: ScanConfig,
): Episode[] {
  const { raw, twin } = series;
  const n = raw.length;
  if (n < 40) return [];

  const values: (number | null)[] = raw.map((r) => (r.received ? readingValue(r, sensorType) : null));
  const rolling = new Rolling(values);
  const perMin = cfg.stepMs / MINUTE;

  const baselineSpan = Math.round((90 * MINUTE) / cfg.stepMs);
  const guard = Math.round((6 * MINUTE) / cfg.stepMs);
  const noiseSpan = Math.round((30 * MINUTE) / cfg.stepMs);
  const refSpan = Math.round((6 * HOUR) / cfg.stepMs);
  const driftSpan = Math.round((60 * MINUTE) / cfg.stepMs);
  const frozenSpan = Math.round((20 * MINUTE) / cfg.stepMs);

  const sdFloor = SD_FLOOR[sensorType] ?? 0.3;
  const minDelta = MIN_DELTA[sensorType] ?? 1;

  const rateLimit: Partial<Record<SensorType, number>> = {
    temperature: cfg.physics.maxTempRateCPerMin,
    pressure: cfg.physics.maxPressureRateHpaPerMin,
    humidity: cfg.physics.maxHumidityRatePctPerMin,
    wind_speed: cfg.physics.maxWindRateMsPerMin,
  };

  /**
   * Length of the run of *identical* values ending at each sample.
   *
   * Flatness must be tested exactly, not through a variance threshold: a
   * prefix-sum variance of a constant series loses all its significant digits
   * to cancellation and lands anywhere between 0 and ~1e-7, which made frozen
   * channels detectable only for some values. An exact run length has no such
   * failure mode and costs one pass.
   */
  const runLength = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (v === null) runLength[i] = 0;
    else if (i > 0 && values[i - 1] === v) runLength[i] = runLength[i - 1] + 1;
    else runLength[i] = 1;
  }

  const flagged: (DetectorHit[] | null)[] = new Array(n).fill(null);
  const deltas = new Float64Array(n);
  const baselines = new Float64Array(n);

  for (let i = baselineSpan + guard; i < n; i++) {
    const v = values[i];
    if (v === null) continue;

    const base = rolling.stats(i - baselineSpan - guard, i - guard);
    if (!Number.isFinite(base.mean)) continue;
    const sd = Math.max(base.sd, sdFloor);
    const delta = v - base.mean;
    const z = Math.abs(delta) / sd;
    deltas[i] = delta;
    baselines[i] = base.mean;

    const hits: DetectorHit[] = [];

    // --- Sudden spike / drop --------------------------------------------
    if (z >= cfg.zThreshold && Math.abs(delta) >= minDelta) {
      hits.push({
        type: delta > 0 ? 'spike' : 'drop',
        strength: clamp((z - cfg.zThreshold) / 12 + 0.35, 0, 1),
        detail: `${round(Math.abs(delta), 2)} ${delta > 0 ? 'above' : 'below'} the 90-minute baseline (${round(z, 1)}σ)`,
      });
    }

    // --- Rate-of-change --------------------------------------------------
    const limit = rateLimit[sensorType];
    const prev = values[i - 1];
    if (limit !== undefined && prev !== null) {
      const rate = Math.abs(v - prev) / perMin;
      if (rate > limit) {
        hits.push({
          type: 'rate_of_change',
          strength: clamp(rate / (limit * 6), 0.4, 1),
          detail: `${round(rate, 2)} per minute against a configured limit of ${round(limit, 2)}`,
        });
      }
    }

    // --- Frozen channel ---------------------------------------------------
    if (sensorType !== 'rainfall' && runLength[i] > frozenSpan) {
      hits.push({
        type: 'frozen',
        strength: 0.95,
        detail: `Identical value (${round(v, 2)}) repeated for ${Math.round((runLength[i] * cfg.stepMs) / MINUTE)} minutes`,
      });
    }

    // --- Excessive noise ---------------------------------------------------
    if (i >= refSpan) {
      const recent = rolling.stats(i - noiseSpan, i + 1);
      const reference = rolling.stats(i - refSpan, i - refSpan + noiseSpan * 4);
      if (Number.isFinite(recent.sd) && Number.isFinite(reference.sd) && reference.sd > 1e-6) {
        const ratio = recent.sd / Math.max(reference.sd, sdFloor * 0.5);
        if (ratio > 3.5) {
          hits.push({
            type: 'noise',
            strength: clamp((ratio - 3.5) / 8 + 0.35, 0, 1),
            detail: `Variance ${round(ratio, 1)}× the reference period six hours earlier`,
          });
        }
      }
    }

    // --- Gradual drift against the digital twin ---------------------------
    if (twinTolerance !== undefined && i >= driftSpan) {
      let sustained = 0;
      let signedSum = 0;
      for (let k = i - driftSpan; k <= i; k++) {
        const kv = values[k];
        const tv = twinValueAt(twin, k, sensorType);
        if (kv === null || tv === null) continue;
        const d = kv - tv;
        if (Math.abs(d) > twinTolerance * 0.62) sustained++;
        signedSum += d;
      }
      const frac = sustained / driftSpan;
      // Drift is a *persistent offset with a quiet channel* — if the value is
      // also spiking, the spike detector owns it.
      if (frac > 0.85 && z < cfg.zThreshold) {
        hits.push({
          type: 'drift',
          strength: clamp(frac, 0.4, 0.95),
          detail: `Offset from the digital twin held for ${Math.round((driftSpan * cfg.stepMs) / MINUTE)} minutes (mean ${round(signedSum / driftSpan, 2)})`,
        });
      }
    }

    // --- Range violation ---------------------------------------------------
    const range =
      sensorType === 'temperature' ? cfg.physics.tempRange :
      sensorType === 'humidity' ? cfg.physics.humidityRange :
      sensorType === 'wind_speed' ? cfg.physics.windRange : null;
    if (range && (v < range[0] || v > range[1])) {
      hits.push({
        type: 'range',
        strength: 1,
        detail: `${round(v, 2)} is outside the possible range ${range[0]} to ${range[1]}`,
      });
    }

    if (hits.length) flagged[i] = hits;
  }

  return mergeEpisodes(series, sensorType, flagged, deltas, baselines, values, cfg.stepMs);
}

function twinValueAt(twin: StationSeries['twin'], i: number, s: SensorType): number | null {
  const t = twin[i];
  if (!t) return null;
  switch (s) {
    case 'temperature': return t.temperature;
    case 'humidity': return t.humidity;
    case 'pressure': return t.pressure;
    case 'wind_speed': return t.windSpeed;
    case 'rainfall': return t.rainfall;
    default: return null;
  }
}

/**
 * Which detector best describes the episode? The strongest one wins; ties are
 * broken by how diagnostic the finding is, so an out-of-range reading is named
 * for the range violation rather than the noise that accompanies it.
 */
const DETECTOR_PRIORITY: DetectorType[] = [
  'range', 'frozen', 'rate_of_change', 'spike', 'drop', 'drift', 'noise',
  'comms', 'missing', 'battery', 'neighbour', 'cross_sensor', 'calibration',
];

function dominantDetector(hits: DetectorHit[]): DetectorType {
  if (!hits.length) return 'spike';
  const max = Math.max(...hits.map((h) => h.strength));
  const tied = hits.filter((h) => h.strength >= max - 0.02);
  tied.sort(
    (a, b) => DETECTOR_PRIORITY.indexOf(a.type) - DETECTOR_PRIORITY.indexOf(b.type),
  );
  return tied[0].type;
}

/** Collapse contiguous flagged samples into episodes, bridging short gaps. */
function mergeEpisodes(
  series: StationSeries,
  sensorType: SensorType,
  flagged: (DetectorHit[] | null)[],
  deltas: Float64Array,
  baselines: Float64Array,
  values: (number | null)[],
  stepMs: number,
): Episode[] {
  const bridge = Math.round((12 * MINUTE) / stepMs);
  const episodes: Episode[] = [];
  let start = -1;
  let lastHit = -1;

  const close = () => {
    if (start < 0) return;
    const end = lastHit;
    let peak = start;
    let peakStrength = 0;
    const typeStrength = new Map<DetectorType, number>();
    for (let i = start; i <= end; i++) {
      const hits = flagged[i];
      if (!hits) continue;
      const s = Math.max(...hits.map((h) => h.strength));
      if (s > peakStrength) {
        peakStrength = s;
        peak = i;
      }
      for (const h of hits) {
        typeStrength.set(h.type, Math.max(typeStrength.get(h.type) ?? 0, h.strength));
      }
    }
    const peakHits = flagged[peak] ?? [];
    // Keep the strongest example of each detector type across the episode.
    const hits: DetectorHit[] = [...typeStrength.entries()].map(([type, strength]) => {
      const example =
        peakHits.find((h) => h.type === type) ??
        (flagged.slice(start, end + 1).flatMap((f) => f ?? []).find((h) => h.type === type) as DetectorHit);
      return { type, strength, detail: example?.detail ?? '' };
    });
    episodes.push({
      stationId: series.station.id,
      sensorType,
      dominant: dominantDetector(hits),
      startIndex: start,
      endIndex: end,
      peakIndex: peak,
      detectorTypes: hits.map((h) => h.type),
      hits,
      peakStrength,
      delta: deltas[peak],
      baseline: baselines[peak],
      value: values[peak],
    });
    start = -1;
  };

  for (let i = 0; i < flagged.length; i++) {
    if (flagged[i]) {
      if (start < 0) start = i;
      lastHit = i;
    } else if (start >= 0 && i - lastHit > bridge) {
      close();
    }
  }
  close();

  // Drop trivially short blips — one stray sample is noise, not an episode.
  const minLen = Math.max(1, Math.round((2 * MINUTE) / stepMs));
  return episodes.filter((e) => e.endIndex - e.startIndex + 1 >= minLen || e.peakStrength > 0.8);
}

export interface SubsystemFindings {
  missingRuns: { startIndex: number; endIndex: number }[];
  commsDegraded: { startIndex: number; endIndex: number; worstLoss: number }[];
  batteryLow: { startIndex: number; endIndex: number; minVolts: number } | null;
  calibrationOverdue: { sensorId: string; sensorType: SensorType; ageDays: number; intervalDays: number }[];
}

/** Communications, power and calibration checks — station-level, not per-channel. */
export function scanSubsystems(
  series: StationSeries,
  station: Station,
  now: number,
  stepMs: number,
): SubsystemFindings {
  const { raw } = series;
  const missingRuns: SubsystemFindings['missingRuns'] = [];
  const commsDegraded: SubsystemFindings['commsDegraded'] = [];

  let runStart = -1;
  for (let i = 0; i < raw.length; i++) {
    if (!raw[i].received) {
      if (runStart < 0) runStart = i;
    } else if (runStart >= 0) {
      if (i - runStart >= Math.round((3 * MINUTE) / stepMs)) {
        missingRuns.push({ startIndex: runStart, endIndex: i - 1 });
      }
      runStart = -1;
    }
  }
  if (runStart >= 0) missingRuns.push({ startIndex: runStart, endIndex: raw.length - 1 });

  let degStart = -1;
  let worst = 0;
  for (let i = 0; i < raw.length; i++) {
    const loss = raw[i].packetLoss;
    const bad = !raw[i].received || (loss !== null && loss > 25);
    if (bad) {
      if (degStart < 0) degStart = i;
      worst = Math.max(worst, loss ?? 100);
    } else if (degStart >= 0) {
      if (i - degStart >= Math.round((5 * MINUTE) / stepMs)) {
        commsDegraded.push({ startIndex: degStart, endIndex: i - 1, worstLoss: worst });
      }
      degStart = -1;
      worst = 0;
    }
  }
  if (degStart >= 0) commsDegraded.push({ startIndex: degStart, endIndex: raw.length - 1, worstLoss: worst });

  const volts = raw.map((r) => r.battery).filter((v): v is number => v !== null);
  const minVolts = volts.length ? Math.min(...volts) : 12.6;
  let batteryLow: SubsystemFindings['batteryLow'] = null;
  if (minVolts < 11.8) {
    const firstBad = raw.findIndex((r) => r.battery !== null && r.battery < 11.8);
    batteryLow = { startIndex: Math.max(0, firstBad), endIndex: raw.length - 1, minVolts: round(minVolts, 2) };
  }

  // Battery packs and modems are serviced, not calibrated against a standard.
  const CALIBRATED: SensorType[] = ['temperature', 'humidity', 'pressure', 'wind_speed', 'rainfall'];
  const calibrationOverdue = station.sensors
    .filter((s) => CALIBRATED.includes(s.type))
    .map((s) => ({
      sensorId: s.id,
      sensorType: s.type,
      ageDays: Math.round((now - s.lastCalibratedAt) / (24 * HOUR)),
      intervalDays: s.calibrationIntervalDays,
    }))
    .filter((s) => s.ageDays > s.intervalDays);

  return { missingRuns, commsDegraded, batteryLow, calibrationOverdue };
}
