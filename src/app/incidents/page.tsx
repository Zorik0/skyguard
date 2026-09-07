'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { format, formatDistanceToNowStrict } from 'date-fns';
import { useResolvedWorld } from '@/hooks/useWorld';
import { PageBody, PageHeader } from '@/components/ui/PageHeader';
import { EmptyState, Panel, SegmentedControl, SeverityChip } from '@/components/ui/primitives';
import { CLASSIFICATION_LABELS } from '@/lib/anomaly/classify';
import type { IncidentStatus } from '@/types';

const STATUS_COLOR: Record<IncidentStatus, string> = {
  new: 'var(--color-failed)',
  acknowledged: 'var(--color-critical)',
  investigating: 'var(--color-warning)',
  monitoring: 'var(--color-event)',
  resolved: 'var(--color-ink-3)',
};

export default function IncidentsPage() {
  const world = useResolvedWorld();
  const [status, setStatus] = useState<IncidentStatus | 'all' | 'open'>('open');

  const incidents = useMemo(() => {
    if (!world) return [];
    return world.incidents.filter((i) =>
      status === 'all' ? true : status === 'open' ? i.status !== 'resolved' : i.status === status,
    );
  }, [world, status]);

  if (!world) return null;

  return (
    <>
      <PageHeader
        title="Incidents"
        subtitle="Anomalies caused by the same underlying event are correlated into one incident, so a front crossing the network is one row rather than twenty-six."
        actions={
          <SegmentedControl
            ariaLabel="Incident status"
            size="sm"
            value={status}
            onChange={setStatus}
            options={[
              { value: 'open', label: 'Open' },
              { value: 'all', label: 'All' },
              { value: 'investigating', label: 'Investigating' },
              { value: 'resolved', label: 'Resolved' },
            ]}
          />
        }
      />

      <PageBody className="flex flex-col gap-3">
        {incidents.length === 0 ? (
          <Panel>
            <EmptyState title="No incidents match this filter" />
          </Panel>
        ) : (
          incidents.map((incident) => (
            <Link
              key={incident.id}
              href={`/incidents/${incident.id}`}
              className="panel block transition-colors hover:border-line-strong"
            >
              <div className="flex flex-wrap items-start gap-3 p-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="tnum text-[11px] text-ink-3">{incident.id}</span>
                    <h2 className="text-[13.5px] font-semibold text-ink">{incident.title}</h2>
                    <SeverityChip severity={incident.severity} />
                    <span
                      className="rounded-[2px] px-1.5 py-px text-[9.5px] font-semibold tracking-wider uppercase"
                      style={{
                        color: STATUS_COLOR[incident.status],
                        background: `color-mix(in srgb, ${STATUS_COLOR[incident.status]} 11%, transparent)`,
                      }}
                    >
                      {incident.status}
                    </span>
                  </div>
                  <p className="mt-1 max-w-3xl text-[11.5px] leading-relaxed text-ink-3">
                    {incident.summary}
                  </p>
                  <div className="tnum mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[10.5px] text-ink-3">
                    <span>Started {format(incident.startedAt, 'dd MMM HH:mm')}</span>
                    <span>{formatDistanceToNowStrict(incident.startedAt)} ago</span>
                    <span>{incident.stationIds.length} stations affected</span>
                    <span>{incident.anomalyIds.length} related anomalies</span>
                  </div>
                </div>

                <div className="w-[190px] shrink-0">
                  <div className="eyebrow">Classification</div>
                  <div
                    className="mt-0.5 text-[12px] font-medium"
                    style={{
                      color:
                        incident.classification === 'meteorological_event'
                          ? 'var(--color-event)'
                          : 'var(--color-critical)',
                    }}
                  >
                    {CLASSIFICATION_LABELS[incident.classification]}
                  </div>
                  <div className="tnum mt-1 text-[11px] text-ink-2">
                    {incident.confidence}% confidence
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {incident.stationIds.slice(0, 6).map((id) => (
                      <span
                        key={id}
                        className="tnum rounded-[2px] bg-line px-1 text-[9.5px] text-ink-3"
                      >
                        {id}
                      </span>
                    ))}
                    {incident.stationIds.length > 6 && (
                      <span className="text-[9.5px] text-ink-3">
                        +{incident.stationIds.length - 6}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </Link>
          ))
        )}
      </PageBody>
    </>
  );
}

export { STATUS_COLOR };
