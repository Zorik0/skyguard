'use client';

import { useEffect, useMemo, useRef } from 'react';
import {
  CircleMarker,
  MapContainer,
  Polyline,
  TileLayer,
  Tooltip,
  useMap,
} from 'react-leaflet';
import type { Map as LeafletMap } from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { format } from 'date-fns';
import type { Incident, StationSnapshot } from '@/types';
import type { World } from '@/lib/world';
import { NETWORK_CENTRE } from '@/lib/simulation/stations';
import { STATUS_META } from '@/lib/units';
import { radarTileUrl } from '@/lib/weather/rainviewer';
import { useSkyGuard } from '@/store/useSkyGuard';
import { formatSensorValue } from '@/lib/units';

/**
 * The network map.
 *
 * Markers are drawn as vector circles rather than image pins so status colour,
 * size and the pulse on a critical station are all driven directly by state —
 * no icon assets to keep in sync with the palette.
 */

/** Highest zoom RainViewer's public tile cache actually renders. */
const RADAR_MAX_NATIVE_ZOOM = 7;

export type MapLayer =
  | 'radar'
  | 'temperature'
  | 'precipitation'
  | 'wind'
  | 'incidents'
  | 'clusters';

function statusRadius(snapshot: StationSnapshot) {
  if (snapshot.status === 'critical' || snapshot.status === 'failed') return 10;
  if (snapshot.status === 'warning' || snapshot.status === 'event') return 8.5;
  return 7;
}

/** Keeps the map centred on a station when one is selected elsewhere. */
function Recenter({ target }: { target: [number, number] | null }) {
  const map = useMap();
  useEffect(() => {
    if (target) map.flyTo(target, Math.max(map.getZoom(), 8), { duration: 0.6 });
  }, [target, map]);
  return null;
}

export function NetworkMap({
  world,
  layers,
  radarFrameIndex,
  selectedIncident,
  focusStationId,
  onSelectStation,
  className,
}: {
  world: World;
  layers: Set<MapLayer>;
  radarFrameIndex: number;
  selectedIncident: Incident | null;
  focusStationId: string | null;
  onSelectStation: (id: string) => void;
  className?: string;
}) {
  const radar = useSkyGuard((s) => s.radar);
  const settings = useSkyGuard((s) => s.settings);
  const selectedStationId = useSkyGuard((s) => s.selectedStationId);
  const mapRef = useRef<LeafletMap | null>(null);

  const frames = useMemo(
    () => (radar ? [...radar.past, ...radar.nowcast] : []),
    [radar],
  );
  const frame = frames[Math.min(radarFrameIndex, frames.length - 1)];

  const focusTarget = useMemo<[number, number] | null>(() => {
    if (!focusStationId) return null;
    const s = world.snapshotById.get(focusStationId);
    return s ? [s.station.latitude, s.station.longitude] : null;
  }, [focusStationId, world]);

  // The geographic trail of a travelling event, drawn in arrival order.
  const propagationPath = useMemo<[number, number][]>(() => {
    if (!selectedIncident || !layers.has('incidents')) return [];
    return selectedIncident.propagation
      .map((p) => world.snapshotById.get(p.stationId))
      .filter((s): s is StationSnapshot => Boolean(s))
      .map((s) => [s.station.latitude, s.station.longitude] as [number, number]);
  }, [selectedIncident, world, layers]);

  return (
    <div className={className}>
      <MapContainer
        center={NETWORK_CENTRE}
        zoom={7}
        minZoom={5}
        maxZoom={12}
        scrollWheelZoom
        className="h-full w-full"
        ref={mapRef}
        attributionControl
      >
        {/* Esri's dark canvas is a genuinely dark basemap that needs no API
            key, which keeps this project runnable straight after a clone. The
            labels ship as a separate reference layer drawn above the terrain. */}
        <TileLayer
          url="https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}"
          attribution='Basemap &copy; <a href="https://www.esri.com/">Esri</a>, HERE, Garmin, &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          maxZoom={16}
        />
        <TileLayer
          url="https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}"
          maxZoom={16}
          zIndex={350}
        />

        {/* Radar is drawn only when the provider actually returned frames — it
            is never faked when the service is down.

            RainViewer's public tile cache only renders up to zoom 7; above
            that it serves a "zoom level not supported" placeholder, which
            would paint grey boxes across the map. `maxNativeZoom` stops Leaflet
            requesting those and upscales the zoom-7 tile instead. */}
        {layers.has('radar') && radar && frame && (
          <TileLayer
            key={frame.path}
            url={radarTileUrl(radar.host, frame.path)}
            opacity={0.55}
            attribution='Radar &copy; <a href="https://www.rainviewer.com/">RainViewer</a>'
            zIndex={400}
            maxNativeZoom={RADAR_MAX_NATIVE_ZOOM}
            maxZoom={16}
          />
        )}

        {propagationPath.length > 1 && (
          <Polyline
            positions={propagationPath}
            pathOptions={{
              color: 'var(--color-event)',
              weight: 2,
              opacity: 0.75,
              dashArray: '5 6',
            }}
          />
        )}

        {world.snapshots.map((snapshot) => {
          const meta = STATUS_META[snapshot.status];
          const isSelected = snapshot.station.id === selectedStationId;
          const inIncident =
            selectedIncident?.stationIds.includes(snapshot.station.id) ?? false;
          const activeCount = snapshot.anomalies.filter((a) => a.endedAt === null).length;

          const temp = formatSensorValue('temperature', snapshot.latest.temperature, settings);
          const rain = snapshot.latest.rainfall ?? 0;
          const wind = formatSensorValue('wind_speed', snapshot.latest.windSpeed, settings);

          return (
            <CircleMarker
              key={snapshot.station.id}
              center={[snapshot.station.latitude, snapshot.station.longitude]}
              radius={statusRadius(snapshot) + (isSelected ? 3 : 0)}
              pathOptions={{
                color: isSelected ? '#ffffff' : meta.color,
                weight: isSelected ? 2 : inIncident ? 2 : 1.25,
                fillColor: meta.color,
                fillOpacity: 0.62,
                opacity: 1,
              }}
              eventHandlers={{ click: () => onSelectStation(snapshot.station.id) }}
            >
              <Tooltip direction="top" offset={[0, -6]} opacity={1}>
                <div className="min-w-[150px]">
                  <div className="text-[11px] font-semibold">
                    {snapshot.station.id} · {snapshot.station.name}
                  </div>
                  <div className="text-[10px]" style={{ color: meta.color }}>
                    {meta.label} · health {snapshot.healthScore}/100
                  </div>
                  <div className="mt-1 text-[10px]">
                    {temp.value}
                    {temp.suffix} · {snapshot.latest.humidity ?? '—'}% ·{' '}
                    {wind.value}
                    {wind.suffix}
                  </div>
                  {activeCount > 0 && (
                    <div className="mt-0.5 text-[10px]">
                      {activeCount} active finding{activeCount === 1 ? '' : 's'}
                    </div>
                  )}
                </div>
              </Tooltip>

              {/* Value labels for the data layers. Rendered as permanent
                  tooltips so the numbers stay legible at any zoom. */}
              {layers.has('temperature') && (
                <Tooltip permanent direction="right" offset={[8, 0]} className="skyguard-value">
                  <span className="text-[10px]">
                    {temp.value}
                    {temp.suffix}
                  </span>
                </Tooltip>
              )}
              {layers.has('wind') && !layers.has('temperature') && (
                <Tooltip permanent direction="right" offset={[8, 0]} className="skyguard-value">
                  <span className="text-[10px]">
                    {wind.value}
                    {wind.suffix}
                  </span>
                </Tooltip>
              )}
              {layers.has('precipitation') && !layers.has('temperature') && !layers.has('wind') && (
                <Tooltip permanent direction="right" offset={[8, 0]} className="skyguard-value">
                  <span className="text-[10px]">{rain.toFixed(2)} mm</span>
                </Tooltip>
              )}
            </CircleMarker>
          );
        })}

        {/* Anomaly clusters: a halo whose size tracks how many findings are
            open at that station. */}
        {layers.has('clusters') &&
          world.snapshots.map((snapshot) => {
            const active = snapshot.anomalies.filter((a) => a.endedAt === null).length;
            if (active === 0) return null;
            return (
              <CircleMarker
                key={`cluster-${snapshot.station.id}`}
                center={[snapshot.station.latitude, snapshot.station.longitude]}
                radius={12 + active * 3.5}
                interactive={false}
                pathOptions={{
                  color: STATUS_META[snapshot.status].color,
                  weight: 1,
                  opacity: 0.35,
                  fillColor: STATUS_META[snapshot.status].color,
                  fillOpacity: 0.09,
                }}
              />
            );
          })}

        <Recenter target={focusTarget} />
      </MapContainer>

      {layers.has('radar') && frame && (
        <div className="pointer-events-none absolute bottom-6 left-2 z-[500] rounded-[3px] border border-line bg-panel/90 px-2 py-1">
          <span className="tnum text-[10px] text-ink-2">
            Radar {format(frame.time, 'HH:mm')}
          </span>
        </div>
      )}
    </div>
  );
}
