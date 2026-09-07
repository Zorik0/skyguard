'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useResolvedWorld, useSelectedStation } from '@/hooks/useWorld';
import { useSkyGuard } from '@/store/useSkyGuard';
import { PageBody, PageHeader } from '@/components/ui/PageHeader';
import { Panel, SegmentedControl, SourceBadge } from '@/components/ui/primitives';
import { StationPicker } from '@/components/stations/StationPicker';
import {
  ChartLegend,
  DEFAULT_TRACES,
  TimeSeriesChart,
  TRACE_COLORS,
} from '@/components/charts/TimeSeriesChart';
import {
  buildAnomalyScoreSeries,
  buildChannelSeries,
  buildDewPointSeries,
} from '@/lib/analysisSeries';
import { SENSOR_LABELS, SENSOR_UNITS } from '@/lib/simulation/stations';
import { healthColor } from '@/lib/units';
import { bandLabel } from '@/lib/health/score';
import { HOUR, MINUTE } from '@/lib/utils';
import type { SensorType } from '@/types';

const RANGES = [
  { value: '30', label: '30 min', ms: 30 * MINUTE },
  { value: '60', label: '1 h', ms: HOUR },
  { value: '180', label: '3 h', ms: 3 * HOUR },
  { value: '360', label: '6 h', ms: 6 * HOUR },
  { value: '720', label: '12 h', ms: 12 * HOUR },
  { value: '1440', label: '24 h', ms: 24 * HOUR },
];

const CHANNELS: SensorType[] = [
  'temperature',
  'humidity',
  'pressure',
  'wind_speed',
  'rainfall',
];

/**
 * Live monitoring.
 *
 * Every chart shares a sync id, so a crosshair on one appears on all of them.
 * That is the point of this screen: the answer to "is this real?" is almost
 * always in whether the *other* channels moved at the same instant.
 */
export default function MonitoringPage() {
  const world = useResolvedWorld();
  const snapshot = useSelectedStation();
  const settings = useSkyGuard((s) => s.settings);
  const cleaned = useSkyGuard((s) => s.cleaned);
  const [range, setRange] = useState('360');

  const windowMs = RANGES.find((r) => r.value === range)?.ms ?? 6 * HOUR;

  const channelSeries = useMemo(() => {
    if (!world || !snapshot) return [];
    return CHANNELS.map((sensorType) => ({
      sensorType,
      ...buildChannelSeries(world, snapshot.station.id, sensorType, windowMs),
    }));
  }, [world, snapshot, windowMs]);

  const dewPoint = useMemo(
    () => (world && snapshot ? buildDewPointSeries(world, snapshot.station.id, windowMs) : []),
    [world, snapshot, windowMs],
  );

  const anomalyScore = useMemo(
    () => (world && snapshot ? buildAnomalyScoreSeries(world, snapshot.station.id, windowMs) : []),
    [world, snapshot, windowMs],
  );

  if (!world || !snapshot) return null;

  const activeSpans = channelSeries.flatMap((c) => c.spans);

  return (
    <>
      <PageHeader
        title="Live monitoring"
        subtitle={
          <>
            {snapshot.station.id} · {snapshot.station.name} · {snapshot.station.elevation} m ·
            synchronised channels, shaded where a finding is open
          </>
        }
        actions={
          <>
            <StationPicker />
            <SegmentedControl
              ariaLabel="Time range"
              size="sm"
              value={range}
              onChange={setRange}
              options={RANGES.map((r) => ({ value: r.value, label: r.label }))}
            />
          </>
        }
      />

      <PageBody className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-[3px] border border-line bg-panel px-3 py-2">
          <ChartLegend traces={DEFAULT_TRACES} />
          <div className="flex flex-wrap items-center gap-3 text-[10px] text-ink-3">
            <LegendSwatch color="var(--color-critical)" label="Probable sensor fault" />
            <LegendSwatch color="var(--color-event)" label="Probable weather event" />
            <LegendSwatch color="var(--color-offline)" label="Missing data" />
            <span className="text-ink-3">
              Showing {cleaned ? 'quality-controlled' : 'raw'} values
            </span>
          </div>
        </div>

        <div className="grid gap-3 xl:grid-cols-[1fr_270px]">
          <div className="flex min-w-0 flex-col gap-3">
            {channelSeries.map((c) => (
              <Panel
                key={c.sensorType}
                eyebrow={SENSOR_UNITS[c.sensorType]}
                title={SENSOR_LABELS[c.sensorType]}
                actions={
                  <>
                    {c.spans.length > 0 && (
                      <span className="tnum text-[10px] text-warning">
                        {c.spans.length} finding{c.spans.length === 1 ? '' : 's'}
                      </span>
                    )}
                    <SourceBadge source="SIMULATED" compact />
                  </>
                }
              >
                <div className="p-2">
                  <TimeSeriesChart
                    points={c.points}
                    spans={c.spans}
                    gaps={c.gaps}
                    sensorType={c.sensorType}
                    settings={settings}
                    height={150}
                    syncId="monitoring"
                  />
                </div>
              </Panel>
            ))}

            <Panel
              eyebrow="°C"
              title="Dew point"
              actions={<SourceBadge source="MODELLED" compact />}
            >
              <div className="p-2">
                <TimeSeriesChart
                  points={dewPoint}
                  sensorType="temperature"
                  settings={settings}
                  traces={[
                    { key: 'raw', label: 'Reported dew point', color: TRACE_COLORS.raw, width: 1.4 },
                    { key: 'twin', label: 'Physics model', color: TRACE_COLORS.twin, dashed: true },
                  ]}
                  height={130}
                  syncId="monitoring"
                />
              </div>
              <p className="border-t border-line px-3 py-1.5 text-[10.5px] text-ink-3">
                Derived by the logger from its own temperature and humidity probes, so a fault on
                either channel propagates into this trace — which is itself a useful signal.
              </p>
            </Panel>

            <Panel
              eyebrow="0–100"
              title="Anomaly score"
              actions={<SourceBadge source="MODELLED" compact />}
            >
              <div className="p-2">
                <TimeSeriesChart
                  points={anomalyScore}
                  spans={activeSpans}
                  sensorType="humidity"
                  settings={settings}
                  traces={[
                    { key: 'raw', label: 'Anomaly score', color: 'var(--color-warning)', width: 1.6 },
                  ]}
                  height={110}
                  syncId="monitoring"
                  domainPadding={0.02}
                />
              </div>
            </Panel>
          </div>

          <div className="flex flex-col gap-3">
            <Panel eyebrow="Now" title="Sensor health">
              <ul className="divide-y divide-line">
                {snapshot.sensorHealth.map((h) => (
                  <li key={h.sensorId}>
                    <Link
                      href={`/health/${h.sensorId}`}
                      className="block px-3 py-2 transition-colors hover:bg-hover"
                    >
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="text-[11.5px] text-ink-2">{SENSOR_LABELS[h.type]}</span>
                        <span
                          className="tnum text-[13px] font-medium"
                          style={{ color: healthColor(h.score) }}
                        >
                          {h.score}
                        </span>
                      </div>
                      <div className="mt-1 h-1 overflow-hidden rounded-full bg-line">
                        <div
                          className="h-full rounded-full"
                          style={{ width: `${h.score}%`, background: healthColor(h.score) }}
                        />
                      </div>
                      <div className="mt-1 flex items-center justify-between text-[9.5px] text-ink-3">
                        <span>{bandLabel(h.band)}</span>
                        <span className="tnum">
                          7 d {h.trend7d > 0 ? '+' : ''}
                          {h.trend7d}
                        </span>
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            </Panel>

            <Panel eyebrow="Findings" title="In this window">
              {activeSpans.length === 0 ? (
                <p className="px-3 py-4 text-center text-[11.5px] text-ink-3">
                  No findings in the selected range.
                </p>
              ) : (
                <ul className="divide-y divide-line">
                  {activeSpans.map((s) => (
                    <li key={s.id}>
                      <Link
                        href={`/anomalies/${s.id}`}
                        className="block px-3 py-2 text-[11.5px] transition-colors hover:bg-hover"
                      >
                        <span className="tnum mr-1.5 text-[10px] text-ink-3">{s.id}</span>
                        <span className="text-ink-2">
                          {s.title.replace(`${snapshot.station.id} `, '')}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </div>
        </div>
      </PageBody>
    </>
  );
}

function LegendSwatch({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span
        className="h-2.5 w-4 rounded-[1px] border"
        style={{
          background: `color-mix(in srgb, ${color} 14%, transparent)`,
          borderColor: `color-mix(in srgb, ${color} 40%, transparent)`,
        }}
        aria-hidden
      />
      {label}
    </span>
  );
}
