'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useResolvedWorld } from '@/hooks/useWorld';
import { PageBody, PageHeader } from '@/components/ui/PageHeader';
import { Panel, SegmentedControl, SourceBadge, StatTile } from '@/components/ui/primitives';
import { SENSOR_LABELS, SENSOR_ORDER, SENSOR_SHORT } from '@/lib/simulation/stations';
import { healthColor } from '@/lib/units';
import { bandLabel, HEALTH_BANDS } from '@/lib/health/score';
import { cn } from '@/lib/utils';
import type { SensorHealth } from '@/types';

/**
 * Sensor-health matrix.
 *
 * Stations down the side, channels across the top. The whole network's
 * condition in one glance, and every cell is a link into that sensor's own
 * page — colour plus the number, never colour alone.
 */
export default function HealthPage() {
  const world = useResolvedWorld();
  const router = useRouter();
  const [sort, setSort] = useState<'station' | 'worst'>('worst');

  const rows = useMemo(() => {
    if (!world) return [];
    const list = world.snapshots.map((s) => ({
      snapshot: s,
      health: world.healthByStation.get(s.station.id) ?? [],
    }));
    return sort === 'worst'
      ? list.sort((a, b) => a.snapshot.healthScore - b.snapshot.healthScore)
      : list.sort((a, b) => a.snapshot.station.id.localeCompare(b.snapshot.station.id));
  }, [world, sort]);

  if (!world) return null;

  const all = [...world.healthByStation.values()].flat();
  const bandCounts = HEALTH_BANDS.map((b) => ({
    ...b,
    count: all.filter((h) => h.band === b.band).length,
  }));

  const worstSensors = [...all].sort((a, b) => a.score - b.score).slice(0, 6);

  return (
    <>
      <PageHeader
        title="Sensor health"
        subtitle={`${all.length} channels across ${world.stations.length} stations · scored from anomaly frequency, calibration age, drift against peers, noise, missing packets and corrections applied`}
        actions={
          <>
            <SourceBadge source="MODELLED" />
            <SegmentedControl
              ariaLabel="Sort"
              size="sm"
              value={sort}
              onChange={setSort}
              options={[
                { value: 'worst', label: 'Worst first' },
                { value: 'station', label: 'By station' },
              ]}
            />
          </>
        }
      />

      <PageBody className="flex flex-col gap-3">
        <section className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
          {bandCounts.map((b) => (
            <StatTile
              key={b.band}
              label={b.label}
              value={b.count}
              hint={`score ${b.min}–${b.max}`}
            >
              <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-line">
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${(b.count / Math.max(all.length, 1)) * 100}%`,
                    background: healthColor(b.min + 5),
                  }}
                />
              </div>
            </StatTile>
          ))}
        </section>

        <Panel eyebrow="Matrix" title="Stations against channels">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] border-collapse text-[11.5px]">
              <caption className="sr-only">
                Health score from 0 to 100 for every sensor channel at every station
              </caption>
              <thead>
                <tr className="border-b border-line">
                  <th scope="col" className="eyebrow px-2.5 py-1.5 text-left font-semibold">
                    Station
                  </th>
                  {SENSOR_ORDER.map((s) => (
                    <th
                      key={s}
                      scope="col"
                      className="eyebrow px-2 py-1.5 text-center font-semibold"
                      title={SENSOR_LABELS[s]}
                    >
                      {SENSOR_SHORT[s]}
                    </th>
                  ))}
                  <th scope="col" className="eyebrow px-2.5 py-1.5 text-right font-semibold">
                    Station
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ snapshot, health }) => (
                  <tr key={snapshot.station.id} className="border-b border-line/60">
                    <th scope="row" className="px-2.5 py-1 text-left font-normal">
                      <Link
                        href={`/stations/${snapshot.station.id}`}
                        className="tnum text-ink hover:underline"
                      >
                        {snapshot.station.id}
                      </Link>
                      <span className="ml-1.5 text-[10px] text-ink-3">
                        {snapshot.station.name}
                      </span>
                    </th>
                    {SENSOR_ORDER.map((type) => {
                      const h = health.find((x) => x.type === type);
                      if (!h) return <td key={type} className="px-2 py-1" />;
                      return (
                        <td key={type} className="px-1 py-1 text-center">
                          <button
                            type="button"
                            onClick={() => router.push(`/health/${h.sensorId}`)}
                            title={`${SENSOR_LABELS[type]} — ${bandLabel(h.band)} (${h.score}/100). ${h.recommendation}`}
                            className={cn(
                              'tnum w-full rounded-[2px] px-1.5 py-1 font-medium transition-transform hover:scale-[1.06]',
                            )}
                            style={{
                              color: healthColor(h.score),
                              background: `color-mix(in srgb, ${healthColor(h.score)} 13%, transparent)`,
                            }}
                          >
                            {h.score}
                          </button>
                        </td>
                      );
                    })}
                    <td className="px-2.5 py-1 text-right">
                      <span
                        className="tnum font-medium"
                        style={{ color: healthColor(snapshot.healthScore) }}
                      >
                        {snapshot.healthScore}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap items-center gap-3 border-t border-line px-3 py-2">
            {HEALTH_BANDS.map((b) => (
              <span key={b.band} className="flex items-center gap-1.5 text-[10px] text-ink-3">
                <span
                  className="h-2 w-3 rounded-[1px]"
                  style={{ background: healthColor(b.min + 5) }}
                  aria-hidden
                />
                {b.label} ({b.min}+)
              </span>
            ))}
          </div>
        </Panel>

        <Panel eyebrow="Priority" title="Channels needing attention">
          <ul className="divide-y divide-line">
            {worstSensors.map((h) => (
              <li key={h.sensorId}>
                <Link
                  href={`/health/${h.sensorId}`}
                  className="flex flex-wrap items-center gap-3 px-3 py-2 transition-colors hover:bg-hover"
                >
                  <span
                    className="tnum w-9 shrink-0 text-[15px] font-medium"
                    style={{ color: healthColor(h.score) }}
                  >
                    {h.score}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[12px] text-ink">
                      <span className="tnum">{h.stationId}</span> · {SENSOR_LABELS[h.type]}
                    </span>
                    <span className="block text-[11px] text-ink-3">{h.recommendation}</span>
                  </span>
                  <SensorFacts health={h} />
                </Link>
              </li>
            ))}
          </ul>
        </Panel>
      </PageBody>
    </>
  );
}

/** Calibration age is only meaningful for instruments that get calibrated. */
const CALIBRATED = new Set(['temperature', 'humidity', 'pressure', 'wind_speed', 'rainfall']);

function SensorFacts({ health }: { health: SensorHealth }) {
  return (
    <span className="tnum flex shrink-0 flex-wrap gap-x-4 gap-y-0.5 text-[10.5px] text-ink-3">
      {CALIBRATED.has(health.type) && <span>calib {health.calibrationAgeDays} d</span>}
      <span>
        offset {health.drift > 0 ? '+' : ''}
        {health.drift} {health.driftUnit}
      </span>
      <span>anoms {health.anomalyCount}</span>
      <span className={health.failureRisk30d > 60 ? 'text-critical' : undefined}>
        risk {health.failureRisk30d}%
      </span>
    </span>
  );
}
