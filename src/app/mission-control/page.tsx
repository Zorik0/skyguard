'use client';

import { useMemo } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { format } from 'date-fns';
import { Radar, X } from 'lucide-react';
import { useResolvedWorld, useSelectedStation } from '@/hooks/useWorld';
import { useSkyGuard } from '@/store/useSkyGuard';
import { TimeSeriesChart } from '@/components/charts/TimeSeriesChart';
import { buildChannelSeries } from '@/lib/analysisSeries';
import { StatusDot } from '@/components/ui/primitives';
import { SENSOR_LABELS } from '@/lib/simulation/stations';
import { healthColor, SEVERITY_META, STATUS_META } from '@/lib/units';
import { CLASSIFICATION_LABELS } from '@/lib/anomaly/classify';
import { HOUR } from '@/lib/utils';
import type { SensorType } from '@/types';

const NetworkMap = dynamic(
  () => import('@/components/map/NetworkMap').then((m) => m.NetworkMap),
  { ssr: false, loading: () => <div className="h-full bg-[#0c1218]" /> },
);

const CHANNELS: SensorType[] = ['temperature', 'humidity', 'pressure'];

/**
 * Mission Control.
 *
 * Built for a wall display: no navigation chrome, minimal interaction, maximum
 * information density. Everything on screen updates from the same world object
 * as the rest of the console.
 */
export default function MissionControlPage() {
  const world = useResolvedWorld();
  const snapshot = useSelectedStation();
  const settings = useSkyGuard((s) => s.settings);
  const selectStation = useSkyGuard((s) => s.selectStation);
  const radar = useSkyGuard((s) => s.radar);

  const charts = useMemo(() => {
    if (!world || !snapshot) return [];
    return CHANNELS.map((sensorType) => ({
      sensorType,
      ...buildChannelSeries(world, snapshot.station.id, sensorType, 6 * HOUR, 150),
    }));
  }, [world, snapshot]);

  if (!world || !snapshot) {
    return (
      <div className="flex h-dvh items-center justify-center gap-3 bg-bg">
        <Radar size={22} className="pulse text-healthy" aria-hidden />
        <span className="text-[13px] text-ink-2">Initialising station network…</span>
      </div>
    );
  }

  const m = world.metrics;
  const criticalIncident =
    world.incidents.find((i) => i.severity === 'critical' && i.status !== 'resolved') ??
    world.incidents.find((i) => i.status !== 'resolved') ??
    null;
  const openAlerts = world.alerts.filter((a) => a.state !== 'resolved').slice(0, 9);
  const tasks = world.maintenance.filter((t) => t.status !== 'completed').slice(0, 6);
  const timeline = world.anomalies
    .slice()
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, 14);

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-bg">
      {/* ------------------------------------------------------------- top -- */}
      <header className="flex shrink-0 items-center gap-4 border-b border-line bg-panel px-4 py-2">
        <span className="flex items-center gap-2">
          <Radar size={16} className="text-healthy" aria-hidden />
          <span className="text-[13px] font-semibold tracking-tight">SkyGuard</span>
          <span className="eyebrow">Mission Control</span>
        </span>

        <div className="flex flex-1 flex-wrap items-center gap-x-5 gap-y-1">
          <Kpi label="Online" value={`${m.stationsOnline}/${world.stations.length}`} tone="var(--color-healthy)" />
          <Kpi label="Degraded" value={m.stationsDegraded} tone="var(--color-warning)" />
          <Kpi label="Offline" value={m.stationsOffline} tone="var(--color-offline)" />
          <Kpi label="Active anomalies" value={m.activeAnomalies} tone="var(--color-critical)" />
          <Kpi label="Critical alerts" value={m.criticalAlerts} tone="var(--color-failed)" />
          <Kpi label="Weather events" value={m.activeWeatherEvents} tone="var(--color-event)" />
          <Kpi label="Data quality" value={`${m.dataQualityScore}`} tone={healthColor(m.dataQualityScore)} />
          <Kpi label="Rows/min" value={m.rowsPerMinute} tone="var(--color-ink-2)" />
        </div>

        <span className="tnum text-[15px] text-ink" suppressHydrationWarning>
          {format(world.now, 'HH:mm')}
        </span>
        <Link
          href="/"
          className="flex h-7 w-7 items-center justify-center rounded-[3px] border border-line bg-raised text-ink-2 hover:text-ink"
          aria-label="Exit Mission Control"
        >
          <X size={13} aria-hidden />
        </Link>
      </header>

      {/* ------------------------------------------------------------ main -- */}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-px bg-line lg:grid-cols-[1.15fr_1.35fr_0.85fr]">
        {/* LEFT — map */}
        <section className="relative min-h-[240px] bg-panel" aria-label="Network map">
          <NetworkMap
            world={world}
            layers={new Set(radar ? ['radar', 'incidents', 'clusters'] : ['incidents', 'clusters'])}
            radarFrameIndex={radar ? radar.past.length - 1 : 0}
            selectedIncident={criticalIncident}
            focusStationId={null}
            onSelectStation={selectStation}
            className="absolute inset-0"
          />
        </section>

        {/* CENTRE — critical incident and charts */}
        <section className="flex min-h-0 flex-col overflow-hidden bg-panel" aria-label="Critical incident">
          {criticalIncident && (
            <div
              className="shrink-0 border-b border-line px-3 py-2"
              style={{
                background: `color-mix(in srgb, ${
                  criticalIncident.classification === 'meteorological_event'
                    ? 'var(--color-event)'
                    : 'var(--color-critical)'
                } 8%, transparent)`,
              }}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="tnum text-[10px] text-ink-3">{criticalIncident.id}</span>
                <span className="text-[13px] font-semibold text-ink">{criticalIncident.title}</span>
                <span
                  className="tnum text-[12px] font-semibold"
                  style={{
                    color:
                      criticalIncident.classification === 'meteorological_event'
                        ? 'var(--color-event)'
                        : 'var(--color-critical)',
                  }}
                >
                  {CLASSIFICATION_LABELS[criticalIncident.classification]} ·{' '}
                  {criticalIncident.confidence}%
                </span>
              </div>
              <p className="mt-0.5 line-clamp-2 text-[11px] text-ink-3">{criticalIncident.summary}</p>
            </div>
          )}

          <div className="flex items-center justify-between border-b border-line px-3 py-1.5">
            <span className="tnum text-[12px] text-ink">
              {snapshot.station.id} · {snapshot.station.name}
            </span>
            <span className="flex items-center gap-2">
              <StatusDot status={snapshot.status} />
              <span className="text-[11px]" style={{ color: STATUS_META[snapshot.status].color }}>
                {STATUS_META[snapshot.status].label}
              </span>
              <span
                className="tnum text-[12px] font-medium"
                style={{ color: healthColor(snapshot.healthScore) }}
              >
                {snapshot.healthScore}
              </span>
            </span>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {charts.map((c) => (
              <div key={c.sensorType} className="border-b border-line p-1.5">
                <div className="eyebrow px-1.5">{SENSOR_LABELS[c.sensorType]}</div>
                <TimeSeriesChart
                  points={c.points}
                  spans={c.spans}
                  gaps={c.gaps}
                  sensorType={c.sensorType}
                  settings={settings}
                  height={112}
                  syncId="mission"
                  showAxis={false}
                />
              </div>
            ))}
          </div>
        </section>

        {/* RIGHT — alerts and maintenance */}
        <section className="flex min-h-0 flex-col overflow-hidden bg-panel" aria-label="Alerts and maintenance">
          <div className="panel-header shrink-0">
            <span className="eyebrow">Alerts</span>
            <span className="tnum text-[10px] text-ink-3">{openAlerts.length} open</span>
          </div>
          <ul className="min-h-0 flex-1 divide-y divide-line overflow-y-auto">
            {openAlerts.map((a) => (
              <li key={a.id} className="flex items-start gap-2 px-2.5 py-1.5">
                <span
                  className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ background: SEVERITY_META[a.severity].color }}
                  aria-hidden
                />
                <div className="min-w-0 flex-1">
                  <div className="tnum text-[10.5px] text-ink-3">
                    {a.stationId} · {format(a.t, 'HH:mm:ss')}
                  </div>
                  <div className="truncate text-[11px] text-ink-2">{a.message}</div>
                </div>
              </li>
            ))}
          </ul>

          <div className="panel-header shrink-0 border-t border-line">
            <span className="eyebrow">Maintenance</span>
            <span className="tnum text-[10px] text-ink-3">{tasks.length}</span>
          </div>
          <ul className="max-h-[34%] shrink-0 divide-y divide-line overflow-y-auto">
            {tasks.map((t) => (
              <li key={t.id} className="px-2.5 py-1.5">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="tnum text-[11px] text-ink-2">{t.stationId}</span>
                  <span
                    className="text-[9px] font-semibold tracking-wider uppercase"
                    style={{ color: SEVERITY_META[t.priority].color }}
                  >
                    {t.priority}
                  </span>
                </div>
                <div className="truncate text-[10.5px] text-ink-3">{t.action}</div>
              </li>
            ))}
          </ul>
        </section>
      </div>

      {/* ---------------------------------------------------------- bottom -- */}
      <footer className="shrink-0 overflow-x-auto border-t border-line bg-panel">
        <ol className="flex min-w-max items-stretch">
          {timeline.map((a) => (
            <li
              key={a.id}
              className="flex min-w-[168px] flex-col gap-0.5 border-r border-line px-2.5 py-1.5"
            >
              <div className="flex items-center gap-1.5">
                <span
                  className="h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ background: SEVERITY_META[a.severity].color }}
                  aria-hidden
                />
                <time className="tnum text-[10px] text-ink-3">{format(a.startedAt, 'HH:mm')}</time>
                <span className="tnum text-[10px] text-ink-2">{a.stationId}</span>
              </div>
              <span className="truncate text-[10.5px] text-ink-2">
                {a.title.replace(`${a.stationId} `, '')}
              </span>
              <span
                className="truncate text-[9.5px]"
                style={{
                  color:
                    a.classification === 'meteorological_event'
                      ? 'var(--color-event)'
                      : 'var(--color-critical)',
                }}
              >
                {CLASSIFICATION_LABELS[a.classification]} · {a.confidence}%
              </span>
            </li>
          ))}
        </ol>
      </footer>
    </div>
  );
}

function Kpi({ label, value, tone }: { label: string; value: string | number; tone: string }) {
  return (
    <span className="flex items-baseline gap-1.5">
      <span className="eyebrow">{label}</span>
      <span className="tnum text-[15px] leading-none font-medium" style={{ color: tone }}>
        {value}
      </span>
    </span>
  );
}
