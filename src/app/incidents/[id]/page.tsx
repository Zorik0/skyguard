'use client';

import { use, useState } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { format } from 'date-fns';
import { ArrowLeft, MessageSquare } from 'lucide-react';
import { useResolvedWorld } from '@/hooks/useWorld';
import { useSkyGuard } from '@/store/useSkyGuard';
import { PageBody, PageHeader } from '@/components/ui/PageHeader';
import {
  Button,
  EmptyState,
  Panel,
  SegmentedControl,
  SeverityChip,
} from '@/components/ui/primitives';
import { AnomalyList } from '@/components/anomalies/AnomalyList';
import { CLASSIFICATION_LABELS } from '@/lib/anomaly/classify';
import { STATUS_META } from '@/lib/units';
import { MINUTE } from '@/lib/utils';
import type { IncidentStatus } from '@/types';

const NetworkMap = dynamic(
  () => import('@/components/map/NetworkMap').then((m) => m.NetworkMap),
  { ssr: false, loading: () => <div className="h-full bg-[#0c1218]" /> },
);

const STATUSES: IncidentStatus[] = [
  'new',
  'acknowledged',
  'investigating',
  'monitoring',
  'resolved',
];

export default function IncidentDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const world = useResolvedWorld();
  const setIncidentStatus = useSkyGuard((s) => s.setIncidentStatus);
  const setOperatorNote = useSkyGuard((s) => s.setOperatorNote);
  const notes = useSkyGuard((s) => s.operatorNotes);
  const selectStation = useSkyGuard((s) => s.selectStation);
  const [draft, setDraft] = useState('');

  const incident = world?.incidents.find((i) => i.id === id);

  if (!world) return null;
  if (!incident) {
    return (
      <>
        <PageHeader title="Incident not found" />
        <PageBody>
          <EmptyState
            title={`No incident with id ${id}`}
            detail="Incident identifiers are assigned per simulation run and change when the clock advances or a scenario is injected."
          />
          <Link href="/incidents" className="mt-3 block text-center text-[12px] text-event hover:underline">
            Back to all incidents
          </Link>
        </PageBody>
      </>
    );
  }

  const anomalies = world.anomalies.filter((a) => incident.anomalyIds.includes(a.id));
  const note = notes[incident.id] ?? '';
  const isMet = incident.classification === 'meteorological_event';
  const accent = isMet ? 'var(--color-event)' : 'var(--color-critical)';
  const firstArrival = incident.propagation[0]?.t ?? incident.startedAt;

  return (
    <>
      <PageHeader
        title={incident.title}
        subtitle={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="tnum">{incident.id}</span>
            <span>·</span>
            <span style={{ color: accent }}>{CLASSIFICATION_LABELS[incident.classification]}</span>
            <span>·</span>
            <span className="tnum">{incident.confidence}% confidence</span>
            <span>·</span>
            <time className="tnum">{format(incident.startedAt, 'dd MMM yyyy HH:mm')}</time>
            {incident.endedAt && (
              <span className="tnum">– {format(incident.endedAt, 'HH:mm')}</span>
            )}
          </span>
        }
        actions={
          <>
            <SeverityChip severity={incident.severity} />
            <SegmentedControl
              ariaLabel="Incident status"
              size="sm"
              value={incident.status}
              onChange={(v) => setIncidentStatus(incident.id, v as IncidentStatus)}
              options={STATUSES.map((s) => ({ value: s, label: s }))}
            />
            <Link
              href="/incidents"
              className="flex items-center gap-1 rounded-[3px] border border-line bg-raised px-2 py-1 text-[11px] text-ink-2 hover:text-ink"
            >
              <ArrowLeft size={11} aria-hidden /> All incidents
            </Link>
          </>
        }
      />

      <PageBody className="flex flex-col gap-3">
        <Panel
          eyebrow="Summary"
          title="What is happening"
          className="border-l-2"
          actions={
            <span className="tnum text-[10.5px] text-ink-3">
              {incident.stationIds.length} stations · {incident.anomalyIds.length} anomalies
            </span>
          }
        >
          <p className="p-3 text-[12.5px] leading-relaxed text-ink-2">{incident.summary}</p>
          {incident.recommendedActions.length > 0 && (
            <div className="border-t border-line p-3">
              <div className="eyebrow mb-1.5">Recommended actions</div>
              <ul className="flex flex-col gap-1">
                {incident.recommendedActions.map((a, i) => (
                  <li key={i} className="flex items-start gap-1.5 text-[12px] text-ink-2">
                    <span
                      className="mt-[6px] h-1 w-1 shrink-0 rounded-full"
                      style={{ background: accent }}
                      aria-hidden
                    />
                    {a}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Panel>

        <div className="grid gap-3 xl:grid-cols-[1fr_1fr]">
          <Panel
            eyebrow="Propagation"
            title="Arrival across the network"
            actions={
              <span className="text-[10.5px] text-ink-3">
                {isMet ? 'ordered geographically' : 'single-station event'}
              </span>
            }
          >
            <ol className="divide-y divide-line">
              {incident.propagation.map((p, idx) => {
                const snap = world.snapshotById.get(p.stationId);
                const lag = Math.round((p.t - firstArrival) / MINUTE);
                return (
                  <li key={p.stationId}>
                    <button
                      type="button"
                      onClick={() => selectStation(p.stationId)}
                      className="flex w-full items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-hover"
                    >
                      <span className="tnum w-4 shrink-0 text-[10px] text-ink-3">{idx + 1}</span>
                      <time className="tnum w-[46px] shrink-0 text-[11px] text-ink-2">
                        {format(p.t, 'HH:mm')}
                      </time>
                      <span className="tnum w-[62px] shrink-0 text-[11.5px] text-ink">
                        {p.stationId}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[11px] text-ink-3">
                        {snap?.station.name} · {snap?.station.elevation} m
                      </span>
                      <span
                        className="h-1.5 w-1.5 shrink-0 rounded-full"
                        style={{ background: snap ? STATUS_META[snap.status].color : 'transparent' }}
                        aria-hidden
                      />
                      <span className="tnum w-[54px] shrink-0 text-right text-[10.5px] text-ink-3">
                        {idx === 0 ? 'first' : `+${lag} min`}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>
            {isMet && incident.propagation.length > 2 && (
              <p className="border-t border-line px-3 py-2 text-[11px] leading-relaxed text-ink-3">
                The stations were affected in geographic order at plausible travel speeds. That
                ordering is the evidence: a failing sensor cannot appear at one station and then at
                its neighbours a measured number of minutes later.
              </p>
            )}
          </Panel>

          <Panel eyebrow="Geography" title="Affected stations" bodyClassName="relative min-h-[320px]">
            <NetworkMap
              world={world}
              layers={new Set(['incidents'])}
              radarFrameIndex={0}
              selectedIncident={incident}
              focusStationId={incident.stationIds[0] ?? null}
              onSelectStation={selectStation}
              className="absolute inset-0"
            />
          </Panel>
        </div>

        <div className="grid gap-3 xl:grid-cols-[1.3fr_1fr]">
          <Panel eyebrow="Related" title="Anomalies in this incident">
            <AnomalyList anomalies={anomalies} />
          </Panel>

          <div className="flex flex-col gap-3">
            <Panel eyebrow="Activity" title="Incident log">
              <ol className="divide-y divide-line">
                {incident.activity.map((a, i) => (
                  <li key={i} className="px-3 py-2">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-[11.5px] font-medium text-ink-2">{a.actor}</span>
                      <time className="tnum text-[10px] text-ink-3">{format(a.t, 'HH:mm:ss')}</time>
                    </div>
                    <p className="mt-0.5 text-[11.5px] leading-relaxed text-ink-3">{a.message}</p>
                  </li>
                ))}
              </ol>
            </Panel>

            <Panel eyebrow="Operator" title="Notes">
              <div className="p-3">
                {note && (
                  <p className="mb-2 rounded-[3px] border border-line bg-raised px-2.5 py-2 text-[11.5px] leading-relaxed whitespace-pre-line text-ink-2">
                    {note}
                  </p>
                )}
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  rows={3}
                  placeholder="Add a note for the next shift…"
                  aria-label="Operator note"
                  className="w-full resize-y rounded-[3px] border border-line bg-raised px-2.5 py-2 text-[11.5px] text-ink placeholder:text-ink-3 focus:border-line-strong focus:outline-none"
                />
                <div className="mt-2 flex justify-end">
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={!draft.trim()}
                    onClick={() => {
                      setOperatorNote(
                        incident.id,
                        note ? `${note}\n\n${draft.trim()}` : draft.trim(),
                      );
                      setDraft('');
                    }}
                  >
                    <MessageSquare size={11} aria-hidden />
                    Save note
                  </Button>
                </div>
              </div>
            </Panel>
          </div>
        </div>
      </PageBody>
    </>
  );
}
