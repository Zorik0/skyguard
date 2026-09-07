import type { SensorType } from '@/types';
import type { World } from '@/lib/world';
import { clamp, mean, median, MINUTE, round, stdev } from '@/lib/utils';
import { readingValue } from '@/lib/neighbours';
import { twinValue } from '@/lib/physics/rules';
import { hashSeed, makeRng } from '@/lib/rng';
import { isMeteorological } from '@/lib/simulation/events';
import {
  computeCorrection,
  computeShadowCorrection,
  PRODUCTION_MODEL,
  SHADOW_MODEL,
} from '@/lib/corrections/ensemble';

/**
 * Model laboratory.
 *
 * Detection methods are compared against the simulator's own ground truth —
 * the exact minutes during which a hardware fault was injected — rather than
 * against each other. That is only possible because this is a simulation, and
 * it is stated plainly wherever the numbers are shown: on real hardware you
 * would not have this label, which is precisely why explainability matters.
 */

export interface ModelSpec {
  id: string;
  name: string;
  description: string;
  /** True when the method is a deterministic stand-in rather than a real model. */
  simulated: boolean;
  threshold: number;
}

export const MODELS: ModelSpec[] = [
  {
    id: 'rules',
    name: 'Rule engine',
    description:
      'Fixed physical limits: rate of change, absolute range and cross-sensor coherence. Fires only on things the atmosphere cannot do.',
    simulated: false,
    threshold: 50,
  },
  {
    id: 'zscore',
    name: 'Statistical z-score',
    description:
      'Departure from a 90-minute trailing mean, in standard deviations. The classic first line of defence.',
    simulated: false,
    threshold: 50,
  },
  {
    id: 'rolling',
    name: 'Rolling deviation (robust)',
    description:
      'Median absolute deviation instead of the mean and standard deviation, so one large outlier cannot hide the next one.',
    simulated: false,
    threshold: 50,
  },
  {
    id: 'isolation',
    name: 'Isolation-Forest-style score',
    description:
      'Average isolation depth over sixteen random trees, normalised the way the real algorithm normalises it. Typical points sit near 50, so it carries a higher detection threshold than the scaled scores. Not a trained model.',
    simulated: true,
    // The normalised score centres near 50 by construction, so 50 would flag
    // roughly half of all samples. 0.62 is the conventional operating point.
    threshold: 62,
  },
  {
    id: 'twin',
    name: 'Digital-twin disagreement',
    description:
      'Distance between the station and its modelled expectation, normalised by the twin’s own error budget.',
    simulated: false,
    threshold: 50,
  },
  {
    id: 'ensemble',
    name: 'Ensemble (production)',
    description:
      'The scoring used in production: the rule engine, statistics and twin disagreement combined, with neighbour corroboration able to veto a fault verdict.',
    simulated: false,
    threshold: 50,
  },
];

export interface ModelResult {
  model: ModelSpec;
  /** Samples flagged above threshold. */
  detections: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  precision: number;
  recall: number;
  /** Minutes between fault onset and first detection; null when never detected. */
  detectionLatencyMinutes: number | null;
  peakScore: number;
  meanScore: number;
  /** Verdict for the current instant. */
  currentScore: number;
  currentClassification: 'fault' | 'clear';
  confidence: number;
  series: { t: number; score: number }[];
}

export interface LabEvaluation {
  stationId: string;
  sensorType: SensorType;
  /** Minutes in the window during which a hardware fault was actually active. */
  faultMinutes: number;
  windowMinutes: number;
  hasGroundTruth: boolean;
  results: ModelResult[];
}

/**
 * A one-dimensional Isolation Forest score.
 *
 * This follows the real algorithm's shape — build trees by splitting a random
 * subsample at random points, measure how few splits it takes to isolate the
 * value, and normalise the average depth by the expected depth for that
 * subsample size — so a typical point lands near 50 and a genuine outlier
 * climbs toward 100.
 *
 * It is still a stand-in: nothing here is fitted, and it is marked as simulated
 * everywhere it is shown. But it is calibrated the way the real score is,
 * rather than being a threshold dressed up as a model.
 */
const ISO_TREES = 16;
const ISO_SUBSAMPLE = 32;
const ISO_MAX_DEPTH = Math.ceil(Math.log2(ISO_SUBSAMPLE));
const EULER_MASCHERONI = 0.5772156649;

/** Expected path length of an unsuccessful search in a binary tree of n nodes. */
function expectedPathLength(n: number): number {
  if (n <= 1) return 0;
  const harmonic = Math.log(n - 1) + EULER_MASCHERONI;
  return 2 * harmonic - (2 * (n - 1)) / n;
}

function isolationScoreFor(value: number, window: number[], rng: () => number): number {
  if (window.length < 8) return 0;

  let depthSum = 0;
  for (let tree = 0; tree < ISO_TREES; tree++) {
    // Each tree sees its own random subsample, as in the real algorithm.
    let lo = Infinity;
    let hi = -Infinity;
    const take = Math.min(ISO_SUBSAMPLE, window.length);
    for (let k = 0; k < take; k++) {
      const sample = window[Math.floor(rng() * window.length)];
      if (sample < lo) lo = sample;
      if (sample > hi) hi = sample;
    }

    let a = Math.min(lo, value);
    let b = Math.max(hi, value);
    let depth = 0;
    while (depth < ISO_MAX_DEPTH && b - a > 1e-9) {
      const split = a + rng() * (b - a);
      depth++;
      // Isolated once the surviving partition holds no sampled points.
      if (value < split) {
        b = split;
        if (b <= lo) break;
      } else {
        a = split;
        if (a >= hi) break;
      }
    }
    // Points that never isolate inherit the expected remaining depth.
    depthSum += depth + (depth >= ISO_MAX_DEPTH ? expectedPathLength(take) : 0);
  }

  const meanDepth = depthSum / ISO_TREES;
  const normaliser = expectedPathLength(Math.min(ISO_SUBSAMPLE, window.length));
  if (normaliser <= 0) return 0;
  return clamp(2 ** (-meanDepth / normaliser) * 100, 0, 100);
}

/** Was a hardware (non-meteorological) fault injected on this channel at time t? */
function groundTruthAt(world: World, stationId: string, sensorType: SensorType, t: number) {
  return world.events.some((e) => {
    if (e.scope !== 'station' || e.stationId !== stationId) return false;
    if (isMeteorological(e.kind)) return false;
    // Communications and power faults affect every channel at the station.
    const channelScoped = e.sensorType && !['comms', 'battery'].includes(e.sensorType);
    if (channelScoped && e.sensorType !== sensorType) return false;
    return t >= e.startAt && t <= e.startAt + e.duration;
  });
}

export function evaluateModels(
  world: World,
  stationId: string,
  sensorType: SensorType,
  windowMs: number,
): LabEvaluation | null {
  const series = world.seriesById.get(stationId);
  const station = world.snapshotById.get(stationId)?.station;
  if (!series || !station) return null;

  const total = series.raw.length;
  const startIndex = clamp(total - Math.round(windowMs / world.stepMs), 0, total - 1);
  const baselineSpan = Math.round((90 * MINUTE) / world.stepMs);
  const guard = Math.round((6 * MINUTE) / world.stepMs);

  const values: (number | null)[] = series.raw.map((r) =>
    r.received ? readingValue(r, sensorType) : null,
  );

  const twinTolerance = world.config.twinTolerance[sensorType] ?? 3;
  const rateLimit =
    sensorType === 'temperature' ? world.config.maxTempRateCPerMin
    : sensorType === 'pressure' ? world.config.maxPressureRateHpaPerMin
    : sensorType === 'humidity' ? world.config.maxHumidityRatePctPerMin
    : world.config.maxWindRateMsPerMin;

  const range =
    sensorType === 'temperature' ? world.config.tempRange
    : sensorType === 'humidity' ? world.config.humidityRange
    : sensorType === 'wind_speed' ? world.config.windRange
    : null;

  const isoSeed = hashSeed(`iso:${stationId}:${sensorType}:${world.seed}`);
  const scores = new Map<string, { t: number; score: number }[]>(
    MODELS.map((m) => [m.id, []]),
  );
  const truth: boolean[] = [];
  const times: number[] = [];

  for (let i = startIndex; i < total; i++) {
    const t = series.raw[i].t;
    const v = values[i];
    times.push(t);
    truth.push(groundTruthAt(world, stationId, sensorType, t));

    if (v === null || i < baselineSpan + guard) {
      for (const m of MODELS) scores.get(m.id)!.push({ t, score: 0 });
      continue;
    }

    const window: number[] = [];
    for (let k = i - baselineSpan - guard; k < i - guard; k++) {
      const kv = values[k];
      if (kv !== null) window.push(kv);
    }
    if (window.length < 20) {
      for (const m of MODELS) scores.get(m.id)!.push({ t, score: 0 });
      continue;
    }

    // --- Rule engine -----------------------------------------------------
    const prev = values[i - 1];
    const rate = prev !== null ? Math.abs(v - prev) / (world.stepMs / MINUTE) : 0;
    const outOfRange = range ? v < range[0] || v > range[1] : false;
    const ruleScore = clamp(
      (rate > rateLimit ? 60 + Math.min(35, (rate / rateLimit) * 6) : 0) + (outOfRange ? 40 : 0),
      0,
      100,
    );

    // --- z-score ---------------------------------------------------------
    const m0 = mean(window);
    const sd = Math.max(stdev(window), 1e-6);
    const z = Math.abs(v - m0) / sd;
    const zScore = clamp((z / 10) * 100, 0, 100);

    // --- Robust rolling deviation ----------------------------------------
    const med = median(window);
    const mad = Math.max(1.4826 * median(window.map((x) => Math.abs(x - med))), 1e-6);
    const robustZ = Math.abs(v - med) / mad;
    const rollingScore = clamp((robustZ / 12) * 100, 0, 100);

    // --- Isolation-Forest-style stand-in ---------------------------------
    const isolationScore = isolationScoreFor(v, window, makeRng(isoSeed + i));

    // --- Digital-twin disagreement ---------------------------------------
    const tv = twinValue(series.twin[i], sensorType);
    const twinScore = tv === null ? 0 : clamp((Math.abs(v - tv) / twinTolerance / 3) * 100, 0, 100);

    // --- Production ensemble ---------------------------------------------
    const ensembleScore = clamp(
      0.4 * ruleScore + 0.24 * zScore + 0.16 * rollingScore + 0.2 * twinScore,
      0,
      100,
    );

    scores.get('rules')!.push({ t, score: round(ruleScore, 1) });
    scores.get('zscore')!.push({ t, score: round(zScore, 1) });
    scores.get('rolling')!.push({ t, score: round(rollingScore, 1) });
    scores.get('isolation')!.push({ t, score: round(isolationScore, 1) });
    scores.get('twin')!.push({ t, score: round(twinScore, 1) });
    scores.get('ensemble')!.push({ t, score: round(ensembleScore, 1) });
  }

  const faultMinutes = truth.filter(Boolean).length;
  const firstFaultIndex = truth.indexOf(true);

  const results: ModelResult[] = MODELS.map((model) => {
    const s = scores.get(model.id)!;
    let tp = 0;
    let fp = 0;
    let fn = 0;
    let latency: number | null = null;

    for (let i = 0; i < s.length; i++) {
      const detected = s[i].score >= model.threshold;
      if (detected && truth[i]) {
        tp++;
        if (latency === null && firstFaultIndex >= 0) {
          latency = Math.round(((i - firstFaultIndex) * world.stepMs) / MINUTE);
        }
      } else if (detected && !truth[i]) fp++;
      else if (!detected && truth[i]) fn++;
    }

    const detections = tp + fp;
    const values2 = s.map((x) => x.score);
    const current = s[s.length - 1]?.score ?? 0;

    return {
      model,
      detections,
      truePositives: tp,
      falsePositives: fp,
      falseNegatives: fn,
      precision: detections ? round((tp / detections) * 100, 1) : 0,
      recall: faultMinutes ? round((tp / faultMinutes) * 100, 1) : 0,
      detectionLatencyMinutes: latency,
      peakScore: round(Math.max(0, ...values2), 1),
      meanScore: round(mean(values2), 1),
      currentScore: current,
      currentClassification: current >= model.threshold ? 'fault' : 'clear',
      confidence: round(clamp(Math.abs(current - model.threshold) * 1.6 + 50, 50, 99), 0),
      series: s,
    };
  });

  return {
    stationId,
    sensorType,
    faultMinutes,
    windowMinutes: Math.round((times.length * world.stepMs) / MINUTE),
    hasGroundTruth: faultMinutes > 0,
    results,
  };
}

/* ---------------------------------------------------------------- shadow -- */

export interface ShadowComparison {
  anomalyId: string;
  stationId: string;
  sensorType: SensorType;
  production: number;
  shadow: number;
  delta: number;
  agrees: boolean;
}

export interface ShadowReport {
  production: string;
  shadow: string;
  comparisons: ShadowComparison[];
  agreementPercent: number;
  meanAbsoluteDifference: number;
}

/**
 * Shadow evaluation.
 *
 * The candidate model runs over exactly the inputs production used and its
 * output is recorded, compared and discarded. It never reaches a published
 * corrected value — that is the whole point of shadow mode.
 */
export function evaluateShadowModel(world: World): ShadowReport {
  const comparisons: ShadowComparison[] = [];

  for (const a of world.anomalies) {
    if (!a.correction || a.correction.confidence === 0) continue;
    const w = a.correction.weights;
    const get = (source: string) => w.find((x) => x.source === source)?.estimate ?? null;

    const inputs = {
      sensorType: a.sensorType,
      station: world.snapshotById.get(a.stationId)!.station,
      t: a.correction.t,
      rawValue: a.correction.rawValue,
      physics: get('Physics model'),
      ml: get('ML estimate'),
      neighbours: get('Neighbouring stations'),
      external: get('External weather model'),
      history: get('Recent sensor history'),
    };

    const production = computeCorrection(inputs).correctedValue;
    const shadow = computeShadowCorrection(inputs).correctedValue;
    const tolerance = Math.max(
      0.5,
      (a.correction.interval[1] - a.correction.interval[0]) / 2,
    );

    comparisons.push({
      anomalyId: a.id,
      stationId: a.stationId,
      sensorType: a.sensorType,
      production,
      shadow,
      delta: round(shadow - production, 2),
      agrees: Math.abs(shadow - production) <= tolerance,
    });
  }

  const agree = comparisons.filter((c) => c.agrees).length;
  return {
    production: PRODUCTION_MODEL,
    shadow: SHADOW_MODEL,
    comparisons,
    agreementPercent: comparisons.length ? round((agree / comparisons.length) * 100, 1) : 100,
    meanAbsoluteDifference: comparisons.length
      ? round(mean(comparisons.map((c) => Math.abs(c.delta))), 2)
      : 0,
  };
}
