import type { DetectorType, SensorType, Station } from '@/types';
import { clamp, HOUR, MINUTE, round } from '@/lib/utils';
import type { PhysicsConfig } from '@/lib/physics/rules';
import { readingValue, type StationSeries } from '@/lib/neighbours';

/**
 * Local, explainable anomaly detection — STAGE 1 of the pipeline.
 *
 * Every detector is a stated statistical or physical test with a threshold an
 * operator can read and change. There is no black-box score: the number that
 * comes out is a weighted sum of named tests, and the tests travel with it.
 *
 * ─── What this file does, in one paragraph ───────────────────────────────
 *
 * It reads one sensor channel — say the temperature at AWS-007 for the last
 * 24 hours, 1440 numbers — and returns a list of *episodes*: stretches of
 * time where something looked wrong, each labelled with which tests fired and
 * how hard. It does NOT decide whether the cause was weather or a broken
 * probe. That judgement happens later, in `classify.ts`, and keeping the two
 * apart is deliberate: detection asks "is this unusual?", classification asks
 * "why?".
 *
 * ─── The seven tests ─────────────────────────────────────────────────────
 *
 *   spike / drop      value is far from its own recent average
 *   rate_of_change    value moved faster than physics allows
 *   frozen            value has not changed at all — a dead channel
 *   noise             the channel became much jitterier than usual
 *   drift             a slow, persistent offset from what we expected
 *   range             value is outside what the instrument can even produce
 *
 * Read `scanSensor` below; each test is one clearly marked block inside its
 * main loop.
 */

/**
 * Sensors that get a full time-series scan.
 *
 * Wind *direction* is deliberately absent: it wraps around at 360°, so a
 * shift from 359° to 1° is a 2° change that naive statistics would score as
 * 358°. Handling that correctly needs circular statistics, which would add
 * complexity for very little diagnostic value.
 */
export const SCANNED_SENSORS: SensorType[] = [
  'temperature',
  'humidity',
  'pressure',
  'wind_speed',
  'rainfall',
];

/** One test firing at one instant. */
export interface DetectorHit {
  type: DetectorType;
  /** 0..1 — how strongly this detector fired. */
  strength: number;
  /** Human-readable evidence, e.g. "4.2 above the 90-minute baseline (7.1σ)". */
  detail: string;
}

/**
 * A contiguous stretch of flagged samples, collapsed into one finding.
 *
 * Without this step a 40-minute fault would produce 40 separate alerts. An
 * operator wants one item on their list that says "AWS-007 temperature,
 * 14:32–15:12, peaked at 61.4 °C".
 */
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

/**
 * Prefix-sum rolling statistics — O(n) for the whole series.
 *
 * ─── The performance trick worth learning ────────────────────────────────
 *
 * We need the mean and standard deviation of a 90-minute window ending at
 * *every* sample. The obvious version re-adds 90 numbers 1440 times, for
 * ~130,000 additions per channel — times 5 channels times 12 stations, on
 * every clock tick. That is slow enough to feel.
 *
 * A prefix sum precomputes the running total once:
 *
 *   values     3    1    4    1    5
 *   sum     0  3    4    8    9   14
 *              ↑              ↑
 *   The sum of values[1..4) is sum[4] - sum[1] = 9 - 3 = 6.  One subtraction.
 *
 * Storing the running sum of *squares* alongside it gives the variance too,
 * via Var(X) = E[X²] − E[X]². So any window's statistics cost the same three
 * subtractions regardless of whether the window spans 10 samples or 10,000.
 * The whole scan becomes O(n) instead of O(n × windowSize).
 *
 * `Float64Array` / `Int32Array` are typed arrays: fixed-size, single-type,
 * and considerably faster than a normal JavaScript array here.
 */
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
  /** Milliseconds between samples — one minute in this simulation. */
  stepMs: number;
  /** Departure in σ that counts as a detection. Typically 3.5–4. */
  zThreshold: number;
}

/**
 * Per-sensor floor on the σ used for z-scores, so quiet periods do not
 * produce enormous z values from instrument noise alone.
 *
 * Why this is needed: a z-score divides by σ, and on a still night the
 * temperature σ can fall to 0.05 °C. A perfectly ordinary 0.5 °C wobble then
 * scores 10σ and the operator gets a false alarm. Flooring σ at a realistic
 * instrument-noise level stops the maths from dividing by almost nothing.
 *
 * Every threshold in this file was tuned against the simulator; on real
 * hardware you would fit them from a few weeks of quiet data.
 */
const SD_FLOOR: Record<string, number> = {
  temperature: 0.28,
  humidity: 1.1,
  pressure: 0.14,
  wind_speed: 0.55,
  rainfall: 0.02,
};

/**
 * Minimum absolute departure worth reporting at all.
 *
 * The second half of the same defence. A finding must be *both* statistically
 * unusual (high z) and physically meaningful (a real number of degrees).
 * A 1.6 °C move is the smallest temperature excursion worth an operator's
 * attention no matter how quiet the channel was beforehand.
 */
const MIN_DELTA: Record<string, number> = {
  temperature: 1.6,
  humidity: 6,
  pressure: 0.9,
  wind_speed: 3.2,
  rainfall: 0.05,
};

/**
 * Scan one sensor channel and return the episodes worth investigating.
 *
 * This is the heart of the file. Read it in three parts:
 *
 *   1. Setup — convert every time span (90 minutes, 6 hours…) into a number
 *      of samples, and build the prefix-sum table.
 *   2. The main loop — for each sample, run all seven tests and record any
 *      that fire in `flagged[i]`.
 *   3. `mergeEpisodes` — collapse runs of flagged samples into findings.
 *
 * @param series          Raw readings plus the digital twin's expectation.
 * @param sensorType      Which channel to scan.
 * @param twinTolerance   How far from the twin is acceptable, in native units.
 * @param cfg             Thresholds, scaled by the operator sensitivity dial.
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

  // A packet that never arrived is `null`, not zero. Writing zero would tell
  // the detectors the temperature dropped to 0 °C, inventing a fault out of a
  // radio problem. Missing data must stay missing all the way through.
  const values: (number | null)[] = raw.map((r) => (r.received ? readingValue(r, sensorType) : null));
  const rolling = new Rolling(values);
  const perMin = cfg.stepMs / MINUTE;

  // Every window below is written as a duration and converted to a sample
  // count here, so the code still reads correctly if the sampling interval
  // changes from one minute to five.
  const baselineSpan = Math.round((90 * MINUTE) / cfg.stepMs); // "normal" reference
  const guard = Math.round((6 * MINUTE) / cfg.stepMs);         // see below
  const noiseSpan = Math.round((30 * MINUTE) / cfg.stepMs);    // recent jitter
  const refSpan = Math.round((6 * HOUR) / cfg.stepMs);         // jitter comparison
  const driftSpan = Math.round((60 * MINUTE) / cfg.stepMs);    // offset persistence
  const frozenSpan = Math.round((20 * MINUTE) / cfg.stepMs);   // dead-channel patience

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

  // Start at `baselineSpan + guard` because earlier samples have no full
  // history behind them to compare against.
  for (let i = baselineSpan + guard; i < n; i++) {
    const v = values[i];
    if (v === null) continue;

    // ─── The baseline, and why there is a gap before it ──────────────────
    //
    // We compare each sample against the 90 minutes ending *six minutes ago*,
    // not the 90 minutes ending now. That six-minute `guard` matters: a fault
    // that ramps up over a few minutes would otherwise contaminate its own
    // reference window, dragging the baseline toward the fault and shrinking
    // the departure we are trying to measure. This is called leakage, and it
    // is one of the easiest ways to build a detector that quietly misses the
    // very events it was written for.
    //
    //   ├──── baseline: 90 min ────┤├guard┤│
    //                                      ↑ sample i under test
    const base = rolling.stats(i - baselineSpan - guard, i - guard);
    if (!Number.isFinite(base.mean)) continue;
    const sd = Math.max(base.sd, sdFloor);
    const delta = v - base.mean;

    // ─── The z-score ──────────────────────────────────────────────────────
    //
    //   z = |value − baseline mean| ÷ baseline σ
    //
    // "How many typical wobbles away from normal is this?" It is unit-free,
    // so the same threshold works for °C, hPa and m/s, and it automatically
    // adapts: on a volatile channel σ is large and a big departure scores
    // low; on a steady one the same departure screams.
    //
    //   z = 1   entirely ordinary (≈32% of samples exceed this)
    //   z = 2   uncommon (≈5%)
    //   z = 3   rare (≈0.3%)
    //   z = 4   the default alarm point here
    const z = Math.abs(delta) / sd;
    deltas[i] = delta;
    baselines[i] = base.mean;

    const hits: DetectorHit[] = [];

    // --- TEST 1: Sudden spike / drop -------------------------------------
    // Note the `&&`: statistically unusual AND physically meaningful. Either
    // test alone produces alarms nobody wants.
    if (z >= cfg.zThreshold && Math.abs(delta) >= minDelta) {
      hits.push({
        type: delta > 0 ? 'spike' : 'drop',
        strength: clamp((z - cfg.zThreshold) / 12 + 0.35, 0, 1),
        detail: `${round(Math.abs(delta), 2)} ${delta > 0 ? 'above' : 'below'} the 90-minute baseline (${round(z, 1)}σ)`,
      });
    }

    // --- TEST 2: Rate-of-change ------------------------------------------
    // A statistics-free test, and the most decisive one in the whole system.
    // Air has thermal mass: surface temperature simply cannot move 40 °C in
    // sixty seconds. No amount of unusual weather makes it possible, so a
    // violation here is close to proof of a hardware fault.
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

    // --- TEST 3: Frozen channel -------------------------------------------
    // A working sensor always jitters slightly — real air is turbulent and
    // every ADC has noise in its last digit. Twenty minutes of *bit-identical*
    // readings therefore means the channel has stopped measuring: a seized
    // anemometer, a detached probe, or firmware repeating its last buffer.
    //
    // Rainfall is excluded for the obvious reason: 0.0 mm for twenty minutes
    // is what a rain gauge does on a dry day.
    if (sensorType !== 'rainfall' && runLength[i] > frozenSpan) {
      hits.push({
        type: 'frozen',
        strength: 0.95,
        detail: `Identical value (${round(v, 2)}) repeated for ${Math.round((runLength[i] * cfg.stepMs) / MINUTE)} minutes`,
      });
    }

    // --- TEST 4: Excessive noise ------------------------------------------
    // Compare the channel's jitter over the last 30 minutes against its jitter
    // six hours ago. The *level* can legitimately change all day; a sudden
    // 3.5× jump in variance cannot, and usually means a corroding connector or
    // water in a terminal block.
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

    // --- TEST 5: Gradual drift against the digital twin --------------------
    // The hardest fault to catch. Drift is slow enough that every individual
    // reading looks plausible — no spike, no rate violation, nothing a
    // threshold would catch. It is only visible as a *persistent* offset from
    // what we expected, so we require the gap to hold for 85% of a full hour.
    //
    // Weather moves and then moves back. A drifting probe does not.
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

    // --- TEST 6: Range violation ------------------------------------------
    // The simplest test in the file and among the most useful: is the number
    // even inside what this instrument can physically output? A thermistor
    // rated -48..56 °C reporting 61.4 °C is not describing the atmosphere —
    // it is describing its own failure.
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

/**
 * Communications, power and calibration checks — station-level, not
 * per-channel.
 *
 * These faults are about the station as a device rather than any one probe: a
 * flat battery takes every channel down with it, so it would be wrong to
 * report it five times. They are also not judgement calls — a missing packet
 * is missing, and there is no weather hypothesis to weigh against it.
 *
 * Note the pattern used three times below for finding runs: remember where a
 * bad stretch started (`runStart`), and when a good sample arrives, close the
 * run if it was long enough to matter. The `if (runStart >= 0)` after each
 * loop handles the case where the series ends mid-fault.
 */
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
