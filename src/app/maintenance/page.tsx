'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { format, formatDistanceToNowStrict } from 'date-fns';
import { useResolvedWorld } from '@/hooks/useWorld';
import { useSkyGuard } from '@/store/useSkyGuard';
import { PageBody, PageHeader } from '@/components/ui/PageHeader';
import {
  EmptyState,
  Panel,
  SegmentedControl,
  SeverityChip,
  SourceBadge,
  StatTile,
} from '@/components/ui/primitives';
import { SENSOR_LABELS } from '@/lib/simulation/stations';
import { healthColor } from '@/lib/units';
import type { MaintenanceStatus, Severity } from '@/types';

const STATUSES: MaintenanceStatus[] = [
  'open',
  'assigned',
  'scheduled',
  'in_progress',
  'completed',
];

const STATUS_LABEL: Record<MaintenanceStatus, string> = {
  open: 'Open',
  assigned: 'Assigned',
  scheduled: 'Scheduled',
  in_progress: 'In progress',
  completed: 'Completed',
};

/**
 * Maintenance centre.
 *
 * The queue is derived from sensor health, not maintained separately, so a
 * channel that recovers stops generating a task and a channel that degrades
 * raises one without anybody typing it in.
 */
export default function MaintenancePage() {
  const world = useResolvedWorld();
  const setStatus = useSkyGuard((s) => s.setMaintenanceStatus);
  const [priority, setPriority] = useState<Severity | 'all'>('all');
  const [status, setStatus_] = useState<MaintenanceStatus | 'open_all'>('open_all');

  const tasks = useMemo(() => {
    if (!world) return [];
    return world.maintenance
      .filter((t) => priority === 'all' || t.priority === priority)
      .filter((t) =>
        status === 'open_all' ? t.status !== 'completed' : t.status === status,
      );
  }, [world, priority, status]);

  if (!world) return null;

  const open = world.maintenance.filter((t) => t.status !== 'completed');
  const critical = open.filter((t) => t.priority === 'critical');
  const totalHours = open.reduce((a, t) => a + t.estimatedHours, 0);

  return (
    <>
      <PageHeader
        title="Maintenance"
        subtitle="Predictive queue derived from sensor-health scores. Priorities follow the health band; due dates follow the priority."
        actions={
          <>
            <SourceBadge source="ESTIMATED" />
            <SegmentedControl
              ariaLabel="Priority"
              size="sm"
              value={priority}
              onChange={setPriority}
              options={[
                { value: 'all', label: 'All' },
                { value: 'critical', label: 'Critical' },
                { value: 'high', label: 'High' },
                { value: 'warning', label: 'Medium' },
              ]}
            />
            <SegmentedControl
              ariaLabel="Status"
              size="sm"
              value={status}
              onChange={setStatus_}
              options={[
                { value: 'open_all', label: 'Not completed' },
                { value: 'open', label: 'Open' },
                { value: 'in_progress', label: 'In progress' },
                { value: 'completed', label: 'Completed' },
              ]}
            />
          </>
        }
      />

      <PageBody className="flex flex-col gap-3">
        <section className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <StatTile label="Open tasks" value={open.length} tone={open.length ? 'warning' : 'healthy'} />
          <StatTile
            label="Critical"
            value={critical.length}
            tone={critical.length ? 'failed' : 'healthy'}
            hint="replace or inspect within 48 h"
          />
          <StatTile
            label="Estimated effort"
            value={totalHours.toFixed(1)}
            suffix="h"
            hint="across all open tasks"
          />
          <StatTile
            label="Stations involved"
            value={new Set(open.map((t) => t.stationId)).size}
            hint={`of ${world.stations.length}`}
          />
        </section>

        <Panel eyebrow="Queue" title={`${tasks.length} task${tasks.length === 1 ? '' : 's'}`}>
          {tasks.length === 0 ? (
            <EmptyState
              title="Nothing in this view"
              detail="Change the filters, or enjoy a network where every channel is within specification."
            />
          ) : (
            <ul className="divide-y divide-line">
              {tasks.map((task) => {
                const health = world.healthByStation
                  .get(task.stationId)
                  ?.find((h) => h.sensorId === task.sensorId);
                return (
                  <li key={task.id} className="flex flex-wrap items-start gap-3 px-3 py-2.5">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="tnum text-[10.5px] text-ink-3">{task.id}</span>
                        <SeverityChip severity={task.priority} />
                        <Link
                          href={`/stations/${task.stationId}`}
                          className="tnum text-[12px] font-medium text-ink hover:underline"
                        >
                          {task.stationId}
                        </Link>
                        <span className="text-[12px] text-ink-2">
                          {task.sensorType ? SENSOR_LABELS[task.sensorType] : 'Station'}
                        </span>
                        {health && (
                          <Link
                            href={`/health/${health.sensorId}`}
                            className="tnum rounded-[2px] px-1 text-[10px]"
                            style={{
                              color: healthColor(health.score),
                              background: `color-mix(in srgb, ${healthColor(health.score)} 12%, transparent)`,
                            }}
                          >
                            health {health.score}
                          </Link>
                        )}
                      </div>
                      <p className="mt-1 text-[12px] leading-relaxed text-ink-2">{task.action}</p>
                      <p className="mt-0.5 text-[10.5px] text-ink-3">{task.reason}</p>
                    </div>

                    <div className="flex w-[230px] shrink-0 flex-col gap-1.5">
                      <label className="flex items-center gap-2">
                        <span className="sr-only">Status for {task.id}</span>
                        <select
                          value={task.status}
                          onChange={(e) => setStatus(task.id, e.target.value as MaintenanceStatus)}
                          className="w-full rounded-[3px] border border-line bg-raised px-2 py-1 text-[11px] text-ink"
                        >
                          {STATUSES.map((s) => (
                            <option key={s} value={s}>
                              {STATUS_LABEL[s]}
                            </option>
                          ))}
                        </select>
                      </label>
                      <div className="tnum flex flex-wrap justify-between gap-x-3 text-[10.5px] text-ink-3">
                        <span>{task.assignee ?? 'Unassigned'}</span>
                        <span
                          className={
                            task.dueAt < world.now ? 'text-critical' : undefined
                          }
                        >
                          due {formatDistanceToNowStrict(task.dueAt, { addSuffix: true })}
                        </span>
                      </div>
                      <div className="tnum text-[10px] text-ink-3">
                        {format(task.dueAt, 'dd MMM yyyy')} · {task.estimatedHours} h estimated
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>

        <Panel eyebrow="Method" title="How this queue is produced">
          <div className="grid gap-x-6 gap-y-2 p-3 text-[11.5px] leading-relaxed text-ink-3 sm:grid-cols-2">
            <p>
              Every channel is scored from anomaly frequency, calibration age, offset against
              neighbouring stations, short-term noise, missing packets and how often a correction
              was needed. Anything below the healthy band raises a task automatically, with the
              priority taken from the band and the recommended action from the dominant penalty.
            </p>
            <p>
              Failure risk is a deterministic estimate from the current score and its trend, not a
              trained model, and it is labelled as an estimate everywhere it appears. Assignments
              and technician names are simulated — this network is fictional, and nothing here
              dispatches a real engineer.
            </p>
          </div>
        </Panel>
      </PageBody>
    </>
  );
}
