'use client';

import Link from 'next/link';
import { formatDistanceToNowStrict } from 'date-fns';
import { useSkyGuard } from '@/store/useSkyGuard';
import type { World } from '@/lib/world';
import { formatSensorValue, healthColor, STATUS_META } from '@/lib/units';
import { StatusDot } from '@/components/ui/primitives';
import { cn } from '@/lib/utils';
import { qcValue } from '@/lib/world';

/**
 * The network status table.
 *
 * One row per station, every column a live value. It reads through the active
 * RAW / QUALITY-CONTROLLED lens, so switching the global toggle visibly changes
 * the numbers here — which is the fastest way to see what SkyGuard changed.
 */
export function StationTable({ world }: { world: World }) {
  const settings = useSkyGuard((s) => s.settings);
  const cleaned = useSkyGuard((s) => s.cleaned);
  const selected = useSkyGuard((s) => s.selectedStationId);
  const selectStation = useSkyGuard((s) => s.selectStation);

  const cell = (v: number | null | undefined, type: Parameters<typeof formatSensorValue>[0]) => {
    const f = formatSensorValue(type, v, settings);
    return (
      <span className="tnum">
        {f.value}
        <span className="ml-0.5 text-[9.5px] text-ink-3">{f.suffix}</span>
      </span>
    );
  };

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[980px] border-collapse text-[11.5px]">
        <caption className="sr-only">
          Live status for every station in the network
        </caption>
        <thead>
          <tr className="border-b border-line text-left">
            {['Station', 'Location', 'Status', 'Temp', 'RH', 'Pressure', 'Wind', 'Rain', 'Battery', 'Signal', 'Health', 'Last packet', 'Findings'].map(
              (h) => (
                <th
                  key={h}
                  scope="col"
                  className="eyebrow px-2.5 py-1.5 font-semibold whitespace-nowrap"
                >
                  {h}
                </th>
              ),
            )}
          </tr>
        </thead>
        <tbody>
          {world.snapshots.map((s) => {
            const active = s.anomalies.filter((a) => a.endedAt === null);
            const critical = active.filter((a) => a.severity === 'critical').length;
            const isSelected = s.station.id === selected;
            const offline = s.status === 'offline';

            return (
              <tr
                key={s.station.id}
                onClick={() => selectStation(s.station.id)}
                className={cn(
                  'cursor-pointer border-b border-line/60 transition-colors',
                  isSelected ? 'bg-raised' : 'hover:bg-hover',
                )}
              >
                <td className="px-2.5 py-1.5 whitespace-nowrap">
                  <Link
                    href={`/stations/${s.station.id}`}
                    className="tnum font-medium text-ink hover:underline"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {s.station.id}
                  </Link>
                </td>
                <td className="max-w-[190px] px-2.5 py-1.5">
                  <div className="truncate text-ink-2">{s.station.name}</div>
                  <div className="tnum truncate text-[9.5px] text-ink-3">
                    {s.station.region} · {s.station.elevation} m
                  </div>
                </td>
                <td className="px-2.5 py-1.5 whitespace-nowrap">
                  <span className="inline-flex items-center gap-1.5">
                    <StatusDot status={s.status} pulse={s.status === 'critical' || s.status === 'failed'} />
                    <span style={{ color: STATUS_META[s.status].color }}>
                      {STATUS_META[s.status].label}
                    </span>
                  </span>
                </td>
                <td className="px-2.5 py-1.5 whitespace-nowrap">
                  {offline ? <span className="text-ink-3">—</span> : cell(qcValue(s.qc, 'temperature', cleaned), 'temperature')}
                </td>
                <td className="px-2.5 py-1.5 whitespace-nowrap">
                  {offline ? <span className="text-ink-3">—</span> : cell(qcValue(s.qc, 'humidity', cleaned), 'humidity')}
                </td>
                <td className="px-2.5 py-1.5 whitespace-nowrap">
                  {offline ? <span className="text-ink-3">—</span> : cell(qcValue(s.qc, 'pressure', cleaned), 'pressure')}
                </td>
                <td className="px-2.5 py-1.5 whitespace-nowrap">
                  {offline ? <span className="text-ink-3">—</span> : cell(qcValue(s.qc, 'wind_speed', cleaned), 'wind_speed')}
                </td>
                <td className="px-2.5 py-1.5 whitespace-nowrap">
                  {offline ? <span className="text-ink-3">—</span> : cell(s.latest.rainfall, 'rainfall')}
                </td>
                <td className="px-2.5 py-1.5 whitespace-nowrap">
                  <span
                    style={{
                      color:
                        (s.latest.battery ?? 12.5) < 11.4
                          ? 'var(--color-failed)'
                          : (s.latest.battery ?? 12.5) < 12
                            ? 'var(--color-warning)'
                            : undefined,
                    }}
                  >
                    {cell(s.latest.battery, 'battery')}
                  </span>
                </td>
                <td className="px-2.5 py-1.5 whitespace-nowrap">
                  {cell(s.latest.signal, 'comms')}
                </td>
                <td className="px-2.5 py-1.5 whitespace-nowrap">
                  <span className="flex items-center gap-1.5">
                    <span
                      className="tnum w-6 text-right"
                      style={{ color: healthColor(s.healthScore) }}
                    >
                      {s.healthScore}
                    </span>
                    <span className="h-1 w-10 overflow-hidden rounded-full bg-line">
                      <span
                        className="block h-full rounded-full"
                        style={{
                          width: `${s.healthScore}%`,
                          background: healthColor(s.healthScore),
                        }}
                      />
                    </span>
                  </span>
                </td>
                <td className="tnum px-2.5 py-1.5 whitespace-nowrap text-ink-3">
                  {formatDistanceToNowStrict(s.lastPacketAt, { addSuffix: false })} ago
                </td>
                <td className="px-2.5 py-1.5 whitespace-nowrap">
                  {active.length === 0 ? (
                    <span className="text-ink-3">—</span>
                  ) : (
                    <span className="flex items-center gap-1">
                      <span className="tnum text-ink-2">{active.length}</span>
                      {critical > 0 && (
                        <span className="tnum rounded-[2px] bg-failed/16 px-1 text-[9.5px] text-failed">
                          {critical} critical
                        </span>
                      )}
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
