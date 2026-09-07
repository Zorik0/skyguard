'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { format } from 'date-fns';
import { BellOff, Check, Eye, Layers } from 'lucide-react';
import { useResolvedWorld } from '@/hooks/useWorld';
import { useSkyGuard } from '@/store/useSkyGuard';
import { PageBody, PageHeader } from '@/components/ui/PageHeader';
import {
  Button,
  EmptyState,
  Panel,
  SegmentedControl,
  SeverityChip,
  StatTile,
} from '@/components/ui/primitives';
import { SENSOR_LABELS } from '@/lib/simulation/stations';
import { SEVERITY_META } from '@/lib/units';
import type { Alert, Severity } from '@/types';

/**
 * Alerts.
 *
 * Grouped by incident by default. Twenty readings caused by one storm are one
 * card with twenty rows behind it, not twenty cards — flooding an operator is
 * the fastest way to make them stop reading alerts at all.
 */
export default function AlertsPage() {
  const world = useResolvedWorld();
  const setAlertState = useSkyGuard((s) => s.setAlertState);
  const [severity, setSeverity] = useState<Severity | 'all'>('all');
  const [grouped, setGrouped] = useState(true);
  const [showResolved, setShowResolved] = useState(false);

  const alerts = useMemo(() => {
    if (!world) return [];
    return world.alerts
      .filter((a) => severity === 'all' || a.severity === severity)
      .filter((a) => showResolved || a.state !== 'resolved');
  }, [world, severity, showResolved]);

  const groups = useMemo(() => {
    const map = new Map<string, Alert[]>();
    for (const a of alerts) {
      const key = a.incidentId ?? `ungrouped:${a.stationId}`;
      const list = map.get(key) ?? [];
      list.push(a);
      map.set(key, list);
    }
    return [...map.entries()].sort(
      (a, b) => Math.max(...b[1].map((x) => x.t)) - Math.max(...a[1].map((x) => x.t)),
    );
  }, [alerts]);

  if (!world) return null;

  const counts = {
    total: world.alerts.length,
    unacknowledged: world.alerts.filter((a) => a.state === 'new').length,
    critical: world.alerts.filter((a) => a.severity === 'critical' && a.state !== 'resolved').length,
    grouped: new Set(world.alerts.map((a) => a.incidentId ?? a.id)).size,
  };

  const act = (alert: Alert, state: Alert['state']) => setAlertState(alert.id, state);

  return (
    <>
      <PageHeader
        title="Alerts"
        subtitle="One alert per finding, collapsed under the incident that explains it."
        actions={
          <>
            <SegmentedControl
              ariaLabel="Severity"
              size="sm"
              value={severity}
              onChange={setSeverity}
              options={[
                { value: 'all', label: 'All' },
                { value: 'critical', label: 'Critical' },
                { value: 'high', label: 'High' },
                { value: 'warning', label: 'Warning' },
              ]}
            />
            <Button size="sm" onClick={() => setGrouped((g) => !g)}>
              <Layers size={11} aria-hidden />
              {grouped ? 'Ungroup' : 'Group by incident'}
            </Button>
            <Button size="sm" onClick={() => setShowResolved((s) => !s)}>
              {showResolved ? 'Hide resolved' : 'Show resolved'}
            </Button>
          </>
        }
      />

      <PageBody className="flex flex-col gap-3">
        <section className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <StatTile label="Alerts raised" value={counts.total} hint="last 24 hours" />
          <StatTile
            label="Unacknowledged"
            value={counts.unacknowledged}
            tone={counts.unacknowledged ? 'warning' : 'healthy'}
          />
          <StatTile
            label="Critical open"
            value={counts.critical}
            tone={counts.critical ? 'failed' : 'healthy'}
          />
          <StatTile
            label="After grouping"
            value={counts.grouped}
            tone="healthy"
            hint={`${counts.total} findings collapsed into ${counts.grouped} threads`}
          />
        </section>

        {alerts.length === 0 ? (
          <Panel>
            <EmptyState
              title="No alerts in this view"
              detail="Either nothing needs attention, or the filters are hiding it."
              icon={<BellOff size={20} aria-hidden />}
            />
          </Panel>
        ) : grouped ? (
          groups.map(([key, items]) => {
            const incident = world.incidents.find((i) => i.id === key);
            const worst = items.reduce(
              (w, a) => (SEVERITY_META[a.severity].rank < SEVERITY_META[w.severity].rank ? a : w),
              items[0],
            );
            return (
              <Panel
                key={key}
                eyebrow={incident ? incident.id : 'Ungrouped'}
                title={incident ? incident.title : `${items[0].stationId} findings`}
                actions={
                  <>
                    <SeverityChip severity={worst.severity} />
                    <span className="tnum text-[10.5px] text-ink-3">
                      {items.length} alert{items.length === 1 ? '' : 's'}
                    </span>
                    {incident && (
                      <Link
                        href={`/incidents/${incident.id}`}
                        className="text-[11px] text-event hover:underline"
                      >
                        Open incident
                      </Link>
                    )}
                  </>
                }
              >
                <AlertRows alerts={items} onAct={act} />
              </Panel>
            );
          })
        ) : (
          <Panel eyebrow="All" title={`${alerts.length} alerts`}>
            <AlertRows alerts={alerts} onAct={act} showIncident />
          </Panel>
        )}
      </PageBody>
    </>
  );
}

function AlertRows({
  alerts,
  onAct,
  showIncident = false,
}: {
  alerts: Alert[];
  onAct: (alert: Alert, state: Alert['state']) => void;
  showIncident?: boolean;
}) {
  return (
    <ul className="divide-y divide-line">
      {alerts.map((a) => (
        <li key={a.id} className="flex flex-wrap items-start gap-3 px-3 py-2">
          <span
            className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full"
            style={{ background: SEVERITY_META[a.severity].color }}
            aria-hidden
          />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="tnum text-[10.5px] text-ink-3">{a.id}</span>
              <Link href={`/stations/${a.stationId}`} className="tnum text-[11.5px] hover:underline">
                {a.stationId}
              </Link>
              <span className="text-[11px] text-ink-3">{SENSOR_LABELS[a.sensorType]}</span>
              <span
                className="rounded-[2px] px-1 text-[9px] font-semibold tracking-wider uppercase"
                style={{
                  color:
                    a.state === 'new' ? 'var(--color-failed)'
                    : a.state === 'acknowledged' ? 'var(--color-warning)'
                    : a.state === 'snoozed' ? 'var(--color-ink-3)'
                    : 'var(--color-healthy)',
                  background: 'color-mix(in srgb, currentColor 11%, transparent)',
                }}
              >
                {a.state}
              </span>
              {showIncident && a.incidentId && (
                <Link
                  href={`/incidents/${a.incidentId}`}
                  className="tnum text-[10px] text-event hover:underline"
                >
                  {a.incidentId}
                </Link>
              )}
            </div>
            <p className="mt-0.5 text-[11.5px] text-ink-2">{a.message}</p>
            <time className="tnum mt-0.5 block text-[10px] text-ink-3">
              {format(a.t, 'dd MMM HH:mm:ss')} · {a.confidence}% confidence
            </time>
          </div>

          <div className="flex shrink-0 flex-wrap gap-1">
            <Button size="sm" onClick={() => onAct(a, 'acknowledged')} disabled={a.state === 'acknowledged'}>
              <Check size={10} aria-hidden /> Acknowledge
            </Button>
            <Link
              href={`/anomalies/${a.anomalyId}`}
              className="inline-flex items-center gap-1.5 rounded-[3px] border border-line bg-raised px-2 py-1 text-[11px] text-ink-2 transition-colors hover:text-ink"
            >
              <Eye size={10} aria-hidden /> Investigate
            </Link>
            <Button size="sm" onClick={() => onAct(a, 'snoozed')} disabled={a.state === 'snoozed'}>
              Snooze
            </Button>
            <Button size="sm" variant="primary" onClick={() => onAct(a, 'resolved')} disabled={a.state === 'resolved'}>
              Resolve
            </Button>
          </div>
        </li>
      ))}
    </ul>
  );
}
