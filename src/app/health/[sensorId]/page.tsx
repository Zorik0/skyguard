'use client';

import { use, useMemo } from 'react';
import Link from 'next/link';
import { format } from 'date-fns';
import { ArrowLeft, TrendingDown, TrendingUp } from 'lucide-react';
import { useResolvedWorld } from '@/hooks/useWorld';
import { useSkyGuard } from '@/store/useSkyGuard';
import { PageBody, PageHeader } from '@/components/ui/PageHeader';
import { EmptyState, Panel, SourceBadge, StatTile } from '@/components/ui/primitives';
import { TimeSeriesChart, DEFAULT_TRACES, ChartLegend } from '@/components/charts/TimeSeriesChart';
import { AnomalyList } from '@/components/anomalies/AnomalyList';
import { buildChannelSeries, buildResidualSeries } from '@/lib/analysisSeries';
import { SENSOR_LABELS, SENSOR_UNITS } from '@/lib/simulation/stations';
import { healthColor } from '@/lib/units';
import { bandLabel } from '@/lib/health/score';
import { DAY, HOUR } from '@/lib/utils';

export default function SensorDetailPage({
  params,
}: {
  params: Promise<{ sensorId: string }>;
}) {
  const { sensorId } = use(params);
  const world = useResolvedWorld();
  const settings = useSkyGuard((s) => s.settings);

  const found = useMemo(() => {
    const snapshot = world?.snapshots.find((s) =>
      s.sensorHealth.some((h) => h.sensorId === sensorId),
    );
    const health = snapshot?.sensorHealth.find((h) => h.sensorId === sensorId);
    const sensor = snapshot?.station.sensors.find((s) => s.id === sensorId);
    return snapshot && health && sensor ? { snapshot, health, sensor } : null;
  }, [world, sensorId]);

  const series = useMemo(() => {
    if (!world || !found) return null;
    return buildChannelSeries(world, found.snapshot.station.id, found.health.type, 24 * HOUR);
  }, [world, found]);

  const residual = useMemo(() => {
    if (!world || !found) return [];
    return buildResidualSeries(world, found.snapshot.station.id, found.health.type, 24 * HOUR);
  }, [world, found]);

  if (!world) return null;
  if (!found) {
    return (
      <>
        <PageHeader title="Sensor not found" />
        <PageBody>
          <EmptyState title={`No sensor with id ${sensorId}`} />
          <Link href="/health" className="mt-3 block text-center text-[12px] text-event hover:underline">
            Back to sensor health
          </Link>
        </PageBody>
      </>
    );
  }

  const { snapshot, health, sensor } = found;
  const anomalies = snapshot.anomalies.filter((a) => a.sensorType === health.type);
  const corrections = anomalies.filter((a) => a.correction && a.correction.confidence > 0);
  const calibrations = snapshot.calibrations.filter((c) => c.sensorId === sensorId);
  const nextService = sensor.lastCalibratedAt + sensor.calibrationIntervalDays * DAY;
  const overdue = nextService < world.now;
  const unit = SENSOR_UNITS[health.type];
  const isCharted = ['temperature', 'humidity', 'pressure', 'wind_speed', 'rainfall'].includes(
    health.type,
  );

  return (
    <>
      <PageHeader
        title={`${SENSOR_LABELS[health.type]} · ${snapshot.station.id}`}
        subtitle={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="tnum">{sensor.id}</span>
            <span>·</span>
            <span>
              {sensor.manufacturer} {sensor.model}
            </span>
            <span>·</span>
            <span className="tnum">serial {sensor.serial}</span>
            <span>·</span>
            <Link href={`/stations/${snapshot.station.id}`} className="hover:underline">
              {snapshot.station.name}
            </Link>
          </span>
        }
        actions={
          <Link
            href="/health"
            className="flex items-center gap-1 rounded-[3px] border border-line bg-raised px-2 py-1 text-[11px] text-ink-2 hover:text-ink"
          >
            <ArrowLeft size={11} aria-hidden /> Health matrix
          </Link>
        }
      />

      <PageBody className="flex flex-col gap-3">
        <section className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          <StatTile
            label="Health score"
            value={health.score}
            suffix="/100"
            hint={bandLabel(health.band)}
            tone={
              health.band === 'healthy' ? 'healthy'
              : health.band === 'minor' ? 'default'
              : health.band === 'warning' ? 'warning'
              : health.band === 'critical' ? 'critical' : 'failed'
            }
          />
          <StatTile
            label="7-day trend"
            value={`${health.trend7d > 0 ? '+' : ''}${health.trend7d}`}
            hint="estimated"
            tone={health.trend7d < -4 ? 'critical' : health.trend7d < 0 ? 'warning' : 'healthy'}
          />
          <StatTile
            label="30-day trend"
            value={`${health.trend30d > 0 ? '+' : ''}${health.trend30d}`}
            hint="estimated"
            tone={health.trend30d < -10 ? 'critical' : health.trend30d < 0 ? 'warning' : 'healthy'}
          />
          <StatTile
            label="Calibration age"
            value={health.calibrationAgeDays}
            suffix="days"
            tone={overdue ? 'critical' : 'default'}
            hint={`${sensor.calibrationIntervalDays}-day interval`}
          />
          <StatTile
            label="Offset from peers"
            value={`${health.drift > 0 ? '+' : ''}${health.drift}`}
            hint={health.driftUnit}
            tone={Math.abs(health.drift) > 3 ? 'warning' : 'default'}
          />
          <StatTile
            label="30-day failure risk"
            value={health.failureRisk30d}
            suffix="%"
            tone={health.failureRisk30d > 65 ? 'failed' : health.failureRisk30d > 35 ? 'warning' : 'healthy'}
            hint="estimate, not a measurement"
          />
        </section>

        <div className="grid gap-3 xl:grid-cols-[1fr_360px]">
          <div className="flex min-w-0 flex-col gap-3">
            {isCharted && series && (
              <Panel
                eyebrow={unit}
                title="Raw and quality-controlled readings"
                actions={<ChartLegend traces={DEFAULT_TRACES} />}
              >
                <div className="p-2">
                  <TimeSeriesChart
                    points={series.points}
                    spans={series.spans}
                    gaps={series.gaps}
                    sensorType={health.type}
                    settings={settings}
                    height={190}
                    syncId="sensor-detail"
                  />
                </div>
              </Panel>
            )}

            {isCharted && residual.length > 0 && (
              <Panel
                eyebrow={unit}
                title="Residual against the digital twin"
                actions={<SourceBadge source="MODELLED" compact />}
              >
                <div className="p-2">
                  <TimeSeriesChart
                    points={residual}
                    sensorType={health.type}
                    settings={settings}
                    traces={[
                      { key: 'raw', label: 'Residual', color: 'var(--color-warning)', width: 1.4 },
                      { key: 'twin', label: 'Zero', color: 'var(--color-ink-3)', dashed: true },
                    ]}
                    height={130}
                    syncId="sensor-detail"
                  />
                </div>
                <p className="border-t border-line px-3 py-2 text-[11px] leading-relaxed text-ink-3">
                  A healthy channel scatters around zero. A residual that settles on one side and
                  stays there is calibration drift — which is what the offset-from-peers figure
                  measures, and what turns into a recalibration task.
                </p>
              </Panel>
            )}

            <Panel eyebrow="History" title="Findings on this channel">
              <AnomalyList
                anomalies={anomalies}
                showStation={false}
                emptyTitle="No findings"
                emptyDetail="This channel has produced no anomalies in the last 24 hours."
              />
            </Panel>
          </div>

          <div className="flex flex-col gap-3">
            <Panel eyebrow="Assessment" title="Why this score">
              {health.factors.length === 0 ? (
                <p className="px-3 py-3 text-[11.5px] text-ink-3">
                  No penalties applied — this channel is performing within specification on every
                  measured criterion.
                </p>
              ) : (
                <ul className="divide-y divide-line">
                  {health.factors.map((f) => (
                    <li key={f.label} className="px-3 py-2">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="text-[11.5px] text-ink-2">{f.label}</span>
                        <span className="tnum text-[11.5px] text-critical">−{f.penalty}</span>
                      </div>
                      <p className="mt-0.5 text-[10.5px] leading-snug text-ink-3">{f.detail}</p>
                    </li>
                  ))}
                  <li className="flex items-baseline justify-between gap-2 bg-raised px-3 py-2">
                    <span className="text-[11.5px] font-medium">Final score</span>
                    <span
                      className="tnum text-[13px] font-medium"
                      style={{ color: healthColor(health.score) }}
                    >
                      {health.score}/100
                    </span>
                  </li>
                </ul>
              )}
            </Panel>

            <Panel eyebrow="Recommendation" title="Predictive maintenance">
              <div className="p-3">
                <p className="rounded-[3px] border border-warning/30 bg-warning/8 px-2.5 py-2 text-[12px] leading-relaxed text-warning">
                  {health.recommendation}
                </p>
                <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 text-[11px]">
                  <Fact label="Installed" value={format(sensor.installedAt, 'dd MMM yyyy')} />
                  <Fact label="Last calibrated" value={format(sensor.lastCalibratedAt, 'dd MMM yyyy')} />
                  <Fact
                    label="Next service due"
                    value={format(nextService, 'dd MMM yyyy')}
                    tone={overdue ? 'var(--color-critical)' : undefined}
                  />
                  <Fact label="Noise (1 h σ)" value={`${health.noise} ${unit}`} />
                  <Fact label="Missing packets" value={`${(health.missingRate * 100).toFixed(1)}%`} />
                  <Fact label="Corrections" value={String(health.correctionCount)} />
                </dl>
                {health.driftRateSignificant ? (
                  <p className="mt-3 flex items-start gap-1.5 text-[11px] leading-relaxed text-ink-3">
                    {health.driftRate < 0 ? (
                      <TrendingDown size={12} className="mt-0.5 shrink-0 text-warning" aria-hidden />
                    ) : (
                      <TrendingUp size={12} className="mt-0.5 shrink-0 text-warning" aria-hidden />
                    )}
                    Offset is changing at {health.driftRate > 0 ? '+' : ''}
                    {health.driftRate} {health.driftRateUnit}, which cleared a two-sigma
                    significance test against the retained telemetry.
                  </p>
                ) : (
                  <p className="mt-3 text-[11px] leading-relaxed text-ink-3">
                    No statistically significant trend in the offset over the retained 24-hour
                    window. A drift rate is only reported when it can actually be resolved from the
                    data rather than inferred from noise.
                  </p>
                )}
              </div>
            </Panel>

            <Panel eyebrow="Records" title="Calibration history">
              {calibrations.length === 0 ? (
                <EmptyState title="No calibration records" />
              ) : (
                <ul className="divide-y divide-line">
                  {calibrations.map((c, i) => (
                    <li key={i} className="px-3 py-2">
                      <div className="flex items-baseline justify-between gap-2">
                        <time className="tnum text-[11px] text-ink-2">
                          {format(c.t, 'dd MMM yyyy')}
                        </time>
                        <span className="tnum text-[11px] text-ink-3">
                          offset {c.offsetApplied > 0 ? '+' : ''}
                          {c.offsetApplied} {unit}
                        </span>
                      </div>
                      <p className="mt-0.5 text-[10.5px] text-ink-3">
                        {c.note} · {c.technician}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>

            {corrections.length > 0 && (
              <Panel eyebrow="Corrections" title="Values replaced on this channel">
                <ul className="divide-y divide-line">
                  {corrections.map((a) => (
                    <li key={a.id} className="px-3 py-2">
                      <Link href={`/anomalies/${a.id}`} className="block hover:underline">
                        <div className="tnum flex items-baseline justify-between gap-2 text-[11.5px]">
                          <span>
                            {a.correction!.rawValue} → {' '}
                            <span className="text-warning">{a.correction!.correctedValue}</span>{' '}
                            {unit}
                          </span>
                          <span className="text-[10px] text-ink-3">
                            {format(a.correction!.t, 'HH:mm')}
                          </span>
                        </div>
                      </Link>
                    </li>
                  ))}
                </ul>
              </Panel>
            )}
          </div>
        </div>
      </PageBody>
    </>
  );
}

function Fact({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div>
      <dt className="eyebrow">{label}</dt>
      <dd className="tnum mt-0.5" style={{ color: tone ?? 'var(--color-ink-2)' }}>
        {value}
      </dd>
    </div>
  );
}
