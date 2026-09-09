import type {
  Alert,
  Anomaly,
  AuditEntry,
  Classification,
  FailureSignature,
  Incident,
  IncidentStatus,
  Severity,
  Station,
} from '@/types';
import { HOUR, MINUTE, round } from '@/lib/utils';
import { makeRng } from '@/lib/rng';
import { CLASSIFICATION_LABELS } from '@/lib/anomaly/classify';

/**
 * Incident correlation — STAGE 5 of the pipeline.
 *
 * Twenty anomalies caused by one front are one operational event, not twenty.
 * Anomalies are therefore clustered — meteorological ones across the whole
 * network, hardware ones per station — and every downstream surface (alerts,
 * notifications, reports) works from the incident rather than the raw anomaly.
 *
 * ─── The operational problem this solves ─────────────────────────────────
 *
 * A cold front crossing twelve stations legitimately produces sixty anomalies:
 * temperature, humidity and pressure at each site, all real, all correctly
 * detected. Show those as sixty alerts and the operator is worse off than with
 * no system at all — the signal is buried in its own success, and the first
 * thing they will do is turn the alerts off.
 *
 * Grouping is the difference between "60 anomalies" and:
 *
 *   ▸ Cold front, 12 stations, 14:20–16:45 — genuine weather, no action
 *   ▸ AWS-007 temperature probe failure — corrected, engineer dispatched
 *
 * ─── The two clustering rules, and why they differ ───────────────────────
 *
 *   meteorological  cluster across the WHOLE NETWORK by time
 *                   → weather is one shared event affecting many stations
 *
 *   hardware        cluster PER STATION by time
 *                   → two stations failing at once is a coincidence, not a
 *                     cause; merging them would invent a relationship and
 *                     send one engineer to fix two unrelated things
 *
 * That asymmetry is the whole insight of the file. It follows directly from
 * what the two phenomena physically are.
 */

const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, high: 1, warning: 2, info: 3 };

function worstSeverity(anomalies: Anomaly[]): Severity {
  return anomalies.reduce<Severity>(
    (worst, a) => (SEVERITY_ORDER[a.severity] < SEVERITY_ORDER[worst] ? a.severity : worst),
    'info',
  );
}

/**
 * Greedy temporal clustering: extend a cluster while anomalies keep arriving.
 *
 * Sort by start time, then walk the list: if the next anomaly begins within
 * `gapMs` of the end of the current cluster, it joins; otherwise it starts a
 * new one.
 *
 *   |--A--|  |--B--|      |--C--|
 *          ↑gap↑     ↑ bigger gap ↑
 *   A and B are one incident; C is separate.
 *
 * "Greedy" means it never reconsiders a decision once made. That is not
 * optimal in general, but for events on a timeline it is both correct enough
 * and O(n log n) — dominated by the sort.
 */
function clusterByTime(anomalies: Anomaly[], gapMs: number): Anomaly[][] {
  const sorted = [...anomalies].sort((a, b) => a.startedAt - b.startedAt);
  const clusters: Anomaly[][] = [];
  let current: Anomaly[] = [];
  let clusterEnd = -Infinity;

  for (const a of sorted) {
    if (!current.length || a.startedAt - clusterEnd <= gapMs) {
      current.push(a);
      clusterEnd = Math.max(clusterEnd, a.endedAt ?? a.startedAt);
    } else {
      clusters.push(current);
      current = [a];
      clusterEnd = a.endedAt ?? a.startedAt;
    }
  }
  if (current.length) clusters.push(current);
  return clusters;
}

function meteorologicalTitle(anomalies: Anomaly[], stations: Map<string, Station>): string {
  const byType = (t: string) => anomalies.filter((a) => a.sensorType === t);
  const temps = byType('temperature');
  // Use the signed departure, not the wording of the title.
  const netTemp = temps.reduce((acc, a) => acc + a.delta, 0);
  const netPressure = byType('pressure').reduce((acc, a) => acc + a.delta, 0);
  const netHumidity = byType('humidity').reduce((acc, a) => acc + a.delta, 0);
  const hasRain = byType('rainfall').length > 0;
  const hasPressure = byType('pressure').length > 0;

  // Where did it enter the network?
  const first = [...anomalies].sort((a, b) => a.startedAt - b.startedAt)[0];
  const entry = stations.get(first.stationId);
  const where = entry ? `${entry.region.toLowerCase()}` : 'the network';

  if (temps.length && netTemp < 0) {
    // Falling temperature with rising humidity and a pressure trough is the
    // textbook frontal signature.
    return hasPressure && netHumidity > 0
      ? `Cold front entering via ${where}`
      : `Cooling air mass crossing ${where}`;
  }
  if (temps.length && netTemp > 0) return `Regional warming event across ${where}`;
  if (hasRain) return `Precipitation event over ${where}`;
  if (hasPressure) return `Synoptic ${netPressure < 0 ? 'pressure fall' : 'pressure rise'} across ${where}`;
  return `Meteorological event affecting ${where}`;
}

function faultTitle(anomalies: Anomaly[]): string {
  const stationId = anomalies[0].stationId;
  const types = [...new Set(anomalies.map((a) => a.sensorType))];
  const primary = anomalies.reduce((w, a) => (a.score > w.score ? a : w), anomalies[0]);
  // Reuse the dominant anomaly's own wording so the incident does not claim a
  // "failure" when the finding was drift or noise.
  if (types.length === 1) return primary.title;
  return `${stationId} multi-channel degradation`;
}

function initialStatus(severity: Severity, ageMinutes: number, seed: string): IncidentStatus {
  if (ageMinutes < 12) return 'new';
  const rng = makeRng(`status:${seed}`);
  const r = rng();
  if (severity === 'critical') return ageMinutes > 45 ? 'investigating' : 'acknowledged';
  if (ageMinutes > 8 * 60) return r < 0.55 ? 'resolved' : 'monitoring';
  if (ageMinutes > 90) return r < 0.5 ? 'monitoring' : 'investigating';
  return 'acknowledged';
}

function buildActivity(
  incidentId: string,
  anomalies: Anomaly[],
  status: IncidentStatus,
  classification: Classification,
): Incident['activity'] {
  const sorted = [...anomalies].sort((a, b) => a.startedAt - b.startedAt);
  const start = sorted[0].startedAt;
  const activity: Incident['activity'] = [
    {
      t: start,
      actor: 'SkyGuard',
      message: `Incident opened from ${anomalies.length} correlated anomal${anomalies.length === 1 ? 'y' : 'ies'} — classified as ${CLASSIFICATION_LABELS[classification].toLowerCase()}.`,
    },
  ];

  const stations = [...new Set(sorted.map((a) => a.stationId))];
  if (stations.length > 1) {
    activity.push({
      t: sorted[Math.min(2, sorted.length - 1)].startedAt,
      actor: 'SkyGuard',
      message: `Signature confirmed at ${stations.length} stations in geographic order — consistent with a travelling system.`,
    });
  }

  const rng = makeRng(`activity:${incidentId}`);
  const operators = ['J. Moreau', 'R. Okafor', 'S. Tanaka', 'M. Lindqvist'];
  const op = operators[Math.floor(rng() * operators.length)];

  if (status !== 'new') {
    activity.push({
      t: start + 6 * MINUTE,
      actor: op,
      message: 'Acknowledged. Reviewing evidence and neighbour comparison.',
    });
  }
  if (status === 'investigating') {
    activity.push({
      t: start + 22 * MINUTE,
      actor: op,
      message: classification === 'sensor_fault'
        ? 'Raised a maintenance task for the affected channel. Corrected values published to the quality-controlled dataset.'
        : 'Confirmed as genuine conditions. No correction applied; continuing to track across the network.',
    });
  }
  if (status === 'monitoring') {
    activity.push({
      t: start + 40 * MINUTE,
      actor: op,
      message: 'Conditions stabilising. Holding the incident open while the event clears the network.',
    });
  }
  if (status === 'resolved') {
    activity.push({
      t: start + 95 * MINUTE,
      actor: op,
      message: 'Event cleared the network. Incident resolved; data retained with quality flags intact.',
    });
  }

  return activity.sort((a, b) => a.t - b.t);
}

export function buildIncidents(anomalies: Anomaly[], stationList: Station[], now: number): Incident[] {
  const stations = new Map(stationList.map((s) => [s.id, s]));
  const incidents: Incident[] = [];
  let seq = 200;

  const push = (group: Anomaly[], classification: Classification, title: string, summary: string) => {
    if (!group.length) return;
    const id = `INC-${++seq}`;
    const severity = worstSeverity(group);
    const startedAt = Math.min(...group.map((a) => a.startedAt));
    const stillOpen = group.some((a) => a.endedAt === null);
    const endedAt = stillOpen ? null : Math.max(...group.map((a) => a.endedAt ?? a.startedAt));
    const ageMinutes = (now - startedAt) / MINUTE;
    const status = stillOpen
      ? initialStatus(severity, ageMinutes, id)
      : ageMinutes > 6 * 60 ? 'resolved' : initialStatus(severity, ageMinutes, id);

    // Geographic arrival order — the propagation trail shown on the map.
    const firstByStation = new Map<string, number>();
    for (const a of group) {
      const prev = firstByStation.get(a.stationId);
      if (prev === undefined || a.startedAt < prev) firstByStation.set(a.stationId, a.startedAt);
    }
    const propagation = [...firstByStation.entries()]
      .map(([stationId, t]) => ({ stationId, t }))
      .sort((a, b) => a.t - b.t);

    const confidence = Math.round(
      group.reduce((acc, a) => acc + a.confidence * a.score, 0) /
        Math.max(1, group.reduce((acc, a) => acc + a.score, 0)),
    );

    const actions = [...new Set(group.map((a) => a.recommendedAction))].slice(0, 3);

    incidents.push({
      id,
      title,
      classification,
      confidence,
      severity,
      startedAt,
      endedAt,
      status,
      stationIds: propagation.map((p) => p.stationId),
      anomalyIds: group.map((a) => a.id),
      summary,
      recommendedActions: actions,
      propagation,
      activity: buildActivity(id, group, status, classification),
    });

    for (const a of group) a.incidentId = id;
  };

  // --- Meteorological events: cluster across the entire network -------------
  const met = anomalies.filter((a) => a.classification === 'meteorological_event');
  for (const cluster of clusterByTime(met, 2.5 * HOUR)) {
    const stationCount = new Set(cluster.map((a) => a.stationId)).size;
    push(
      cluster,
      'meteorological_event',
      meteorologicalTitle(cluster, stations),
      `${stationCount} station${stationCount === 1 ? '' : 's'} affected across ${cluster.length} related anomalies. Readings are believed accurate and are published unmodified.`,
    );
  }

  // --- Hardware faults: cluster per station --------------------------------
  // A calibration lapse is a maintenance item, not an operational incident, so
  // it stays out of the incident queue and lives on the maintenance board.
  const isCalibrationOnly = (a: Anomaly) =>
    a.detectorTypes.length === 1 && a.detectorTypes[0] === 'calibration';

  const byStation = new Map<string, Anomaly[]>();
  for (const a of anomalies) {
    if (a.classification === 'meteorological_event') continue;
    if (isCalibrationOnly(a)) continue;
    const list = byStation.get(a.stationId) ?? [];
    list.push(a);
    byStation.set(a.stationId, list);
  }

  for (const [stationId, list] of byStation) {
    const comms = list.filter((a) => a.classification === 'communications');
    const power = list.filter((a) => a.classification === 'power');
    const rest = list.filter((a) => a.classification !== 'communications' && a.classification !== 'power');

    for (const cluster of clusterByTime(comms, 3 * HOUR)) {
      const minutes = Math.round(
        cluster.reduce((acc, a) => acc + ((a.endedAt ?? now) - a.startedAt), 0) / MINUTE,
      );
      push(cluster, 'communications', `${stationId} telemetry outage`,
        `Telemetry link lost for ${minutes} minutes. Observations are absent for the affected period; no values have been corrected.`);
    }
    for (const cluster of clusterByTime(power, 6 * HOUR)) {
      push(cluster, 'power', `${stationId} power subsystem decline`,
        'Pack voltage is falling faster than solar input can recover. Packet loss follows once the modem browns out.');
    }
    for (const cluster of clusterByTime(rest, 3 * HOUR)) {
      const types = new Set(cluster.map((a) => a.sensorType));
      push(cluster, 'sensor_fault', faultTitle(cluster),
        `${cluster.length} related anomal${cluster.length === 1 ? 'y' : 'ies'} across ${types.size} channel${types.size === 1 ? '' : 's'} at a single station, with no corroborating signature anywhere else in the network.`);
    }
  }

  return incidents.sort((a, b) => b.startedAt - a.startedAt);
}

/**
 * Alerts. One per anomaly worth an operator's attention, each carrying its
 * incident so the UI can collapse a storm into a single row.
 */
export function buildAlerts(anomalies: Anomaly[], now: number): Alert[] {
  return anomalies
    .filter((a) => a.severity !== 'info')
    .map<Alert>((a) => {
      const ageMinutes = (now - a.startedAt) / MINUTE;
      const rng = makeRng(`alert:${a.id}`);
      const r = rng();
      const state: Alert['state'] =
        ageMinutes < 15 ? 'new'
        : a.endedAt !== null && ageMinutes > 5 * 60 ? 'resolved'
        : r < 0.45 ? 'acknowledged'
        : r < 0.55 ? 'snoozed'
        : 'new';
      return {
        id: `AL-${a.id.slice(2)}`,
        stationId: a.stationId,
        sensorType: a.sensorType,
        severity: a.severity,
        message: `${a.title} — ${CLASSIFICATION_LABELS[a.classification].toLowerCase()} (${a.confidence}% confidence)`,
        t: a.detectedAt,
        confidence: a.confidence,
        incidentId: a.incidentId,
        anomalyId: a.id,
        state,
      };
    })
    .sort((a, b) => b.t - a.t);
}

/**
 * Audit trail. Every classification and every correction is recorded with the
 * raw value intact — the raw measurement is never overwritten anywhere in the
 * system, and this is the record that proves it.
 */
export function buildAuditTrail(anomalies: Anomaly[]): AuditEntry[] {
  const entries: AuditEntry[] = [];

  for (const a of anomalies) {
    const firedRules = a.rules.filter((r) => r.fired).map((r) => r.name);
    entries.push({
      id: `AU-${a.id}-D`,
      t: a.detectedAt,
      stationId: a.stationId,
      sensorType: a.sensorType,
      rawValue: a.rawValue,
      flag: a.classification === 'meteorological_event' ? 'good'
        : a.classification === 'communications' ? 'missing'
        : a.correction ? 'bad' : 'suspect',
      correctedValue: a.correction ? a.correction.correctedValue : null,
      anomalyScore: a.score,
      classification: a.classification,
      confidence: a.confidence,
      rules: firedRules,
      modelVersion: a.correction?.modelVersion ?? 'rules-v2.1',
      operatorAction: null,
      reason: firedRules.length
        ? firedRules.join(' + ').toLowerCase()
        : a.summary,
      incidentId: a.incidentId,
    });

    if (a.correction && a.correction.confidence > 0) {
      entries.push({
        id: `AU-${a.id}-C`,
        t: a.correction.t,
        stationId: a.stationId,
        sensorType: a.sensorType,
        rawValue: a.correction.rawValue,
        flag: 'corrected',
        correctedValue: a.correction.correctedValue,
        anomalyScore: a.score,
        classification: a.classification,
        confidence: a.correction.confidence,
        rules: firedRules,
        modelVersion: a.correction.modelVersion,
        operatorAction: 'Correction published to quality-controlled dataset',
        reason: `${a.correction.method}; raw value retained`,
        incidentId: a.incidentId,
      });
    }
  }

  return entries.sort((a, b) => b.t - a.t);
}

/**
 * Failure-signature clustering: recurring fingerprints of detector types on a
 * given channel, so an operator can recognise "this again" across the network.
 */
const SIGNATURE_LIBRARY: {
  id: string;
  name: string;
  pattern: string;
  commonCause: string;
  match: (a: Anomaly) => boolean;
}[] = [
  {
    id: 'SIG-7',
    name: 'Loose temperature connection',
    pattern: 'Temperature spike + stable RH + stable pressure',
    commonCause: 'Loose probe connection or corroded terminal',
    match: (a) => a.sensorType === 'temperature' &&
      a.detectorTypes.some((d) => d === 'spike' || d === 'rate_of_change') &&
      a.classification === 'sensor_fault',
  },
  {
    id: 'SIG-3',
    name: 'Aging humidity probe',
    pattern: 'Sustained RH offset + rising noise + calibration overdue',
    commonCause: 'Polymer sensing element at end of life',
    match: (a) => a.sensorType === 'humidity' &&
      a.detectorTypes.some((d) => d === 'drift' || d === 'calibration'),
  },
  {
    id: 'SIG-11',
    name: 'Frozen sensor channel',
    pattern: 'Zero variance across an extended window',
    commonCause: 'Logger channel latch-up or severed signal line',
    match: (a) => a.detectorTypes.includes('frozen'),
  },
  {
    id: 'SIG-5',
    name: 'Battery brownout',
    pattern: 'Falling pack voltage followed by intermittent packet loss',
    commonCause: 'Degraded battery pack or failing charge controller',
    match: (a) => a.classification === 'power' || a.detectorTypes.includes('battery'),
  },
  {
    id: 'SIG-2',
    name: 'Communications dropout',
    pattern: 'Complete packet loss with healthy sensors either side of the gap',
    commonCause: 'Modem reset or backhaul interruption',
    match: (a) => a.classification === 'communications',
  },
  {
    id: 'SIG-9',
    name: 'Condensation interference',
    pattern: 'Variance step change without a mean shift',
    commonCause: 'Moisture ingress into the enclosure or terminal block',
    match: (a) => a.detectorTypes.includes('noise'),
  },
  {
    id: 'SIG-4',
    name: 'Barometer drift',
    pattern: 'Slow one-directional pressure offset against neighbours',
    commonCause: 'Ageing MEMS barometer element',
    match: (a) => a.sensorType === 'pressure' && a.detectorTypes.includes('drift'),
  },
];

export function buildSignatures(anomalies: Anomaly[]): FailureSignature[] {
  const out: FailureSignature[] = [];

  for (const sig of SIGNATURE_LIBRARY) {
    const matched = anomalies.filter(sig.match);
    if (!matched.length) continue;
    for (const a of matched) a.signatureId = sig.id;

    const sensors = new Set(matched.map((a) => `${a.stationId}:${a.sensorType}`));
    // Historical occurrence count is seeded from the signature so the library
    // reads consistently across sessions; live matches are added on top.
    const rng = makeRng(`sig:${sig.id}`);
    const historical = 6 + Math.floor(rng() * 11);

    out.push({
      id: sig.id,
      name: sig.name,
      pattern: sig.pattern,
      occurrences: historical + matched.length,
      sensorsAffected: sensors.size,
      commonCause: sig.commonCause,
      historicalConfidence: round(72 + rng() * 22, 0),
      detectorTypes: [...new Set(matched.flatMap((a) => a.detectorTypes))],
      anomalyIds: matched.map((a) => a.id),
    });
  }

  return out.sort((a, b) => b.occurrences - a.occurrences);
}

/**
 * Historical similarity search — cosine-style comparison over a small feature
 * vector, so "find similar events" returns a defensible ranking rather than an
 * arbitrary one.
 */
export function similarAnomalies(target: Anomaly, all: Anomaly[], limit = 5) {
  const featureVector = (a: Anomaly) => [
    a.sensorType === target.sensorType ? 1 : 0,
    a.classification === target.classification ? 1 : 0,
    a.signatureId && a.signatureId === target.signatureId ? 1 : 0,
    1 - Math.min(1, Math.abs(a.score - target.score) / 100),
    1 - Math.min(1, Math.abs(a.confidence - target.confidence) / 100),
    a.detectorTypes.filter((d) => target.detectorTypes.includes(d)).length /
      Math.max(1, new Set([...a.detectorTypes, ...target.detectorTypes]).size),
  ];
  const weights = [0.22, 0.24, 0.18, 0.12, 0.09, 0.15];

  return all
    .filter((a) => a.id !== target.id)
    .map((a) => ({
      anomaly: a,
      similarity: Math.round(
        featureVector(a).reduce((acc, v, i) => acc + v * weights[i], 0) * 100,
      ),
    }))
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit);
}
