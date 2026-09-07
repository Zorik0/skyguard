import type { Anomaly, QcReading, SensorType } from '@/types';
import type { World } from '@/lib/world';
import { clamp, MINUTE } from '@/lib/utils';
import { neighbourConsensus, readingValue } from '@/lib/neighbours';
import { twinValue } from '@/lib/physics/rules';
import { fitLinear } from '@/lib/corrections/ensemble';

/**
 * Chart-ready series for one station channel.
 *
 * Four traces are shown together because the whole argument of the platform is
 * visible in the gap between them: what the sensor said, what physics expected,
 * what the neighbour regression predicted, and what was finally published.
 */
export interface EstimatePoint {
  t: number;
  raw: number | null;
  twin: number | null;
  ml: number | null;
  corrected: number | null;
  neighbours: number | null;
  flag: string | null;
}

export interface AnomalySpan {
  from: number;
  to: number;
  classification: Anomaly['classification'];
  id: string;
  title: string;
}

export interface ChannelSeries {
  points: EstimatePoint[];
  spans: AnomalySpan[];
  gaps: { from: number; to: number }[];
}

/**
 * Build the traces at chart resolution rather than at telemetry resolution.
 *
 * The neighbour regression needs a consensus at every plotted point, which is
 * the expensive part — so the series is thinned to the number of pixels a
 * chart can actually resolve before any of that work happens.
 */
export function buildChannelSeries(
  world: World,
  stationId: string,
  sensorType: SensorType,
  windowMs: number,
  maxPoints = 260,
): ChannelSeries {
  const series = world.seriesById.get(stationId);
  const qc = world.qcById.get(stationId);
  const station = world.snapshotById.get(stationId)?.station;
  if (!series || !qc || !station) return { points: [], spans: [], gaps: [] };

  const total = series.raw.length;
  const wantSamples = Math.round(windowMs / world.stepMs);
  const startIndex = clamp(total - wantSamples, 0, Math.max(0, total - 2));
  const span = total - startIndex;
  const stride = Math.max(1, Math.ceil(span / maxPoints));

  const relevances = world.snapshotById.get(stationId)?.neighbours ?? [];

  // Fit the neighbour regression on the plotted window's earlier half, which
  // is the part least likely to contain the fault being examined.
  const fitEnd = startIndex + Math.floor(span / 2);
  const fitStride = Math.max(1, Math.round((10 * MINUTE) / world.stepMs));
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = startIndex; i < fitEnd; i += fitStride) {
    const y = readingValue(series.raw[i], sensorType);
    if (y === null) continue;
    const c = neighbourConsensus(station, sensorType, i, relevances, world.seriesById);
    if (c.consensus === null) continue;
    xs.push(c.consensus);
    ys.push(y);
  }
  const fit = fitLinear(xs, ys);

  const points: EstimatePoint[] = [];
  const gaps: { from: number; to: number }[] = [];
  let gapStart: number | null = null;

  for (let i = startIndex; i < total; i += stride) {
    const r = series.raw[i];
    const q: QcReading | undefined = qc[i];
    const consensus = neighbourConsensus(
      station, sensorType, i, relevances, world.seriesById,
    ).consensus;

    if (!r.received) {
      if (gapStart === null) gapStart = r.t;
    } else if (gapStart !== null) {
      gaps.push({ from: gapStart, to: r.t });
      gapStart = null;
    }

    const correctedValue = q?.corrected[sensorType];
    points.push({
      t: r.t,
      raw: r.received ? readingValue(r, sensorType) : null,
      twin: twinValue(series.twin[i], sensorType),
      ml: fit && consensus !== null ? Number((fit.a + fit.b * consensus).toFixed(2)) : null,
      neighbours: consensus !== null ? Number(consensus.toFixed(2)) : null,
      corrected: correctedValue ?? null,
      flag: q?.flags[sensorType] ?? null,
    });
  }
  if (gapStart !== null) gaps.push({ from: gapStart, to: series.raw[total - 1].t });

  const windowStart = series.raw[startIndex].t;
  const spans: AnomalySpan[] = world.anomalies
    .filter(
      (a) =>
        a.stationId === stationId &&
        a.sensorType === sensorType &&
        (a.endedAt ?? world.now) >= windowStart,
    )
    .map((a) => ({
      from: Math.max(a.startedAt, windowStart),
      to: a.endedAt ?? world.now,
      classification: a.classification,
      id: a.id,
      title: a.title,
    }));

  return { points, spans, gaps };
}

/**
 * Dew point is reported by the logger rather than measured directly — it is
 * derived from the station's own temperature and humidity probes, which is why
 * a fault on either one corrupts it too. It gets its own builder because it is
 * not a sensor channel in its own right.
 */
export function buildDewPointSeries(
  world: World,
  stationId: string,
  windowMs: number,
  maxPoints = 260,
): EstimatePoint[] {
  const series = world.seriesById.get(stationId);
  if (!series) return [];
  const total = series.raw.length;
  const startIndex = clamp(total - Math.round(windowMs / world.stepMs), 0, total - 1);
  const stride = Math.max(1, Math.ceil((total - startIndex) / maxPoints));

  const points: EstimatePoint[] = [];
  for (let i = startIndex; i < total; i += stride) {
    const r = series.raw[i];
    points.push({
      t: r.t,
      raw: r.received ? r.dewPoint : null,
      twin: series.twin[i].dewPoint,
      ml: null,
      corrected: null,
      neighbours: null,
      flag: null,
    });
  }
  return points;
}

/**
 * Anomaly score through time: at each instant, the highest score among the
 * findings covering it. A step series rather than a smooth one, because that
 * is genuinely how detection behaves.
 */
export function buildAnomalyScoreSeries(
  world: World,
  stationId: string,
  windowMs: number,
  maxPoints = 260,
): EstimatePoint[] {
  const series = world.seriesById.get(stationId);
  if (!series) return [];
  const total = series.raw.length;
  const startIndex = clamp(total - Math.round(windowMs / world.stepMs), 0, total - 1);
  const stride = Math.max(1, Math.ceil((total - startIndex) / maxPoints));
  const stationAnomalies = world.anomalies.filter((a) => a.stationId === stationId);

  const points: EstimatePoint[] = [];
  for (let i = startIndex; i < total; i += stride) {
    const t = series.raw[i].t;
    let score = 0;
    for (const a of stationAnomalies) {
      if (t >= a.startedAt && t <= (a.endedAt ?? world.now)) score = Math.max(score, a.score);
    }
    points.push({ t, raw: score, twin: null, ml: null, corrected: null, neighbours: null, flag: null });
  }
  return points;
}

/**
 * Residual against the digital twin — the leading indicator behind a sensor's
 * health score, and the quantity that turns into a drift finding when it stops
 * returning to zero.
 */
export function buildResidualSeries(
  world: World,
  stationId: string,
  sensorType: SensorType,
  windowMs: number,
  maxPoints = 260,
): EstimatePoint[] {
  const base = buildChannelSeries(world, stationId, sensorType, windowMs, maxPoints);
  return base.points.map((p) => ({
    ...p,
    raw: p.raw !== null && p.twin !== null ? Number((p.raw - p.twin).toFixed(2)) : null,
    twin: 0,
    ml: null,
    corrected: null,
    neighbours: null,
  }));
}

/** Compact series for a sparkline — no regression, no neighbour lookups. */
export function buildSparkline(
  world: World,
  stationId: string,
  sensorType: SensorType,
  windowMs: number,
  maxPoints = 48,
): number[] {
  const series = world.seriesById.get(stationId);
  if (!series) return [];
  const wantSamples = Math.round(windowMs / world.stepMs);
  const startIndex = clamp(series.raw.length - wantSamples, 0, series.raw.length - 1);
  const stride = Math.max(1, Math.ceil((series.raw.length - startIndex) / maxPoints));
  const out: number[] = [];
  for (let i = startIndex; i < series.raw.length; i += stride) {
    const v = readingValue(series.raw[i], sensorType);
    if (v !== null) out.push(v);
  }
  return out;
}

/** Change over a window, for the delta shown beside each metric. */
export function channelDelta(
  world: World,
  stationId: string,
  sensorType: SensorType,
  windowMs: number,
): number | null {
  const series = world.seriesById.get(stationId);
  if (!series) return null;
  const wantSamples = Math.round(windowMs / world.stepMs);
  const startIndex = clamp(series.raw.length - wantSamples, 0, series.raw.length - 1);
  let first: number | null = null;
  for (let i = startIndex; i < series.raw.length; i++) {
    const v = readingValue(series.raw[i], sensorType);
    if (v !== null) { first = v; break; }
  }
  let last: number | null = null;
  for (let i = series.raw.length - 1; i >= startIndex; i--) {
    const v = readingValue(series.raw[i], sensorType);
    if (v !== null) { last = v; break; }
  }
  if (first === null || last === null) return null;
  return last - first;
}
