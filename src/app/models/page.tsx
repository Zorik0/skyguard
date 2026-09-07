'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, FlaskConical } from 'lucide-react';
import { useResolvedWorld, useSelectedStation } from '@/hooks/useWorld';
import { useSkyGuard } from '@/store/useSkyGuard';
import { PageBody, PageHeader } from '@/components/ui/PageHeader';
import {
  ConfidenceBar,
  EmptyState,
  Panel,
  SegmentedControl,
  SourceBadge,
  StatTile,
} from '@/components/ui/primitives';
import { StationPicker } from '@/components/stations/StationPicker';
import { TimeSeriesChart } from '@/components/charts/TimeSeriesChart';
import { evaluateModels, evaluateShadowModel } from '@/lib/models/lab';
import { SENSOR_LABELS } from '@/lib/simulation/stations';
import { HOUR } from '@/lib/utils';
import type { SensorType } from '@/types';

const CHANNELS: SensorType[] = ['temperature', 'humidity', 'pressure', 'wind_speed'];

const MODEL_COLORS: Record<string, string> = {
  rules: 'var(--color-failed)',
  zscore: 'var(--color-event)',
  rolling: 'var(--color-healthy)',
  isolation: '#a78bfa',
  twin: 'var(--color-warning)',
  ensemble: 'var(--color-ink)',
};

export default function ModelLabPage() {
  const world = useResolvedWorld();
  const snapshot = useSelectedStation();
  const settings = useSkyGuard((s) => s.settings);
  const [channel, setChannel] = useState<SensorType>('temperature');
  const [windowHours, setWindowHours] = useState('12');

  const evaluation = useMemo(
    () =>
      world && snapshot
        ? evaluateModels(world, snapshot.station.id, channel, Number(windowHours) * HOUR)
        : null,
    [world, snapshot, channel, windowHours],
  );

  const shadow = useMemo(() => (world ? evaluateShadowModel(world) : null), [world]);

  if (!world || !snapshot || !evaluation) return null;

  const chartPoints = evaluation.results[0].series.map((_, i) => {
    const point: Record<string, number> = { t: evaluation.results[0].series[i].t };
    for (const r of evaluation.results) point[r.model.id] = r.series[i]?.score ?? 0;
    return point as unknown as Parameters<typeof TimeSeriesChart>[0]['points'][number];
  });

  return (
    <>
      <PageHeader
        title="Model lab"
        subtitle="Detection methods run over the same telemetry and scored against the simulator's own record of when a fault was actually injected."
        actions={
          <>
            <StationPicker />
            <SegmentedControl
              ariaLabel="Channel"
              size="sm"
              value={channel}
              onChange={setChannel}
              options={CHANNELS.map((c) => ({ value: c, label: SENSOR_LABELS[c] }))}
            />
            <SegmentedControl
              ariaLabel="Window"
              size="sm"
              value={windowHours}
              onChange={setWindowHours}
              options={[
                { value: '6', label: '6 h' },
                { value: '12', label: '12 h' },
                { value: '24', label: '24 h' },
              ]}
            />
          </>
        }
      />

      <PageBody className="flex flex-col gap-3">
        <div className="flex items-start gap-2 rounded-[3px] border border-event/30 bg-event/7 px-3 py-2">
          <FlaskConical size={13} className="mt-0.5 shrink-0 text-event" aria-hidden />
          <p className="text-[11.5px] leading-relaxed text-ink-2">
            Precision and recall here are measured against ground truth that only exists because
            this network is simulated — the exact minutes a fault was injected. Real hardware never
            comes with that label, which is why the production path publishes evidence and rules
            rather than a score alone.
          </p>
        </div>

        <section className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <StatTile
            label="Window"
            value={evaluation.windowMinutes}
            suffix="min"
            hint={`${snapshot.station.id} · ${SENSOR_LABELS[channel]}`}
          />
          <StatTile
            label="Fault minutes"
            value={evaluation.faultMinutes}
            tone={evaluation.faultMinutes ? 'critical' : 'healthy'}
            hint="ground truth from the simulator"
          />
          <StatTile
            label="Methods compared"
            value={evaluation.results.length}
            hint="one is a deterministic stand-in"
          />
          <StatTile
            label="Shadow agreement"
            value={shadow?.agreementPercent ?? 0}
            suffix="%"
            tone="event"
            hint={`${shadow?.production} vs ${shadow?.shadow}`}
          />
        </section>

        <Panel eyebrow="Comparison" title="Detector scores over the window">
          <div className="p-2">
            <TimeSeriesChart
              points={chartPoints}
              sensorType="humidity"
              settings={settings}
              traces={evaluation.results.map((r) => ({
                key: r.model.id as never,
                label: r.model.name,
                color: MODEL_COLORS[r.model.id],
                width: r.model.id === 'ensemble' ? 1.8 : 1.1,
                dashed: r.model.simulated,
              }))}
              height={230}
            />
          </div>
        </Panel>

        <Panel
          eyebrow="Scorecard"
          title="How each method performed"
          actions={
            <span className="text-[10.5px] text-ink-3">
              detection threshold 50 · {evaluation.hasGroundTruth ? 'fault present in window' : 'no fault in window'}
            </span>
          }
        >
          <div className="overflow-x-auto">
            <table className="w-full min-w-[980px] text-[11.5px]">
              <thead>
                <tr className="border-b border-line text-left">
                  {[
                    'Method', 'Current score', 'Verdict', 'Confidence', 'Detections',
                    'False positives', 'Missed', 'Precision', 'Recall', 'Latency', 'Peak',
                  ].map((h) => (
                    <th key={h} scope="col" className="eyebrow px-2.5 py-1.5 font-semibold whitespace-nowrap">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {evaluation.results.map((r) => (
                  <tr key={r.model.id} className="border-b border-line/60 hover:bg-hover">
                    <td className="px-2.5 py-2">
                      <div className="flex items-center gap-1.5">
                        <span
                          className="h-[2px] w-3.5 shrink-0 rounded-full"
                          style={{ background: MODEL_COLORS[r.model.id] }}
                          aria-hidden
                        />
                        <span className="font-medium text-ink">{r.model.name}</span>
                        {r.model.simulated && <SourceBadge source="SIMULATED" compact />}
                      </div>
                      <p className="mt-0.5 max-w-[300px] text-[10.5px] leading-snug text-ink-3">
                        {r.model.description}
                      </p>
                    </td>
                    <td className="tnum px-2.5 py-2">{r.currentScore}</td>
                    <td className="px-2.5 py-2">
                      <span
                        className="rounded-[2px] px-1.5 py-px text-[9.5px] font-semibold tracking-wider uppercase"
                        style={{
                          color:
                            r.currentClassification === 'fault'
                              ? 'var(--color-failed)'
                              : 'var(--color-healthy)',
                          background: 'color-mix(in srgb, currentColor 11%, transparent)',
                        }}
                      >
                        {r.currentClassification}
                      </span>
                    </td>
                    <td className="px-2.5 py-2">
                      <span className="block w-[92px]">
                        <ConfidenceBar value={r.confidence} color={MODEL_COLORS[r.model.id]} />
                      </span>
                    </td>
                    <td className="tnum px-2.5 py-2">{r.detections}</td>
                    <td className="tnum px-2.5 py-2" style={{ color: r.falsePositives > 0 ? 'var(--color-warning)' : undefined }}>
                      {r.falsePositives}
                    </td>
                    <td className="tnum px-2.5 py-2">{r.falseNegatives}</td>
                    <td className="tnum px-2.5 py-2">{evaluation.hasGroundTruth ? `${r.precision}%` : '—'}</td>
                    <td className="tnum px-2.5 py-2">{evaluation.hasGroundTruth ? `${r.recall}%` : '—'}</td>
                    <td className="tnum px-2.5 py-2">
                      {r.detectionLatencyMinutes !== null ? `${r.detectionLatencyMinutes} min` : '—'}
                    </td>
                    <td className="tnum px-2.5 py-2 text-ink-3">{r.peakScore}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>

        <Panel
          eyebrow="Shadow mode"
          title="Candidate model running alongside production"
          actions={
            <span className="tnum text-[11px] text-ink-3">
              mean |Δ| {shadow?.meanAbsoluteDifference}
            </span>
          }
        >
          <div className="grid gap-px bg-line sm:grid-cols-3">
            <div className="bg-panel px-3 py-2.5">
              <div className="eyebrow">Production model</div>
              <div className="tnum mt-1 text-[15px] text-ink">{shadow?.production}</div>
              <p className="mt-1 text-[10.5px] text-ink-3">
                Publishes the corrected values shown throughout the platform.
              </p>
            </div>
            <div className="bg-panel px-3 py-2.5">
              <div className="eyebrow">Shadow model</div>
              <div className="tnum mt-1 text-[15px] text-event">{shadow?.shadow}</div>
              <p className="mt-1 text-[10.5px] text-ink-3">
                Runs on the same inputs. Its output is recorded and compared, never published.
              </p>
            </div>
            <div className="bg-panel px-3 py-2.5">
              <div className="eyebrow">Agreement</div>
              <div className="tnum mt-1 text-[15px] text-healthy">
                {shadow?.agreementPercent}%
              </div>
              <p className="mt-1 text-[10.5px] text-ink-3">
                Within the production prediction interval on{' '}
                {shadow?.comparisons.filter((c) => c.agrees).length} of{' '}
                {shadow?.comparisons.length} corrections.
              </p>
            </div>
          </div>

          {shadow && shadow.comparisons.length > 0 ? (
            <div className="overflow-x-auto border-t border-line">
              <table className="w-full min-w-[560px] text-[11.5px]">
                <thead>
                  <tr className="border-b border-line text-left">
                    {['Anomaly', 'Station', 'Channel', 'Production', 'Shadow', 'Δ', 'Within interval'].map((h) => (
                      <th key={h} scope="col" className="eyebrow px-2.5 py-1.5 font-semibold">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {shadow.comparisons.map((c) => (
                    <tr key={c.anomalyId} className="border-b border-line/60">
                      <td className="px-2.5 py-1.5">
                        <Link href={`/anomalies/${c.anomalyId}`} className="tnum text-event hover:underline">
                          {c.anomalyId}
                        </Link>
                      </td>
                      <td className="tnum px-2.5 py-1.5">{c.stationId}</td>
                      <td className="px-2.5 py-1.5 text-ink-2">{SENSOR_LABELS[c.sensorType]}</td>
                      <td className="tnum px-2.5 py-1.5">{c.production}</td>
                      <td className="tnum px-2.5 py-1.5 text-event">{c.shadow}</td>
                      <td className="tnum px-2.5 py-1.5 text-ink-3">
                        {c.delta > 0 ? '+' : ''}{c.delta}
                      </td>
                      <td className="px-2.5 py-1.5">
                        {c.agrees ? (
                          <span className="text-[10.5px] text-healthy">yes</span>
                        ) : (
                          <span className="flex items-center gap-1 text-[10.5px] text-warning">
                            <AlertTriangle size={10} aria-hidden /> no
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState
              title="No corrections to compare"
              detail="A shadow model can only be evaluated where production actually published a corrected value."
            />
          )}
        </Panel>
      </PageBody>
    </>
  );
}
