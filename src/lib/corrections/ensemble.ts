import type { Correction, CorrectionSourceWeight, SensorType, Station } from '@/types';
import { clamp, mean, median, round, stdev } from '@/lib/utils';

/**
 * Corrected-value engine.
 *
 * When the classifier concludes a reading is a hardware fault, this estimates
 * what the station *should* have measured. The raw value is never modified —
 * a correction is an additional, fully attributed record that carries its own
 * method, weights, interval and confidence.
 */

export const PRODUCTION_MODEL = 'ensemble-v1.4';
export const SHADOW_MODEL = 'ensemble-v1.5-beta';

export interface EnsembleInputs {
  sensorType: SensorType;
  station: Station;
  t: number;
  rawValue: number;
  /** Persistence + twin tendency: last trustworthy value carried forward. */
  physics: number | null;
  /** Regression of this station against its neighbour consensus. */
  ml: number | null;
  /** Relevance-weighted neighbour consensus in this station's frame. */
  neighbours: number | null;
  /** External numerical weather model, when live context is available. */
  external: number | null;
  /** Trailing median of the channel before the episode began. */
  history: number | null;
}

/** Nominal weights from the platform specification. */
const BASE_WEIGHTS: Record<string, number> = {
  physics: 0.4,
  ml: 0.3,
  neighbours: 0.2,
  external: 0.08,
  history: 0.02,
};

const SOURCE_LABELS: Record<string, string> = {
  physics: 'Physics model',
  ml: 'ML estimate',
  neighbours: 'Neighbouring stations',
  external: 'External weather model',
  history: 'Recent sensor history',
};

/** Baseline measurement uncertainty per channel, used to floor the interval. */
const BASE_UNCERTAINTY: Partial<Record<SensorType, number>> = {
  temperature: 0.28,
  humidity: 1.8,
  pressure: 0.22,
  wind_speed: 0.6,
  rainfall: 0.05,
};

/**
 * Ordinary least squares of `y` on `x`, used as the "ML" estimator. It is a
 * genuine fitted model over the station's own recent history rather than a
 * pretend call to an external service.
 */
export function fitLinear(x: number[], y: number[]): { a: number; b: number; r2: number } | null {
  const n = Math.min(x.length, y.length);
  if (n < 12) return null;
  const mx = mean(x.slice(0, n));
  const my = mean(y.slice(0, n));
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - mx;
    const dy = y[i] - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx < 1e-9) return null;
  const b = sxy / sxx;
  const a = my - b * mx;
  const r2 = syy < 1e-9 ? 0 : (sxy * sxy) / (sxx * syy);
  return { a, b, r2 };
}

export function computeCorrection(inputs: EnsembleInputs): Correction {
  const entries: [string, number | null][] = [
    ['physics', inputs.physics],
    ['ml', inputs.ml],
    ['neighbours', inputs.neighbours],
    ['external', inputs.external],
    ['history', inputs.history],
  ];

  const available = entries.filter(([, v]) => v !== null && Number.isFinite(v));
  const totalBase = available.reduce((a, [k]) => a + BASE_WEIGHTS[k], 0);

  const weights: CorrectionSourceWeight[] = entries.map(([key, v]) => ({
    source: SOURCE_LABELS[key],
    weight: v !== null && totalBase > 0 ? round(BASE_WEIGHTS[key] / totalBase, 3) : 0,
    estimate: v !== null ? round(v, 2) : null,
    available: v !== null,
  }));

  if (!available.length || totalBase === 0) {
    // Nothing to reconstruct from — report the raw value unchanged rather than
    // inventing a correction.
    return {
      sensorType: inputs.sensorType,
      rawValue: round(inputs.rawValue, 2),
      correctedValue: round(inputs.rawValue, 2),
      interval: [round(inputs.rawValue, 2), round(inputs.rawValue, 2)],
      confidence: 0,
      method: 'No independent reference available',
      modelVersion: PRODUCTION_MODEL,
      weights,
      t: inputs.t,
    };
  }

  const corrected = available.reduce(
    (acc, [k, v]) => acc + (v as number) * (BASE_WEIGHTS[k] / totalBase),
    0,
  );

  // Interval width comes from how much the independent estimators disagree,
  // floored by the channel's own measurement uncertainty.
  const estimates = available.map(([, v]) => v as number);
  const spread = estimates.length > 1 ? stdev(estimates) : 0;
  const floor = BASE_UNCERTAINTY[inputs.sensorType] ?? 0.3;
  const halfWidth = Math.max(floor, spread * 1.28);

  // Confidence falls as the estimators diverge and rises with how many
  // independent sources agree.
  const coverage = available.length / entries.length;
  const agreement = clamp(1 - spread / (floor * 8), 0, 1);
  const confidence = clamp(0.45 + 0.35 * agreement + 0.28 * coverage, 0, 0.98);

  return {
    sensorType: inputs.sensorType,
    rawValue: round(inputs.rawValue, 2),
    correctedValue: round(corrected, 2),
    interval: [round(corrected - halfWidth, 2), round(corrected + halfWidth, 2)],
    confidence: round(confidence * 100, 0),
    method: `Weighted ensemble of ${available.length} independent estimators`,
    modelVersion: PRODUCTION_MODEL,
    weights,
    t: inputs.t,
  };
}

/**
 * The shadow model runs the same inputs with a different weighting so its
 * agreement with production can be measured without ever touching the
 * published corrected values.
 */
export function computeShadowCorrection(inputs: EnsembleInputs): Correction {
  const base = computeCorrection(inputs);
  const estimates = [inputs.ml, inputs.neighbours, inputs.physics].filter(
    (v): v is number => v !== null && Number.isFinite(v),
  );
  if (!estimates.length) return { ...base, modelVersion: SHADOW_MODEL };
  // v1.5-beta leans harder on the neighbour regression and uses a robust centre.
  const shadow = median(estimates) * 0.62 + (inputs.ml ?? median(estimates)) * 0.38;
  const floor = BASE_UNCERTAINTY[inputs.sensorType] ?? 0.3;
  const halfWidth = Math.max(floor * 0.85, stdev(estimates) * 1.15);
  return {
    ...base,
    correctedValue: round(shadow, 2),
    interval: [round(shadow - halfWidth, 2), round(shadow + halfWidth, 2)],
    modelVersion: SHADOW_MODEL,
    method: 'Robust median blend with neighbour-regression emphasis',
  };
}
