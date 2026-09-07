import type { World } from '@/lib/world';
import { SENSOR_LABELS } from '@/lib/simulation/stations';
import { CLASSIFICATION_LABELS } from '@/lib/anomaly/classify';
import { bandLabel } from '@/lib/health/score';
import { readingValue } from '@/lib/neighbours';
import type { SensorType } from '@/types';

/**
 * Client-side report generation.
 *
 * Everything is produced in the browser from the same world object the screens
 * render, so an export can never disagree with what an operator was looking at
 * when they clicked the button. No server round trip and no second query path.
 */

export type ReportFormat = 'csv' | 'json';

export interface ReportDefinition {
  id: string;
  name: string;
  description: string;
  formats: ReportFormat[];
  build: (world: World) => Record<string, unknown>[];
}

/** RFC 4180 quoting — a comma or quote inside a field must not break the file. */
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: Record<string, unknown>[]): string {
  if (!rows.length) return '';
  const headers = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const lines = [headers.join(',')];
  for (const row of rows) lines.push(headers.map((h) => csvCell(row[h])).join(','));
  return lines.join('\r\n');
}

export function toJson(rows: Record<string, unknown>[]): string {
  return JSON.stringify(rows, null, 2);
}

const iso = (t: number) => new Date(t).toISOString();

const CHANNELS: SensorType[] = ['temperature', 'humidity', 'pressure', 'wind_speed', 'rainfall'];

export const REPORTS: ReportDefinition[] = [
  {
    id: 'station-health',
    name: 'Daily station-health report',
    description: 'One row per station: status, health score, uptime, open findings and the weakest channel.',
    formats: ['csv', 'json'],
    build: (world) =>
      world.snapshots.map((s) => {
        const weakest = [...s.sensorHealth].sort((a, b) => a.score - b.score)[0];
        return {
          station_id: s.station.id,
          name: s.station.name,
          region: s.station.region,
          latitude: s.station.latitude,
          longitude: s.station.longitude,
          elevation_m: s.station.elevation,
          status: s.status,
          health_score: s.healthScore,
          uptime_percent: s.uptime,
          last_packet_utc: iso(s.lastPacketAt),
          open_findings: s.anomalies.filter((a) => a.endedAt === null).length,
          weakest_channel: SENSOR_LABELS[weakest.type],
          weakest_score: weakest.score,
          weakest_band: bandLabel(weakest.band),
          firmware: s.station.firmware,
          battery_v: s.latest.battery,
          signal_dbm: s.latest.signal,
        };
      }),
  },
  {
    id: 'anomaly-daily',
    name: 'Daily anomaly report',
    description: 'Every finding in the last 24 hours with its classification, confidence, rules and recommended action.',
    formats: ['csv', 'json'],
    build: (world) =>
      world.anomalies.map((a) => ({
        anomaly_id: a.id,
        station_id: a.stationId,
        channel: SENSOR_LABELS[a.sensorType],
        started_utc: iso(a.startedAt),
        ended_utc: a.endedAt ? iso(a.endedAt) : '',
        severity: a.severity,
        score: a.score,
        classification: CLASSIFICATION_LABELS[a.classification],
        confidence_percent: a.confidence,
        detectors: a.detectorTypes.join(' '),
        rules_fired: a.rules.filter((r) => r.fired).map((r) => r.name).join('; '),
        raw_value: a.rawValue,
        corrected_value: a.correction?.correctedValue ?? '',
        recommended_action: a.recommendedAction,
        incident_id: a.incidentId ?? '',
        signature_id: a.signatureId ?? '',
      })),
  },
  {
    id: 'anomaly-weekly',
    name: 'Weekly anomaly summary',
    description: 'Aggregated counts per station and channel, with mean confidence and correction rate.',
    formats: ['csv', 'json'],
    build: (world) => {
      const rows: Record<string, unknown>[] = [];
      for (const snapshot of world.snapshots) {
        for (const channel of CHANNELS) {
          const items = world.anomalies.filter(
            (a) => a.stationId === snapshot.station.id && a.sensorType === channel,
          );
          if (!items.length) continue;
          rows.push({
            station_id: snapshot.station.id,
            channel: SENSOR_LABELS[channel],
            findings: items.length,
            critical: items.filter((a) => a.severity === 'critical').length,
            sensor_faults: items.filter((a) => a.classification === 'sensor_fault').length,
            weather_events: items.filter((a) => a.classification === 'meteorological_event').length,
            mean_confidence: Math.round(items.reduce((s, a) => s + a.confidence, 0) / items.length),
            corrections: items.filter((a) => a.correction && a.correction.confidence > 0).length,
          });
        }
      }
      return rows;
    },
  },
  {
    id: 'maintenance',
    name: 'Maintenance report',
    description: 'The open maintenance queue with priority, due date, assignee and the reason the task exists.',
    formats: ['csv', 'json'],
    build: (world) =>
      world.maintenance.map((t) => ({
        task_id: t.id,
        station_id: t.stationId,
        sensor_id: t.sensorId ?? '',
        channel: t.sensorType ? SENSOR_LABELS[t.sensorType] : '',
        priority: t.priority,
        status: t.status,
        assignee: t.assignee ?? '',
        due_utc: iso(t.dueAt),
        estimated_hours: t.estimatedHours,
        action: t.action,
        reason: t.reason,
      })),
  },
  {
    id: 'incidents',
    name: 'Incident report',
    description: 'Correlated incidents with affected stations, classification, confidence and propagation order.',
    formats: ['csv', 'json'],
    build: (world) =>
      world.incidents.map((i) => ({
        incident_id: i.id,
        title: i.title,
        classification: CLASSIFICATION_LABELS[i.classification],
        confidence_percent: i.confidence,
        severity: i.severity,
        status: i.status,
        started_utc: iso(i.startedAt),
        ended_utc: i.endedAt ? iso(i.endedAt) : '',
        stations: i.stationIds.join(' '),
        anomalies: i.anomalyIds.join(' '),
        propagation: i.propagation.map((p) => `${p.stationId}@${iso(p.t)}`).join(' '),
        summary: i.summary,
      })),
  },
  {
    id: 'corrected-data',
    name: 'Corrected-data report',
    description: 'Every published correction with the raw value it accompanies, its interval, method and model version.',
    formats: ['csv', 'json'],
    build: (world) =>
      world.anomalies
        .filter((a) => a.correction && a.correction.confidence > 0)
        .map((a) => ({
          timestamp_utc: iso(a.correction!.t),
          station_id: a.stationId,
          channel: SENSOR_LABELS[a.sensorType],
          raw_value: a.correction!.rawValue,
          corrected_value: a.correction!.correctedValue,
          interval_low: a.correction!.interval[0],
          interval_high: a.correction!.interval[1],
          confidence_percent: a.correction!.confidence,
          method: a.correction!.method,
          model_version: a.correction!.modelVersion,
          anomaly_id: a.id,
        })),
  },
  {
    id: 'raw-export',
    name: 'Raw-data export',
    description: 'Unmodified station telemetry, exactly as reported. Hourly resolution to keep the file manageable.',
    formats: ['csv', 'json'],
    build: (world) => {
      const rows: Record<string, unknown>[] = [];
      const stride = 60;
      for (const snapshot of world.snapshots) {
        for (let i = 0; i < snapshot.series.length; i += stride) {
          const r = snapshot.series[i];
          rows.push({
            timestamp_utc: iso(r.t),
            station_id: snapshot.station.id,
            received: r.received,
            temperature_c: r.temperature,
            humidity_percent: r.humidity,
            pressure_hpa: r.pressure,
            dew_point_c: r.dewPoint,
            wind_speed_ms: r.windSpeed,
            wind_direction_deg: r.windDirection,
            rainfall_mm: r.rainfall,
            battery_v: r.battery,
            solar_v: r.solarVoltage,
            signal_dbm: r.signal,
            packet_loss_percent: r.packetLoss,
          });
        }
      }
      return rows;
    },
  },
  {
    id: 'qc-export',
    name: 'Quality-controlled dataset',
    description: 'The same telemetry with quality flags and corrected values alongside — never instead of — the raw readings.',
    formats: ['csv', 'json'],
    build: (world) => {
      const rows: Record<string, unknown>[] = [];
      const stride = 60;
      for (const snapshot of world.snapshots) {
        for (let i = 0; i < snapshot.qcSeries.length; i += stride) {
          const q = snapshot.qcSeries[i];
          const row: Record<string, unknown> = {
            timestamp_utc: iso(q.t),
            station_id: snapshot.station.id,
            received: q.received,
          };
          for (const channel of CHANNELS) {
            row[`${channel}_raw`] = readingValue(q, channel);
            row[`${channel}_flag`] = q.flags[channel] ?? 'good';
            row[`${channel}_corrected`] = q.corrected[channel] ?? '';
          }
          rows.push(row);
        }
      }
      return rows;
    },
  },
  {
    id: 'research',
    name: 'Research dataset',
    description: 'Station metadata joined to per-channel health, drift, calibration age and failure risk — the shape a study would want.',
    formats: ['csv', 'json'],
    build: (world) => {
      const rows: Record<string, unknown>[] = [];
      for (const snapshot of world.snapshots) {
        for (const h of snapshot.sensorHealth) {
          const sensor = snapshot.station.sensors.find((s) => s.id === h.sensorId)!;
          rows.push({
            station_id: snapshot.station.id,
            latitude: snapshot.station.latitude,
            longitude: snapshot.station.longitude,
            elevation_m: snapshot.station.elevation,
            terrain: snapshot.station.terrain,
            maritime_influence: snapshot.station.maritimeInfluence,
            sensor_id: h.sensorId,
            channel: SENSOR_LABELS[h.type],
            manufacturer: sensor.manufacturer,
            model: sensor.model,
            installed_utc: iso(sensor.installedAt),
            last_calibrated_utc: iso(sensor.lastCalibratedAt),
            calibration_age_days: h.calibrationAgeDays,
            calibration_interval_days: sensor.calibrationIntervalDays,
            health_score: h.score,
            health_band: bandLabel(h.band),
            offset_vs_peers: h.drift,
            offset_unit: h.driftUnit,
            drift_rate_per_week: h.driftRateSignificant ? h.driftRate : '',
            noise_sigma_1h: h.noise,
            missing_rate: h.missingRate,
            anomaly_count_24h: h.anomalyCount,
            correction_count_24h: h.correctionCount,
            failure_risk_30d_percent: h.failureRisk30d,
          });
        }
      }
      return rows;
    },
  },
  {
    id: 'audit',
    name: 'Audit trail export',
    description: 'The complete provenance record: raw value, flag, correction, rules, model version and operator action.',
    formats: ['csv', 'json'],
    build: (world) =>
      world.audit.map((e) => ({
        timestamp_utc: iso(e.t),
        entry_id: e.id,
        station_id: e.stationId,
        channel: e.sensorType ? SENSOR_LABELS[e.sensorType] : '',
        raw_value: e.rawValue,
        quality_flag: e.flag,
        corrected_value: e.correctedValue ?? '',
        anomaly_score: e.anomalyScore ?? '',
        classification: e.classification ? CLASSIFICATION_LABELS[e.classification] : '',
        confidence_percent: e.confidence ?? '',
        rules: e.rules.join('; '),
        model_version: e.modelVersion,
        operator_action: e.operatorAction ?? '',
        reason: e.reason,
        incident_id: e.incidentId ?? '',
      })),
  },
];

/** Trigger a download entirely in the browser. */
export function downloadReport(
  rows: Record<string, unknown>[],
  filename: string,
  format: ReportFormat,
) {
  const content = format === 'csv' ? toCsv(rows) : toJson(rows);
  const blob = new Blob([content], {
    type: format === 'csv' ? 'text/csv;charset=utf-8' : 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${filename}.${format}`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  // Give the browser a moment to start the download before revoking.
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
