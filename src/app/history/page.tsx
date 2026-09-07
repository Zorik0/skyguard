'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { format } from 'date-fns';
import { Search } from 'lucide-react';
import { useResolvedWorld } from '@/hooks/useWorld';
import { PageBody, PageHeader } from '@/components/ui/PageHeader';
import {
  ConfidenceBar,
  EmptyState,
  Panel,
  SeverityChip,
  SourceBadge,
} from '@/components/ui/primitives';
import { AnomalyList } from '@/components/anomalies/AnomalyList';
import { CLASSIFICATION_LABELS } from '@/lib/anomaly/classify';
import { SENSOR_LABELS } from '@/lib/simulation/stations';
import { similarAnomalies } from '@/lib/incidents/group';
import type { Classification, DetectorType, SensorType, Severity } from '@/types';

const DETECTORS: DetectorType[] = [
  'spike', 'drop', 'frozen', 'noise', 'drift', 'range',
  'rate_of_change', 'neighbour', 'missing', 'comms', 'battery', 'calibration',
];

/**
 * Historical analysis.
 *
 * Full-text and structured search over past findings, plus a similarity search
 * that ranks previous events against a selected one using a small explicit
 * feature vector rather than an opaque embedding.
 */
export default function HistoryPage() {
  const world = useResolvedWorld();
  const [query, setQuery] = useState('');
  const [station, setStation] = useState('all');
  const [sensor, setSensor] = useState<SensorType | 'all'>('all');
  const [detector, setDetector] = useState<DetectorType | 'all'>('all');
  const [severity, setSeverity] = useState<Severity | 'all'>('all');
  const [classification, setClassification] = useState<Classification | 'all'>('all');
  const [minConfidence, setMinConfidence] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const results = useMemo(() => {
    if (!world) return [];
    const q = query.trim().toLowerCase();
    return world.anomalies
      .filter((a) => station === 'all' || a.stationId === station)
      .filter((a) => sensor === 'all' || a.sensorType === sensor)
      .filter((a) => detector === 'all' || a.detectorTypes.includes(detector))
      .filter((a) => severity === 'all' || a.severity === severity)
      .filter((a) => classification === 'all' || a.classification === classification)
      .filter((a) => a.confidence >= minConfidence)
      .filter(
        (a) =>
          !q ||
          a.id.toLowerCase().includes(q) ||
          a.title.toLowerCase().includes(q) ||
          a.narrative.toLowerCase().includes(q),
      )
      .sort((a, b) => b.startedAt - a.startedAt);
  }, [world, query, station, sensor, detector, severity, classification, minConfidence]);

  const selected = world?.anomalies.find((a) => a.id === selectedId) ?? results[0] ?? null;
  const similar = useMemo(
    () => (world && selected ? similarAnomalies(selected, world.anomalies, 6) : []),
    [world, selected],
  );

  if (!world) return null;

  return (
    <>
      <PageHeader
        title="Historical analysis"
        subtitle="Search the retained findings, then ask what else has looked like this before."
        actions={<SourceBadge source="MODELLED" />}
      />

      <PageBody className="flex flex-col gap-3">
        <Panel eyebrow="Search" title="Filters">
          <div className="flex flex-wrap items-end gap-2 p-3">
            <label className="min-w-[200px] flex-1">
              <span className="eyebrow mb-1 block">Text</span>
              <span className="flex items-center gap-2 rounded-[3px] border border-line bg-raised px-2 py-1.5 focus-within:border-line-strong">
                <Search size={12} className="shrink-0 text-ink-3" aria-hidden />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="id, title or explanation…"
                  className="w-full bg-transparent text-[11.5px] text-ink placeholder:text-ink-3 focus:outline-none"
                />
              </span>
            </label>

            <Field label="Station">
              <select value={station} onChange={(e) => setStation(e.target.value)} className={SELECT}>
                <option value="all">All</option>
                {world.stations.map((s) => (
                  <option key={s.id} value={s.id}>{s.id}</option>
                ))}
              </select>
            </Field>

            <Field label="Channel">
              <select
                value={sensor}
                onChange={(e) => setSensor(e.target.value as SensorType | 'all')}
                className={SELECT}
              >
                <option value="all">All</option>
                {(Object.keys(SENSOR_LABELS) as SensorType[]).map((s) => (
                  <option key={s} value={s}>{SENSOR_LABELS[s]}</option>
                ))}
              </select>
            </Field>

            <Field label="Anomaly type">
              <select
                value={detector}
                onChange={(e) => setDetector(e.target.value as DetectorType | 'all')}
                className={SELECT}
              >
                <option value="all">All</option>
                {DETECTORS.map((d) => (
                  <option key={d} value={d}>{d.replace(/_/g, ' ')}</option>
                ))}
              </select>
            </Field>

            <Field label="Severity">
              <select
                value={severity}
                onChange={(e) => setSeverity(e.target.value as Severity | 'all')}
                className={SELECT}
              >
                <option value="all">All</option>
                {['critical', 'high', 'warning', 'info'].map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </Field>

            <Field label="Classification">
              <select
                value={classification}
                onChange={(e) => setClassification(e.target.value as Classification | 'all')}
                className={SELECT}
              >
                <option value="all">All</option>
                {(Object.keys(CLASSIFICATION_LABELS) as Classification[]).map((c) => (
                  <option key={c} value={c}>{CLASSIFICATION_LABELS[c]}</option>
                ))}
              </select>
            </Field>

            <Field label={`Min confidence ${minConfidence}%`}>
              <input
                type="range"
                min={0}
                max={99}
                value={minConfidence}
                onChange={(e) => setMinConfidence(Number(e.target.value))}
                className="h-1 w-[110px] accent-[var(--color-event)]"
              />
            </Field>
          </div>
        </Panel>

        <div className="grid gap-3 xl:grid-cols-[1.25fr_1fr]">
          <Panel eyebrow="Results" title={`${results.length} matching findings`} bodyClassName="max-h-[560px] overflow-y-auto">
            {results.length === 0 ? (
              <EmptyState title="Nothing matched" detail="Loosen a filter and try again." />
            ) : (
              <ul className="divide-y divide-line">
                {results.map((a) => (
                  <li key={a.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(a.id)}
                      className={`w-full px-3 py-2 text-left transition-colors hover:bg-hover ${
                        selected?.id === a.id ? 'bg-raised' : ''
                      }`}
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="tnum text-[10.5px] text-ink-3">{a.id}</span>
                        <span className="text-[12px] text-ink">{a.title}</span>
                        <SeverityChip severity={a.severity} />
                      </div>
                      <div className="tnum mt-0.5 flex flex-wrap gap-x-3 text-[10.5px] text-ink-3">
                        <span>{format(a.startedAt, 'dd MMM HH:mm')}</span>
                        <span>{CLASSIFICATION_LABELS[a.classification]} · {a.confidence}%</span>
                        <span>score {a.score}</span>
                        <span>{a.detectorTypes.join(', ')}</span>
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <div className="flex flex-col gap-3">
            {selected && (
              <Panel
                eyebrow="Similarity"
                title={`Events resembling ${selected.id}`}
                actions={
                  <Link href={`/anomalies/${selected.id}`} className="text-[11px] text-event hover:underline">
                    Investigate
                  </Link>
                }
              >
                {similar.length === 0 ? (
                  <EmptyState title="No comparable events" />
                ) : (
                  <ul className="divide-y divide-line">
                    {similar.map(({ anomaly, similarity }) => (
                      <li key={anomaly.id}>
                        <Link
                          href={`/anomalies/${anomaly.id}`}
                          className="flex items-center gap-3 px-3 py-2 transition-colors hover:bg-hover"
                        >
                          <span className="tnum w-10 shrink-0 text-[10.5px] text-ink-3">{anomaly.id}</span>
                          <span className="min-w-0 flex-1 truncate text-[11.5px] text-ink-2">
                            {anomaly.title}
                          </span>
                          <span className="w-[104px] shrink-0">
                            <ConfidenceBar value={similarity} label="Similarity" />
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
                <p className="border-t border-line px-3 py-2 text-[10.5px] leading-relaxed text-ink-3">
                  Similarity blends channel, classification, failure signature, score, confidence and
                  the overlap of detector types. The weights are fixed and inspectable rather than
                  learned, so a ranking can always be explained.
                </p>
              </Panel>
            )}

            <Panel
              eyebrow="Clustering"
              title="Recurring failure signatures"
              actions={<SourceBadge source="MODELLED" compact />}
            >
              {world.signatures.length === 0 ? (
                <EmptyState title="No recurring signatures" />
              ) : (
                <ul className="divide-y divide-line">
                  {world.signatures.map((sig) => (
                    <li key={sig.id} className="px-3 py-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="tnum text-[10.5px] text-ink-3">{sig.id}</span>
                        <span className="text-[12px] font-medium text-ink">{sig.name}</span>
                      </div>
                      <p className="mt-0.5 text-[11px] text-ink-2">{sig.pattern}</p>
                      <div className="tnum mt-1 flex flex-wrap gap-x-4 text-[10.5px] text-ink-3">
                        <span>seen {sig.occurrences}×</span>
                        <span>{sig.sensorsAffected} sensors affected</span>
                        <span>historical confidence {sig.historicalConfidence}%</span>
                      </div>
                      <p className="mt-0.5 text-[10.5px] text-ink-3">
                        Most common cause: {sig.commonCause}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </div>
        </div>

        <Panel eyebrow="Recent" title="Latest findings across the network" bodyClassName="max-h-[380px] overflow-y-auto">
          <AnomalyList anomalies={world.anomalies.slice().sort((a, b) => b.startedAt - a.startedAt)} limit={20} />
        </Panel>
      </PageBody>
    </>
  );
}

const SELECT =
  'rounded-[3px] border border-line bg-raised px-2 py-1.5 text-[11.5px] text-ink';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col">
      <span className="eyebrow mb-1">{label}</span>
      {children}
    </label>
  );
}
