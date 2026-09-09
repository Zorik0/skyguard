import type { Correction, CorrectionSourceWeight, SensorType, Station } from '@/types';
import { clamp, mean, median, round, stdev } from '@/lib/utils';

/**
 * Corrected-value engine — STAGE 4 of the pipeline.
 *
 * When the classifier concludes a reading is a hardware fault, this estimates
 * what the station *should* have measured. The raw value is never modified —
 * a correction is an additional, fully attributed record that carries its own
 * method, weights, interval and confidence.
 *
 * ─── The rule that matters most in this entire codebase ──────────────────
 *
 * THE RAW VALUE IS NEVER OVERWRITTEN.
 *
 * A correction is a new, separate record that sits *beside* the original,
 * carrying its own method, weights, interval and model version. The raw export
 * still contains 61.4 °C, faults included.
 *
 * This is not fussiness. Overwriting measurements destroys the only evidence
 * that the instrument was failing, makes the archive unauditable, and means a
 * later improvement to the correction model can never be applied to old data —
 * because the input it needed is gone. Climate records are decades long; the
 * software that touches them must be reversible.
 *
 * ─── Why five estimators instead of one good one ─────────────────────────
 *
 * Every method of guessing the true value has a blind spot:
 *
 *   physics (40%)     carry the last trustworthy reading forward along the
 *                     twin's tendency — excellent for the first minutes of a
 *                     fault, progressively worse the longer it lasts
 *   ml (30%)          least-squares fit of this station against its neighbour
 *                     consensus, trained on the 3 hours BEFORE the fault —
 *                     learns this station's own quirks, needs quiet history
 *   neighbours (20%)  relevance-weighted consensus — strong when the network
 *                     is dense, useless if the neighbours are also affected
 *   external (8%)     Open-Meteo's model — independent of our whole network,
 *                     but coarse: a grid cell, not this hilltop
 *   history (2%)      trailing median before the episode — crude, always
 *                     available, and a sanity anchor when all else fails
 *
 * Combining them means no single blind spot decides the answer, and — just as
 * usefully — the *disagreement* between them becomes the uncertainty estimate.
 * When five independent methods land within 0.2 °C, that agreement is
 * meaningful. When they scatter over 4 °C, the interval widens and says so.
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

/**
 * Nominal weights from the platform specification.
 *
 * They sum to 1.0 when every estimator is available. When one is missing —
 * the external API is down, say — the remaining weights are *renormalised*
 * (each divided by the total that survived) rather than the gap being silently
 * absorbed. Renormalising widens the prediction interval honestly; absorbing
 * would bias the answer toward whichever estimator happened to be present.
 */
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

/**
 * Baseline measurement uncertainty per channel, used to floor the interval.
 *
 * Even if all five estimators agreed to the last decimal, we could not claim
 * to know the temperature to ±0.001 °C — the instrument itself is only good to
 * about ±0.28 °C. The interval can never be narrower than the physics allows.
 */
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
 *
 * ─── Yes, linear regression really is machine learning ───────────────────
 *
 * It learns parameters from data to predict unseen values, which is the whole
 * definition. It just happens to be the model you can fully explain, whose
 * training is exact rather than iterative, and which cannot be wrong in ways
 * nobody can account for. For "predict station A from the consensus of its
 * neighbours" that is a feature, not a compromise.
 *
 * The fit finds the line `y = a + b·x` minimising the squared vertical
 * distance to the points:
 *
 *   b (slope)     = Σ(x−x̄)(y−ȳ) ÷ Σ(x−x̄)²
 *   a (intercept) = ȳ − b·x̄
 *   r²            = the fraction of variance the line explains, 0..1
 *
 * `r²` is the honesty check. 0.95 means the neighbours predict this station
 * almost perfectly and the estimate deserves its weight; 0.2 means the fit is
 * mostly noise. Critically, the model is trained on the three hours *before*
 * the fault began — training on the faulty period would teach it to reproduce
 * the fault, which is the single most common way to fool yourself with a
 * fitted model.
 *
 * Returns `null` rather than a bad fit when there is too little data (n < 12)
 * or `x` never varies (a vertical line has no defined slope).
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

  // The weighted average, with each weight renormalised over the estimators
  // that actually returned a value.
  //
  //   physics 22.1 (0.40)  ml 22.4 (0.30)  neighbours 22.0 (0.20)
  //   external 21.8 (0.08) history 22.3 (0.02)   →   22.16 °C
  const corrected = available.reduce(
    (acc, [k, v]) => acc + (v as number) * (BASE_WEIGHTS[k] / totalBase),
    0,
  );

  // Interval width comes from how much the independent estimators disagree,
  // floored by the channel's own measurement uncertainty.
  //
  // This is the part students most often leave out, and it is the part an
  // operator needs most. "22.2 °C" is a claim; "22.2 °C, 21.9–22.5" is a claim
  // with its own error bars attached. 1.28 is the z-value for an 80%
  // two-sided interval under a normal distribution.
  const estimates = available.map(([, v]) => v as number);
  const spread = estimates.length > 1 ? stdev(estimates) : 0;
  const floor = BASE_UNCERTAINTY[inputs.sensorType] ?? 0.3;
  const halfWidth = Math.max(floor, spread * 1.28);

  // Confidence falls as the estimators diverge and rises with how many
  // independent sources agree. Two independent things are being asked:
  // "do they agree?" and "how many of them were there?" — five estimators
  // clustered tightly is a much stronger position than two.
  // Capped at 0.98: certainty is not on the menu here either.
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
 *
 * ─── Shadow deployment ───────────────────────────────────────────────────
 *
 * A pattern worth stealing for any project with a model in it. The candidate
 * model runs on live traffic, in production, on every request — and its output
 * goes nowhere near the user. You accumulate weeks of real evidence about how
 * it behaves before anyone depends on it.
 *
 * Compare the alternatives: a test set only tells you about data you already
 * had, and a straight cutover tells you about the new model's failures by
 * inflicting them on operators. Shadowing gets you the evidence without the
 * blast radius. The Model Lab page (`/models`) charts the divergence between
 * v1.4 and v1.5-beta over time.
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
