'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { format } from 'date-fns';
import { Download } from 'lucide-react';
import { useResolvedWorld } from '@/hooks/useWorld';
import { useSkyGuard } from '@/store/useSkyGuard';
import { PageBody, PageHeader } from '@/components/ui/PageHeader';
import {
  Button,
  EmptyState,
  Panel,
  SegmentedControl,
  SourceBadge,
  StatTile,
} from '@/components/ui/primitives';
import { SENSOR_LABELS, SENSOR_UNITS } from '@/lib/simulation/stations';
import { CLASSIFICATION_LABELS } from '@/lib/anomaly/classify';
import { downloadReport, REPORTS } from '@/lib/reports/export';
import type { QualityFlag } from '@/types';

const FLAG_COLOR: Record<QualityFlag, string> = {
  good: 'var(--color-healthy)',
  suspect: 'var(--color-warning)',
  bad: 'var(--color-failed)',
  missing: 'var(--color-offline)',
  corrected: 'var(--color-warning)',
};

/**
 * Audit trail.
 *
 * The record that makes the platform's central promise checkable: for every
 * value SkyGuard touched, what it was, what flag it carried, what replaced it,
 * which rules fired, which model version decided, and why.
 */
export default function AuditPage() {
  const world = useResolvedWorld();
  const settings = useSkyGuard((s) => s.settings);
  const [flag, setFlag] = useState<QualityFlag | 'all'>('all');
  const [station, setStation] = useState('all');

  const entries = useMemo(() => {
    if (!world) return [];
    return world.audit
      .filter((e) => flag === 'all' || e.flag === flag)
      .filter((e) => station === 'all' || e.stationId === station);
  }, [world, flag, station]);

  if (!world) return null;

  const counts = world.audit.reduce<Record<string, number>>((acc, e) => {
    acc[e.flag] = (acc[e.flag] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <>
      <PageHeader
        title="Audit log"
        subtitle="Every classification and every correction, with the raw measurement intact beside it."
        actions={
          <>
            <SourceBadge source="SIMULATED" />
            <label>
              <span className="sr-only">Station</span>
              <select
                value={station}
                onChange={(e) => setStation(e.target.value)}
                className="rounded-[3px] border border-line bg-raised px-2 py-1 text-[11px] text-ink"
              >
                <option value="all">All stations</option>
                {world.stations.map((s) => (
                  <option key={s.id} value={s.id}>{s.id}</option>
                ))}
              </select>
            </label>
            <SegmentedControl
              ariaLabel="Quality flag"
              size="sm"
              value={flag}
              onChange={setFlag}
              options={[
                { value: 'all', label: 'All' },
                { value: 'corrected', label: 'Corrected' },
                { value: 'bad', label: 'Bad' },
                { value: 'suspect', label: 'Suspect' },
                { value: 'missing', label: 'Missing' },
              ]}
            />
            <Button
              size="sm"
              variant="primary"
              onClick={() => {
                const def = REPORTS.find((r) => r.id === 'audit')!;
                downloadReport(def.build(world), `skyguard-audit-${format(world.now, 'yyyyMMdd-HHmm')}`, 'csv');
              }}
            >
              <Download size={11} aria-hidden /> Export
            </Button>
          </>
        }
      />

      <PageBody className="flex flex-col gap-3">
        <section className="grid grid-cols-2 gap-2 sm:grid-cols-5">
          <StatTile label="Entries" value={world.audit.length} hint="last 24 hours" />
          <StatTile label="Corrections" value={counts.corrected ?? 0} tone="warning" />
          <StatTile label="Flagged bad" value={counts.bad ?? 0} tone="failed" />
          <StatTile label="Flagged suspect" value={counts.suspect ?? 0} tone="warning" />
          <StatTile label="Raw values altered" value={0} tone="healthy" hint="never" />
        </section>

        <Panel eyebrow="Trail" title={`${entries.length} entries`}>
          {entries.length === 0 ? (
            <EmptyState title="No entries match this filter" />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1080px] text-[11px]">
                <thead>
                  <tr className="border-b border-line text-left">
                    {['Time', 'Station', 'Channel', 'Raw', 'Flag', 'Corrected', 'Score', 'Classification', 'Confidence', 'Rules', 'Model', 'Operator action', 'Incident'].map((h) => (
                      <th key={h} scope="col" className="eyebrow px-2 py-1.5 font-semibold whitespace-nowrap">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {entries.map((e) => (
                    <tr key={e.id} className="border-b border-line/60 hover:bg-hover">
                      <td className="tnum px-2 py-1.5 whitespace-nowrap text-ink-3">
                        {format(e.t, 'dd MMM HH:mm:ss')}
                      </td>
                      <td className="px-2 py-1.5 whitespace-nowrap">
                        <Link href={`/stations/${e.stationId}`} className="tnum hover:underline">
                          {e.stationId}
                        </Link>
                      </td>
                      <td className="px-2 py-1.5 whitespace-nowrap text-ink-2">
                        {e.sensorType ? SENSOR_LABELS[e.sensorType] : '—'}
                      </td>
                      <td className="tnum px-2 py-1.5 whitespace-nowrap">
                        {e.rawValue !== null
                          ? `${e.rawValue} ${e.sensorType ? SENSOR_UNITS[e.sensorType] : ''}`
                          : '—'}
                      </td>
                      <td className="px-2 py-1.5 whitespace-nowrap">
                        <span
                          className="rounded-[2px] px-1 py-px text-[9px] font-semibold tracking-wider uppercase"
                          style={{
                            color: FLAG_COLOR[e.flag],
                            background: `color-mix(in srgb, ${FLAG_COLOR[e.flag]} 12%, transparent)`,
                          }}
                        >
                          {e.flag}
                        </span>
                      </td>
                      <td className="tnum px-2 py-1.5 whitespace-nowrap text-warning">
                        {e.correctedValue !== null
                          ? `${e.correctedValue} ${e.sensorType ? SENSOR_UNITS[e.sensorType] : ''}`
                          : '—'}
                      </td>
                      <td className="tnum px-2 py-1.5">{e.anomalyScore ?? '—'}</td>
                      <td className="px-2 py-1.5 whitespace-nowrap text-ink-2">
                        {e.classification ? CLASSIFICATION_LABELS[e.classification] : '—'}
                      </td>
                      <td className="tnum px-2 py-1.5">{e.confidence !== null ? `${e.confidence}%` : '—'}</td>
                      <td className="max-w-[210px] truncate px-2 py-1.5 text-ink-3" title={e.rules.join('; ')}>
                        {e.rules.length ? e.rules.join(' + ') : '—'}
                      </td>
                      <td className="tnum px-2 py-1.5 whitespace-nowrap text-ink-3">{e.modelVersion}</td>
                      <td className="max-w-[220px] truncate px-2 py-1.5 text-ink-3" title={e.operatorAction ?? ''}>
                        {e.operatorAction ?? '—'}
                      </td>
                      <td className="px-2 py-1.5 whitespace-nowrap">
                        {e.incidentId ? (
                          <Link href={`/incidents/${e.incidentId}`} className="tnum text-event hover:underline">
                            {e.incidentId}
                          </Link>
                        ) : (
                          '—'
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="border-t border-line px-3 py-2 text-[11px] leading-relaxed text-ink-3">
            Values are shown in native SI units regardless of the display preference
            ({settings.temperatureUnit === 'F' ? 'Fahrenheit' : 'Celsius'} is applied elsewhere), so
            an exported audit trail is directly comparable between operators.
          </p>
        </Panel>
      </PageBody>
    </>
  );
}
