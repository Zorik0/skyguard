'use client';

import { useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { format } from 'date-fns';
import { Pause, Play } from 'lucide-react';
import { useResolvedWorld, useSelectedStation } from '@/hooks/useWorld';
import { useSkyGuard } from '@/store/useSkyGuard';
import { PageBody, PageHeader } from '@/components/ui/PageHeader';
import {
  Button,
  EmptyState,
  Panel,
  SegmentedControl,
  SourceBadge,
} from '@/components/ui/primitives';
import { StationPicker } from '@/components/stations/StationPicker';
import { TimeSeriesChart } from '@/components/charts/TimeSeriesChart';
import { buildChannelSeries } from '@/lib/analysisSeries';
import { formatSensorValue } from '@/lib/units';
import { CLASSIFICATION_LABELS } from '@/lib/anomaly/classify';
import { MINUTE, round } from '@/lib/utils';
import type { EnsembleBand } from '@/types';

const NetworkMap = dynamic(
  () => import('@/components/map/NetworkMap').then((m) => m.NetworkMap),
  { ssr: false, loading: () => <div className="h-full bg-[#0c1218]" /> },
);

const PLAYBACK_RANGES = [
  { value: '15', label: '15 min' },
  { value: '60', label: '1 h' },
  { value: '180', label: '3 h' },
  { value: '360', label: '6 h' },
  { value: '720', label: '12 h' },
  { value: '1440', label: '24 h' },
];

/**
 * Weather event analysis.
 *
 * The timeline scrubber rewinds the whole network, not one chart: dragging it
 * moves every station's displayed conditions backwards together, which is how
 * you watch a front physically cross the map.
 */
export default function WeatherEventsPage() {
  const world = useResolvedWorld();
  const snapshot = useSelectedStation();
  const settings = useSkyGuard((s) => s.settings);
  const selectStation = useSkyGuard((s) => s.selectStation);
  const offset = useSkyGuard((s) => s.playbackOffsetMinutes);
  const setOffset = useSkyGuard((s) => s.setPlaybackOffset);
  const externalStatus = useSkyGuard((s) => s.externalStatus);
  const external = useSkyGuard((s) => s.external);

  const [span, setSpan] = useState('360');
  const [playing, setPlaying] = useState(false);
  const [ensemble, setEnsemble] = useState<{ bands: EnsembleBand[]; status: string }>({
    bands: [],
    status: 'loading',
  });

  const spanMinutes = Number(span);

  // Replay: step backwards through the window, then stop at "now".
  useEffect(() => {
    if (!playing) return;
    const id = window.setInterval(() => {
      setOffset(
        useSkyGuard.getState().playbackOffsetMinutes <= 0
          ? spanMinutes
          : Math.max(0, useSkyGuard.getState().playbackOffsetMinutes - Math.ceil(spanMinutes / 40)),
      );
    }, 220);
    return () => window.clearInterval(id);
  }, [playing, spanMinutes, setOffset]);

  // Ensemble spread is fetched only for the station being examined. When the
  // provider is unreachable there is nothing to fetch, and "unavailable" is
  // derived below rather than written into state from inside the effect.
  const stationId = snapshot?.station.id;
  const canFetchEnsemble = Boolean(stationId) && externalStatus === 'live';

  useEffect(() => {
    if (!canFetchEnsemble || !stationId) return;
    let cancelled = false;
    const controller = new AbortController();

    fetch(`/api/weather/ensemble?station=${stationId}`, { signal: controller.signal })
      .then((r) => r.json())
      .then((d: { bands?: EnsembleBand[]; status?: string }) => {
        if (!cancelled) setEnsemble({ bands: d.bands ?? [], status: d.status ?? 'error' });
      })
      .catch(() => {
        if (!cancelled) setEnsemble({ bands: [], status: 'error' });
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [canFetchEnsemble, stationId]);

  const ensembleView = canFetchEnsemble
    ? ensemble
    : { bands: [] as EnsembleBand[], status: 'unavailable' };

  const metIncidents = useMemo(
    () => world?.incidents.filter((i) => i.classification === 'meteorological_event') ?? [],
    [world],
  );
  const featured = metIncidents.sort((a, b) => b.stationIds.length - a.stationIds.length)[0] ?? null;

  const channel = useMemo(
    () =>
      world && snapshot
        ? buildChannelSeries(world, snapshot.station.id, 'temperature', spanMinutes * MINUTE)
        : null,
    [world, snapshot, spanMinutes],
  );

  if (!world || !snapshot) return null;

  const playbackTime = world.now - offset * MINUTE;
  const stepIndex = Math.max(
    0,
    Math.min(
      snapshot.series.length - 1,
      Math.round((playbackTime - world.from) / world.stepMs),
    ),
  );

  const ext = external.get(snapshot.station.id);
  const nextHours = ext?.hourly.filter((h) => h.t >= world.now).slice(0, 8) ?? [];

  return (
    <>
      <PageHeader
        title="Weather event analysis"
        subtitle="Genuine meteorological events, the evidence that identified them as real, and how they moved across the network."
        actions={
          <>
            <StationPicker />
            <SegmentedControl
              ariaLabel="Playback window"
              size="sm"
              value={span}
              onChange={(v) => {
                setSpan(v);
                setOffset(0);
              }}
              options={PLAYBACK_RANGES}
            />
          </>
        }
      />

      <PageBody className="flex flex-col gap-3">
        {/* ------------------------------------------------- playback ----- */}
        <Panel
          eyebrow="Playback"
          title="Rewind the network"
          actions={
            <span className="tnum text-[11px] text-ink-2">
              {format(playbackTime, 'dd MMM HH:mm')}
              {offset > 0 && <span className="ml-1.5 text-warning">−{offset} min</span>}
            </span>
          }
        >
          <div className="flex flex-wrap items-center gap-2 p-3">
            <Button
              size="sm"
              variant={playing ? 'primary' : 'default'}
              onClick={() => {
                if (!playing && offset === 0) setOffset(spanMinutes);
                setPlaying((p) => !p);
              }}
            >
              {playing ? <Pause size={11} aria-hidden /> : <Play size={11} aria-hidden />}
              {playing ? 'Pause' : 'Replay event'}
            </Button>

            <input
              type="range"
              min={0}
              max={spanMinutes}
              value={offset}
              onChange={(e) => {
                setPlaying(false);
                setOffset(Number(e.target.value));
              }}
              aria-label="Rewind the network"
              className="h-1 min-w-[180px] flex-1 accent-[var(--color-event)]"
              // The slider reads right-to-left: 0 is now, max is the far past.
              style={{ direction: 'rtl' }}
            />

            <Button size="sm" onClick={() => { setPlaying(false); setOffset(0); }}>
              Return to now
            </Button>
          </div>

          <div className="grid grid-cols-2 gap-px border-t border-line bg-line sm:grid-cols-3 lg:grid-cols-6">
            {(
              [
                ['temperature', 'Temperature'],
                ['humidity', 'Humidity'],
                ['pressure', 'Pressure'],
                ['wind_speed', 'Wind'],
                ['rainfall', 'Rainfall'],
              ] as const
            ).map(([type, label]) => {
              const reading = snapshot.series[stepIndex];
              const value =
                type === 'temperature' ? reading?.temperature
                : type === 'humidity' ? reading?.humidity
                : type === 'pressure' ? reading?.pressure
                : type === 'wind_speed' ? reading?.windSpeed
                : reading?.rainfall;
              const f = formatSensorValue(type, value ?? null, settings);
              return (
                <div key={type} className="bg-panel px-3 py-2">
                  <div className="eyebrow truncate">{label}</div>
                  <div className="mt-0.5 flex items-baseline gap-1">
                    <span className="tnum text-[16px] leading-none">{f.value}</span>
                    <span className="text-[10px] text-ink-3">{f.suffix}</span>
                  </div>
                </div>
              );
            })}
            <div className="bg-panel px-3 py-2">
              <div className="eyebrow truncate">Dew point</div>
              <div className="mt-0.5 flex items-baseline gap-1">
                <span className="tnum text-[16px] leading-none">
                  {formatSensorValue('temperature', snapshot.series[stepIndex]?.dewPoint ?? null, settings).value}
                </span>
                <span className="text-[10px] text-ink-3">
                  {formatSensorValue('temperature', 0, settings).suffix}
                </span>
              </div>
            </div>
          </div>
        </Panel>

        <div className="grid gap-3 xl:grid-cols-[1fr_1fr]">
          <Panel eyebrow="Geography" title="Event propagation" bodyClassName="relative min-h-[380px]">
            <NetworkMap
              world={world}
              layers={new Set(['incidents', 'temperature'])}
              radarFrameIndex={0}
              selectedIncident={featured}
              focusStationId={null}
              onSelectStation={selectStation}
              className="absolute inset-0"
            />
          </Panel>

          <div className="flex flex-col gap-3">
            <Panel
              eyebrow="Events"
              title="Confirmed meteorological events"
              actions={<SourceBadge source="MODELLED" compact />}
            >
              {metIncidents.length === 0 ? (
                <EmptyState
                  title="No genuine weather events in progress"
                  detail="Every current finding has been classified as a hardware, communications or power problem."
                />
              ) : (
                <ul className="divide-y divide-line">
                  {metIncidents.map((i) => (
                    <li key={i.id}>
                      <Link
                        href={`/incidents/${i.id}`}
                        className="block px-3 py-2 transition-colors hover:bg-hover"
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="tnum text-[10px] text-ink-3">{i.id}</span>
                          <span className="text-[12px] font-medium text-ink">{i.title}</span>
                        </div>
                        <div className="tnum mt-0.5 flex flex-wrap gap-x-3 text-[10.5px] text-ink-3">
                          <span className="text-event">
                            {CLASSIFICATION_LABELS[i.classification]} · {i.confidence}%
                          </span>
                          <span>{i.stationIds.length} stations</span>
                          <span>{i.anomalyIds.length} anomalies</span>
                          <span>{format(i.startedAt, 'HH:mm')}</span>
                        </div>
                        <p className="mt-1 text-[10.5px] text-ink-3">
                          No correction applied — these readings are published as measured.
                        </p>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>

            <Panel
              eyebrow="Forecast"
              title={`Open-Meteo outlook · ${snapshot.station.id}`}
              actions={<SourceBadge source="EXTERNAL_MODEL" compact />}
            >
              {externalStatus === 'live' && nextHours.length ? (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[420px] text-[11px]">
                    <thead>
                      <tr className="border-b border-line text-left">
                        {['Hour', 'Temp', 'RH', 'Pressure', 'Wind', 'Precip', 'Prob'].map((h) => (
                          <th key={h} scope="col" className="eyebrow px-2.5 py-1.5 font-semibold">
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {nextHours.map((h) => (
                        <tr key={h.t} className="border-b border-line/60">
                          <td className="tnum px-2.5 py-1 text-ink-2">{format(h.t, 'HH:mm')}</td>
                          <td className="tnum px-2.5 py-1">{round(h.temperature, 1)}°</td>
                          <td className="tnum px-2.5 py-1">{round(h.humidity, 0)}%</td>
                          <td className="tnum px-2.5 py-1">{round(h.pressure, 0)}</td>
                          <td className="tnum px-2.5 py-1">{round(h.windSpeed, 1)}</td>
                          <td className="tnum px-2.5 py-1">{round(h.precipitation, 1)}</td>
                          <td className="tnum px-2.5 py-1 text-ink-3">
                            {round(h.precipitationProbability, 0)}%
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <EmptyState
                  title="External weather context unavailable"
                  detail="Forecast context is an enhancement. Event classification does not depend on it."
                />
              )}
            </Panel>

            <Panel
              eyebrow="Uncertainty"
              title="Ensemble spread"
              actions={<SourceBadge source="EXTERNAL_MODEL" compact />}
            >
              {ensembleView.bands.length ? (
                <>
                  <div className="p-2">
                    <TimeSeriesChart
                      points={ensembleView.bands.slice(0, 48).map((b) => ({
                        t: b.t,
                        raw: b.mean,
                        twin: b.min,
                        ml: b.max,
                        corrected: null,
                        neighbours: null,
                        flag: null,
                      }))}
                      sensorType="temperature"
                      settings={settings}
                      traces={[
                        { key: 'raw', label: 'Ensemble mean', color: 'var(--color-event)', width: 1.6 },
                        { key: 'twin', label: 'Coolest member', color: 'var(--color-ink-3)', dashed: true },
                        { key: 'ml', label: 'Warmest member', color: 'var(--color-ink-3)', dashed: true },
                      ]}
                      height={120}
                    />
                  </div>
                  {ensembleView.bands[0] && (
                    <p className="border-t border-line px-3 py-2 text-[11px] leading-relaxed text-ink-3">
                      Next hour expected{' '}
                      <span className="tnum text-ink-2">{ensembleView.bands[0].mean} °C</span>, likely
                      range{' '}
                      <span className="tnum text-ink-2">
                        {ensembleView.bands[0].min}–{ensembleView.bands[0].max} °C
                      </span>
                      . A wide spread means the model itself is uncertain, which is taken into
                      account before a departure from it is treated as evidence.
                    </p>
                  )}
                </>
              ) : (
                <EmptyState
                  title={
                    ensembleView.status === 'loading'
                      ? 'Loading ensemble members…'
                      : 'Ensemble forecast unavailable'
                  }
                  detail="Forecast uncertainty is shown when the ensemble endpoint responds. It is never fabricated."
                />
              )}
            </Panel>
          </div>
        </div>

        <Panel
          eyebrow="Selected station"
          title={`Temperature through the event · ${snapshot.station.id}`}
        >
          <div className="p-2">
            {channel && (
              <TimeSeriesChart
                points={channel.points}
                spans={channel.spans}
                gaps={channel.gaps}
                sensorType="temperature"
                settings={settings}
                height={190}
              />
            )}
          </div>
        </Panel>
      </PageBody>
    </>
  );
}
