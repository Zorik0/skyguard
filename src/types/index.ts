/**
 * SkyGuard domain model.
 *
 * The architecture keeps a hard separation between the concepts described in
 * the platform spec: raw telemetry is never mutated, quality-controlled values
 * are derived, and every derived value records its provenance.
 */

/** Where a displayed value came from. Rendered as a badge next to the value. */
export type DataSource =
  | 'LIVE'
  | 'SIMULATED'
  | 'EXTERNAL_MODEL'
  | 'CORRECTED'
  | 'ESTIMATED'
  | 'MODELLED';

export type DataMode = 'hybrid' | 'simulation' | 'demo';

export type StationStatus =
  | 'healthy'
  | 'warning'
  | 'critical'
  | 'failed'
  | 'offline'
  | 'event';

export type SensorType =
  | 'temperature'
  | 'humidity'
  | 'pressure'
  | 'wind_speed'
  | 'wind_direction'
  | 'rainfall'
  | 'battery'
  | 'comms';

export type Severity = 'info' | 'warning' | 'high' | 'critical';

export type Classification =
  | 'sensor_fault'
  | 'meteorological_event'
  | 'communications'
  | 'power'
  | 'indeterminate';

export interface SensorSpec {
  id: string;
  stationId: string;
  type: SensorType;
  label: string;
  unit: string;
  manufacturer: string;
  model: string;
  serial: string;
  installedAt: number;
  lastCalibratedAt: number;
  calibrationIntervalDays: number;
}

export interface Station {
  id: string;
  name: string;
  region: string;
  latitude: number;
  longitude: number;
  elevation: number;
  /** Distance from the coast in km — drives maritime moderation in the sim. */
  maritimeInfluence: number;
  terrain: 'coastal' | 'valley' | 'foothill' | 'alpine' | 'plateau';
  installedAt: number;
  firmware: string;
  hardwareModel: string;
  sensors: SensorSpec[];
}

/**
 * One minute of station telemetry exactly as the (simulated) logger reported
 * it. Null means the packet carried no value for that channel.
 */
export interface RawReading {
  t: number;
  temperature: number | null;
  humidity: number | null;
  pressure: number | null;
  dewPoint: number | null;
  windSpeed: number | null;
  windDirection: number | null;
  rainfall: number | null;
  battery: number | null;
  solarVoltage: number | null;
  signal: number | null;
  packetLoss: number | null;
  /** False when the packet never arrived (communications outage). */
  received: boolean;
}

/** The value the station *should* be reading, from the digital twin. */
export interface TwinReading {
  t: number;
  temperature: number;
  humidity: number;
  pressure: number;
  dewPoint: number;
  windSpeed: number;
  rainfall: number;
}

export type QualityFlag = 'good' | 'suspect' | 'bad' | 'missing' | 'corrected';

/** A raw reading after the quality-control pipeline has run over it. */
export interface QcReading extends RawReading {
  flags: Partial<Record<SensorType, QualityFlag>>;
  corrected: Partial<Record<SensorType, number>>;
}

export interface EvidenceItem {
  id: string;
  label: string;
  detail: string;
  /** Which conclusion this evidence supports. */
  supports: 'fault' | 'weather' | 'neutral';
  weight: number;
  source: DataSource;
}

export interface RuleTrigger {
  id: string;
  name: string;
  description: string;
  fired: boolean;
  observed: string;
  limit: string;
}

export interface CorrectionSourceWeight {
  source: string;
  weight: number;
  estimate: number | null;
  available: boolean;
}

export interface Correction {
  sensorType: SensorType;
  rawValue: number;
  correctedValue: number;
  interval: [number, number];
  confidence: number;
  method: string;
  modelVersion: string;
  weights: CorrectionSourceWeight[];
  t: number;
}

export interface Anomaly {
  id: string;
  stationId: string;
  sensorType: SensorType;
  startedAt: number;
  endedAt: number | null;
  detectedAt: number;
  score: number;
  severity: Severity;
  classification: Classification;
  confidence: number;
  title: string;
  summary: string;
  narrative: string;
  evidence: EvidenceItem[];
  rules: RuleTrigger[];
  recommendedAction: string;
  rawValue: number | null;
  /** Signed departure from the pre-episode baseline, in native units. */
  delta: number;
  correction: Correction | null;
  incidentId: string | null;
  signatureId: string | null;
  detectorTypes: DetectorType[];
}

export type DetectorType =
  | 'spike'
  | 'drop'
  | 'frozen'
  | 'noise'
  | 'drift'
  | 'range'
  | 'rate_of_change'
  | 'cross_sensor'
  | 'neighbour'
  | 'missing'
  | 'comms'
  | 'battery'
  | 'calibration';

export interface SensorHealth {
  sensorId: string;
  stationId: string;
  type: SensorType;
  score: number;
  band: 'healthy' | 'minor' | 'warning' | 'critical' | 'failed';
  trend7d: number;
  trend30d: number;
  calibrationAgeDays: number;
  anomalyCount: number;
  correctionCount: number;
  /** Current offset from the relevance-weighted peer consensus. */
  drift: number;
  driftUnit: string;
  /** Rate of change of that offset — 0 when not statistically significant. */
  driftRate: number;
  driftRateUnit: string;
  /** True when the trend cleared the significance test. */
  driftRateSignificant: boolean;
  noise: number;
  missingRate: number;
  failureRisk30d: number;
  recommendation: string;
  factors: { label: string; penalty: number; detail: string }[];
}

export type IncidentStatus =
  | 'new'
  | 'acknowledged'
  | 'investigating'
  | 'monitoring'
  | 'resolved';

export interface IncidentActivity {
  t: number;
  actor: string;
  message: string;
}

export interface Incident {
  id: string;
  title: string;
  classification: Classification;
  confidence: number;
  severity: Severity;
  startedAt: number;
  endedAt: number | null;
  status: IncidentStatus;
  stationIds: string[];
  anomalyIds: string[];
  summary: string;
  recommendedActions: string[];
  /** Ordered arrival of the event across the network. */
  propagation: { stationId: string; t: number }[];
  activity: IncidentActivity[];
}

export interface Alert {
  id: string;
  stationId: string;
  sensorType: SensorType;
  severity: Severity;
  message: string;
  t: number;
  confidence: number;
  incidentId: string | null;
  anomalyId: string;
  state: 'new' | 'acknowledged' | 'snoozed' | 'resolved';
}

export type MaintenanceStatus =
  | 'open'
  | 'assigned'
  | 'scheduled'
  | 'in_progress'
  | 'completed';

export interface MaintenanceTask {
  id: string;
  stationId: string;
  sensorId: string | null;
  sensorType: SensorType | null;
  priority: Severity;
  title: string;
  action: string;
  reason: string;
  status: MaintenanceStatus;
  assignee: string | null;
  dueAt: number;
  createdAt: number;
  estimatedHours: number;
}

export interface AuditEntry {
  id: string;
  t: number;
  stationId: string;
  sensorType: SensorType | null;
  rawValue: number | null;
  flag: QualityFlag;
  correctedValue: number | null;
  anomalyScore: number | null;
  classification: Classification | null;
  confidence: number | null;
  rules: string[];
  modelVersion: string;
  operatorAction: string | null;
  reason: string;
  incidentId: string | null;
}

export interface NeighbourRelevance {
  stationId: string;
  distanceKm: number;
  elevationDiff: number;
  correlation: number;
  terrainMatch: number;
  relevance: number;
}

export interface CalibrationRecord {
  t: number;
  sensorId: string;
  technician: string;
  offsetApplied: number;
  note: string;
}

export interface MaintenanceRecord {
  t: number;
  stationId: string;
  technician: string;
  action: string;
  outcome: string;
}

export interface FailureSignature {
  id: string;
  name: string;
  pattern: string;
  occurrences: number;
  sensorsAffected: number;
  commonCause: string;
  historicalConfidence: number;
  detectorTypes: DetectorType[];
  anomalyIds: string[];
}

/** External weather context fetched from a real provider. */
export interface ExternalCurrent {
  t: number;
  temperature: number;
  humidity: number;
  pressure: number;
  dewPoint: number;
  windSpeed: number;
  windDirection: number;
  precipitation: number;
  weatherCode: number;
  elevation: number | null;
}

export interface ExternalHourly {
  t: number;
  temperature: number;
  humidity: number;
  pressure: number;
  dewPoint: number;
  windSpeed: number;
  precipitation: number;
  precipitationProbability: number;
}

export interface EnsembleBand {
  t: number;
  mean: number;
  min: number;
  max: number;
}

export interface ExternalContext {
  stationId: string;
  provider: string;
  fetchedAt: number;
  current: ExternalCurrent | null;
  hourly: ExternalHourly[];
  ensemble: EnsembleBand[];
  elevation: number | null;
  status: 'live' | 'fallback' | 'loading' | 'error';
  message?: string;
}

export interface RadarFrame {
  time: number;
  path: string;
}

export interface RadarMeta {
  host: string;
  past: RadarFrame[];
  nowcast: RadarFrame[];
  status: 'live' | 'unavailable';
}

export interface StationSnapshot {
  station: Station;
  status: StationStatus;
  latest: RawReading;
  qc: QcReading;
  healthScore: number;
  sensorHealth: SensorHealth[];
  anomalies: Anomaly[];
  neighbours: NeighbourRelevance[];
  uptime: number;
  lastPacketAt: number;
  twin: TwinReading;
  series: RawReading[];
  twinSeries: TwinReading[];
  qcSeries: QcReading[];
  calibrations: CalibrationRecord[];
  maintenance: MaintenanceRecord[];
}
