import type {
  Classification,
  DetectorType,
  EvidenceItem,
  RuleTrigger,
  SensorType,
  Station,
} from '@/types';
import { clamp, round } from '@/lib/utils';
import type { PropagationMatch } from '@/lib/neighbours';
import { SENSOR_LABELS, SENSOR_UNITS } from '@/lib/simulation/stations';

/**
 * Weather or hardware? — STAGE 3 of the pipeline.
 *
 * This is the judgement the whole platform exists to make, so it is made by
 * accumulating named, weighted evidence on both sides rather than by a single
 * opaque score. Confidence is simply the share of total evidence weight held
 * by the winning side — which means it can always be explained by listing the
 * evidence, and it can never reach certainty.
 *
 * ─── If you read one file in this project, read this one ─────────────────
 *
 * `detectors.ts` found that something is unusual. This file decides *why*,
 * and it is the whole point of the product. Two readings can look identical
 * on a chart:
 *
 *   AWS-007  temperature jumps to 61 °C   → the probe has failed
 *   AWS-033  temperature falls 7 °C       → a cold front arrived
 *
 * Get this wrong in one direction and you erase real weather from the record.
 * Get it wrong in the other and you publish broken data to whoever depends on
 * it. Both mistakes are worse than not having the system at all.
 *
 * ─── How the decision is made ────────────────────────────────────────────
 *
 * Think of a courtroom, not a formula. Each observation is a piece of
 * evidence with a stated weight, filed on one side or the other:
 *
 *   TOWARD HARDWARE FAULT              TOWARD REAL WEATHER
 *   impossible rate of change   2.5    same signature at neighbours  2.0–3.2
 *   other channels did not move 2.2    every channel moved together  1.4–2.8
 *   dew point above air temp    2.0    the digital twin agrees       1.5
 *   variance jumped             1.6    rate is fast but achievable   1.4
 *   no neighbour agrees         2.4    external model agrees         1.2
 *   digital twin disagrees      0.7–2.1  rain observed at the gauge  1.1
 *
 *   confidence = winning weight ÷ total weight
 *
 * So a verdict of "94% sensor fault" is not a probability from a model; it is
 * arithmetic over a list the operator can read line by line and disagree
 * with. That is the difference between a system people trust and one they
 * eventually switch off.
 *
 * ─── Three design decisions worth noticing ───────────────────────────────
 *
 *   1. Both sides start at 0.3, so neither can ever reach 100%. A system that
 *      claims certainty about the physical world is lying.
 *   2. If the winner holds less than 60% of the weight, the verdict is
 *      `indeterminate` — "I don't know, a human should look" is a legitimate
 *      and useful answer, and far better than a confident coin flip.
 *   3. Some findings skip the weighing entirely (see "dispositive" below).
 */

export interface CrossSensorDeltas {
  temperature: number | null;
  humidity: number | null;
  pressure: number | null;
  dewPoint: number | null;
  windSpeed: number | null;
  rainfall: number | null;
}

export interface ClassifyInput {
  station: Station;
  sensorType: SensorType;
  detectorTypes: DetectorType[];
  rules: RuleTrigger[];
  delta: number;
  propagation: { matches: PropagationMatch[]; coverage: number };
  cross: CrossSensorDeltas;
  twinDelta: number | null;
  twinTolerance: number | undefined;
  neighbourZ: number | null;
  externalDelta: number | null;
  externalAvailable: boolean;
  packetLoss: number | null;
  battery: number | null;
}

export interface ClassifyResult {
  classification: Classification;
  confidence: number;
  evidence: EvidenceItem[];
  faultWeight: number;
  weatherWeight: number;
  coherence: number;
}

/**
 * How well do the other channels corroborate a real air-mass change?
 *
 * Cooling air should moisten (RH up) and usually sits near a pressure change;
 * warming air should dry. A probe fault moves one channel and leaves the rest
 * exactly where they were.
 *
 * ─── The single most useful idea in the file ─────────────────────────────
 *
 * A weather station carries several independent instruments. Weather is a
 * property of the air, so it moves all of them at once. A fault lives in one
 * piece of hardware, so it moves exactly one.
 *
 *   Real cold front:   temp ↓ 7 °C   humidity ↑ 22%   pressure ↓ 4 hPa
 *   Failed thermistor: temp ↑ 41 °C  humidity —       pressure —
 *
 * The second row is physically incoherent: air that heats by 41 °C without
 * drying does not exist. You do not need a model to reject it, only the
 * relationship between the variables.
 *
 * Returns 0 (no corroboration at all — suspicious) to 1 (every channel
 * responded as physics requires). The score is an average over whichever
 * terms could be evaluated, so a station with a broken hygrometer still
 * scores on the terms that remain.
 */
export function coherenceScore(cross: CrossSensorDeltas, sensorType: SensorType): number {
  const dT = cross.temperature;
  const dRH = cross.humidity;
  const dP = cross.pressure;
  let score = 0;
  let terms = 0;

  if (dT !== null && dRH !== null && Math.abs(dT) > 0.4) {
    terms++;
    // Opposite signs is the physically expected response: warm air holds more
    // moisture, so at constant water content, warming it *lowers* relative
    // humidity and cooling it raises it. Temperature up + humidity up in the
    // same breath is a contradiction unless it actually rained.
    const expected = -Math.sign(dT);
    const strength = clamp(Math.abs(dRH) / (Math.abs(dT) * 2.2), 0, 1);
    score += Math.sign(dRH) === expected ? strength : 0;
  }
  if (dP !== null) {
    terms++;
    score += clamp(Math.abs(dP) / 2.4, 0, 1);
  }
  if (cross.windSpeed !== null) {
    terms++;
    score += clamp(Math.abs(cross.windSpeed) / 4.5, 0, 1);
  }
  if (sensorType === 'humidity' && cross.dewPoint !== null && dT !== null) {
    terms++;
    score += clamp(Math.abs(cross.dewPoint) / 2.5, 0, 1);
  }

  return terms ? clamp(score / terms, 0, 1) : 0;
}

function ev(
  id: string,
  label: string,
  detail: string,
  supports: EvidenceItem['supports'],
  weight: number,
  source: EvidenceItem['source'],
): EvidenceItem {
  return { id, label, detail, supports, weight: round(weight, 2), source };
}

export function classify(input: ClassifyInput): ClassifyResult {
  const {
    sensorType, detectorTypes, rules, delta, propagation, cross,
    twinDelta, twinTolerance, neighbourZ, externalDelta, externalAvailable,
    packetLoss, battery,
  } = input;

  const unit = SENSOR_UNITS[sensorType];
  const evidence: EvidenceItem[] = [];
  const fired = new Set(rules.filter((r) => r.fired).map((r) => r.id));
  const detectors = new Set(detectorTypes);

  // --- Subsystem faults are not a judgement call ---------------------------
  // A radio that stopped transmitting is not an interesting meteorological
  // question. There is no weather hypothesis to weigh, so we return
  // immediately rather than pretending to deliberate.
  if (detectors.has('comms') || detectors.has('missing')) {
    evidence.push(
      ev('comms_loss', 'Telemetry link degraded',
        packetLoss !== null
          ? `Packet loss reached ${round(packetLoss, 0)}% — observations are absent, not wrong.`
          : 'Packets stopped arriving from this station.',
        'fault', 3, 'SIMULATED'),
    );
    return {
      classification: 'communications',
      confidence: 96,
      evidence,
      faultWeight: 3,
      weatherWeight: 0,
      coherence: 0,
    };
  }
  if (detectors.has('battery')) {
    evidence.push(
      ev('battery_decline', 'Power subsystem declining',
        `Pack voltage fell to ${round(battery ?? 0, 2)} V; the modem browns out below 11.4 V.`,
        'fault', 3, 'SIMULATED'),
    );
    return {
      classification: 'power',
      confidence: 94,
      evidence,
      faultWeight: 3,
      weatherWeight: 0,
      coherence: 0,
    };
  }

  // --- Dispositive hardware findings ---------------------------------------
  // A channel with zero variance, or one reporting outside what the instrument
  // can physically produce, is not measuring the atmosphere at all. There is
  // no weather hypothesis to weigh against these, so they short-circuit rather
  // than compete on points.
  if (detectors.has('frozen')) {
    evidence.push(
      ev('frozen', 'Channel has stopped responding',
        `The ${SENSOR_LABELS[sensorType].toLowerCase()} value has not changed at all for an extended period. A live sensor always carries some measurement noise, so this channel is no longer tracking anything.`,
        'fault', 3.4, 'SIMULATED'),
    );
    return { classification: 'sensor_fault', confidence: 96, evidence, faultWeight: 3.4, weatherWeight: 0, coherence: 0 };
  }
  if (fired.has('range')) {
    const r = rules.find((x) => x.id === 'range')!;
    evidence.push(
      ev('range', 'Outside the possible measurement range',
        `Reported ${r.observed}; the instrument can only produce ${r.limit}. No atmospheric condition can put a reading here.`,
        'fault', 3.4, 'MODELLED'),
    );
    if (fired.has('rate_of_change')) {
      const rr = rules.find((x) => x.id === 'rate_of_change')!;
      evidence.push(ev('rate', 'Physically impossible rate of change',
        `Observed ${rr.observed} against a configured limit of ${rr.limit}.`, 'fault', 2.5, 'MODELLED'));
    }
    if (neighbourZ !== null && fired.has('neighbour')) {
      evidence.push(ev('neighbour_isolated', 'No neighbouring station agrees',
        `${round(neighbourZ, 1)}σ from the relevance-weighted consensus.`, 'fault', 2.4, 'SIMULATED'));
    }
    return { classification: 'sensor_fault', confidence: 98, evidence, faultWeight: 5.8, weatherWeight: 0, coherence: 0 };
  }

  const coherence = coherenceScore(cross, sensorType);
  const orderedMatches = [...propagation.matches].sort((a, b) => a.lagMinutes - b.lagMinutes);
  // "Propagated" means at least two relevant neighbours — a third of those
  // considered — saw the same thing. One neighbour agreeing could be
  // coincidence; a pattern crossing the network in geographic order is
  // weather, because weather travels and a broken probe does not.
  const propagated = propagation.coverage >= 0.34 && orderedMatches.length >= 2;

  // Both sides open with the same small prior. Because confidence is a share
  // of the total, a non-zero starting weight on the losing side mathematically
  // caps the winner below 100% — the system is structurally incapable of
  // claiming certainty.
  let faultWeight = 0.3;
  let weatherWeight = 0.3;

  // ---------------------------------------------------------------- FAULT --
  if (fired.has('rate_of_change')) {
    const r = rules.find((x) => x.id === 'rate_of_change')!;
    faultWeight += 2.5;
    evidence.push(ev('rate', 'Physically impossible rate of change',
      `Observed ${r.observed} against a configured limit of ${r.limit}. Surface air cannot change this fast.`,
      'fault', 2.5, 'MODELLED'));
  }

  if (fired.has('cross_sensor')) {
    const r = rules.find((x) => x.id === 'cross_sensor')!;
    faultWeight += 2.2;
    evidence.push(ev('cross', 'Other channels did not respond',
      `${r.observed}. A real air-mass change moves humidity and pressure with the temperature.`,
      'fault', 2.2, 'SIMULATED'));
  } else if (Math.abs(delta) > 0.4 && coherence < 0.22 && !detectors.has('drift')) {
    faultWeight += 1.6;
    evidence.push(ev('incoherent', 'Cross-sensor response is missing',
      `${SENSOR_LABELS[sensorType]} moved ${round(Math.abs(delta), 2)} ${unit} while the other channels stayed within their normal variation.`,
      'fault', 1.6, 'SIMULATED'));
  }

  if (fired.has('dewpoint_consistency')) {
    faultWeight += 2;
    const r = rules.find((x) => x.id === 'dewpoint_consistency')!;
    evidence.push(ev('dewpoint', 'Internally inconsistent variables',
      `${r.observed}. Dew point above air temperature is thermodynamically impossible.`,
      'fault', 2, 'MODELLED'));
  }

  if (detectors.has('noise')) {
    faultWeight += 1.6;
    evidence.push(ev('noise', 'Measurement variance has increased',
      'Short-term variance is well above this channel’s established baseline — typically a failing connector or damp terminal.',
      'fault', 1.6, 'SIMULATED'));
  }

  if (detectors.has('drift')) {
    // A persistent one-directional offset is the signature of calibration
    // drift. Weather moves and then moves back; a drifting probe does not.
    faultWeight += propagated ? 1.9 : 3.1;
    evidence.push(ev('drift', 'Sustained offset from the digital twin',
      `The channel holds a persistent ${twinDelta !== null && twinDelta > 0 ? 'positive' : 'negative'} offset rather than tracking expected conditions — the signature of calibration drift.`,
      'fault', 1.9, 'MODELLED'));
  }

  if (neighbourZ !== null && fired.has('neighbour') && !propagated) {
    faultWeight += 2.4;
    evidence.push(ev('neighbour_isolated', 'No neighbouring station agrees',
      `${round(neighbourZ, 1)}σ from the relevance-weighted consensus, and the signature appears at no other station in the network.`,
      'fault', 2.4, 'SIMULATED'));
  }

  if (twinDelta !== null && twinTolerance !== undefined && Math.abs(twinDelta) > twinTolerance) {
    const w = clamp(Math.abs(twinDelta) / twinTolerance, 1, 3) * 0.7;
    faultWeight += w;
    evidence.push(ev('twin_disagree', 'Digital twin disagrees',
      `Station reads ${round(Math.abs(twinDelta), 2)} ${unit} from its modelled expectation (tolerance ${round(twinTolerance, 2)} ${unit}).`,
      'fault', w, 'MODELLED'));
  }

  if (externalAvailable && externalDelta !== null && Math.abs(externalDelta) > (twinTolerance ?? 3) * 1.2) {
    faultWeight += 1.2;
    evidence.push(ev('external_disagree', 'External weather model disagrees',
      `Open-Meteo expects a value ${round(Math.abs(externalDelta), 2)} ${unit} away from what the station reported.`,
      'fault', 1.2, 'EXTERNAL_MODEL'));
  }

  // -------------------------------------------------------------- WEATHER --
  if (propagated) {
    const w = 2.0 + 1.2 * clamp(propagation.coverage, 0, 1);
    weatherWeight += w;
    const order = orderedMatches
      .slice(0, 4)
      .map((m) => `${m.stationId} ${m.lagMinutes >= 0 ? '+' : ''}${m.lagMinutes}m`)
      .join(', ');
    evidence.push(ev('propagation', 'The same signature appears across the network',
      `${orderedMatches.length} of the relevant neighbours show a comparable change (${order}). Weather travels; a probe fault does not.`,
      'weather', w, 'SIMULATED'));
  }

  if (coherence > 0.42) {
    const w = 1.4 + 1.4 * coherence;
    weatherWeight += w;
    const parts: string[] = [];
    if (cross.temperature !== null) parts.push(`temperature ${cross.temperature > 0 ? '+' : ''}${round(cross.temperature, 1)}°C`);
    if (cross.humidity !== null) parts.push(`humidity ${cross.humidity > 0 ? '+' : ''}${round(cross.humidity, 1)}%`);
    if (cross.pressure !== null) parts.push(`pressure ${cross.pressure > 0 ? '+' : ''}${round(cross.pressure, 1)} hPa`);
    if (cross.windSpeed !== null) parts.push(`wind ${cross.windSpeed > 0 ? '+' : ''}${round(cross.windSpeed, 1)} m/s`);
    evidence.push(ev('coherent', 'Every channel moved together',
      `${parts.join(', ')} — the coordinated response expected from a real air-mass change.`,
      'weather', w, 'SIMULATED'));
  }

  // Neither of the next two count when the finding *is* a slow offset: a drift
  // trivially satisfies both, so awarding them would argue against the very
  // evidence that identified it.
  if (!detectors.has('drift') && twinDelta !== null && twinTolerance !== undefined && Math.abs(twinDelta) <= twinTolerance) {
    weatherWeight += 1.5;
    evidence.push(ev('twin_agree', 'Digital twin tracks the station',
      `The modelled expectation is within ${round(twinTolerance, 2)} ${unit} of the observation, so conditions genuinely changed.`,
      'weather', 1.5, 'MODELLED'));
  }

  if (!fired.has('rate_of_change') && !detectors.has('drift')) {
    weatherWeight += 1.4;
    evidence.push(ev('plausible_rate', 'Change stayed within atmospheric limits',
      'The rate of change is fast but physically achievable for the surface atmosphere.',
      'weather', 1.4, 'MODELLED'));
  }

  if (externalAvailable && externalDelta !== null && Math.abs(externalDelta) <= (twinTolerance ?? 3)) {
    weatherWeight += 1.2;
    evidence.push(ev('external_agree', 'External weather model agrees',
      'Open-Meteo’s forecast for this location is consistent with the observed conditions.',
      'weather', 1.2, 'EXTERNAL_MODEL'));
  }

  if (cross.rainfall !== null && cross.rainfall > 0.02 && (sensorType === 'humidity' || sensorType === 'temperature')) {
    weatherWeight += 1.1;
    evidence.push(ev('rain_support', 'Precipitation observed at the station',
      `The gauge recorded ${round(cross.rainfall, 2)} mm through the same period, supporting a genuine event.`,
      'weather', 1.1, 'SIMULATED'));
  }

  // ─── The verdict ────────────────────────────────────────────────────────
  //
  // Everything above was gathering evidence. This is the entire decision:
  //
  //   fault 8.4, weather 1.2  →  share 0.875  →  "sensor fault, 88%"
  //   fault 1.1, weather 6.9  →  share 0.863  →  "weather event, 86%"
  //   fault 3.2, weather 3.0  →  share 0.516  →  "indeterminate"
  const total = faultWeight + weatherWeight;
  const faultShare = total > 0 ? faultWeight / total : 0.5;
  const isFault = faultShare >= 0.5;
  const share = isFault ? faultShare : 1 - faultShare;

  let classification: Classification = isFault ? 'sensor_fault' : 'meteorological_event';
  // Genuinely ambiguous cases must say so rather than pick a side. Below 60%
  // the evidence is close to balanced, and forcing a verdict there would mean
  // publishing a decision the data does not support.
  if (share < 0.6) classification = 'indeterminate';

  // Strongest evidence first, so the UI leads with the reason that mattered.
  evidence.sort((a, b) => b.weight - a.weight);

  return {
    classification,
    confidence: round(clamp(share, 0.5, 0.98) * 100, 0),
    evidence,
    faultWeight: round(faultWeight, 2),
    weatherWeight: round(weatherWeight, 2),
    coherence: round(coherence, 2),
  };
}

export const CLASSIFICATION_LABELS: Record<Classification, string> = {
  sensor_fault: 'Likely sensor fault',
  meteorological_event: 'Likely genuine weather event',
  communications: 'Communications failure',
  power: 'Power subsystem fault',
  indeterminate: 'Indeterminate — needs review',
};
