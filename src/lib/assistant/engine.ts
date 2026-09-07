import type { World } from '@/lib/world';
import type { Settings } from '@/store/useSkyGuard';
import type { Anomaly, SensorType } from '@/types';
import { CLASSIFICATION_LABELS } from '@/lib/anomaly/classify';
import { SENSOR_LABELS } from '@/lib/simulation/stations';
import { bandLabel } from '@/lib/health/score';
import { formatSensorValue } from '@/lib/units';
import { HOUR, round } from '@/lib/utils';

/**
 * Operator assistant.
 *
 * This answers questions from application state using keyword intents and
 * explanation templates. It is deliberately *not* a language model, and it
 * does not pretend to be one: every answer is assembled from the same objects
 * the screens render, so it can never contradict them or invent a number.
 *
 * The provider interface exists so a real model can be added later without
 * touching a single call site — but a model would be an additional provider,
 * not a replacement for the guarantee that answers trace back to real data.
 */

export interface AssistantLink {
  label: string;
  href: string;
}

export interface AssistantAnswer {
  headline: string;
  paragraphs: string[];
  facts: { label: string; value: string }[];
  links: AssistantLink[];
  intent: string;
  /** How well the question matched — surfaced so the answer is never oversold. */
  match: 'exact' | 'partial' | 'none';
}

export interface AssistantContext {
  world: World;
  settings: Settings;
  selectedStationId: string;
}

export interface AssistantProvider {
  readonly name: string;
  ask(question: string, ctx: AssistantContext): Promise<AssistantAnswer>;
}

/* ------------------------------------------------------------- matching -- */

function extractStationId(q: string, ctx: AssistantContext): string | null {
  const direct = q.toUpperCase().match(/AWS[-\s]?(\d{1,3})/);
  if (direct) {
    const padded = `AWS-${direct[1].padStart(3, '0')}`;
    if (ctx.world.snapshotById.has(padded)) return padded;
  }
  const byName = ctx.world.stations.find((s) =>
    q.toLowerCase().includes(s.name.toLowerCase()),
  );
  return byName?.id ?? null;
}

function extractSensor(q: string): SensorType | null {
  const lower = q.toLowerCase();
  const map: [string, SensorType][] = [
    ['temperature', 'temperature'],
    ['temp', 'temperature'],
    ['humidity', 'humidity'],
    ['rh', 'humidity'],
    ['pressure', 'pressure'],
    ['barometer', 'pressure'],
    ['wind', 'wind_speed'],
    ['rain', 'rainfall'],
    ['battery', 'battery'],
    ['power', 'battery'],
    ['comms', 'comms'],
    ['communication', 'comms'],
  ];
  for (const [needle, type] of map) if (lower.includes(needle)) return type;
  return null;
}

function hasAny(q: string, words: string[]) {
  return words.some((w) => q.includes(w));
}

function describeAnomaly(a: Anomaly, settings: Settings): string {
  const raw = a.rawValue !== null
    ? formatSensorValue(a.sensorType, a.rawValue, settings)
    : null;
  const parts = [
    `${a.id} — ${a.title}`,
    `${CLASSIFICATION_LABELS[a.classification]} at ${a.confidence}% confidence`,
  ];
  if (raw) parts.push(`raw ${raw.value}${raw.suffix}`);
  if (a.correction && a.correction.confidence > 0) {
    const c = formatSensorValue(a.sensorType, a.correction.correctedValue, settings);
    parts.push(`corrected to ${c.value}${c.suffix}`);
  }
  return parts.join(', ');
}

/* ---------------------------------------------------------------- rules -- */

type Handler = (
  q: string,
  ctx: AssistantContext,
) => AssistantAnswer | null;

const stationStatusHandler: Handler = (q, ctx) => {
  const stationId = extractStationId(q, ctx);
  if (!stationId) return null;
  if (!hasAny(q, ['why', 'status', 'wrong', 'happening', 'critical', 'health', 'state', 'tell me about'])) {
    return null;
  }

  const snap = ctx.world.snapshotById.get(stationId);
  if (!snap) return null;

  const active = snap.anomalies.filter((a) => a.endedAt === null);
  const worst = [...snap.anomalies].sort((a, b) => b.score - a.score)[0];
  const worstSensor = [...snap.sensorHealth].sort((a, b) => a.score - b.score)[0];

  const paragraphs: string[] = [];
  if (worst) {
    paragraphs.push(worst.narrative.split('\n\n').slice(0, 3).join(' '));
  } else {
    paragraphs.push(
      `${stationId} (${snap.station.name}) has no open findings. All ${snap.sensorHealth.length} channels are reporting within specification and the last packet arrived normally.`,
    );
  }
  if (active.length > 1) {
    paragraphs.push(
      `There ${active.length === 2 ? 'is one further' : `are ${active.length - 1} further`} open finding${active.length === 2 ? '' : 's'} at this station: ${active
        .filter((a) => a.id !== worst?.id)
        .slice(0, 3)
        .map((a) => a.title)
        .join('; ')}.`,
    );
  }

  return {
    headline: `${stationId} — ${snap.station.name}`,
    paragraphs,
    facts: [
      { label: 'Status', value: snap.status },
      { label: 'Station health', value: `${snap.healthScore}/100` },
      { label: 'Weakest channel', value: `${SENSOR_LABELS[worstSensor.type]} ${worstSensor.score}/100 (${bandLabel(worstSensor.band)})` },
      { label: 'Open findings', value: String(active.length) },
      { label: 'Uptime (24 h)', value: `${snap.uptime}%` },
    ],
    links: [
      { label: `Open ${stationId}`, href: `/stations/${stationId}` },
      ...(worst ? [{ label: `Investigate ${worst.id}`, href: `/anomalies/${worst.id}` }] : []),
    ],
    intent: 'station_status',
    match: 'exact',
  };
};

const weatherOrFaultHandler: Handler = (q, ctx) => {
  if (!hasAny(q, ['real weather', 'genuine', 'weather or', 'fault or', 'is it weather', 'actually weather'])) {
    return null;
  }
  const stationId = extractStationId(q, ctx);
  const sensor = extractSensor(q);
  const candidates = ctx.world.anomalies
    .filter((a) => (!stationId || a.stationId === stationId) && (!sensor || a.sensorType === sensor))
    .sort((a, b) => b.score - a.score);
  const target = candidates[0];
  if (!target) return null;

  const weatherEvidence = target.evidence.filter((e) => e.supports === 'weather');
  const faultEvidence = target.evidence.filter((e) => e.supports === 'fault');

  return {
    headline: `${target.id}: ${CLASSIFICATION_LABELS[target.classification]} — ${target.confidence}% confidence`,
    paragraphs: [
      target.narrative.split('\n\n')[1] ?? target.summary,
      weatherEvidence.length
        ? `Supporting a genuine event: ${weatherEvidence.map((e) => e.label.toLowerCase()).join('; ')}.`
        : 'No evidence supported a genuine meteorological explanation.',
      faultEvidence.length
        ? `Supporting a hardware fault: ${faultEvidence.map((e) => e.label.toLowerCase()).join('; ')}.`
        : 'No evidence supported a hardware explanation.',
    ],
    facts: [
      { label: 'Station', value: target.stationId },
      { label: 'Channel', value: SENSOR_LABELS[target.sensorType] },
      { label: 'Rules fired', value: String(target.rules.filter((r) => r.fired).length) },
      { label: 'Recommended action', value: target.recommendedAction },
    ],
    links: [{ label: `Open ${target.id}`, href: `/anomalies/${target.id}` }],
    intent: 'weather_or_fault',
    match: 'exact',
  };
};

const maintenanceHandler: Handler = (q, ctx) => {
  if (!hasAny(q, ['service', 'serviced', 'maintenance', 'replace', 'recalibrate', 'calibrat', 'repair'])) {
    return null;
  }
  const tasks = ctx.world.maintenance
    .filter((t) => t.status !== 'completed')
    .slice(0, 6);
  if (!tasks.length) return null;

  const critical = tasks.filter((t) => t.priority === 'critical');
  return {
    headline: `${ctx.world.maintenance.filter((t) => t.status !== 'completed').length} open maintenance tasks`,
    paragraphs: [
      critical.length
        ? `${critical.length} ${critical.length === 1 ? 'task is' : 'tasks are'} critical and should be scheduled first: ${critical.map((t) => `${t.stationId} ${SENSOR_LABELS[t.sensorType ?? 'temperature'].toLowerCase()}`).join(', ')}.`
        : 'Nothing is currently critical. The queue below is ordered by priority and due date.',
      tasks.map((t) => `${t.stationId} · ${t.action}`).join('\n'),
    ],
    facts: tasks.slice(0, 5).map((t) => ({
      label: `${t.stationId} ${SENSOR_LABELS[t.sensorType ?? 'temperature'].toLowerCase()}`,
      value: `${t.priority} — ${t.status.replace('_', ' ')}`,
    })),
    links: [{ label: 'Open maintenance queue', href: '/maintenance' }],
    intent: 'maintenance',
    match: 'exact',
  };
};

const incidentSummaryHandler: Handler = (q, ctx) => {
  if (!hasAny(q, ['summar', 'incident', 'today', "what's happening", 'whats happening', 'overview'])) {
    return null;
  }
  const open = ctx.world.incidents.filter((i) => i.status !== 'resolved');
  const critical = open.filter((i) => i.severity === 'critical' || i.severity === 'high');
  const met = open.filter((i) => i.classification === 'meteorological_event');

  return {
    headline: `${open.length} open incidents, ${critical.length} at high severity or above`,
    paragraphs: [
      critical.length
        ? critical.map((i) => `${i.id} — ${i.title} (${i.confidence}% confidence, ${i.stationIds.length} station${i.stationIds.length === 1 ? '' : 's'}).`).join(' ')
        : 'No incident is currently above warning severity.',
      met.length
        ? `${met.length} of the open incidents ${met.length === 1 ? 'is' : 'are'} classified as genuine meteorological events, so no correction has been applied to the affected readings.`
        : 'No genuine meteorological events are currently in progress.',
    ],
    facts: open.slice(0, 5).map((i) => ({
      label: i.id,
      value: `${i.severity} · ${i.status} · ${i.title}`,
    })),
    links: [{ label: 'Open incidents', href: '/incidents' }],
    intent: 'incident_summary',
    match: 'exact',
  };
};

const affectedStationsHandler: Handler = (q, ctx) => {
  if (!hasAny(q, ['affected', 'cold front', 'front', 'storm', 'which stations', 'event'])) return null;
  const incident = ctx.world.incidents
    .filter((i) => i.classification === 'meteorological_event')
    .sort((a, b) => b.stationIds.length - a.stationIds.length)[0];
  if (!incident) return null;

  const order = incident.propagation
    .map((p, idx) => {
      const station = ctx.world.snapshotById.get(p.stationId)?.station;
      const lag = idx === 0 ? 'first' : `+${Math.round((p.t - incident.propagation[0].t) / 60000)} min`;
      return `${p.stationId} (${station?.name ?? '—'}) ${lag}`;
    })
    .join(' → ');

  return {
    headline: `${incident.title} — ${incident.stationIds.length} stations`,
    paragraphs: [
      incident.summary,
      `Arrival order across the network: ${order}. The geographic ordering is itself the evidence that this is a travelling system rather than a set of unrelated sensor faults.`,
    ],
    facts: [
      { label: 'Incident', value: incident.id },
      { label: 'Classification', value: CLASSIFICATION_LABELS[incident.classification] },
      { label: 'Confidence', value: `${incident.confidence}%` },
      { label: 'Status', value: incident.status },
    ],
    links: [
      { label: `Open ${incident.id}`, href: `/incidents/${incident.id}` },
      { label: 'View on map', href: '/map' },
    ],
    intent: 'affected_stations',
    match: 'exact',
  };
};

const qualityHandler: Handler = (q, ctx) => {
  if (!hasAny(q, ['quality', 'how healthy', 'network health', 'score', 'corrected'])) return null;
  const m = ctx.world.metrics;
  const corrections = ctx.world.anomalies.filter((a) => a.correction && a.correction.confidence > 0);
  return {
    headline: `Network data quality ${m.dataQualityScore}/100`,
    paragraphs: [
      `${m.stationsOnline} of ${ctx.world.stations.length} stations are online, ${m.stationsDegraded} are degraded and ${m.stationsOffline} are offline. ${m.healthySensors} of ${m.totalSensors} channels are healthy.`,
      corrections.length
        ? `${corrections.length} reading${corrections.length === 1 ? ' has' : 's have'} been given a quality-controlled estimate in the last 24 hours. Every raw value is preserved unchanged in the audit trail.`
        : 'No corrections have been applied in the last 24 hours.',
    ],
    facts: [
      { label: 'Active anomalies', value: String(m.activeAnomalies) },
      { label: 'Critical alerts', value: String(m.criticalAlerts) },
      { label: 'Weather events', value: String(m.activeWeatherEvents) },
      { label: 'Channels needing attention', value: String(m.sensorsNeedingMaintenance) },
    ],
    links: [
      { label: 'Sensor health', href: '/health' },
      { label: 'Corrected values', href: '/corrections' },
    ],
    intent: 'network_quality',
    match: 'exact',
  };
};

const worstStationsHandler: Handler = (q, ctx) => {
  if (!hasAny(q, ['worst', 'lowest', 'attention', 'problem', 'degraded', 'unhealthy'])) return null;
  const ranked = [...ctx.world.snapshots].sort((a, b) => a.healthScore - b.healthScore).slice(0, 5);
  return {
    headline: 'Stations needing attention',
    paragraphs: [
      ranked
        .map((s) => `${s.station.id} (${s.station.name}) at ${s.healthScore}/100 — ${s.anomalies.filter((a) => a.endedAt === null).length} open finding(s).`)
        .join(' '),
    ],
    facts: ranked.map((s) => ({
      label: `${s.station.id} ${s.station.name}`,
      value: `${s.healthScore}/100 · ${s.status}`,
    })),
    links: [{ label: 'Sensor health matrix', href: '/health' }],
    intent: 'worst_stations',
    match: 'exact',
  };
};

const HANDLERS: Handler[] = [
  stationStatusHandler,
  weatherOrFaultHandler,
  affectedStationsHandler,
  incidentSummaryHandler,
  maintenanceHandler,
  worstStationsHandler,
  qualityHandler,
];

export class RuleBasedAssistant implements AssistantProvider {
  readonly name = 'SkyGuard rule engine';

  async ask(question: string, ctx: AssistantContext): Promise<AssistantAnswer> {
    const q = question.trim().toLowerCase();
    if (!q) {
      return {
        headline: 'Ask about the network',
        paragraphs: ['Try one of the suggested questions below.'],
        facts: [],
        links: [],
        intent: 'empty',
        match: 'none',
      };
    }

    for (const handler of HANDLERS) {
      const answer = handler(q, ctx);
      if (answer) return answer;
    }

    // Nothing matched cleanly. Rather than guessing, fall back to a factual
    // search over the entities the question mentions.
    const stationId = extractStationId(q, ctx);
    if (stationId) {
      const snap = ctx.world.snapshotById.get(stationId)!;
      return {
        headline: `${stationId} — ${snap.station.name}`,
        paragraphs: [
          `I could not match that question to a specific intent, so here is the current state of ${stationId}.`,
          snap.anomalies.length
            ? snap.anomalies.slice(0, 3).map((a) => describeAnomaly(a, ctx.settings)).join(' ')
            : 'There are no findings on this station in the last 24 hours.',
        ],
        facts: [
          { label: 'Status', value: snap.status },
          { label: 'Health', value: `${snap.healthScore}/100` },
          { label: 'Elevation', value: `${snap.station.elevation} m` },
          { label: 'Last packet', value: `${round((ctx.world.now - snap.lastPacketAt) / 60000, 0)} min ago` },
        ],
        links: [{ label: `Open ${stationId}`, href: `/stations/${stationId}` }],
        intent: 'station_fallback',
        match: 'partial',
      };
    }

    return {
      headline: 'No matching intent',
      paragraphs: [
        'This assistant answers from application state using a fixed set of intents rather than a language model, so it will tell you when a question falls outside them instead of guessing.',
        'It can answer questions about station status, whether an anomaly is real weather, which sensors need servicing, which stations a weather event has affected, and the current network summary.',
      ],
      facts: [],
      links: [
        { label: 'Overview', href: '/' },
        { label: 'Anomalies', href: '/anomalies' },
      ],
      intent: 'unmatched',
      match: 'none',
    };
  }
}

export const assistant = new RuleBasedAssistant();

export const SUGGESTED_QUESTIONS = [
  'Why is AWS-007 showing a critical status?',
  'Is the AWS-033 anomaly real weather?',
  'Which sensors should be serviced this month?',
  'Show stations affected by the current cold front.',
  "Summarise today's critical incidents.",
  'Which stations need attention?',
];

export { HOUR };
