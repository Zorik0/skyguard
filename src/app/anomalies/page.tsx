'use client';

import { useMemo, useState } from 'react';
import { useResolvedWorld } from '@/hooks/useWorld';
import { PageBody, PageHeader } from '@/components/ui/PageHeader';
import { Panel, SegmentedControl, SourceBadge } from '@/components/ui/primitives';
import { AnomalyList } from '@/components/anomalies/AnomalyList';
import { CLASSIFICATION_LABELS } from '@/lib/anomaly/classify';
import type { Classification, Severity } from '@/types';

type ClassFilter = Classification | 'all';
type SeverityFilter = Severity | 'all';
type StateFilter = 'all' | 'active' | 'resolved';

export default function AnomaliesPage() {
  const world = useResolvedWorld();
  const [classification, setClassification] = useState<ClassFilter>('all');
  const [severity, setSeverity] = useState<SeverityFilter>('all');
  const [state, setState] = useState<StateFilter>('all');
  const [station, setStation] = useState('all');
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    if (!world) return [];
    const q = query.trim().toLowerCase();
    return world.anomalies
      .filter((a) => classification === 'all' || a.classification === classification)
      .filter((a) => severity === 'all' || a.severity === severity)
      .filter((a) =>
        state === 'all' ? true : state === 'active' ? a.endedAt === null : a.endedAt !== null,
      )
      .filter((a) => station === 'all' || a.stationId === station)
      .filter(
        (a) =>
          !q ||
          a.id.toLowerCase().includes(q) ||
          a.title.toLowerCase().includes(q) ||
          a.summary.toLowerCase().includes(q),
      )
      .sort((a, b) => b.score - a.score || b.startedAt - a.startedAt);
  }, [world, classification, severity, state, station, query]);

  if (!world) return null;

  const counts = {
    fault: world.anomalies.filter((a) => a.classification === 'sensor_fault').length,
    weather: world.anomalies.filter((a) => a.classification === 'meteorological_event').length,
    comms: world.anomalies.filter((a) => a.classification === 'communications').length,
    power: world.anomalies.filter((a) => a.classification === 'power').length,
  };

  return (
    <>
      <PageHeader
        title="Anomalies"
        subtitle={`${world.anomalies.length} detections in the last 24 hours · ${counts.fault} hardware, ${counts.weather} meteorological, ${counts.comms} communications, ${counts.power} power`}
        actions={<SourceBadge source="MODELLED" />}
      />

      <PageBody className="flex flex-col gap-3">
        <Panel eyebrow="Filter" title="Refine detections">
          <div className="flex flex-wrap items-center gap-2 p-3">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by id, title or summary…"
              aria-label="Search anomalies"
              className="min-w-[200px] flex-1 rounded-[3px] border border-line bg-raised px-2.5 py-1.5 text-[11.5px] text-ink placeholder:text-ink-3 focus:border-line-strong focus:outline-none"
            />

            <SegmentedControl<ClassFilter>
              ariaLabel="Classification"
              size="sm"
              value={classification}
              onChange={setClassification}
              options={[
                { value: 'all', label: 'All' },
                { value: 'sensor_fault', label: 'Sensor fault' },
                { value: 'meteorological_event', label: 'Weather' },
                { value: 'communications', label: 'Comms' },
              ]}
            />

            <SegmentedControl<SeverityFilter>
              ariaLabel="Severity"
              size="sm"
              value={severity}
              onChange={setSeverity}
              options={[
                { value: 'all', label: 'Any' },
                { value: 'critical', label: 'Critical' },
                { value: 'high', label: 'High' },
                { value: 'warning', label: 'Warning' },
              ]}
            />

            <SegmentedControl<StateFilter>
              ariaLabel="State"
              size="sm"
              value={state}
              onChange={setState}
              options={[
                { value: 'all', label: 'All' },
                { value: 'active', label: 'Active' },
                { value: 'resolved', label: 'Ended' },
              ]}
            />

            <label>
              <span className="sr-only">Station</span>
              <select
                value={station}
                onChange={(e) => setStation(e.target.value)}
                className="rounded-[3px] border border-line bg-raised px-2 py-1 text-[11px] text-ink"
              >
                <option value="all">All stations</option>
                {world.stations.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.id}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </Panel>

        <Panel
          eyebrow="Results"
          title={`${filtered.length} anomal${filtered.length === 1 ? 'y' : 'ies'}`}
          actions={
            classification !== 'all' ? (
              <span className="text-[10.5px] text-ink-3">
                {CLASSIFICATION_LABELS[classification as Classification]}
              </span>
            ) : null
          }
        >
          <AnomalyList
            anomalies={filtered}
            emptyTitle="No anomalies match these filters"
            emptyDetail="Widen the filters, or clear the search box, to see more detections."
          />
        </Panel>
      </PageBody>
    </>
  );
}
