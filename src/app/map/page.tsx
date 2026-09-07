'use client';

import dynamic from 'next/dynamic';
import { useMemo, useState } from 'react';
import { format } from 'date-fns';
import {
  ChevronLeft,
  ChevronRight,
  CloudRain,
  Layers,
  Pause,
  Play,
  Thermometer,
  Wind,
} from 'lucide-react';
import { useResolvedWorld } from '@/hooks/useWorld';
import { useSkyGuard } from '@/store/useSkyGuard';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button, SegmentedControl } from '@/components/ui/primitives';
import { StationPanel } from '@/components/map/StationPanel';
import type { MapLayer } from '@/components/map/NetworkMap';
import { STATUS_META } from '@/lib/units';
import { cn } from '@/lib/utils';
import { useRadarPlayback } from '@/hooks/useRadarPlayback';

// Leaflet touches `window` at import time, so the map only ever loads in the
// browser. The placeholder keeps the layout stable while it arrives.
const NetworkMap = dynamic(
  () => import('@/components/map/NetworkMap').then((m) => m.NetworkMap),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full items-center justify-center bg-[#0c1218] text-[12px] text-ink-3">
        Loading map…
      </div>
    ),
  },
);

const LAYER_OPTIONS: { id: MapLayer; label: string; icon?: typeof Layers }[] = [
  { id: 'radar', label: 'Radar', icon: CloudRain },
  { id: 'incidents', label: 'Incidents' },
  { id: 'clusters', label: 'Anomaly clusters' },
  { id: 'temperature', label: 'Temperature', icon: Thermometer },
  { id: 'wind', label: 'Wind', icon: Wind },
  { id: 'precipitation', label: 'Precipitation' },
];

export default function MapPage() {
  const world = useResolvedWorld();
  const radar = useSkyGuard((s) => s.radar);
  const radarMessage = useSkyGuard((s) => s.radarMessage);
  const selectedStationId = useSkyGuard((s) => s.selectedStationId);
  const selectStation = useSkyGuard((s) => s.selectStation);

  const [layers, setLayers] = useState<Set<MapLayer>>(
    () => new Set<MapLayer>(['radar', 'incidents']),
  );
  const [panelOpen, setPanelOpen] = useState(true);
  const [incidentId, setIncidentId] = useState<string>('');

  const frames = useMemo(
    () => (radar ? [...radar.past, ...radar.nowcast] : []),
    [radar],
  );
  const playback = useRadarPlayback(frames.length);

  const snapshot = world?.snapshotById.get(selectedStationId) ?? null;
  const metIncidents = world?.incidents.filter(
    (i) => i.classification === 'meteorological_event' && i.stationIds.length > 1,
  ) ?? [];
  const selectedIncident =
    metIncidents.find((i) => i.id === incidentId) ?? metIncidents[0] ?? null;

  const toggleLayer = (id: MapLayer) => {
    setLayers((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (!world) return null;

  const counts = world.snapshots.reduce<Record<string, number>>((acc, s) => {
    acc[s.status] = (acc[s.status] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Network map"
        subtitle={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {Object.entries(STATUS_META).map(([key, meta]) => (
              <span key={key} className="flex items-center gap-1">
                <span
                  className="h-1.5 w-1.5 rounded-full"
                  style={{ background: meta.color }}
                  aria-hidden
                />
                <span className="tnum">{counts[key] ?? 0}</span> {meta.label}
              </span>
            ))}
          </span>
        }
        actions={
          <>
            {metIncidents.length > 0 && (
              <label>
                <span className="sr-only">Incident to trace</span>
                <select
                  value={selectedIncident?.id ?? ''}
                  onChange={(e) => setIncidentId(e.target.value)}
                  className="rounded-[3px] border border-line bg-raised px-2 py-1 text-[11px] text-ink"
                >
                  {metIncidents.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.id} · {i.title}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <Button size="sm" onClick={() => setPanelOpen((p) => !p)}>
              {panelOpen ? 'Hide' : 'Show'} station panel
            </Button>
          </>
        }
      />

      <div className="flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1">
          <NetworkMap
            world={world}
            layers={layers}
            radarFrameIndex={playback.index}
            selectedIncident={layers.has('incidents') ? selectedIncident : null}
            focusStationId={selectedStationId}
            onSelectStation={(id) => {
              selectStation(id);
              setPanelOpen(true);
            }}
            className="absolute inset-0"
          />

          {/* Layer switcher */}
          <div className="panel absolute top-2 left-2 z-[500] w-[186px] overflow-hidden">
            <div className="panel-header">
              <span className="eyebrow flex items-center gap-1.5">
                <Layers size={11} aria-hidden /> Layers
              </span>
            </div>
            <ul className="p-1">
              {LAYER_OPTIONS.map((opt) => {
                const disabled = opt.id === 'radar' && !radar;
                const Icon = opt.icon;
                return (
                  <li key={opt.id}>
                    <label
                      className={cn(
                        'flex cursor-pointer items-center gap-2 rounded-[2px] px-1.5 py-1 text-[11.5px] transition-colors',
                        disabled ? 'cursor-not-allowed text-ink-3 opacity-55' : 'text-ink-2 hover:bg-hover',
                      )}
                    >
                      <input
                        type="checkbox"
                        checked={layers.has(opt.id) && !disabled}
                        disabled={disabled}
                        onChange={() => toggleLayer(opt.id)}
                        className="h-3 w-3 accent-[var(--color-event)]"
                      />
                      {Icon && <Icon size={11} className="shrink-0" aria-hidden />}
                      <span className="min-w-0 flex-1 truncate">{opt.label}</span>
                    </label>
                  </li>
                );
              })}
            </ul>
            {!radar && (
              <p className="border-t border-line px-2 py-1.5 text-[10px] leading-snug text-warning">
                Radar unavailable. {radarMessage ?? 'The provider did not return frames.'}
              </p>
            )}
          </div>

          {/* Radar playback */}
          {layers.has('radar') && frames.length > 1 && (
            <div className="panel absolute right-2 bottom-2 left-2 z-[500] mx-auto max-w-[620px]">
              <div className="flex items-center gap-2 px-2.5 py-1.5">
                <Button size="sm" variant="ghost" onClick={playback.prev} title="Previous frame">
                  <ChevronLeft size={13} aria-hidden />
                  <span className="sr-only">Previous frame</span>
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={playback.toggle}
                  title={playback.playing ? 'Pause' : 'Play'}
                >
                  {playback.playing ? <Pause size={13} aria-hidden /> : <Play size={13} aria-hidden />}
                  <span className="sr-only">{playback.playing ? 'Pause radar' : 'Play radar'}</span>
                </Button>
                <Button size="sm" variant="ghost" onClick={playback.next} title="Next frame">
                  <ChevronRight size={13} aria-hidden />
                  <span className="sr-only">Next frame</span>
                </Button>

                <input
                  type="range"
                  min={0}
                  max={frames.length - 1}
                  value={playback.index}
                  onChange={(e) => playback.setIndex(Number(e.target.value))}
                  aria-label="Radar frame"
                  className="h-1 min-w-0 flex-1 accent-[var(--color-event)]"
                />

                <span className="tnum w-[46px] shrink-0 text-right text-[10.5px] text-ink-2">
                  {frames[playback.index] ? format(frames[playback.index].time, 'HH:mm') : '--:--'}
                </span>

                <SegmentedControl
                  ariaLabel="Playback speed"
                  size="sm"
                  value={String(playback.speed)}
                  onChange={(v) => playback.setSpeed(Number(v))}
                  options={[
                    { value: '0.5', label: '0.5×' },
                    { value: '1', label: '1×' },
                    { value: '2', label: '2×' },
                  ]}
                />
              </div>
            </div>
          )}
        </div>

        {panelOpen && snapshot && (
          <div className="hidden w-[330px] shrink-0 lg:block">
            <StationPanel snapshot={snapshot} world={world} onClose={() => setPanelOpen(false)} />
          </div>
        )}
      </div>
    </div>
  );
}
