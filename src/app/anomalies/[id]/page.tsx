'use client';

import { use, useMemo } from 'react';
import Link from 'next/link';
import { format } from 'date-fns';
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  CloudSun,
  Minus,
  ShieldAlert,
  X,
} from 'lucide-react';
import { useResolvedWorld } from '@/hooks/useWorld';
import { useSkyGuard } from '@/store/useSkyGuard';
import { PageBody, PageHeader } from '@/components/ui/PageHeader';
import {
  ConfidenceBar,
  EmptyState,
  Panel,
  SeverityChip,
  SourceBadge,
} from '@/components/ui/primitives';
import { TimeSeriesChart, DEFAULT_TRACES, ChartLegend } from '@/components/charts/TimeSeriesChart';
import { buildChannelSeries } from '@/lib/analysisSeries';
import { CLASSIFICATION_LABELS } from '@/lib/anomaly/classify';
import { SENSOR_LABELS, SENSOR_UNITS } from '@/lib/simulation/stations';
import { similarAnomalies } from '@/lib/incidents/group';
import { formatSensorValue } from '@/lib/units';
import { HOUR, round } from '@/lib/utils';
import { neighbourConsensus } from '@/lib/neighbours';
import type { SensorType } from '@/types';

/**
 * The explainable investigation page.
 *
 * This is where the platform makes its argument: what happened, what the
 * evidence was on both sides, which configured rules fired and against what
 * limits, how the neighbours and the external model compared, and what the
 * corrected estimate is worth. An operator should be able to disagree with the
 * verdict here — which is only possible if everything behind it is visible.
 */
export default function AnomalyDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const world = useResolvedWorld();
  const settings = useSkyGuard((s) => s.settings);
  const externalStatus = useSkyGuard((s) => s.externalStatus);
  const external = useSkyGuard((s) => s.external);

  const anomaly = world?.anomalies.find((a) => a.id === id);

  const channel = useMemo(() => {
    if (!world || !anomaly) return null;
    return buildChannelSeries(world, anomaly.stationId, anomaly.sensorType, 8 * HOUR);
  }, [world, anomaly]);

  const crossChannels = useMemo(() => {
    if (!world || !anomaly) return [];
    const others: SensorType[] = (['temperature', 'humidity', 'pressure', 'wind_speed'] as SensorType[])
      .filter((s) => s !== anomaly.sensorType);
    return others.map((s) => ({
      sensorType: s,
      series: buildChannelSeries(world, anomaly.stationId, s, 8 * HOUR, 180),
    }));
  }, [world, anomaly]);

  const neighbourRows = useMemo(() => {
    if (!world || !anomaly) return [];
    const snap = world.snapshotById.get(anomaly.stationId);
    if (!snap) return [];
    const index = Math.round((anomaly.startedAt - world.from) / world.stepMs);
    const consensus = neighbourConsensus(
      snap.station,
      anomaly.sensorType,
      Math.min(Math.max(index, 0), snap.series.length - 1),
      snap.neighbours,
      world.seriesById,
    );
    return snap.neighbours.slice(0, 6).map((n) => {
      const contributor = consensus.contributors.find((c) => c.stationId === n.stationId);
      const neighbourSnap = world.snapshotById.get(n.stationId);
      return { ...n, adjusted: contributor?.value ?? null, name: neighbourSnap?.station.name ?? '' };
    });
  }, [world, anomaly]);

  if (!world) return null;

  if (!anomaly) {
    return (
      <>
        <PageHeader title="Anomaly not found" />
        <PageBody>
          <EmptyState
            title={`No anomaly with id ${id}`}
            detail="Anomaly identifiers are assigned per simulation run and change when the clock advances or a scenario is injected."
          />
          <Link href="/anomalies" className="mt-3 block text-center text-[12px] text-event hover:underline">
            Back to all anomalies
          </Link>
        </PageBody>
      </>
    );
  }

  const snap = world.snapshotById.get(anomaly.stationId)!;
  const isFault = anomaly.classification === 'sensor_fault';
  const accent = isFault
    ? 'var(--color-critical)'
    : anomaly.classification === 'meteorological_event'
      ? 'var(--color-event)'
      : 'var(--color-warning)';
  const Icon = isFault ? ShieldAlert : anomaly.classification === 'meteorological_event' ? CloudSun : AlertTriangle;

  const weatherEvidence = anomaly.evidence.filter((e) => e.supports === 'weather');
  const faultEvidence = anomaly.evidence.filter((e) => e.supports === 'fault');
  const firedRules = anomaly.rules.filter((r) => r.fired);
  const passedRules = anomaly.rules.filter((r) => !r.fired);
  const similar = similarAnomalies(anomaly, world.anomalies, 5);
  const ext = external.get(anomaly.stationId);
  const unit = SENSOR_UNITS[anomaly.sensorType];

  return (
    <>
      <PageHeader
        title={anomaly.title}
        subtitle={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="tnum">{anomaly.id}</span>
            <span>·</span>
            <Link href={`/stations/${anomaly.stationId}`} className="tnum text-ink-2 hover:underline">
              {anomaly.stationId} {snap.station.name}
            </Link>
            <span>·</span>
            <span>{SENSOR_LABELS[anomaly.sensorType]}</span>
            <span>·</span>
            <time className="tnum">{format(anomaly.startedAt, 'dd MMM yyyy HH:mm:ss')}</time>
            {anomaly.endedAt === null ? (
              <span className="rounded-[2px] bg-failed/12 px-1 text-[9px] font-semibold tracking-wider text-failed uppercase">
                ongoing
              </span>
            ) : (
              <span className="text-ink-3">
                ended {format(anomaly.endedAt, 'HH:mm')}
              </span>
            )}
          </span>
        }
        actions={
          <>
            <SeverityChip severity={anomaly.severity} />
            {anomaly.incidentId && (
              <Link
                href={`/incidents/${anomaly.incidentId}`}
                className="rounded-[3px] border border-line bg-raised px-2 py-1 text-[11px] text-ink-2 hover:text-ink"
              >
                {anomaly.incidentId}
              </Link>
            )}
            <Link
              href="/anomalies"
              className="flex items-center gap-1 rounded-[3px] border border-line bg-raised px-2 py-1 text-[11px] text-ink-2 hover:text-ink"
            >
              <ArrowLeft size={11} aria-hidden /> All anomalies
            </Link>
          </>
        }
      />

      <PageBody className="flex flex-col gap-3">
        {/* ------------------------------------------------------- verdict -- */}
        <section
          className="panel"
          style={{ borderColor: `color-mix(in srgb, ${accent} 30%, var(--color-line))` }}
        >
          <div
            className="flex flex-wrap items-center gap-3 px-4 py-3"
            style={{ background: `color-mix(in srgb, ${accent} 7%, transparent)` }}
          >
            <Icon size={22} style={{ color: accent }} aria-hidden />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-2">
                <h2 className="text-[19px] leading-tight font-semibold" style={{ color: accent }}>
                  {CLASSIFICATION_LABELS[anomaly.classification]}
                </h2>
                <span className="tnum text-[19px] font-semibold" style={{ color: accent }}>
                  {anomaly.confidence}% confidence
                </span>
              </div>
              <p className="mt-0.5 text-[11.5px] text-ink-3">
                Anomaly score {anomaly.score}/100 · {firedRules.length} rule
                {firedRules.length === 1 ? '' : 's'} fired · {anomaly.evidence.length} pieces of
                evidence weighed
              </p>
            </div>

            <div className="w-full max-w-[260px]">
              <div className="mb-1 flex justify-between text-[10px]">
                <span className="text-critical">Hardware fault</span>
                <span className="text-event">Genuine weather</span>
              </div>
              <EvidenceBalance
                faultWeight={faultEvidence.reduce((a, e) => a + e.weight, 0)}
                weatherWeight={weatherEvidence.reduce((a, e) => a + e.weight, 0)}
              />
            </div>
          </div>

          {anomaly.correction && anomaly.correction.confidence > 0 && (
            <div className="grid gap-px border-t border-line bg-line sm:grid-cols-4">
              <CorrectionCell label="Raw value" value={formatSensorValue(anomaly.sensorType, anomaly.correction.rawValue, settings)} badge="SIMULATED" />
              <CorrectionCell label="Corrected estimate" value={formatSensorValue(anomaly.sensorType, anomaly.correction.correctedValue, settings)} badge="CORRECTED" accent="var(--color-warning)" />
              <CorrectionCell
                label="Prediction interval"
                value={{
                  value: `${formatSensorValue(anomaly.sensorType, anomaly.correction.interval[0], settings).value}–${formatSensorValue(anomaly.sensorType, anomaly.correction.interval[1], settings).value}`,
                  suffix: unit,
                }}
                badge="ESTIMATED"
              />
              <CorrectionCell
                label="Correction confidence"
                value={{ value: String(anomaly.correction.confidence), suffix: '%' }}
                badge="ESTIMATED"
                footnote={anomaly.correction.modelVersion}
              />
            </div>
          )}
        </section>

        {/* -------------------------------------------- what happened ------ */}
        <div className="grid gap-3 xl:grid-cols-[1.4fr_1fr]">
          <Panel eyebrow="Explanation" title="What happened">
            <div className="flex flex-col gap-2.5 p-3">
              {anomaly.narrative.split('\n\n').map((p, i) => (
                <p key={i} className="text-[12.5px] leading-relaxed text-ink-2">
                  {p}
                </p>
              ))}
            </div>
          </Panel>

          <Panel eyebrow="Response" title="Recommended action">
            <div className="flex flex-col gap-3 p-3">
              <p
                className="rounded-[3px] border px-3 py-2.5 text-[12.5px] leading-relaxed"
                style={{
                  color: accent,
                  borderColor: `color-mix(in srgb, ${accent} 30%, transparent)`,
                  background: `color-mix(in srgb, ${accent} 8%, transparent)`,
                }}
              >
                {anomaly.recommendedAction}
              </p>

              <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-[11.5px]">
                <div>
                  <dt className="eyebrow">Detectors</dt>
                  <dd className="mt-0.5 text-ink-2">{anomaly.detectorTypes.join(', ')}</dd>
                </div>
                <div>
                  <dt className="eyebrow">Signature</dt>
                  <dd className="mt-0.5 text-ink-2">
                    {anomaly.signatureId ? (
                      <Link href="/history" className="text-event hover:underline">
                        {anomaly.signatureId}
                      </Link>
                    ) : (
                      '—'
                    )}
                  </dd>
                </div>
                <div>
                  <dt className="eyebrow">Detected at</dt>
                  <dd className="tnum mt-0.5 text-ink-2">{format(anomaly.detectedAt, 'HH:mm:ss')}</dd>
                </div>
                <div>
                  <dt className="eyebrow">Model</dt>
                  <dd className="tnum mt-0.5 text-ink-2">
                    {anomaly.correction?.modelVersion ?? 'rules-v2.1'}
                  </dd>
                </div>
              </dl>
            </div>
          </Panel>
        </div>

        {/* -------------------------------------------------- evidence ----- */}
        <div className="grid gap-3 lg:grid-cols-2">
          <Panel
            eyebrow="Evidence"
            title="Supporting a hardware fault"
            actions={<span className="tnum text-[10.5px] text-critical">{faultEvidence.reduce((a, e) => a + e.weight, 0).toFixed(1)} weight</span>}
          >
            <EvidenceCards items={faultEvidence} accent="var(--color-critical)" />
          </Panel>
          <Panel
            eyebrow="Evidence"
            title="Supporting genuine weather"
            actions={<span className="tnum text-[10.5px] text-event">{weatherEvidence.reduce((a, e) => a + e.weight, 0).toFixed(1)} weight</span>}
          >
            <EvidenceCards items={weatherEvidence} accent="var(--color-event)" />
          </Panel>
        </div>

        {/* -------------------------------------------------- timeline ----- */}
        <Panel
          eyebrow="Timeline"
          title={`${SENSOR_LABELS[anomaly.sensorType]} before, during and after`}
          actions={<ChartLegend traces={DEFAULT_TRACES} />}
        >
          <div className="p-2">
            {channel && (
              <TimeSeriesChart
                points={channel.points}
                spans={channel.spans}
                gaps={channel.gaps}
                sensorType={anomaly.sensorType}
                settings={settings}
                height={210}
                syncId="anomaly-detail"
              />
            )}
          </div>
        </Panel>

        {/* --------------------------------------------- cross-sensor ------ */}
        <Panel
          eyebrow="Cross-sensor comparison"
          title="Did the other channels respond?"
          actions={<SourceBadge source="SIMULATED" />}
        >
          <div className="grid gap-px bg-line sm:grid-cols-2 xl:grid-cols-3">
            {crossChannels.map(({ sensorType, series }) => (
              <div key={sensorType} className="bg-panel p-2">
                <div className="mb-1 flex items-center justify-between px-1">
                  <span className="eyebrow">{SENSOR_LABELS[sensorType]}</span>
                  <span className="tnum text-[10px] text-ink-3">
                    {SENSOR_UNITS[sensorType]}
                  </span>
                </div>
                <TimeSeriesChart
                  points={series.points}
                  spans={series.spans}
                  gaps={series.gaps}
                  sensorType={sensorType}
                  settings={settings}
                  traces={[
                    { key: 'raw', label: 'Raw', color: 'var(--color-ink-2)', width: 1.2 },
                    { key: 'twin', label: 'Twin', color: '#a78bfa', dashed: true },
                  ]}
                  height={104}
                  syncId="anomaly-detail"
                  showAxis={false}
                />
              </div>
            ))}
          </div>
          <p className="border-t border-line px-3 py-2 text-[11px] text-ink-3">
            {isFault
              ? 'A real change in the air moves several of these together. Flat companions alongside a large excursion are the clearest evidence of a single failing channel.'
              : 'These channels moved together, which is what a genuine change in the air mass looks like.'}
          </p>
        </Panel>

        {/* ---------------------------------------------- neighbours ------- */}
        <div className="grid gap-3 lg:grid-cols-2">
          <Panel
            eyebrow="Neighbour comparison"
            title="Relevance-weighted nearby stations"
            actions={<SourceBadge source="SIMULATED" />}
          >
            <div className="overflow-x-auto">
              <table className="w-full min-w-[420px] text-[11.5px]">
                <thead>
                  <tr className="border-b border-line text-left">
                    {['Station', 'Relevance', 'Distance', 'Δ elevation', 'Correlation', `Adjusted ${unit}`].map((h) => (
                      <th key={h} scope="col" className="eyebrow px-2.5 py-1.5 font-semibold whitespace-nowrap">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {neighbourRows.map((n) => (
                    <tr key={n.stationId} className="border-b border-line/60">
                      <td className="px-2.5 py-1.5">
                        <Link href={`/stations/${n.stationId}`} className="tnum text-ink hover:underline">
                          {n.stationId}
                        </Link>
                        <span className="ml-1.5 text-[10px] text-ink-3">{n.name}</span>
                      </td>
                      <td className="px-2.5 py-1.5">
                        <span className="flex items-center gap-1.5">
                          <span className="tnum w-7 text-right text-ink-2">{n.relevance}%</span>
                          <span className="h-1 w-12 overflow-hidden rounded-full bg-line">
                            <span
                              className="block h-full rounded-full bg-event"
                              style={{ width: `${n.relevance}%` }}
                            />
                          </span>
                        </span>
                      </td>
                      <td className="tnum px-2.5 py-1.5 text-ink-3">{n.distanceKm} km</td>
                      <td className="tnum px-2.5 py-1.5 text-ink-3">
                        {n.elevationDiff > 0 ? '+' : ''}{n.elevationDiff} m
                      </td>
                      <td className="tnum px-2.5 py-1.5 text-ink-3">{n.correlation.toFixed(2)}</td>
                      <td className="tnum px-2.5 py-1.5 text-ink-2">
                        {n.adjusted !== null ? round(n.adjusted, 2) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="border-t border-line px-3 py-2 text-[11px] text-ink-3">
              Relevance blends distance, elevation difference, terrain character and the historical
              correlation of expected conditions — the nearest station is not always the most
              informative one. Values are adjusted into {anomaly.stationId}’s own frame before
              comparison.
            </p>
          </Panel>

          <Panel
            eyebrow="External context"
            title="Open-Meteo comparison"
            actions={<SourceBadge source="EXTERNAL_MODEL" />}
          >
            {externalStatus === 'live' && ext?.current ? (
              <div className="p-3">
                <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-[11.5px] sm:grid-cols-3">
                  <ExternalRow label="Model temperature" value={`${round(ext.current.temperature, 1)} °C`} />
                  <ExternalRow label="Model humidity" value={`${round(ext.current.humidity, 0)} %`} />
                  <ExternalRow label="Model pressure" value={`${round(ext.current.pressure, 1)} hPa`} />
                  <ExternalRow label="Model wind" value={`${round(ext.current.windSpeed, 1)} m/s`} />
                  <ExternalRow label="Model dew point" value={`${round(ext.current.dewPoint, 1)} °C`} />
                  <ExternalRow label="Grid elevation" value={ext.elevation !== null ? `${ext.elevation} m` : '—'} />
                </dl>
                <p className="mt-3 border-t border-line pt-2 text-[11px] leading-relaxed text-ink-3">
                  The external model is supporting context, not ground truth. It is compared after
                  correcting for the difference between its grid elevation
                  {ext.elevation !== null ? ` (${ext.elevation} m)` : ''} and the station’s own
                  ({snap.station.elevation} m), so terrain alone cannot manufacture a disagreement.
                </p>
              </div>
            ) : (
              <EmptyState
                title="External weather context unavailable"
                detail="Classification and correction for this anomaly were produced from station telemetry, physics rules and neighbour comparison alone. The verdict does not depend on an external provider being reachable."
              />
            )}
          </Panel>
        </div>

        {/* -------------------------------------------------- rules -------- */}
        <Panel
          eyebrow="Physics validation"
          title="Rules evaluated"
          actions={
            <span className="text-[10.5px] text-ink-3">
              {firedRules.length} of {anomaly.rules.length} fired
            </span>
          }
        >
          {anomaly.rules.length === 0 ? (
            <EmptyState
              title="No channel rules apply"
              detail="This finding came from a subsystem check — communications, power or calibration — rather than from an atmospheric consistency rule."
            />
          ) : (
            <ul className="divide-y divide-line">
              {[...firedRules, ...passedRules].map((r) => (
                <li key={r.id} className="flex items-start gap-2.5 px-3 py-2">
                  {r.fired ? (
                    <Check size={13} className="mt-0.5 shrink-0 text-failed" aria-hidden />
                  ) : (
                    <Minus size={13} className="mt-0.5 shrink-0 text-ink-3" aria-hidden />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-2">
                      <span
                        className={`text-[12px] font-medium ${r.fired ? 'text-ink' : 'text-ink-3'}`}
                      >
                        {r.name}
                      </span>
                      <span
                        className={`text-[9px] font-semibold tracking-wider uppercase ${r.fired ? 'text-failed' : 'text-ink-3'}`}
                      >
                        {r.fired ? 'violated' : 'passed'}
                      </span>
                    </div>
                    <p className="mt-0.5 text-[11px] text-ink-3">{r.description}</p>
                    <div className="tnum mt-1 flex flex-wrap gap-x-4 text-[10.5px]">
                      <span className={r.fired ? 'text-failed' : 'text-ink-2'}>
                        observed {r.observed}
                      </span>
                      <span className="text-ink-3">limit {r.limit}</span>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        {/* ------------------------------------------------ correction ----- */}
        {anomaly.correction && anomaly.correction.confidence > 0 && (
          <Panel
            eyebrow="Corrected value"
            title="How the estimate was produced"
            actions={<span className="tnum text-[10.5px] text-ink-3">{anomaly.correction.method}</span>}
          >
            <div className="overflow-x-auto">
              <table className="w-full min-w-[460px] text-[11.5px]">
                <thead>
                  <tr className="border-b border-line text-left">
                    {['Source', 'Weight', 'Estimate', 'Available'].map((h) => (
                      <th key={h} scope="col" className="eyebrow px-3 py-1.5 font-semibold">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {anomaly.correction.weights.map((w) => (
                    <tr key={w.source} className="border-b border-line/60">
                      <td className={`px-3 py-1.5 ${w.available ? 'text-ink' : 'text-ink-3'}`}>
                        {w.source}
                      </td>
                      <td className="px-3 py-1.5">
                        <span className="flex items-center gap-2">
                          <span className="tnum w-9 text-right text-ink-2">
                            {(w.weight * 100).toFixed(0)}%
                          </span>
                          <span className="h-1 w-20 overflow-hidden rounded-full bg-line">
                            <span
                              className="block h-full rounded-full bg-warning"
                              style={{ width: `${w.weight * 100}%` }}
                            />
                          </span>
                        </span>
                      </td>
                      <td className="tnum px-3 py-1.5 text-ink-2">
                        {w.estimate !== null ? `${w.estimate} ${unit}` : '—'}
                      </td>
                      <td className="px-3 py-1.5">
                        {w.available ? (
                          <Check size={12} className="text-healthy" aria-hidden />
                        ) : (
                          <X size={12} className="text-ink-3" aria-hidden />
                        )}
                        <span className="sr-only">{w.available ? 'available' : 'unavailable'}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="border-t border-line px-3 py-2 text-[11px] leading-relaxed text-ink-3">
              Weights are renormalised across whichever estimators were available, so a missing
              external model widens the interval rather than silently biasing the result. The raw
              value of {anomaly.correction.rawValue} {unit} is never overwritten — the correction is
              an additional record in the audit trail.
            </p>
          </Panel>
        )}

        {/* --------------------------------------------------- similar ----- */}
        <Panel eyebrow="Historical" title="Similar past events">
          {similar.length === 0 ? (
            <EmptyState title="No comparable events" />
          ) : (
            <ul className="divide-y divide-line">
              {similar.map(({ anomaly: a, similarity }) => (
                <li key={a.id}>
                  <Link
                    href={`/anomalies/${a.id}`}
                    className="flex items-center gap-3 px-3 py-2 transition-colors hover:bg-hover"
                  >
                    <span className="tnum w-10 shrink-0 text-[11px] text-ink-3">{a.id}</span>
                    <span className="min-w-0 flex-1 truncate text-[12px] text-ink-2">{a.title}</span>
                    <span className="hidden shrink-0 text-[10.5px] text-ink-3 sm:block">
                      {CLASSIFICATION_LABELS[a.classification]}
                    </span>
                    <span className="w-[110px] shrink-0">
                      <ConfidenceBar value={similarity} label="Similarity" />
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </PageBody>
    </>
  );
}

function EvidenceBalance({
  faultWeight,
  weatherWeight,
}: {
  faultWeight: number;
  weatherWeight: number;
}) {
  const total = faultWeight + weatherWeight || 1;
  const faultPct = (faultWeight / total) * 100;
  return (
    <div
      className="flex h-2 overflow-hidden rounded-full bg-line"
      role="img"
      aria-label={`Evidence balance: ${faultPct.toFixed(0)} percent hardware fault, ${(100 - faultPct).toFixed(0)} percent genuine weather`}
    >
      <div style={{ width: `${faultPct}%`, background: 'var(--color-critical)' }} />
      <div style={{ width: `${100 - faultPct}%`, background: 'var(--color-event)' }} />
    </div>
  );
}

function EvidenceCards({
  items,
  accent,
}: {
  items: { id: string; label: string; detail: string; weight: number; source: string }[];
  accent: string;
}) {
  if (!items.length) {
    return <EmptyState title="No evidence on this side" detail="Nothing the detector examined supported this explanation." />;
  }
  return (
    <ul className="divide-y divide-line">
      {items.map((e) => (
        <li key={e.id} className="px-3 py-2">
          <div className="flex items-start justify-between gap-2">
            <span className="text-[12px] font-medium text-ink">{e.label}</span>
            <span className="flex shrink-0 items-center gap-1.5">
              <SourceBadge source={e.source as never} compact />
              <span className="tnum text-[10px]" style={{ color: accent }}>
                {e.weight.toFixed(1)}
              </span>
            </span>
          </div>
          <p className="mt-0.5 text-[11.5px] leading-relaxed text-ink-3">{e.detail}</p>
        </li>
      ))}
    </ul>
  );
}

function CorrectionCell({
  label,
  value,
  badge,
  accent,
  footnote,
}: {
  label: string;
  value: { value: string; suffix: string };
  badge: string;
  accent?: string;
  footnote?: string;
}) {
  return (
    <div className="bg-panel px-3 py-2.5">
      <div className="flex items-center justify-between gap-1">
        <span className="eyebrow truncate">{label}</span>
        <SourceBadge source={badge as never} compact />
      </div>
      <div className="mt-1 flex items-baseline gap-1">
        <span className="tnum text-[20px] leading-none font-medium" style={{ color: accent }}>
          {value.value}
        </span>
        <span className="text-[10px] text-ink-3">{value.suffix}</span>
      </div>
      {footnote && <div className="tnum mt-1 text-[9.5px] text-ink-3">{footnote}</div>}
    </div>
  );
}

function ExternalRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="eyebrow">{label}</dt>
      <dd className="tnum mt-0.5 text-ink-2">{value}</dd>
    </div>
  );
}
