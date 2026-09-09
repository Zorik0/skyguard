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
 *
 * ─── Precision and recall, which every project like this needs ───────────
 *
 * "Accuracy" is a trap here. Faults occupy perhaps 40 minutes of a 1440-minute
 * day, so a detector that reports "no fault, ever" scores 97% accurate and is
 * completely useless. Two numbers are needed instead:
 *
 *   PRECISION = true positives ÷ everything I flagged
 *               "when I raise an alarm, how often am I right?"
 *               Low precision → operators stop trusting the alerts.
 *
 *   RECALL    = true positives ÷ every fault that actually happened
 *               "of the real faults, how many did I catch?"
 *               Low recall → broken data reaches whoever depends on it.
 *
 * They trade against each other, and the trade is the interesting part. Lower
 * the threshold and recall rises while precision falls; raise it and the
 * reverse. There is no setting that maximises both, so choosing one is an
 * operational decision about which mistake costs more — which is exactly why
 * this page exposes the dial rather than hiding it.
 *
 * ─── The honest caveat, worth saying out loud in a viva ──────────────────
 *
 * These scores exist only because a simulator knows which minutes were faults.
 * Real hardware never comes with that label. That is not a weakness of the
 * demonstration — it is the reason the production path publishes evidence and
 * rules rather than a score alone: those can be checked by a human on data
 * that has no ground truth at all.
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
      'A real Isolation Forest — 32 trees fitted over the window, given the multivariate feature vector the method is designed for. Its score is centred by construction, so it carries a higher detection threshold than the scaled scores.',
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
 * Isolation Forest — the one genuine machine-learning model in the codebase.
 *
 * The real algorithm, implemented properly rather than approximated: a forest
 * is *fitted once* over the whole window, each tree splitting a random
 * subsample on a random feature at a random point, and every sample is then
 * scored by its average path length normalised against the expected path
 * length for that subsample size.
 *
 * It is given the feature vector it is designed for — Isolation Forest is a
 * multivariate method, and handing it a single channel would be testing a
 * strawman. The features below are the same quantities the other detectors
 * look at, so the comparison in the Model Lab is a fair one.
 *
 * Nothing here is trained on labels; it is an unsupervised fit over the
 * window being examined, and it is marked as simulated wherever it is shown.
 *
 * ─── The idea, which is unusually elegant ────────────────────────────────
 *
 * Most outlier detectors describe what *normal* looks like and measure
 * distance from it. Isolation Forest inverts the problem: outliers are easier
 * to separate from everything else, so just count how much effort separation
 * takes.
 *
 * Build a tree by repeatedly picking a random feature and a random split point
 * until every point sits alone. Then ask how deep each point ended up:
 *
 *   ordinary point   surrounded by neighbours, needs ~12 splits to isolate
 *   outlier          sitting alone in empty space, isolated in ~3
 *
 * Average that depth over 32 independently random trees and the noise cancels
 * out. Short average path → anomaly.
 *
 * ─── Why it is unsupervised, and why that matters ────────────────────────
 *
 * It is never shown which samples are faults. It is handed the window and
 * finds the odd ones out on structure alone. That is the honest setting for
 * this problem: real hardware does not arrive labelled, so a supervised model
 * would need someone to hand-label thousands of faults first.
 *
 * ─── The maths, in three lines ───────────────────────────────────────────
 *
 *   c(n)     = 2·(ln(n−1) + γ) − 2(n−1)/n     expected path in a random tree
 *   score    = 2^(−averagePath / c(n))         normalise to 0..1
 *   0.5      = ordinary · toward 1 = anomalous · toward 0 = deep in a cluster
 *
 * γ ≈ 0.5772 is the Euler–Mascheroni constant, which appears because c(n) is
 * derived from the harmonic series. Dividing by c(n) is what makes scores from
 * differently-sized subsamples comparable.
 *
 * The `size` field on a leaf handles trees cut off at max depth: rather than
 * pretending those points were isolated, the leaf is charged the expected
 * remaining depth for the points still in it.
 */
const ISO_TREES = 32;
const ISO_SUBSAMPLE = 128;
const EULER_MASCHERONI = 0.5772156649;

/** Expected path length of an unsuccessful search in a binary tree of n nodes. */
function expectedPathLength(n: number): number {
  if (n <= 1) return 0;
  const harmonic = Math.log(n - 1) + EULER_MASCHERONI;
  return 2 * harmonic - (2 * (n - 1)) / n;
}

interface IsoNode {
  dim: number;
  split: number;
  left: IsoNode | null;
  right: IsoNode | null;
  /** Points remaining at a leaf, used to charge the expected remaining depth. */
  size: number;
}

function buildIsoTree(
  points: number[][],
  indices: number[],
  depth: number,
  maxDepth: number,
  dims: number,
  rng: () => number,
): IsoNode {
  if (depth >= maxDepth || indices.length <= 1) {
    return { dim: -1, split: 0, left: null, right: null, size: indices.length };
  }

  // Pick a feature that actually varies here; a constant one cannot split.
  let dim = -1;
  let min = 0;
  let max = 0;
  for (let attempt = 0; attempt < dims; attempt++) {
    const candidate = Math.floor(rng() * dims);
    let lo = Infinity;
    let hi = -Infinity;
    for (const i of indices) {
      const v = points[i][candidate];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (hi - lo > 1e-12) {
      dim = candidate;
      min = lo;
      max = hi;
      break;
    }
  }
  if (dim < 0) {
    return { dim: -1, split: 0, left: null, right: null, size: indices.length };
  }

  const split = min + rng() * (max - min);
  const left: number[] = [];
  const right: number[] = [];
  for (const i of indices) {
    if (points[i][dim] < split) left.push(i);
    else right.push(i);
  }

  return {
    dim,
    split,
    left: buildIsoTree(points, left, depth + 1, maxDepth, dims, rng),
    right: buildIsoTree(points, right, depth + 1, maxDepth, dims, rng),
    size: indices.length,
  };
}

function isoPathLength(node: IsoNode, point: number[], depth: number): number {
  if (node.dim < 0 || !node.left || !node.right) {
    return depth + expectedPathLength(node.size);
  }
  return point[node.dim] < node.split
    ? isoPathLength(node.left, point, depth + 1)
    : isoPathLength(node.right, point, depth + 1);
}

/** Fit a forest over the feature matrix and score every row against it. */
function isolationForestScores(features: number[][], rng: () => number): number[] {
  const n = features.length;
  if (n < 32) return new Array(n).fill(0);

  const dims = features[0].length;
  const take = Math.min(ISO_SUBSAMPLE, n);
  const maxDepth = Math.ceil(Math.log2(take));
  const normaliser = expectedPathLength(take);
  if (normaliser <= 0) return new Array(n).fill(0);

  const trees: IsoNode[] = [];
  for (let t = 0; t < ISO_TREES; t++) {
    const indices: number[] = new Array(take);
    for (let k = 0; k < take; k++) indices[k] = Math.floor(rng() * n);
    trees.push(buildIsoTree(features, indices, 0, maxDepth, dims, rng));
  }

  return features.map((point) => {
    let sum = 0;
    for (const tree of trees) sum += isoPathLength(tree, point, 0);
    return clamp(2 ** (-sum / trees.length / normaliser) * 100, 0, 100);
  });
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
  // Feature rows for the Isolation Forest, aligned with the scored samples.
  const features: number[][] = [];
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
      features.push([0, 0, 1, 0]);
      continue;
    }

    const window: number[] = [];
    for (let k = i - baselineSpan - guard; k < i - guard; k++) {
      const kv = values[k];
      if (kv !== null) window.push(kv);
    }
    if (window.length < 20) {
      for (const m of MODELS) scores.get(m.id)!.push({ t, score: 0 });
      features.push([0, 0, 1, 0]);
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

    const tv = twinValue(series.twin[i], sensorType);

    // --- Robust rolling deviation ----------------------------------------
    const med = median(window);
    const mad = Math.max(1.4826 * median(window.map((x) => Math.abs(x - med))), 1e-6);
    const robustZ = Math.abs(v - med) / mad;
    const rollingScore = clamp((robustZ / 12) * 100, 0, 100);

    // --- Isolation Forest features ----------------------------------------
    // The same quantities the other detectors examine, so the comparison is
    // between methods rather than between inputs. Scored after the scan, once
    // the forest has been fitted over the whole window.
    const recentSd = stdev(window.slice(-30));
    features.push([
      (v - m0) / sd,
      prev !== null ? (v - prev) / Math.max(sd, 1e-6) : 0,
      recentSd / Math.max(sd, 1e-6),
      tv === null ? 0 : (v - tv) / twinTolerance,
    ]);

    // --- Digital-twin disagreement ---------------------------------------
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
    scores.get('isolation')!.push({ t, score: 0 });
    scores.get('twin')!.push({ t, score: round(twinScore, 1) });
    scores.get('ensemble')!.push({ t, score: round(ensembleScore, 1) });
  }

  // Fit the forest over the whole window, then fill in its scores.
  const isolationScores = isolationForestScores(features, makeRng(isoSeed));
  const isolationSeries = scores.get('isolation')!;
  for (let k = 0; k < isolationSeries.length; k++) {
    isolationSeries[k].score = round(isolationScores[k] ?? 0, 1);
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
