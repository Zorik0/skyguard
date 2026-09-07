'use client';

import { useMemo } from 'react';
import { ArrowDown, ArrowRight, ArrowUp } from 'lucide-react';
import type { SensorType, StationSnapshot } from '@/types';
import type { World } from '@/lib/world';
import { qcValue } from '@/lib/world';
import { useSkyGuard } from '@/store/useSkyGuard';
import { buildSparkline, channelDelta } from '@/lib/analysisSeries';
import { formatDelta, formatSensorValue, healthColor } from '@/lib/units';
import { Sparkline } from '@/components/charts/Sparkline';
import { SourceBadge } from '@/components/ui/primitives';
import { compassPoint, HOUR } from '@/lib/utils';
import { SENSOR_LABELS } from '@/lib/simulation/stations';

/**
 * The selected station's current conditions.
 *
 * Each metric shows its latest value, the change over the window, a sparkline,
 * a quality indicator and — critically — whether the number on screen is the
 * raw measurement or a corrected estimate.
 */

interface MetricSpec {
  key: string;
  label: string;
  sensorType: SensorType | null;
  value: number | null;
  /** Derived channels have no sparkline of their own. */
  sparkType?: SensorType;
  extra?: string;
}

export function StationMetrics({
  world,
  snapshot,
  windowMs = 3 * HOUR,
}: {
  world: World;
  snapshot: StationSnapshot;
  windowMs?: number;
}) {
  const settings = useSkyGuard((s) => s.settings);
  const cleaned = useSkyGuard((s) => s.cleaned);

  const metrics = useMemo<MetricSpec[]>(() => {
    const q = snapshot.qc;
    return [
      { key: 'temperature', label: 'Temperature', sensorType: 'temperature', value: qcValue(q, 'temperature', cleaned), sparkType: 'temperature' },
      { key: 'humidity', label: 'Humidity', sensorType: 'humidity', value: qcValue(q, 'humidity', cleaned), sparkType: 'humidity' },
      { key: 'pressure', label: 'Pressure', sensorType: 'pressure', value: qcValue(q, 'pressure', cleaned), sparkType: 'pressure' },
      { key: 'dewPoint', label: 'Dew point', sensorType: 'temperature', value: q.dewPoint, sparkType: 'temperature' },
      { key: 'rainfall', label: 'Rainfall', sensorType: 'rainfall', value: q.rainfall, sparkType: 'rainfall' },
      { key: 'wind_speed', label: 'Wind speed', sensorType: 'wind_speed', value: qcValue(q, 'wind_speed', cleaned), sparkType: 'wind_speed' },
      {
        key: 'wind_direction',
        label: 'Wind direction',
        sensorType: 'wind_direction',
        value: q.windDirection,
        extra: q.windDirection !== null ? compassPoint(q.windDirection) : undefined,
      },
      { key: 'battery', label: 'Battery', sensorType: 'battery', value: q.battery, sparkType: 'battery' },
      { key: 'comms', label: 'Signal', sensorType: 'comms', value: q.signal, sparkType: 'comms' },
    ];
  }, [snapshot, cleaned]);

  const worstHealth = [...snapshot.sensorHealth].sort((a, b) => a.score - b.score)[0];

  return (
    <div className="grid grid-cols-2 gap-px bg-line sm:grid-cols-3 lg:grid-cols-5">
      {metrics.map((m) => {
        const spark = m.sparkType
          ? buildSparkline(world, snapshot.station.id, m.sparkType, windowMs)
          : [];
        const delta = m.sparkType
          ? channelDelta(world, snapshot.station.id, m.sparkType, windowMs)
          : null;
        const f = formatSensorValue(m.sensorType ?? 'temperature', m.value, settings);
        const flag = m.sensorType ? snapshot.qc.flags[m.sensorType] : undefined;
        const isCorrected =
          cleaned && m.sensorType && snapshot.qc.corrected[m.sensorType] !== undefined;

        const health = snapshot.sensorHealth.find((h) => h.type === m.sensorType);
        const trendIcon =
          delta === null || Math.abs(delta) < 1e-6 ? ArrowRight : delta > 0 ? ArrowUp : ArrowDown;
        const TrendIcon = trendIcon;

        return (
          <div key={m.key} className="min-w-0 bg-panel px-3 py-2">
            <div className="flex items-center justify-between gap-1">
              <span className="eyebrow truncate">{m.label}</span>
              {isCorrected ? (
                <SourceBadge source="CORRECTED" compact />
              ) : flag === 'suspect' ? (
                <span
                  className="text-[8.5px] font-semibold tracking-wider text-warning uppercase"
                  title="Flagged as suspect; no correction has been published"
                >
                  suspect
                </span>
              ) : flag === 'missing' ? (
                <span className="text-[8.5px] font-semibold tracking-wider text-offline uppercase">
                  missing
                </span>
              ) : (
                <SourceBadge source="SIMULATED" compact />
              )}
            </div>

            <div className="mt-1 flex items-baseline gap-1">
              <span
                className="tnum text-[19px] leading-none font-medium"
                style={{ color: isCorrected ? 'var(--color-warning)' : undefined }}
              >
                {f.value}
              </span>
              <span className="text-[10px] text-ink-3">{f.suffix}</span>
              {m.extra && <span className="text-[10px] text-ink-3">· {m.extra}</span>}
            </div>

            <div className="mt-1.5 flex items-end justify-between gap-2">
              <div className="min-w-0">
                {delta !== null && m.sparkType && (
                  <span className="tnum flex items-center gap-0.5 text-[10px] text-ink-3">
                    <TrendIcon size={9} aria-hidden />
                    {formatDelta(m.sparkType, delta, settings)}
                  </span>
                )}
                {health && (
                  <span
                    className="tnum mt-0.5 block text-[9.5px]"
                    style={{ color: healthColor(health.score) }}
                    title={`${SENSOR_LABELS[health.type]} health`}
                  >
                    health {health.score}
                  </span>
                )}
              </div>
              {spark.length > 1 && (
                <Sparkline
                  values={spark}
                  width={62}
                  height={20}
                  color={
                    isCorrected
                      ? 'var(--color-warning)'
                      : health
                        ? healthColor(health.score)
                        : 'var(--color-ink-2)'
                  }
                  ariaLabel={`${m.label} over the last ${Math.round(windowMs / HOUR)} hours`}
                />
              )}
            </div>
          </div>
        );
      })}

      <div className="min-w-0 bg-panel px-3 py-2">
        <div className="flex items-center justify-between gap-1">
          <span className="eyebrow truncate">Sensor health</span>
          <SourceBadge source="MODELLED" compact />
        </div>
        <div className="mt-1 flex items-baseline gap-1">
          <span
            className="tnum text-[19px] leading-none font-medium"
            style={{ color: healthColor(snapshot.healthScore) }}
          >
            {snapshot.healthScore}
          </span>
          <span className="text-[10px] text-ink-3">/100</span>
        </div>
        <div className="mt-1.5 truncate text-[9.5px] text-ink-3">
          weakest: {SENSOR_LABELS[worstHealth.type]} {worstHealth.score}
        </div>
      </div>
    </div>
  );
}
