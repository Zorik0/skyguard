import type {
  Anomaly,
  Correction,
  DetectorType,
  ExternalContext,
  NeighbourRelevance,
  RawReading,
  SensorType,
  Severity,
  Station,
} from '@/types';
import { clamp, DAY, fromSeaLevel, HOUR, mean, median, MINUTE, round, toSeaLevel } from '@/lib/utils';
import { evaluatePhysics, twinValue, type PhysicsConfig } from '@/lib/physics/rules';
import {
  findPropagation,
  neighbourConsensus,
  readingValue,
  type StationSeries,
} from '@/lib/neighbours';
import { computeCorrection, fitLinear, type EnsembleInputs } from '@/lib/corrections/ensemble';
import { classify, type CrossSensorDeltas } from './classify';
import { anomalyTitle, buildNarrative, recommendedAction } from './narrative';
import { SCANNED_SENSORS, scanSensor, scanSubsystems, type Episode } from './detectors';
import { SENSOR_LABELS } from '@/lib/simulation/stations';

/**
 * The analysis pipeline — where the four stages are wired together.
 *
 * This file is the conductor. It owns very little logic of its own; what it
 * does is walk every station and every channel, calling each stage in turn and
 * carrying the result forward:
 *
 *   detectors.ts   scanSensor()        →  is anything unusual here?
 *   physics/rules  evaluatePhysics()   →  which physical laws does it break?
 *   neighbours.ts  findPropagation()   →  did anyone else see it?
 *   classify.ts    classify()          →  weather or hardware?
 *   ensemble.ts    computeCorrection() →  what should it have read?
 *   narrative.ts   buildNarrative()    →  say all of that in English
 *
 * The output is an `Anomaly[]` — self-contained records carrying the evidence,
 * the rules, the verdict, the correction and the recommended action, so every
 * screen can explain a finding without re-deriving it.
 *
 * Read `analyseNetwork` at the bottom for the loop structure; the helpers
 * above it prepare the inputs each stage needs.
 */
export interface AnalysisContext {
  stations: Station[];
  seriesById: Map<string, StationSeries>;
  relevanceById: Map<string, NeighbourRelevance[]>;
  externalById: Map<string, ExternalContext>;
  config: PhysicsConfig;
  zThreshold: number;
  now: number;
  from: number;
  stepMs: number;
}

/**
 * Second gate on reporting: an episode may fire every detector in the file
 * and still not be worth an operator's attention if the actual departure is
 * trivially small. Alarm fatigue is a real failure mode — a system that cries
 * wolf gets muted, and then it catches nothing at all.
 */
const MIN_DELTA_FOR_REPORT: Partial<Record<SensorType, number>> = {
  temperature: 1.6,
  humidity: 6,
  pressure: 0.9,
  wind_speed: 3.2,
  rainfall: 0.05,
};

function severityFor(score: number, classification: string): Severity {
  if (classification === 'meteorological_event') {
    // A real weather event is operationally interesting but never a hardware
    // emergency, so it is capped below "critical".
    return score >= 70 ? 'high' : score >= 45 ? 'warning' : 'info';
  }
  if (score >= 82) return 'critical';
  if (score >= 62) return 'high';
  if (score >= 38) return 'warning';
  return 'info';
}

/** Environmental lapse rate, °C per metre. */
const LAPSE_RATE = 0.0065;

/**
 * Interpolate the external model onto an arbitrary instant, in the station's
 * own frame.
 *
 * A numerical weather model reports for its grid cell's elevation, which is
 * rarely the station's. Comparing the two directly would manufacture a
 * disagreement out of terrain alone, so temperature is lapse-corrected and
 * pressure is carried across via mean sea level before anything is compared.
 */
function externalValueAt(
  ext: ExternalContext | undefined,
  sensorType: SensorType,
  t: number,
  station?: Station,
): number | null {
  if (!ext || ext.status !== 'live' || !ext.hourly.length) return null;
  const pick = (h: (typeof ext.hourly)[number]): number | null => {
    switch (sensorType) {
      case 'temperature': return h.temperature;
      case 'humidity': return h.humidity;
      case 'pressure': return h.pressure;
      case 'wind_speed': return h.windSpeed;
      case 'rainfall': return h.precipitation / 60;
      default: return null;
    }
  };
  let before: (typeof ext.hourly)[number] | null = null;
  let after: (typeof ext.hourly)[number] | null = null;
  for (const h of ext.hourly) {
    if (h.t <= t) before = h;
    if (h.t >= t && !after) after = h;
  }
  if (!before && !after) return null;
  let value: number | null;
  if (!before) value = pick(after!);
  else if (!after || after.t === before.t) value = pick(before);
  else {
    const a = pick(before);
    const b = pick(after);
    if (a === null || b === null) return null;
    const f = (t - before.t) / (after.t - before.t);
    value = a + (b - a) * f;
  }
  if (value === null) return null;

  const modelElevation = ext.elevation;
  if (station && modelElevation !== null && Math.abs(modelElevation - station.elevation) > 20) {
    const dz = modelElevation - station.elevation;
    if (sensorType === 'temperature') return value + LAPSE_RATE * dz;
    if (sensorType === 'dewPoint' as SensorType) return value + LAPSE_RATE * 0.35 * dz;
    if (sensorType === 'pressure') {
      const refTemp = pick(before ?? after!) === null ? 10 : (before ?? after!).temperature;
      return fromSeaLevel(toSeaLevel(value, modelElevation, refTemp), station.elevation, refTemp);
    }
  }
  return value;
}

/** Departure of every channel from its pre-episode baseline, at the peak. */
function crossSensorDeltas(
  raw: RawReading[],
  startIndex: number,
  peakIndex: number,
  stepMs: number,
): CrossSensorDeltas {
  const span = Math.round((60 * MINUTE) / stepMs);
  const from = Math.max(0, startIndex - span);
  const slice = raw.slice(from, Math.max(from + 1, startIndex));
  const peak = raw[peakIndex];

  const delta = (get: (r: RawReading) => number | null): number | null => {
    const base = slice.map(get).filter((v): v is number => v !== null);
    const now = peak ? get(peak) : null;
    if (!base.length || now === null) return null;
    return now - mean(base);
  };

  const rainSum = raw
    .slice(startIndex, peakIndex + 1)
    .map((r) => r.rainfall)
    .filter((v): v is number => v !== null)
    .reduce((a, b) => a + b, 0);

  return {
    temperature: delta((r) => r.temperature),
    humidity: delta((r) => r.humidity),
    pressure: delta((r) => r.pressure),
    dewPoint: delta((r) => r.dewPoint),
    windSpeed: delta((r) => r.windSpeed),
    rainfall: rainSum,
  };
}

function buildAnomalyFromEpisode(
  ctx: AnalysisContext,
  station: Station,
  series: StationSeries,
  episode: Episode,
): Anomaly | null {
  const { raw, twin } = series;
  const i = episode.peakIndex;
  const current = raw[i];
  if (!current) return null;

  const value = readingValue(current, episode.sensorType);
  const minDelta = MIN_DELTA_FOR_REPORT[episode.sensorType] ?? 0;
  const isStructural = episode.detectorTypes.some((d) =>
    ['frozen', 'range', 'drift', 'noise'].includes(d),
  );
  if (!isStructural && Math.abs(episode.delta) < minDelta) return null;

  const relevances = ctx.relevanceById.get(station.id) ?? [];
  const windowSpan = Math.round((90 * MINUTE) / ctx.stepMs);
  const window = raw.slice(Math.max(0, i - windowSpan), i + 1);

  const consensus = neighbourConsensus(
    station, episode.sensorType, i, relevances, ctx.seriesById,
  );

  const rules = evaluatePhysics({
    station,
    sensorType: episode.sensorType,
    current,
    previous: raw[i - 1] ?? null,
    window,
    twin: twin[i],
    neighbourConsensus: consensus.consensus,
    neighbourSpread: consensus.spread,
    config: ctx.config,
  });

  // Propagation matching asks "did this signature travel?", which only means
  // anything for a transient event. A slow calibration offset has no front to
  // follow, and searching for one just matches the neighbours' own diurnal
  // swing — so it is skipped entirely.
  const TRANSIENT: DetectorType[] = ['spike', 'drop', 'rate_of_change'];
  const isTransient = episode.detectorTypes.some((d) => TRANSIENT.includes(d));
  const propagation = isTransient
    ? findPropagation(station, episode.sensorType, i, episode.delta, relevances, ctx.seriesById, ctx.stepMs)
    : { matches: [], coverage: 0 };

  const cross = crossSensorDeltas(raw, episode.startIndex, i, ctx.stepMs);
  const tv = twinValue(twin[i], episode.sensorType);
  const twinDelta = tv !== null && value !== null ? value - tv : null;
  const twinTolerance = ctx.config.twinTolerance[episode.sensorType];
  const neighbourZ =
    consensus.consensus !== null && value !== null
      ? (value - consensus.consensus) / Math.max(consensus.spread ?? 0.35, 0.35)
      : null;

  const ext = ctx.externalById.get(station.id);
  const extValue = externalValueAt(ext, episode.sensorType, current.t, station);
  const externalDelta = extValue !== null && value !== null ? value - extValue : null;

  const verdict = classify({
    station,
    sensorType: episode.sensorType,
    detectorTypes: episode.detectorTypes,
    rules,
    delta: episode.delta,
    propagation,
    cross,
    twinDelta,
    twinTolerance,
    neighbourZ,
    externalDelta,
    externalAvailable: extValue !== null,
    packetLoss: current.packetLoss,
    battery: current.battery,
  });

  // --- Score ---------------------------------------------------------------
  const firedCount = rules.filter((r) => r.fired).length;
  const deltaFrac = clamp(Math.abs(episode.delta) / Math.max(minDelta * 4, 1e-6), 0, 1);
  let score = clamp(
    Math.round(
      100 * (0.42 * episode.peakStrength + 0.3 * clamp(firedCount / 4, 0, 1) + 0.28 * deltaFrac),
    ),
    1,
    100,
  );
  // A frozen or out-of-range channel is not producing usable data at all, so
  // it is severe regardless of how large the numeric departure happens to be.
  if (episode.detectorTypes.includes('frozen') || episode.detectorTypes.includes('range')) {
    score = Math.max(score, 86);
  }

  // --- Correction ----------------------------------------------------------
  let correction: Correction | null = null;
  if (verdict.classification === 'sensor_fault' && value !== null) {
    correction = buildCorrection(ctx, station, series, episode, consensus.consensus, extValue);
  }

  const durationMinutes = ((episode.endIndex - episode.startIndex) * ctx.stepMs) / MINUTE;
  const action = recommendedAction(verdict.classification, episode.sensorType, episode.detectorTypes);

  return {
    id: '',
    stationId: station.id,
    sensorType: episode.sensorType,
    startedAt: raw[episode.startIndex].t,
    endedAt: episode.endIndex >= raw.length - 2 ? null : raw[episode.endIndex].t,
    detectedAt: raw[Math.min(episode.startIndex + 1, raw.length - 1)].t,
    score,
    severity: severityFor(score, verdict.classification),
    classification: verdict.classification,
    confidence: verdict.confidence,
    title: anomalyTitle(station, episode.sensorType, verdict.classification, episode.dominant, episode.delta),
    summary: episode.hits[0]?.detail ?? `${SENSOR_LABELS[episode.sensorType]} departed from its baseline.`,
    narrative: buildNarrative({
      station,
      sensorType: episode.sensorType,
      classification: verdict.classification,
      confidence: verdict.confidence,
      delta: episode.delta,
      durationMinutes,
      evidence: verdict.evidence,
      correction,
      neighbourCount: relevances.filter((r) => r.relevance >= 35).length,
      action,
    }),
    evidence: verdict.evidence,
    rules,
    recommendedAction: action,
    rawValue: value,
    delta: round(episode.delta, 3),
    correction,
    incidentId: null,
    signatureId: null,
    detectorTypes: episode.detectorTypes,
  };
}

/**
 * Assemble the five independent estimators and hand them to the ensemble.
 * None of them may read the faulty channel's current value.
 */
function buildCorrection(
  ctx: AnalysisContext,
  station: Station,
  series: StationSeries,
  episode: Episode,
  consensusNow: number | null,
  externalNow: number | null,
): Correction {
  const { raw, twin } = series;
  const i = episode.peakIndex;
  const s = episode.sensorType;
  const rawValue = readingValue(raw[i], s) ?? 0;
  const preIndex = Math.max(0, episode.startIndex - 1);

  // 1. Physics: last trustworthy reading carried forward along the twin's tendency.
  const lastGood = readingValue(raw[preIndex], s);
  const twinThen = twinValue(twin[preIndex], s);
  const twinNow = twinValue(twin[i], s);
  const physics =
    lastGood !== null && twinThen !== null && twinNow !== null
      ? lastGood + (twinNow - twinThen)
      : twinNow;

  // 2. ML: least-squares regression of this station against its neighbour
  //    consensus, fitted on the three hours *before* the episode.
  const relevances = ctx.relevanceById.get(station.id) ?? [];
  const fitSpan = Math.round((3 * HOUR) / ctx.stepMs);
  const stride = Math.max(1, Math.round((5 * MINUTE) / ctx.stepMs));
  const xs: number[] = [];
  const ys: number[] = [];
  for (let k = Math.max(0, preIndex - fitSpan); k < preIndex; k += stride) {
    const y = readingValue(raw[k], s);
    if (y === null) continue;
    const c = neighbourConsensus(station, s, k, relevances, ctx.seriesById);
    if (c.consensus === null) continue;
    xs.push(c.consensus);
    ys.push(y);
  }
  const fit = fitLinear(xs, ys);
  const ml = fit && consensusNow !== null ? fit.a + fit.b * consensusNow : null;

  // 3. Trailing median of the channel before it failed.
  const histSpan = Math.round((30 * MINUTE) / ctx.stepMs);
  const hist = raw
    .slice(Math.max(0, preIndex - histSpan), preIndex)
    .map((r) => readingValue(r, s))
    .filter((v): v is number => v !== null);

  const inputs: EnsembleInputs = {
    sensorType: s,
    station,
    t: raw[i].t,
    rawValue,
    physics: physics ?? null,
    ml,
    neighbours: consensusNow,
    external: externalNow,
    history: hist.length ? median(hist) : null,
  };
  return computeCorrection(inputs);
}

/** Communications, power and calibration anomalies. */
function subsystemAnomalies(
  ctx: AnalysisContext,
  station: Station,
  series: StationSeries,
): Anomaly[] {
  const findings = scanSubsystems(series, station, ctx.now, ctx.stepMs);
  const out: Anomaly[] = [];
  const { raw } = series;

  const makeSubsystem = (
    sensorType: SensorType,
    detectors: DetectorType[],
    startIndex: number,
    endIndex: number,
    score: number,
    summary: string,
  ): Anomaly | null => {
    const peak = raw[Math.min(endIndex, raw.length - 1)];
    if (!peak) return null;
    const verdict = classify({
      station,
      sensorType,
      detectorTypes: detectors,
      rules: [],
      delta: 0,
      propagation: { matches: [], coverage: 0 },
      cross: { temperature: null, humidity: null, pressure: null, dewPoint: null, windSpeed: null, rainfall: null },
      twinDelta: null,
      twinTolerance: undefined,
      neighbourZ: null,
      externalDelta: null,
      externalAvailable: false,
      packetLoss: peak.packetLoss,
      battery: peak.battery,
    });
    const durationMinutes = ((endIndex - startIndex) * ctx.stepMs) / MINUTE;
    const action = recommendedAction(verdict.classification, sensorType, detectors);
    return {
      id: '',
      stationId: station.id,
      sensorType,
      startedAt: raw[startIndex].t,
      endedAt: endIndex >= raw.length - 2 ? null : raw[endIndex].t,
      detectedAt: raw[Math.min(startIndex + 2, raw.length - 1)].t,
      score,
      severity: severityFor(score, verdict.classification),
      classification: verdict.classification,
      confidence: verdict.confidence,
      title: anomalyTitle(station, sensorType, verdict.classification, detectors[0], 0),
      summary,
      narrative: buildNarrative({
        station, sensorType,
        classification: verdict.classification,
        confidence: verdict.confidence,
        delta: 0,
        durationMinutes,
        evidence: verdict.evidence,
        correction: null,
        neighbourCount: 0,
        action,
      }),
      evidence: verdict.evidence,
      rules: [],
      recommendedAction: action,
      rawValue: sensorType === 'battery' ? peak.battery : peak.signal,
      delta: 0,
      correction: null,
      incidentId: null,
      signatureId: null,
      detectorTypes: detectors,
    };
  };

  for (const run of findings.missingRuns) {
    const minutes = ((run.endIndex - run.startIndex) * ctx.stepMs) / MINUTE;
    if (minutes < 4) continue;
    const a = makeSubsystem(
      'comms', ['comms', 'missing'], run.startIndex, run.endIndex,
      clamp(Math.round(55 + minutes / 2), 55, 97),
      `${Math.round(minutes)} minutes with no packets received.`,
    );
    if (a) out.push(a);
  }

  if (findings.batteryLow) {
    const b = findings.batteryLow;
    const a = makeSubsystem(
      'battery', ['battery'], b.startIndex, b.endIndex,
      clamp(Math.round((12.4 - b.minVolts) * 40), 40, 96),
      `Pack voltage fell to ${b.minVolts} V.`,
    );
    if (a) out.push(a);
  }

  for (const c of findings.calibrationOverdue) {
    const over = c.ageDays - c.intervalDays;
    if (over < 10) continue;
    const peakT = ctx.now;
    const action = `Recalibrate the ${SENSOR_LABELS[c.sensorType].toLowerCase()} channel — ${over} days past its ${c.intervalDays}-day interval.`;
    out.push({
      id: '',
      stationId: station.id,
      sensorType: c.sensorType,
      startedAt: peakT - over * DAY,
      endedAt: null,
      detectedAt: peakT - over * DAY,
      // A calibration lapse widens uncertainty; it is not a live failure, so
      // it never escalates past a warning.
      score: clamp(Math.round(20 + over / 5), 20, 46),
      severity: over > 60 ? 'warning' : 'info',
      classification: 'sensor_fault',
      confidence: 88,
      title: `${station.id} ${SENSOR_LABELS[c.sensorType].toLowerCase()} calibration overdue`,
      summary: `${c.ageDays} days since last calibration against a ${c.intervalDays}-day interval.`,
      narrative: `The ${station.id} ${SENSOR_LABELS[c.sensorType].toLowerCase()} channel was last calibrated ${c.ageDays} days ago, ${over} days beyond its ${c.intervalDays}-day service interval.\n\nReadings from this channel remain usable but carry a widening uncertainty, and any drift detected here should be read in that light.\n\nRecommended action: ${action}`,
      evidence: [{
        id: 'calibration_age',
        label: 'Calibration interval exceeded',
        detail: `Last calibrated ${c.ageDays} days ago; the interval for this instrument is ${c.intervalDays} days.`,
        supports: 'fault',
        weight: 1.5,
        source: 'SIMULATED',
      }],
      rules: [],
      recommendedAction: action,
      rawValue: null,
      delta: 0,
      correction: null,
      incidentId: null,
      signatureId: null,
      detectorTypes: ['calibration'],
    });
  }

  return out;
}

export function analyseNetwork(ctx: AnalysisContext): Anomaly[] {
  const all: Anomaly[] = [];

  for (const station of ctx.stations) {
    const series = ctx.seriesById.get(station.id);
    if (!series) continue;

    for (const sensorType of SCANNED_SENSORS) {
      const episodes = scanSensor(series, sensorType, ctx.config.twinTolerance[sensorType], {
        physics: ctx.config,
        stepMs: ctx.stepMs,
        zThreshold: ctx.zThreshold,
      });
      for (const ep of episodes) {
        const a = buildAnomalyFromEpisode(ctx, station, series, ep);
        if (a) all.push(a);
      }
    }

    all.push(...subsystemAnomalies(ctx, station, series));
  }

  // Stable, human-friendly identifiers assigned in chronological order.
  all.sort((a, b) => a.startedAt - b.startedAt || a.stationId.localeCompare(b.stationId));
  all.forEach((a, idx) => {
    a.id = `A-${1000 + idx}`;
  });
  return all;
}
