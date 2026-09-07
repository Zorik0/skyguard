'use client';

import Link from 'next/link';
import { format } from 'date-fns';
import { ChevronRight } from 'lucide-react';
import type { Anomaly } from '@/types';
import { cn } from '@/lib/utils';
import { CLASSIFICATION_LABELS } from '@/lib/anomaly/classify';
import { SENSOR_LABELS } from '@/lib/simulation/stations';
import { formatSensorValue, SEVERITY_META } from '@/lib/units';
import { useSkyGuard } from '@/store/useSkyGuard';
import { EmptyState, SeverityChip } from '@/components/ui/primitives';

const CLASSIFICATION_COLOR: Record<string, string> = {
  sensor_fault: 'var(--color-critical)',
  meteorological_event: 'var(--color-event)',
  communications: 'var(--color-offline)',
  power: 'var(--color-warning)',
  indeterminate: 'var(--color-ink-3)',
};

/** Compact anomaly rows, used on the overview, station pages and search. */
export function AnomalyList({
  anomalies,
  emptyTitle = 'No anomalies',
  emptyDetail,
  showStation = true,
  limit,
  className,
}: {
  anomalies: Anomaly[];
  emptyTitle?: string;
  emptyDetail?: string;
  showStation?: boolean;
  limit?: number;
  className?: string;
}) {
  const settings = useSkyGuard((s) => s.settings);
  const items = limit ? anomalies.slice(0, limit) : anomalies;

  if (!items.length) {
    return <EmptyState title={emptyTitle} detail={emptyDetail} />;
  }

  return (
    <ul className={cn('divide-y divide-line', className)}>
      {items.map((a) => {
        const raw = a.rawValue !== null ? formatSensorValue(a.sensorType, a.rawValue, settings) : null;
        const corrected =
          a.correction && a.correction.confidence > 0
            ? formatSensorValue(a.sensorType, a.correction.correctedValue, settings)
            : null;

        return (
          <li key={a.id}>
            <Link
              href={`/anomalies/${a.id}`}
              className="group flex items-start gap-2.5 px-3 py-2 transition-colors hover:bg-hover"
            >
              <span
                className="mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ background: SEVERITY_META[a.severity].color }}
                aria-hidden
              />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="tnum text-[10.5px] text-ink-3">{a.id}</span>
                  <span className="truncate text-[12px] font-medium text-ink">{a.title}</span>
                  <SeverityChip severity={a.severity} />
                  {a.endedAt === null && (
                    <span className="rounded-[2px] bg-failed/12 px-1 text-[9px] font-semibold tracking-wider text-failed uppercase">
                      active
                    </span>
                  )}
                </div>

                <div className="mt-0.5 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[10.5px] text-ink-3">
                  <span style={{ color: CLASSIFICATION_COLOR[a.classification] }}>
                    {CLASSIFICATION_LABELS[a.classification]} · {a.confidence}%
                  </span>
                  {showStation && <span className="tnum">{a.stationId}</span>}
                  <span>{SENSOR_LABELS[a.sensorType]}</span>
                  <span className="tnum">score {a.score}</span>
                  <time className="tnum" dateTime={new Date(a.startedAt).toISOString()}>
                    {format(a.startedAt, 'dd MMM HH:mm')}
                  </time>
                </div>

                {raw && (
                  <div className="tnum mt-1 flex flex-wrap items-center gap-2 text-[10.5px]">
                    <span className="text-ink-2">
                      raw {raw.value}
                      <span className="text-ink-3">{raw.suffix}</span>
                    </span>
                    {corrected && (
                      <>
                        <ChevronRight size={9} className="text-ink-3" aria-hidden />
                        <span className="text-warning">
                          corrected {corrected.value}
                          <span className="opacity-70">{corrected.suffix}</span>
                        </span>
                        <span className="text-ink-3">
                          ±
                          {(
                            (a.correction!.interval[1] - a.correction!.interval[0]) / 2
                          ).toFixed(2)}
                        </span>
                      </>
                    )}
                  </div>
                )}
              </div>
              <ChevronRight
                size={13}
                className="mt-1 shrink-0 text-ink-3 transition-transform group-hover:translate-x-0.5"
                aria-hidden
              />
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
