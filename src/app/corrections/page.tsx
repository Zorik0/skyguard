'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { format } from 'date-fns';
import { ArrowRight, ShieldCheck } from 'lucide-react';
import { useResolvedWorld, useSelectedStation } from '@/hooks/useWorld';
import { useSkyGuard } from '@/store/useSkyGuard';
import { PageBody, PageHeader } from '@/components/ui/PageHeader';
import {
  EmptyState,
  Panel,
  SegmentedControl,
  SourceBadge,
  StatTile,
} from '@/components/ui/primitives';
import { StationPicker } from '@/components/stations/StationPicker';
import { TimeSeriesChart, ChartLegend, DEFAULT_TRACES } from '@/components/charts/TimeSeriesChart';
import { buildChannelSeries } from '@/lib/analysisSeries';
import { formatSensorValue } from '@/lib/units';
import { SENSOR_LABELS, SENSOR_UNITS } from '@/lib/simulation/stations';
import { HOUR } from '@/lib/utils';
import type { SensorType } from '@/types';

/**
 * Corrected values.
 *
 * The raw measurement is never overwritten anywhere in this system. A
 * correction is an additional record with its own method, weights, interval and
 * confidence — and this screen puts the two side by side so the difference is
 * always visible rather than silently applied.
 */
export default function CorrectionsPage() {
  const world = useResolvedWorld();
  const snapshot = useSelectedStation();
  const settings = useSkyGuard((s) => s.settings);
  const cleaned = useSkyGuard((s) => s.cleaned);
  const setCleaned = useSkyGuard((s) => s.setCleaned);
  const [channel, setChannel] = useState<SensorType>('temperature');

  const corrections = useMemo(
    () =>
      world?.anomalies
        .filter((a) => a.correction && a.correction.confidence > 0)
        .sort((a, b) => b.correction!.t - a.correction!.t) ?? [],
    [world],
  );

  const series = useMemo(
    () =>
      world && snapshot
        ? buildChannelSeries(world, snapshot.station.id, channel, 12 * HOUR)
        : null,
    [world, snapshot, channel],
  );

  if (!world || !snapshot) return null;

  const totalShift = corrections.reduce(
    (acc, a) => acc + Math.abs(a.correction!.correctedValue - a.correction!.rawValue),
    0,
  );
  const meanConfidence = corrections.length
    ? Math.round(corrections.reduce((a, c) => a + c.correction!.confidence, 0) / corrections.length)
    : 0;

  const flaggedCounts = snapshot.qcSeries.reduce(
    (acc, r) => {
      for (const [, flag] of Object.entries(r.flags)) {
        if (flag) acc[flag] = (acc[flag] ?? 0) + 1;
      }
      return acc;
    },
    {} as Record<string, number>,
  );

  return (
    <>
      <PageHeader
        title="Corrected values"
        subtitle="Every correction, with the raw value it replaced, the interval around it and the method that produced it."
        actions={
          <>
            <StationPicker />
            <SegmentedControl
              ariaLabel="Data lens"
              size="sm"
              value={cleaned ? 'qc' : 'raw'}
              onChange={(v) => setCleaned(v === 'qc')}
              options={[
                { value: 'raw', label: 'RAW' },
                { value: 'qc', label: 'QUALITY-CONTROLLED' },
              ]}
            />
          </>
        }
      />

      <PageBody className="flex flex-col gap-3">
        <section className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <StatTile
            label="Corrections published"
            value={corrections.length}
            tone={corrections.length ? 'warning' : 'healthy'}
            hint="in the last 24 hours"
          />
          <StatTile
            label="Mean confidence"
            value={meanConfidence}
            suffix="%"
            hint="across published corrections"
          />
          <StatTile
            label="Total adjustment"
            value={totalShift.toFixed(1)}
            hint="sum of absolute changes, native units"
          />
          <StatTile
            label="Raw values overwritten"
            value={0}
            tone="healthy"
            hint="never — corrections are additive records"
          />
        </section>

        <Panel
          eyebrow="Comparison"
          title={`Raw against quality-controlled · ${snapshot.station.id}`}
          actions={
            <>
              <ChartLegend traces={DEFAULT_TRACES} />
              <SegmentedControl
                ariaLabel="Channel"
                size="sm"
                value={channel}
                onChange={setChannel}
                options={(['temperature', 'humidity', 'pressure', 'wind_speed'] as SensorType[]).map(
                  (s) => ({ value: s, label: SENSOR_LABELS[s] }),
                )}
              />
            </>
          }
        >
          <div className="p-2">
            {series && (
              <TimeSeriesChart
                points={series.points}
                spans={series.spans}
                gaps={series.gaps}
                sensorType={channel}
                settings={settings}
                height={220}
              />
            )}
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line px-3 py-2 text-[10.5px] text-ink-3">
            {Object.entries(flaggedCounts).map(([flag, count]) => (
              <span key={flag} className="tnum">
                {flag}: {count}
              </span>
            ))}
            <span>samples flagged across all channels in the last 24 h</span>
          </div>
        </Panel>

        <Panel
          eyebrow="Ledger"
          title="Every published correction"
          actions={<SourceBadge source="CORRECTED" />}
        >
          {corrections.length === 0 ? (
            <EmptyState
              title="No corrections published"
              detail="Nothing in the last 24 hours was classified as a hardware fault with enough independent references to reconstruct a value."
              icon={<ShieldCheck size={20} aria-hidden />}
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[900px] text-[11.5px]">
                <thead>
                  <tr className="border-b border-line text-left">
                    {['Time', 'Station', 'Channel', 'Raw', '', 'Corrected', 'Interval', 'Confidence', 'Method', 'Model', 'Anomaly'].map(
                      (h, i) => (
                        <th key={i} scope="col" className="eyebrow px-2.5 py-1.5 font-semibold whitespace-nowrap">
                          {h}
                        </th>
                      ),
                    )}
                  </tr>
                </thead>
                <tbody>
                  {corrections.map((a) => {
                    const c = a.correction!;
                    const raw = formatSensorValue(a.sensorType, c.rawValue, settings);
                    const corrected = formatSensorValue(a.sensorType, c.correctedValue, settings);
                    const lo = formatSensorValue(a.sensorType, c.interval[0], settings);
                    const hi = formatSensorValue(a.sensorType, c.interval[1], settings);
                    return (
                      <tr key={a.id} className="border-b border-line/60 hover:bg-hover">
                        <td className="tnum px-2.5 py-1.5 whitespace-nowrap text-ink-3">
                          {format(c.t, 'dd MMM HH:mm')}
                        </td>
                        <td className="px-2.5 py-1.5 whitespace-nowrap">
                          <Link href={`/stations/${a.stationId}`} className="tnum hover:underline">
                            {a.stationId}
                          </Link>
                        </td>
                        <td className="px-2.5 py-1.5 whitespace-nowrap text-ink-2">
                          {SENSOR_LABELS[a.sensorType]}
                        </td>
                        <td className="tnum px-2.5 py-1.5 whitespace-nowrap">
                          {raw.value}
                          <span className="ml-0.5 text-[9.5px] text-ink-3">{raw.suffix}</span>
                        </td>
                        <td className="px-1 py-1.5">
                          <ArrowRight size={10} className="text-ink-3" aria-hidden />
                        </td>
                        <td className="tnum px-2.5 py-1.5 whitespace-nowrap text-warning">
                          {corrected.value}
                          <span className="ml-0.5 text-[9.5px] opacity-70">{corrected.suffix}</span>
                        </td>
                        <td className="tnum px-2.5 py-1.5 whitespace-nowrap text-ink-3">
                          {lo.value}–{hi.value} {SENSOR_UNITS[a.sensorType]}
                        </td>
                        <td className="px-2.5 py-1.5 whitespace-nowrap">
                          <span className="flex items-center gap-1.5">
                            <span className="tnum w-7 text-right text-ink-2">{c.confidence}%</span>
                            <span className="h-1 w-10 overflow-hidden rounded-full bg-line">
                              <span
                                className="block h-full rounded-full bg-warning"
                                style={{ width: `${c.confidence}%` }}
                              />
                            </span>
                          </span>
                        </td>
                        <td className="max-w-[190px] truncate px-2.5 py-1.5 text-ink-3">
                          {c.method}
                        </td>
                        <td className="tnum px-2.5 py-1.5 whitespace-nowrap text-ink-3">
                          {c.modelVersion}
                        </td>
                        <td className="px-2.5 py-1.5 whitespace-nowrap">
                          <Link
                            href={`/anomalies/${a.id}`}
                            className="tnum text-event hover:underline"
                          >
                            {a.id}
                          </Link>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="border-t border-line px-3 py-2 text-[11px] leading-relaxed text-ink-3">
            Each row preserves the original measurement alongside the estimate, the method, the
            model version and the operator-visible confidence. The raw column is the value the
            station actually reported and is what the raw-data export contains.
          </p>
        </Panel>
      </PageBody>
    </>
  );
}
