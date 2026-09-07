'use client';

import Link from 'next/link';
import { format, formatDistanceToNowStrict } from 'date-fns';
import { Activity, ExternalLink, Wrench, X } from 'lucide-react';
import type { StationSnapshot } from '@/types';
import type { World } from '@/lib/world';
import { qcValue } from '@/lib/world';
import { useSkyGuard } from '@/store/useSkyGuard';
import { formatSensorValue, healthColor } from '@/lib/units';
import { SENSOR_LABELS } from '@/lib/simulation/stations';
import { Button, EmptyState, SourceBadge, StatusLabel } from '@/components/ui/primitives';
import { AnomalyList } from '@/components/anomalies/AnomalyList';

/** Side panel shown when a station is selected on the map. */
export function StationPanel({
  snapshot,
  world,
  onClose,
}: {
  snapshot: StationSnapshot;
  world: World;
  onClose: () => void;
}) {
  const settings = useSkyGuard((s) => s.settings);
  const cleaned = useSkyGuard((s) => s.cleaned);
  const incidents = world.incidents.filter((i) =>
    i.stationIds.includes(snapshot.station.id) && i.status !== 'resolved',
  );
  const tasks = world.maintenance.filter(
    (t) => t.stationId === snapshot.station.id && t.status !== 'completed',
  );

  const rows: { label: string; value: string }[] = [
    { label: 'Temperature', value: fmt('temperature') },
    { label: 'Humidity', value: fmt('humidity') },
    { label: 'Pressure', value: fmt('pressure') },
    { label: 'Wind', value: fmt('wind_speed') },
    { label: 'Rainfall', value: fmt('rainfall') },
    { label: 'Battery', value: fmt('battery') },
    { label: 'Signal', value: fmt('comms') },
  ];

  function fmt(type: Parameters<typeof formatSensorValue>[0]) {
    const v = qcValue(snapshot.qc, type, cleaned);
    const f = formatSensorValue(type, v, settings);
    return `${f.value} ${f.suffix}`;
  }

  return (
    <aside className="flex h-full w-full flex-col border-l border-line bg-panel">
      <header className="panel-header shrink-0">
        <div className="min-w-0">
          <h2 className="tnum truncate text-[13px] font-semibold">
            {snapshot.station.id} · {snapshot.station.name}
          </h2>
          <p className="truncate text-[10.5px] text-ink-3">
            {snapshot.station.region} · {snapshot.station.elevation} m ·{' '}
            {snapshot.station.latitude.toFixed(3)}, {snapshot.station.longitude.toFixed(3)}
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={onClose}>
          <X size={13} aria-hidden />
          <span className="sr-only">Close station panel</span>
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
          <StatusLabel status={snapshot.status} />
          <span className="flex items-center gap-1.5">
            <span className="eyebrow">Health</span>
            <span
              className="tnum text-[14px] font-medium"
              style={{ color: healthColor(snapshot.healthScore) }}
            >
              {snapshot.healthScore}
            </span>
          </span>
        </div>

        <section className="border-b border-line px-3 py-2">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="eyebrow">Current observations</span>
            <SourceBadge source={cleaned ? 'CORRECTED' : 'SIMULATED'} compact />
          </div>
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1">
            {rows.map((r) => (
              <div key={r.label} className="flex items-baseline justify-between gap-2">
                <dt className="text-[11px] text-ink-3">{r.label}</dt>
                <dd className="tnum text-[11.5px] text-ink">{r.value}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="border-b border-line px-3 py-2">
          <div className="eyebrow mb-1.5">Sensor health</div>
          <ul className="flex flex-col gap-1">
            {snapshot.sensorHealth.map((h) => (
              <li key={h.sensorId}>
                <Link
                  href={`/health/${h.sensorId}`}
                  className="flex items-center gap-2 rounded-[2px] px-1 py-0.5 hover:bg-hover"
                >
                  <span className="w-[92px] shrink-0 truncate text-[11px] text-ink-2">
                    {SENSOR_LABELS[h.type]}
                  </span>
                  <span className="h-1 flex-1 overflow-hidden rounded-full bg-line">
                    <span
                      className="block h-full rounded-full"
                      style={{ width: `${h.score}%`, background: healthColor(h.score) }}
                    />
                  </span>
                  <span
                    className="tnum w-6 shrink-0 text-right text-[10.5px]"
                    style={{ color: healthColor(h.score) }}
                  >
                    {h.score}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>

        <section className="border-b border-line px-3 py-2">
          <div className="eyebrow mb-1">Link and power</div>
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
            <Row label="Uptime (24 h)" value={`${snapshot.uptime}%`} />
            <Row label="Last packet" value={`${formatDistanceToNowStrict(snapshot.lastPacketAt)} ago`} />
            <Row label="Packet loss" value={`${snapshot.latest.packetLoss ?? 0}%`} />
            <Row label="Solar" value={`${snapshot.latest.solarVoltage ?? 0} V`} />
            <Row label="Firmware" value={snapshot.station.firmware} />
            <Row label="Hardware" value={snapshot.station.hardwareModel} />
          </dl>
        </section>

        {incidents.length > 0 && (
          <section className="border-b border-line px-3 py-2">
            <div className="eyebrow mb-1.5">Active incidents</div>
            <ul className="flex flex-col gap-1">
              {incidents.map((i) => (
                <li key={i.id}>
                  <Link
                    href={`/incidents/${i.id}`}
                    className="flex items-center gap-2 text-[11.5px] text-ink-2 hover:text-ink"
                  >
                    <span className="tnum shrink-0 text-ink-3">{i.id}</span>
                    <span className="min-w-0 flex-1 truncate">{i.title}</span>
                    <ExternalLink size={10} className="shrink-0" aria-hidden />
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="border-b border-line">
          <div className="eyebrow px-3 pt-2 pb-1">Findings</div>
          {snapshot.anomalies.length ? (
            <AnomalyList anomalies={snapshot.anomalies} limit={5} showStation={false} />
          ) : (
            <EmptyState title="No findings" detail="Every channel is reporting normally." />
          )}
        </section>

        {tasks.length > 0 && (
          <section className="border-b border-line px-3 py-2">
            <div className="eyebrow mb-1.5">Maintenance</div>
            <ul className="flex flex-col gap-1.5">
              {tasks.slice(0, 3).map((t) => (
                <li key={t.id} className="flex items-start gap-1.5 text-[11px]">
                  <Wrench size={10} className="mt-0.5 shrink-0 text-ink-3" aria-hidden />
                  <span className="text-ink-2">{t.action}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {snapshot.maintenance.length > 0 && (
          <section className="px-3 py-2">
            <div className="eyebrow mb-1">Last site visit</div>
            <p className="text-[11px] text-ink-2">
              {snapshot.maintenance[0].action} — {snapshot.maintenance[0].outcome}
            </p>
            <p className="tnum mt-0.5 text-[10px] text-ink-3">
              {format(snapshot.maintenance[0].t, 'dd MMM yyyy')} ·{' '}
              {snapshot.maintenance[0].technician}
            </p>
          </section>
        )}
      </div>

      <footer className="flex shrink-0 gap-1.5 border-t border-line p-2">
        <Link
          href={`/stations/${snapshot.station.id}`}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-[3px] border border-line bg-raised px-2 py-1.5 text-[11.5px] text-ink-2 transition-colors hover:text-ink"
        >
          Station profile
        </Link>
        <Link
          href="/monitoring"
          className="flex flex-1 items-center justify-center gap-1.5 rounded-[3px] border border-event/40 bg-event/10 px-2 py-1.5 text-[11.5px] text-event transition-colors hover:bg-event/18"
        >
          <Activity size={11} aria-hidden />
          Live charts
        </Link>
      </footer>
    </aside>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-ink-3">{label}</dt>
      <dd className="tnum text-ink-2">{value}</dd>
    </div>
  );
}
