import type { World } from '@/lib/world';
import { SENSOR_LABELS } from '@/lib/simulation/stations';
import { CLASSIFICATION_LABELS } from '@/lib/anomaly/classify';

/**
 * Global search across every entity type.
 *
 * Results are grouped by kind and ranked by how the match was made — an exact
 * identifier beats a name prefix, which beats a substring — so typing "007"
 * puts the station first and its anomalies immediately after.
 */

export type SearchKind =
  | 'station'
  | 'sensor'
  | 'anomaly'
  | 'incident'
  | 'alert'
  | 'maintenance';

export interface SearchResult {
  kind: SearchKind;
  id: string;
  title: string;
  subtitle: string;
  href: string;
  score: number;
}

export const KIND_LABELS: Record<SearchKind, string> = {
  station: 'Stations',
  sensor: 'Sensors',
  anomaly: 'Anomalies',
  incident: 'Incidents',
  alert: 'Alerts',
  maintenance: 'Maintenance',
};

function score(haystack: string, needle: string): number {
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase();
  if (!n) return 0;
  if (h === n) return 100;
  if (h.startsWith(n)) return 80;
  const idx = h.indexOf(n);
  if (idx === 0) return 70;
  if (idx > 0) return 50 - Math.min(idx, 20);
  return 0;
}

function best(needle: string, ...fields: string[]): number {
  return Math.max(0, ...fields.map((f) => score(f, needle)));
}

export function searchWorld(world: World, query: string, limit = 24): SearchResult[] {
  const q = query.trim();
  if (q.length < 1) return [];
  const out: SearchResult[] = [];

  for (const snap of world.snapshots) {
    const s = best(q, snap.station.id, snap.station.name, snap.station.region, snap.station.id.replace('AWS-', ''));
    if (s > 0) {
      out.push({
        kind: 'station',
        id: snap.station.id,
        title: `${snap.station.id} · ${snap.station.name}`,
        subtitle: `${snap.station.region} · ${snap.station.elevation} m · ${snap.status} · health ${snap.healthScore}/100`,
        href: `/stations/${snap.station.id}`,
        score: s + 6,
      });
    }
    for (const sensor of snap.station.sensors) {
      const ss = best(q, sensor.id, `${snap.station.id} ${SENSOR_LABELS[sensor.type]}`, sensor.model, sensor.serial);
      if (ss > 0) {
        const health = snap.sensorHealth.find((h) => h.sensorId === sensor.id);
        out.push({
          kind: 'sensor',
          id: sensor.id,
          title: `${sensor.id} · ${SENSOR_LABELS[sensor.type]}`,
          subtitle: `${sensor.manufacturer} ${sensor.model} · health ${health?.score ?? '—'}/100`,
          href: `/health/${sensor.id}`,
          score: ss,
        });
      }
    }
  }

  for (const a of world.anomalies) {
    const s = best(q, a.id, a.title, a.stationId, SENSOR_LABELS[a.sensorType], CLASSIFICATION_LABELS[a.classification]);
    if (s > 0) {
      out.push({
        kind: 'anomaly',
        id: a.id,
        title: `${a.id} · ${a.title}`,
        subtitle: `${CLASSIFICATION_LABELS[a.classification]} · ${a.confidence}% · score ${a.score}`,
        href: `/anomalies/${a.id}`,
        score: s + 3,
      });
    }
  }

  for (const i of world.incidents) {
    const s = best(q, i.id, i.title, ...i.stationIds);
    if (s > 0) {
      out.push({
        kind: 'incident',
        id: i.id,
        title: `${i.id} · ${i.title}`,
        subtitle: `${i.severity} · ${i.status} · ${i.stationIds.length} station(s)`,
        href: `/incidents/${i.id}`,
        score: s + 4,
      });
    }
  }

  for (const a of world.alerts) {
    const s = best(q, a.id, a.message, a.stationId);
    if (s > 0) {
      out.push({
        kind: 'alert',
        id: a.id,
        title: `${a.id} · ${a.stationId}`,
        subtitle: a.message,
        href: `/alerts?focus=${a.id}`,
        score: s,
      });
    }
  }

  for (const m of world.maintenance) {
    const s = best(q, m.id, m.title, m.stationId, m.action);
    if (s > 0) {
      out.push({
        kind: 'maintenance',
        id: m.id,
        title: `${m.id} · ${m.title}`,
        subtitle: `${m.priority} · ${m.status.replace('_', ' ')}`,
        href: `/maintenance?focus=${m.id}`,
        score: s,
      });
    }
  }

  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}

export function groupResults(results: SearchResult[]) {
  const groups = new Map<SearchKind, SearchResult[]>();
  for (const r of results) {
    const list = groups.get(r.kind) ?? [];
    list.push(r);
    groups.set(r.kind, list);
  }
  return [...groups.entries()];
}
