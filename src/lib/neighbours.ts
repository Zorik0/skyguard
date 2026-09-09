import type {
  NeighbourRelevance,
  RawReading,
  SensorType,
  Station,
  TwinReading,
} from '@/types';
import {
  clamp,
  correlation,
  dewPoint,
  haversineKm,
  HOUR,
  mean,
  median,
  MINUTE,
  rhFromDewPoint,
  round,
  stdev,
  toSeaLevel,
  fromSeaLevel,
} from '@/lib/utils';

/**
 * Neighbour intelligence — STAGE 2 of the pipeline.
 *
 * Proximity alone is a poor guide — a valley station 8 km from an alpine one
 * is a bad reference, while two valley stations 60 km apart track each other
 * closely. Relevance therefore blends distance, elevation, terrain character
 * and the historical correlation of their expected conditions.
 *
 * ─── Why neighbours decide the case ──────────────────────────────────────
 *
 * A single station cannot tell you whether its own thermometer is lying. It
 * has no second opinion. Eleven other stations do.
 *
 *   AWS-007 reads 61 °C, everyone else reads 22 °C  →  AWS-007 is broken
 *   AWS-007 reads 15 °C, and over the next 90 minutes each station
 *   downwind reads 15 °C in turn                    →  a front is passing
 *
 * The second pattern is the giveaway. Weather is a physical thing that moves
 * across the map at a measurable speed; a failing probe is a local event with
 * no geography at all. `findPropagation` at the bottom of this file is what
 * looks for that travelling signature, and it is the single most decisive
 * piece of evidence the classifier receives.
 *
 * The file has three jobs, in order:
 *
 *   adjustToStation    make two stations comparable in the first place
 *   computeRelevance   decide which neighbours are worth listening to
 *   neighbourConsensus + findPropagation   ask them
 */

/**
 * Environmental lapse rate: air cools by 6.5 °C for every 1000 m of altitude.
 *
 * This is why a mountain station reading 8 °C while the coast reads 17 °C is
 * not an anomaly — it is 1400 m higher, and 1400 × 0.0065 ≈ 9 °C of the gap
 * is pure altitude. Fail to account for it and every alpine station looks
 * permanently faulty.
 */
const LAPSE_RATE = 0.0065;

export interface StationSeries {
  station: Station;
  raw: RawReading[];
  twin: TwinReading[];
}

export function readingValue(r: RawReading | null | undefined, s: SensorType): number | null {
  if (!r) return null;
  switch (s) {
    case 'temperature': return r.temperature;
    case 'humidity': return r.humidity;
    case 'pressure': return r.pressure;
    case 'wind_speed': return r.windSpeed;
    case 'wind_direction': return r.windDirection;
    case 'rainfall': return r.rainfall;
    case 'battery': return r.battery;
    case 'comms': return r.signal;
    default: return null;
  }
}

/**
 * Bring a neighbour's reading into the target station's frame so the two are
 * actually comparable: temperature by lapse rate, pressure via mean sea level.
 *
 * ─── Read this before the comparison code ────────────────────────────────
 *
 * You cannot subtract one station's reading from another's and call the
 * difference an anomaly. Stations sit at different altitudes, and altitude
 * changes all three main variables in entirely predictable ways. Translate
 * first, compare second.
 *
 *   Cascade Pass at 1450 m reads 8.2 °C
 *   what would that air be at Marion Ridge's 320 m?
 *     8.2 + 0.0065 × (1450 − 320) = 15.5 °C
 *
 * Each channel needs a different translation:
 *
 *   temperature   add back the lapse rate
 *   pressure      go up to sea level, then back down to the target
 *   humidity      convert to dew point, carry that across, convert back
 *
 * The humidity case is the subtle one and is explained inline below.
 */
export function adjustToStation(
  value: number,
  sensorType: SensorType,
  from: Station,
  to: Station,
  fromTemp: number | null,
  toTemp: number | null,
): number {
  if (sensorType === 'temperature') {
    return value + LAPSE_RATE * (from.elevation - to.elevation);
  }
  if (sensorType === 'pressure') {
    const t = fromTemp ?? 10;
    return fromSeaLevel(toSeaLevel(value, from.elevation, t), to.elevation, t);
  }
  if (sensorType === 'humidity' && fromTemp !== null && toTemp !== null) {
    // Relative humidity is not comparable between sites at different
    // temperatures. Carry the neighbour's *moisture content* across instead —
    // its dew point — and re-express it at the target's temperature.
    //
    // "Relative" is doing the damage: RH is the water in the air as a
    // percentage of the most that air could hold, and warm air can hold far
    // more. So the same parcel of air reads 80% RH at 5 °C and 40% RH at
    // 20 °C, having gained or lost precisely no water.
    //
    // Dew point is absolute — the temperature at which that air would start
    // condensing — so it survives the journey between stations. Convert to it,
    // carry it, convert back.
    //
    // The `Math.min(td, toTemp - 0.05)` guard keeps dew point just below air
    // temperature: above it, the maths would return RH over 100%, which is
    // physically meaningless.
    const td = dewPoint(fromTemp, clamp(value, 1, 100));
    return clamp(rhFromDewPoint(toTemp, Math.min(td, toTemp - 0.05)), 0, 100);
  }
  return value;
}

/**
 * Score every other station on how good a reference it is for `target`.
 *
 * The naive approach — "use the closest station" — fails badly in real
 * terrain. Two valley towns 60 km apart share the same air mass and track each
 * other within a degree; a peak 8 km away but 1200 m up is a different
 * climate entirely.
 *
 * Four factors, weighted, each on a 0..1 scale:
 *
 *   distance     33%   exp(-km/70): 70 km away scores 0.37, 140 km 0.14
 *   elevation    25%   exp(-Δm/420): the same shape, in metres
 *   correlation  24%   do their conditions historically move together?
 *   terrain      18%   coast vs valley vs alpine, plus maritime influence
 *
 * `Math.exp(-x/k)` is exponential decay — a smooth "less and less relevant"
 * curve with no cliff edge, which a hard cutoff at, say, 50 km would have.
 *
 * One detail worth noticing: the correlation is computed from the digital
 * *twins*, not the raw probes. If it used raw data, a station that had been
 * broken for a week would score as uncorrelated and quietly drop out of its
 * own diagnosis — exactly when you most need the comparison.
 */
export function computeRelevance(
  target: Station,
  all: StationSeries[],
): NeighbourRelevance[] {
  const self = all.find((s) => s.station.id === target.id);
  const selfTwin = self ? self.twin.map((x) => x.temperature) : [];

  return all
    .filter((s) => s.station.id !== target.id)
    .map(({ station, twin }) => {
      const distanceKm = haversineKm(
        target.latitude,
        target.longitude,
        station.latitude,
        station.longitude,
      );
      const elevationDiff = Math.abs(station.elevation - target.elevation);
      // Correlation of expected conditions — independent of any live fault,
      // because it is computed from the twins rather than the raw probes.
      const corr = correlation(selfTwin, twin.map((x) => x.temperature));

      const distanceScore = Math.exp(-distanceKm / 70);
      const elevationScore = Math.exp(-elevationDiff / 420);
      const terrainMatch =
        (station.terrain === target.terrain ? 1 : 0.55) *
        Math.exp(-Math.abs(station.maritimeInfluence - target.maritimeInfluence) * 1.6);
      const corrScore = clamp((corr + 1) / 2, 0, 1);

      const relevance = clamp(
        0.33 * distanceScore +
          0.25 * elevationScore +
          0.24 * corrScore +
          0.18 * terrainMatch,
        0,
        1,
      );

      return {
        stationId: station.id,
        distanceKm: round(distanceKm, 1),
        elevationDiff: Math.round(station.elevation - target.elevation),
        correlation: round(corr, 3),
        terrainMatch: round(terrainMatch, 3),
        relevance: round(relevance * 100, 0),
      };
    })
    .sort((a, b) => b.relevance - a.relevance);
}

export interface ConsensusResult {
  consensus: number | null;
  spread: number | null;
  contributors: { stationId: string; value: number; relevance: number }[];
}

/**
 * Relevance-weighted consensus for one sensor at one instant, expressed in the
 * target station's own frame.
 *
 * "Given what everyone else is reading, what *should* this station be reading
 * right now?" A plain average would let a distant, irrelevant station pull the
 * answer around; weighting by relevance means the stations that actually share
 * this air mass dominate.
 *
 *   consensus = Σ(value × relevance) ÷ Σ(relevance)
 *
 * The returned `spread` is how much the neighbours disagree among themselves,
 * and it matters as much as the consensus does. Tight spread → a confident
 * expectation, so a departure is meaningful. Wide spread → the network itself
 * is unsettled, and one odd station proves much less.
 */
export function neighbourConsensus(
  target: Station,
  sensorType: SensorType,
  index: number,
  relevances: NeighbourRelevance[],
  seriesById: Map<string, StationSeries>,
  minRelevance = 35,
): ConsensusResult {
  const contributors: { stationId: string; value: number; relevance: number }[] = [];
  // The target's own temperature may be the faulty channel, so the frame of
  // reference comes from its digital twin rather than its probe.
  const self = seriesById.get(target.id);
  const targetTemp = self?.twin[index]?.temperature ?? null;

  for (const rel of relevances) {
    if (rel.relevance < minRelevance) continue;
    const ns = seriesById.get(rel.stationId);
    if (!ns) continue;
    const reading = ns.raw[index];
    if (!reading || !reading.received) continue;
    const v = readingValue(reading, sensorType);
    if (v === null) continue;
    contributors.push({
      stationId: rel.stationId,
      value: adjustToStation(v, sensorType, ns.station, target, reading.temperature, targetTemp),
      relevance: rel.relevance,
    });
  }

  if (contributors.length < 2) return { consensus: null, spread: null, contributors };

  const totalW = contributors.reduce((a, c) => a + c.relevance, 0);
  const consensus = contributors.reduce((a, c) => a + c.value * c.relevance, 0) / totalW;
  // Robust spread: median absolute deviation scaled to a normal σ.
  //
  // Plain standard deviation squares every deviation, so one broken neighbour
  // reading 61 °C would inflate the spread enormously and make the network
  // look uncertain when eleven of twelve stations actually agree. The MAD
  // takes the *median* deviation instead, so outliers cannot dominate it.
  //
  // 1.4826 is the constant that makes the MAD equal σ for normally
  // distributed data, so the two measures stay on the same scale and the
  // downstream sigma thresholds keep their meaning.
  const devs = contributors.map((c) => Math.abs(c.value - consensus));
  const spread = Math.max(1.4826 * median(devs), stdev(contributors.map((c) => c.value)) * 0.6);

  return { consensus, spread, contributors };
}

export interface PropagationMatch {
  stationId: string;
  lagMinutes: number;
  magnitude: number;
  relevance: number;
}

/**
 * Did the same signature appear at other stations nearby in time?
 *
 * This is the single most decisive piece of evidence in the weather-vs-fault
 * question. Real weather travels: it shows up at neighbouring stations offset
 * by a plausible lag and in a geographically sensible order. A failing probe
 * appears at exactly one station and nowhere else, ever.
 *
 * ─── The algorithm ───────────────────────────────────────────────────────
 *
 * For each relevant neighbour, slide a ±3 hour window over its data looking
 * for the same change:
 *
 *   for lag in -180min … +180min, in 5-minute steps:
 *       did this neighbour move in the SAME DIRECTION
 *       by at least HALF the magnitude we saw?
 *   keep the match with the smallest |lag|
 *
 * Two matches at plausible lags, covering at least a third of the neighbours
 * considered, is strong evidence of a real event. Zero matches — nobody,
 * anywhere, at any lag — is strong evidence of a broken probe.
 *
 * `coverage` (matched ÷ considered) is returned alongside the matches because
 * "3 of 4 neighbours agree" and "3 of 11 neighbours agree" are very different
 * findings, and the raw count alone cannot tell them apart.
 *
 * A note on cost: this is deliberately a brute-force search. Cross-correlation
 * via FFT would be asymptotically faster, but at 11 neighbours × 72 lags it is
 * already sub-millisecond, and the loop below is one you can actually read.
 */
export function findPropagation(
  target: Station,
  sensorType: SensorType,
  index: number,
  observedDelta: number,
  relevances: NeighbourRelevance[],
  seriesById: Map<string, StationSeries>,
  stepMs: number,
  windowMs = 3 * HOUR,
): { matches: PropagationMatch[]; coverage: number } {
  const matches: PropagationMatch[] = [];
  const lagSpan = Math.round(windowMs / stepMs);
  const baselineSpan = Math.round((90 * MINUTE) / stepMs);
  let considered = 0;

  for (const rel of relevances) {
    if (rel.relevance < 35) continue;
    const ns = seriesById.get(rel.stationId);
    if (!ns) continue;
    considered++;

    let best: PropagationMatch | null = null;
    for (let lag = -lagSpan; lag <= lagSpan; lag += Math.max(1, Math.round(5 * MINUTE / stepMs))) {
      const j = index + lag;
      if (j - baselineSpan < 0 || j >= ns.raw.length) continue;
      const v = readingValue(ns.raw[j], sensorType);
      const baseVals: number[] = [];
      for (let k = j - baselineSpan; k < j - baselineSpan / 3; k++) {
        const bv = readingValue(ns.raw[k], sensorType);
        if (bv !== null) baseVals.push(bv);
      }
      if (v === null || baseVals.length < 10) continue;
      const delta = v - mean(baseVals);
      // Same direction, at least half the magnitude.
      if (Math.sign(delta) !== Math.sign(observedDelta)) continue;
      const ratio = Math.abs(delta) / Math.max(Math.abs(observedDelta), 1e-6);
      if (ratio < 0.45) continue;
      const candidate: PropagationMatch = {
        stationId: rel.stationId,
        lagMinutes: Math.round((lag * stepMs) / MINUTE),
        magnitude: round(delta, 2),
        relevance: rel.relevance,
      };
      if (!best || Math.abs(candidate.lagMinutes) < Math.abs(best.lagMinutes)) best = candidate;
    }
    if (best) matches.push(best);
  }

  matches.sort((a, b) => a.lagMinutes - b.lagMinutes);
  return { matches, coverage: considered ? matches.length / considered : 0 };
}
