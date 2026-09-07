import type {
  Alert,
  Anomaly,
  AuditEntry,
  CalibrationRecord,
  ExternalContext,
  FailureSignature,
  Incident,
  MaintenanceRecord,
  MaintenanceTask,
  QcReading,
  QualityFlag,
  RawReading,
  SensorHealth,
  SensorType,
  Station,
  StationSnapshot,
  StationStatus,
} from '@/types';
import { clamp, DAY, HOUR, median, MINUTE, round, slopeWithError } from '@/lib/utils';
import { makeRng } from '@/lib/rng';
import { buildStations, metadataAnchor } from '@/lib/simulation/stations';
import { generateSeries, SIM_STEP_MS, SIM_WINDOW_MS } from '@/lib/simulation/engine';
import { baselineEvents } from '@/lib/simulation/baseline';
import type { SimEvent } from '@/lib/simulation/events';
import {
  computeRelevance,
  neighbourConsensus,
  readingValue,
  type StationSeries,
} from '@/lib/neighbours';
import { DEFAULT_PHYSICS_CONFIG, scaleConfig, twinValue, type PhysicsConfig } from '@/lib/physics/rules';
import { analyseNetwork } from '@/lib/anomaly/analyze';
import {
  buildAlerts,
  buildAuditTrail,
  buildIncidents,
  buildSignatures,
} from '@/lib/incidents/group';
import { buildMaintenanceTasks, computeSensorHealth, stationHealthScore } from '@/lib/health/score';

/**
 * The single source of truth for every screen.
 *
 * One pure function turns (seed, events, clock) into the entire application
 * state: telemetry, anomalies, incidents, alerts, health, maintenance and the
 * audit trail. Because every screen reads from this one object, a fault
 * injected at AWS-007 necessarily appears on the overview, the map, the health
 * matrix, the alert list and the audit log at the same instant — there is no
 * second copy of the data that could disagree.
 */

export interface WorldOptions {
  /** Simulation clock, already rounded to the sample interval. */
  now: number;
  seed: number;
  /** Baseline story plus anything the operator injected. */
  injectedEvents: SimEvent[];
  /** 0–100. Scales every physics threshold as one operator-facing dial. */
  sensitivity: number;
  /** Live external context, keyed by station id. Empty is fine. */
  external: Map<string, ExternalContext>;
  /** Simulation mode drops the baseline story's live-feel and runs clean. */
  includeBaseline: boolean;
}

export interface NetworkMetrics {
  stationsOnline: number;
  stationsDegraded: number;
  stationsOffline: number;
  healthySensors: number;
  sensorsNeedingMaintenance: number;
  activeAnomalies: number;
  criticalAlerts: number;
  activeWeatherEvents: number;
  rowsPerMinute: number;
  dataQualityScore: number;
  totalSensors: number;
}

export interface World {
  now: number;
  from: number;
  stepMs: number;
  seed: number;
  events: SimEvent[];
  stations: Station[];
  seriesById: Map<string, StationSeries>;
  qcById: Map<string, QcReading[]>;
  snapshots: StationSnapshot[];
  snapshotById: Map<string, StationSnapshot>;
  anomalies: Anomaly[];
  incidents: Incident[];
  alerts: Alert[];
  audit: AuditEntry[];
  signatures: FailureSignature[];
  maintenance: MaintenanceTask[];
  healthByStation: Map<string, SensorHealth[]>;
  metrics: NetworkMetrics;
  config: PhysicsConfig;
}

const CORRECTABLE: SensorType[] = ['temperature', 'humidity', 'pressure', 'wind_speed', 'rainfall'];

export interface DriftMeasurement {
  /** Current offset from the peer consensus, in native units. */
  offset: number;
  /** Weekly rate of change of that offset; 0 when not significant. */
  ratePerWeek: number;
  significant: boolean;
}

/**
 * Calibration drift, measured the way a real network measures it: against the
 * station's peers rather than against a model of itself.
 *
 * The headline number is the *current offset*, which is directly observable
 * and robust. A weekly rate is also fitted, but only reported when it clears a
 * two-sigma test — twenty-four hours of telemetry frequently cannot resolve a
 * drift of a few tenths per day, and reporting an unresolvable trend as fact
 * would be worse than reporting nothing.
 */
function computeDriftRates(
  stations: Station[],
  seriesById: Map<string, StationSeries>,
  relevanceById: Map<string, ReturnType<typeof computeRelevance>>,
  stepMs: number,
): Map<string, Map<SensorType, DriftMeasurement>> {
  const out = new Map<string, Map<SensorType, DriftMeasurement>>();
  const stride = Math.max(1, Math.round((15 * MINUTE) / stepMs));
  const samplesPerWeek = (7 * DAY) / (stride * stepMs);

  for (const station of stations) {
    const series = seriesById.get(station.id);
    const relevances = relevanceById.get(station.id) ?? [];
    const perSensor = new Map<SensorType, DriftMeasurement>();
    if (!series) {
      out.set(station.id, perSensor);
      continue;
    }

    for (const sensorType of CORRECTABLE) {
      const residuals: number[] = [];
      for (let i = 0; i < series.raw.length; i += stride) {
        if (!series.raw[i].received) continue;
        const v = readingValue(series.raw[i], sensorType);
        if (v === null) continue;
        const c = neighbourConsensus(station, sensorType, i, relevances, seriesById);
        if (c.consensus === null) continue;
        residuals.push(v - c.consensus);
      }
      if (residuals.length >= 24) {
        const { slope: perSample, se } = slopeWithError(residuals);
        const significant = Number.isFinite(se) && Math.abs(perSample) > 2 * se;
        perSensor.set(sensorType, {
          offset: round(median(residuals), 2),
          ratePerWeek: significant ? round(perSample * samplesPerWeek, 2) : 0,
          significant,
        });
      }
    }
    out.set(station.id, perSensor);
  }
  return out;
}

/**
 * Quality-controlled series.
 *
 * Raw readings are copied, never mutated. Corrections are carried across the
 * whole episode by anchoring the peak estimate to the digital twin's shape, so
 * the corrected trace follows real conditions rather than sitting flat.
 */
function buildQcSeries(series: StationSeries, anomalies: Anomaly[], stepMs: number, from: number): QcReading[] {
  const qc: QcReading[] = series.raw.map((r) => ({
    ...r,
    flags: {} as Partial<Record<SensorType, QualityFlag>>,
    corrected: {} as Partial<Record<SensorType, number>>,
  }));

  for (let i = 0; i < qc.length; i++) {
    if (!qc[i].received) {
      for (const s of CORRECTABLE) qc[i].flags[s] = 'missing';
    }
  }

  const idxOf = (t: number) => clamp(Math.round((t - from) / stepMs), 0, qc.length - 1);

  for (const a of anomalies) {
    if (a.stationId !== series.station.id) continue;
    if (!CORRECTABLE.includes(a.sensorType)) continue;

    const start = idxOf(a.startedAt);
    const end = idxOf(a.endedAt ?? series.raw[series.raw.length - 1].t);

    if (a.classification === 'meteorological_event') {
      for (let i = start; i <= end; i++) {
        if (qc[i].flags[a.sensorType] === undefined) qc[i].flags[a.sensorType] = 'good';
      }
      continue;
    }

    if (!a.correction || a.correction.confidence === 0) {
      for (let i = start; i <= end; i++) {
        if (qc[i].received) qc[i].flags[a.sensorType] = 'suspect';
      }
      continue;
    }

    const peakIdx = idxOf(a.correction.t);
    const twinAtPeak = twinValue(series.twin[peakIdx], a.sensorType);
    const offset = twinAtPeak !== null ? a.correction.correctedValue - twinAtPeak : 0;

    for (let i = start; i <= end; i++) {
      if (!qc[i].received) continue;
      const tv = twinValue(series.twin[i], a.sensorType);
      if (tv === null) continue;
      qc[i].flags[a.sensorType] = 'corrected';
      qc[i].corrected[a.sensorType] = round(tv + offset, 2);
    }
  }

  for (let i = 0; i < qc.length; i++) {
    for (const s of CORRECTABLE) {
      if (qc[i].flags[s] === undefined) qc[i].flags[s] = 'good';
    }
  }

  return qc;
}

/** Read a channel through the active raw/quality-controlled lens. */
export function qcValue(reading: QcReading, sensorType: SensorType, cleaned: boolean): number | null {
  if (cleaned) {
    const c = reading.corrected[sensorType];
    if (c !== undefined) return c;
  }
  return readingValue(reading, sensorType);
}

function deriveStatus(
  station: Station,
  latest: RawReading,
  lastPacketAt: number,
  now: number,
  healthScore: number,
  anomalies: Anomaly[],
): StationStatus {
  if (now - lastPacketAt > 10 * MINUTE) return 'offline';
  const active = anomalies.filter((a) => a.endedAt === null);
  if (healthScore < 20) return 'failed';
  if (healthScore < 40 || active.some((a) => a.severity === 'critical')) return 'critical';
  if (active.some((a) => a.classification === 'meteorological_event') && healthScore >= 60) return 'event';
  if (healthScore < 70 || active.some((a) => a.severity === 'high' || a.severity === 'warning')) return 'warning';
  void latest;
  return 'healthy';
}

function buildHistory(station: Station, now: number) {
  const anchor = metadataAnchor(now);
  const calibrations: CalibrationRecord[] = [];
  const maintenance: MaintenanceRecord[] = [];
  const technicians = ['R. Okafor', 'M. Lindqvist', 'A. Bhatt', 'J. Moreau', 'S. Tanaka'];

  for (const sensor of station.sensors) {
    const rng = makeRng(`cal:${sensor.id}`);
    // Two prior calibrations behind the most recent one.
    for (let k = 0; k < 3; k++) {
      const t = sensor.lastCalibratedAt - k * sensor.calibrationIntervalDays * DAY;
      if (t < station.installedAt) break;
      calibrations.push({
        t,
        sensorId: sensor.id,
        technician: technicians[Math.floor(rng() * technicians.length)],
        offsetApplied: round((rng() - 0.5) * (sensor.type === 'humidity' ? 2.4 : 0.6), 2),
        note: k === 0 ? 'Routine calibration against reference standard' : 'Scheduled interval calibration',
      });
    }
  }

  const rng = makeRng(`maint:${station.id}`);
  const actions = [
    ['Annual site inspection', 'All channels within specification'],
    ['Enclosure reseal and desiccant replacement', 'Moisture ingress resolved'],
    ['Anemometer bearing service', 'Rotation restored to specification'],
    ['Solar panel clean and charge-controller check', 'Charge current restored'],
    ['Rain-gauge funnel clean', 'Blockage cleared'],
    ['Modem firmware update', 'Link stability improved'],
  ];
  for (let k = 0; k < 4; k++) {
    const [action, outcome] = actions[Math.floor(rng() * actions.length)];
    maintenance.push({
      t: anchor - Math.floor(20 + rng() * 320) * DAY,
      stationId: station.id,
      technician: technicians[Math.floor(rng() * technicians.length)],
      action,
      outcome,
    });
  }

  return {
    calibrations: calibrations.sort((a, b) => b.t - a.t),
    maintenance: maintenance.sort((a, b) => b.t - a.t),
  };
}

export function buildWorld(options: WorldOptions): World {
  const { now, seed, injectedEvents, sensitivity, external, includeBaseline } = options;
  const from = now - SIM_WINDOW_MS;
  const stepMs = SIM_STEP_MS;

  const events: SimEvent[] = [
    ...(includeBaseline ? baselineEvents(now) : []),
    ...injectedEvents,
  ];

  const stations = buildStations(now);

  // 1. Telemetry -----------------------------------------------------------
  const seriesById = new Map<string, StationSeries>();
  for (const station of stations) {
    const { raw, twin } = generateSeries(station, from, now, seed, events);
    seriesById.set(station.id, { station, raw, twin });
  }
  const allSeries = [...seriesById.values()];

  // 2. Neighbour relevance -------------------------------------------------
  const relevanceById = new Map(
    stations.map((s) => [s.id, computeRelevance(s, allSeries)] as const),
  );

  // 3. Detection, classification and correction ----------------------------
  const config = scaleConfig(DEFAULT_PHYSICS_CONFIG, sensitivity);
  const zThreshold = clamp(4 + (50 - sensitivity) / 12, 2.2, 9);
  const anomalies = analyseNetwork({
    stations,
    seriesById,
    relevanceById,
    externalById: external,
    config,
    zThreshold,
    now,
    from,
    stepMs,
  });

  // 4. Correlation into incidents ------------------------------------------
  const incidents = buildIncidents(anomalies, stations, now);
  const signatures = buildSignatures(anomalies);
  const alerts = buildAlerts(anomalies, now);
  const audit = buildAuditTrail(anomalies);

  // 5. Health, quality control and snapshots -------------------------------
  const driftRates = computeDriftRates(stations, seriesById, relevanceById, stepMs);
  const qcById = new Map<string, QcReading[]>();
  const healthByStation = new Map<string, SensorHealth[]>();
  const snapshots: StationSnapshot[] = [];

  for (const station of stations) {
    const series = seriesById.get(station.id)!;
    const stationAnomalies = anomalies.filter((a) => a.stationId === station.id);

    const health = station.sensors.map((sensor) =>
      computeSensorHealth(
        station, sensor, series, stationAnomalies, now, stepMs, seed,
        driftRates.get(station.id)?.get(sensor.type),
      ),
    );
    healthByStation.set(station.id, health);

    const qc = buildQcSeries(series, stationAnomalies, stepMs, from);
    qcById.set(station.id, qc);

    const received = series.raw.filter((r) => r.received);
    const latest = received[received.length - 1] ?? series.raw[series.raw.length - 1];
    const lastPacketAt = latest?.t ?? from;
    const healthScore = stationHealthScore(health);
    const uptime = series.raw.length ? received.length / series.raw.length : 0;

    const { calibrations, maintenance } = buildHistory(station, now);

    snapshots.push({
      station,
      status: deriveStatus(station, latest, lastPacketAt, now, healthScore, stationAnomalies),
      latest,
      qc: qc[qc.length - 1],
      healthScore,
      sensorHealth: health,
      anomalies: stationAnomalies.sort((a, b) => b.startedAt - a.startedAt),
      neighbours: relevanceById.get(station.id) ?? [],
      uptime: round(uptime * 100, 2),
      lastPacketAt,
      twin: series.twin[series.twin.length - 1],
      series: series.raw,
      twinSeries: series.twin,
      qcSeries: qc,
      calibrations,
      maintenance,
    });
  }

  const maintenance = buildMaintenanceTasks(stations, healthByStation, anomalies, now);

  // 6. Network roll-up ------------------------------------------------------
  const allHealth = [...healthByStation.values()].flat();
  const activeAnomalies = anomalies.filter((a) => a.endedAt === null);
  const metrics: NetworkMetrics = {
    stationsOnline: snapshots.filter((s) => s.status !== 'offline').length,
    stationsDegraded: snapshots.filter((s) => ['warning', 'critical', 'failed'].includes(s.status)).length,
    stationsOffline: snapshots.filter((s) => s.status === 'offline').length,
    healthySensors: allHealth.filter((h) => h.band === 'healthy').length,
    sensorsNeedingMaintenance: allHealth.filter((h) => h.band !== 'healthy').length,
    activeAnomalies: activeAnomalies.length,
    criticalAlerts: alerts.filter((a) => a.severity === 'critical' && a.state !== 'resolved').length,
    activeWeatherEvents: incidents.filter(
      (i) => i.classification === 'meteorological_event' && i.status !== 'resolved',
    ).length,
    rowsPerMinute: snapshots.filter((s) => s.status !== 'offline').length,
    totalSensors: allHealth.length,
    dataQualityScore: round(
      allHealth.length ? allHealth.reduce((a, h) => a + h.score, 0) / allHealth.length : 100,
      1,
    ),
  };

  return {
    now,
    from,
    stepMs,
    seed,
    events,
    stations,
    seriesById,
    qcById,
    snapshots,
    snapshotById: new Map(snapshots.map((s) => [s.station.id, s])),
    anomalies,
    incidents,
    alerts,
    audit,
    signatures,
    maintenance,
    healthByStation,
    metrics,
    config,
  };
}

export { SIM_STEP_MS, SIM_WINDOW_MS, HOUR };
