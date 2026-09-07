'use client';

import { use, useMemo } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { format, formatDistanceToNowStrict } from 'date-fns';
import { Activity, ArrowLeft } from 'lucide-react';
import { useResolvedWorld } from '@/hooks/useWorld';
import { useSkyGuard } from '@/store/useSkyGuard';
import { PageBody, PageHeader } from '@/components/ui/PageHeader';
import {
  EmptyState,
  Panel,
  SourceBadge,
  StatTile,
  StatusLabel,
} from '@/components/ui/primitives';
import { StationMetrics } from '@/components/stations/StationMetrics';
import { AnomalyList } from '@/components/anomalies/AnomalyList';
import { TimeSeriesChart, DEFAULT_TRACES, ChartLegend } from '@/components/charts/TimeSeriesChart';
import { buildChannelSeries } from '@/lib/analysisSeries';
import { SENSOR_LABELS, SENSOR_UNITS } from '@/lib/simulation/stations';
import { healthColor } from '@/lib/units';
import { bandLabel } from '@/lib/health/score';
import { DAY, HOUR, round } from '@/lib/utils';
import type { SensorType } from '@/types';

const NetworkMap = dynamic(
  () => import('@/components/map/NetworkMap').then((m) => m.NetworkMap),
  { ssr: false, loading: () => <div className="h-full bg-[#0c1218]" /> },
);

const TWIN_CHANNELS: SensorType[] = ['temperature', 'humidity', 'pressure', 'wind_speed'];

export default function StationDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const world = useResolvedWorld();
  const settings = useSkyGuard((s) => s.settings);
  const selectStation = useSkyGuard((s) => s.selectStation);

  const snapshot = world?.snapshotById.get(id) ?? null;

  const charts = useMemo(() => {
    if (!world || !snapshot) return [];
    return TWIN_CHANNELS.map((sensorType) => ({
      sensorType,
      ...buildChannelSeries(world, snapshot.station.id, sensorType, 12 * HOUR, 200),
    }));
  }, [world, snapshot]);

  if (!world) return null;
  if (!snapshot) {
    return (
      <>
        <PageHeader title="Station not found" />
        <PageBody>
          <EmptyState title={`No station with id ${id}`} />
          <Link href="/" className="mt-3 block text-center text-[12px] text-event hover:underline">
            Back to the overview
          </Link>
        </PageBody>
      </>
    );
  }

  const { station } = snapshot;
  const incidents = world.incidents.filter((i) => i.stationIds.includes(station.id));
  const tasks = world.maintenance.filter((t) => t.stationId === station.id);
  const ageDays = Math.round((world.now - station.installedAt) / DAY);

  return (
    <>
      <PageHeader
        title={`${station.id} · ${station.name}`}
        subtitle={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>{station.region}</span>
            <span className="tnum">
              {station.latitude.toFixed(4)}, {station.longitude.toFixed(4)}
            </span>
            <span className="tnum">{station.elevation} m</span>
            <span>{station.terrain}</span>
            <span className="tnum">installed {format(station.installedAt, 'dd MMM yyyy')}</span>
          </span>
        }
        actions={
          <>
            <StatusLabel status={snapshot.status} />
            <Link
              href="/monitoring"
              onClick={() => selectStation(station.id)}
              className="flex items-center gap-1.5 rounded-[3px] border border-event/40 bg-event/10 px-2 py-1 text-[11px] text-event hover:bg-event/18"
            >
              <Activity size={11} aria-hidden /> Live charts
            </Link>
            <Link
              href="/"
              className="flex items-center gap-1 rounded-[3px] border border-line bg-raised px-2 py-1 text-[11px] text-ink-2 hover:text-ink"
            >
              <ArrowLeft size={11} aria-hidden /> Overview
            </Link>
          </>
        }
      />

      <PageBody className="flex flex-col gap-3">
        <section className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
          <StatTile
            label="Health"
            value={snapshot.healthScore}
            suffix="/100"
            tone={snapshot.healthScore >= 80 ? 'healthy' : snapshot.healthScore >= 60 ? 'warning' : 'critical'}
          />
          <StatTile label="Uptime 24 h" value={snapshot.uptime} suffix="%" />
          <StatTile
            label="Last packet"
            value={formatDistanceToNowStrict(snapshot.lastPacketAt)}
            hint="ago"
          />
          <StatTile label="Battery" value={snapshot.latest.battery ?? '—'} suffix="V" tone={(snapshot.latest.battery ?? 12.5) < 11.6 ? 'critical' : 'default'} />
          <StatTile label="Solar" value={snapshot.latest.solarVoltage ?? '—'} suffix="V" />
          <StatTile label="Signal" value={snapshot.latest.signal ?? '—'} suffix="dBm" />
          <StatTile label="Firmware" value={station.firmware} hint={station.hardwareModel} />
        </section>

        <Panel eyebrow="Current conditions" title="Observations">
          <StationMetrics world={world} snapshot={snapshot} />
        </Panel>

        <div className="grid gap-3 xl:grid-cols-[1fr_360px]">
          <div className="flex min-w-0 flex-col gap-3">
            <Panel
              eyebrow="Digital twin"
              title="Observed against expected"
              actions={<ChartLegend traces={DEFAULT_TRACES.slice(0, 3)} />}
            >
              <div className="grid gap-px bg-line sm:grid-cols-2">
                {charts.map((c) => (
                  <div key={c.sensorType} className="bg-panel p-2">
                    <div className="mb-1 flex items-center justify-between px-1">
                      <span className="eyebrow">{SENSOR_LABELS[c.sensorType]}</span>
                      <span className="tnum text-[10px] text-ink-3">
                        {SENSOR_UNITS[c.sensorType]}
                      </span>
                    </div>
                    <TimeSeriesChart
                      points={c.points}
                      spans={c.spans}
                      gaps={c.gaps}
                      sensorType={c.sensorType}
                      settings={settings}
                      traces={DEFAULT_TRACES.slice(0, 3)}
                      height={126}
                      syncId="station-detail"
                      showAxis={false}
                    />
                  </div>
                ))}
              </div>
              <p className="border-t border-line px-3 py-2 text-[11px] leading-relaxed text-ink-3">
                The digital twin is built from the regional field, elevation, terrain and
                neighbouring stations rather than from this station&apos;s own probes, so a large and
                persistent gap between the two lines is evidence about the hardware — not about the
                weather.
              </p>
            </Panel>

            <Panel eyebrow="Findings" title="Anomalies at this station">
              <AnomalyList
                anomalies={snapshot.anomalies}
                showStation={false}
                emptyTitle="No findings"
                emptyDetail="Every channel here has stayed within its expected range for the last 24 hours."
              />
            </Panel>

            <Panel eyebrow="History" title="Maintenance record">
              {snapshot.maintenance.length === 0 ? (
                <EmptyState title="No recorded site visits" />
              ) : (
                <ul className="divide-y divide-line">
                  {snapshot.maintenance.map((m, i) => (
                    <li key={i} className="px-3 py-2">
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <span className="text-[12px] text-ink">{m.action}</span>
                        <time className="tnum text-[10.5px] text-ink-3">
                          {format(m.t, 'dd MMM yyyy')}
                        </time>
                      </div>
                      <p className="mt-0.5 text-[11px] text-ink-3">
                        {m.outcome} · {m.technician}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </div>

          <div className="flex flex-col gap-3">
            <Panel eyebrow="Inventory" title="Sensors">
              <ul className="divide-y divide-line">
                {station.sensors.map((sensor) => {
                  const health = snapshot.sensorHealth.find((h) => h.sensorId === sensor.id)!;
                  return (
                    <li key={sensor.id}>
                      <Link
                        href={`/health/${sensor.id}`}
                        className="block px-3 py-2 transition-colors hover:bg-hover"
                      >
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="text-[11.5px] text-ink">{SENSOR_LABELS[sensor.type]}</span>
                          <span
                            className="tnum text-[12px] font-medium"
                            style={{ color: healthColor(health.score) }}
                          >
                            {health.score}
                          </span>
                        </div>
                        <div className="mt-1 h-1 overflow-hidden rounded-full bg-line">
                          <div
                            className="h-full rounded-full"
                            style={{ width: `${health.score}%`, background: healthColor(health.score) }}
                          />
                        </div>
                        <div className="tnum mt-1 flex flex-wrap gap-x-3 text-[9.5px] text-ink-3">
                          <span>{sensor.manufacturer} {sensor.model}</span>
                          <span>{bandLabel(health.band)}</span>
                          <span>calib {health.calibrationAgeDays} d</span>
                        </div>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </Panel>

            <Panel eyebrow="Context" title="Neighbour relevance">
              <ul className="divide-y divide-line">
                {snapshot.neighbours.slice(0, 6).map((n) => (
                  <li key={n.stationId}>
                    <Link
                      href={`/stations/${n.stationId}`}
                      className="flex items-center gap-2 px-3 py-1.5 transition-colors hover:bg-hover"
                    >
                      <span className="tnum w-[62px] shrink-0 text-[11.5px] text-ink">
                        {n.stationId}
                      </span>
                      <span className="h-1 flex-1 overflow-hidden rounded-full bg-line">
                        <span
                          className="block h-full rounded-full bg-event"
                          style={{ width: `${n.relevance}%` }}
                        />
                      </span>
                      <span className="tnum w-8 shrink-0 text-right text-[10.5px] text-ink-2">
                        {n.relevance}%
                      </span>
                      <span className="tnum w-[52px] shrink-0 text-right text-[10px] text-ink-3">
                        {n.distanceKm} km
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </Panel>

            <Panel eyebrow="Geography" title="Location" bodyClassName="relative h-[220px]">
              <NetworkMap
                world={world}
                layers={new Set()}
                radarFrameIndex={0}
                selectedIncident={null}
                focusStationId={station.id}
                onSelectStation={selectStation}
                className="absolute inset-0"
              />
            </Panel>

            <Panel eyebrow="Identity" title="Hardware" actions={<SourceBadge source="SIMULATED" compact />}>
              <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 p-3 text-[11px]">
                <Fact label="Station id" value={station.id} />
                <Fact label="Hardware" value={station.hardwareModel} />
                <Fact label="Firmware" value={station.firmware} />
                <Fact label="Service age" value={`${ageDays} days`} />
                <Fact label="Terrain" value={station.terrain} />
                <Fact label="Maritime influence" value={round(station.maritimeInfluence, 2).toFixed(2)} />
                <Fact label="Packet loss" value={`${snapshot.latest.packetLoss ?? 0}%`} />
                <Fact label="Open tasks" value={String(tasks.filter((t) => t.status !== 'completed').length)} />
              </dl>
            </Panel>

            {incidents.length > 0 && (
              <Panel eyebrow="Linked" title="Incidents">
                <ul className="divide-y divide-line">
                  {incidents.map((i) => (
                    <li key={i.id}>
                      <Link
                        href={`/incidents/${i.id}`}
                        className="block px-3 py-2 transition-colors hover:bg-hover"
                      >
                        <div className="flex items-baseline gap-2">
                          <span className="tnum text-[10px] text-ink-3">{i.id}</span>
                          <span className="min-w-0 flex-1 truncate text-[11.5px] text-ink-2">
                            {i.title}
                          </span>
                        </div>
                        <div className="tnum mt-0.5 text-[10px] text-ink-3">
                          {i.status} · {i.confidence}% · {format(i.startedAt, 'dd MMM HH:mm')}
                        </div>
                      </Link>
                    </li>
                  ))}
                </ul>
              </Panel>
            )}
          </div>
        </div>
      </PageBody>
    </>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="eyebrow">{label}</dt>
      <dd className="tnum mt-0.5 text-ink-2">{value}</dd>
    </div>
  );
}
