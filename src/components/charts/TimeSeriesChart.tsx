'use client';

import { useMemo } from 'react';
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceArea,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { format } from 'date-fns';
import type { AnomalySpan, EstimatePoint } from '@/lib/analysisSeries';
import type { Classification, SensorType } from '@/types';
import type { Settings } from '@/store/useSkyGuard';
import { formatSensorValue } from '@/lib/units';

/**
 * Synchronised multi-trace chart.
 *
 * Every chart on a page shares a `syncId`, so hovering one moves the crosshair
 * on all of them — which is how an operator answers "did anything else move
 * when the temperature did?" without reading four separate tooltips.
 *
 * Shaded regions carry meaning: blue for a genuine meteorological event,
 * orange for a probable sensor fault, grey hatching for missing data.
 */

export const TRACE_COLORS = {
  raw: 'var(--color-ink)',
  twin: '#a78bfa',
  ml: 'var(--color-healthy)',
  corrected: 'var(--color-warning)',
  neighbours: 'var(--color-ink-3)',
};

const SPAN_COLOR: Record<Classification, string> = {
  meteorological_event: 'var(--color-event)',
  sensor_fault: 'var(--color-critical)',
  communications: 'var(--color-offline)',
  power: 'var(--color-warning)',
  indeterminate: 'var(--color-ink-3)',
};

export interface TraceConfig {
  key: keyof Pick<EstimatePoint, 'raw' | 'twin' | 'ml' | 'corrected' | 'neighbours'>;
  label: string;
  color: string;
  dashed?: boolean;
  width?: number;
}

export const DEFAULT_TRACES: TraceConfig[] = [
  { key: 'raw', label: 'Raw sensor', color: TRACE_COLORS.raw, width: 1.5 },
  { key: 'twin', label: 'Physics model', color: TRACE_COLORS.twin, dashed: true },
  { key: 'ml', label: 'ML estimate', color: TRACE_COLORS.ml, dashed: true },
  { key: 'corrected', label: 'Corrected', color: TRACE_COLORS.corrected, width: 1.75 },
];

function TooltipCard({
  active,
  payload,
  label,
  sensorType,
  settings,
}: {
  active?: boolean;
  // Structural subset of recharts' tooltip payload — it types `dataKey` as a
  // union that includes an accessor function, which we never use here.
  payload?: readonly {
    dataKey?: unknown;
    value?: unknown;
    color?: string;
    name?: unknown;
  }[];
  label?: string | number;
  sensorType: SensorType;
  settings: Settings;
}) {
  if (!active || !payload?.length) return null;
  const rows = payload.filter(
    (p) => typeof p.value === 'number' && Number.isFinite(p.value),
  );
  if (!rows.length) return null;

  return (
    <div className="panel px-2 py-1.5 shadow-lg" style={{ background: 'var(--color-raised)' }}>
      <div className="tnum mb-1 text-[10px] text-ink-3">
        {typeof label === 'number' ? format(label, 'dd MMM HH:mm') : label}
      </div>
      <div className="flex flex-col gap-0.5">
        {rows.map((row) => {
          const f = formatSensorValue(sensorType, row.value as number, settings);
          return (
            <div key={String(row.dataKey)} className="flex items-center gap-2 text-[11px]">
              <span
                className="h-[2px] w-3 shrink-0 rounded-full"
                style={{ background: row.color }}
              />
              <span className="flex-1 whitespace-nowrap text-ink-3">{String(row.name)}</span>
              <span className="tnum text-ink">
                {f.value}
                <span className="ml-0.5 text-ink-3">{f.suffix}</span>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function TimeSeriesChart({
  points,
  spans = [],
  gaps = [],
  sensorType,
  settings,
  traces = DEFAULT_TRACES,
  height = 150,
  syncId,
  showAxis = true,
  domainPadding = 0.08,
}: {
  points: EstimatePoint[];
  spans?: AnomalySpan[];
  gaps?: { from: number; to: number }[];
  sensorType: SensorType;
  settings: Settings;
  traces?: TraceConfig[];
  height?: number;
  syncId?: string;
  showAxis?: boolean;
  domainPadding?: number;
}) {
  const domain = useMemo(() => {
    const values: number[] = [];
    for (const p of points) {
      for (const t of traces) {
        const v = p[t.key];
        if (typeof v === 'number' && Number.isFinite(v)) values.push(v);
      }
    }
    if (!values.length) return undefined;
    const min = Math.min(...values);
    const max = Math.max(...values);
    const pad = Math.max((max - min) * domainPadding, 0.4);
    return [min - pad, max + pad] as [number, number];
  }, [points, traces, domainPadding]);

  const tickFormatter = (v: number) => {
    const f = formatSensorValue(sensorType, v, settings);
    return f.value;
  };

  if (!points.length) {
    return (
      <div
        className="flex items-center justify-center text-[11px] text-ink-3"
        style={{ height }}
      >
        No telemetry in this window
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart
        data={points}
        syncId={syncId}
        margin={{ top: 6, right: 6, bottom: showAxis ? 2 : 0, left: showAxis ? -14 : -38 }}
      >
        <CartesianGrid stroke="var(--color-line)" strokeDasharray="2 4" vertical={false} />

        {/* Missing data first, so anomaly shading reads on top of it. */}
        {gaps.map((g, i) => (
          <ReferenceArea
            key={`gap-${i}`}
            x1={g.from}
            x2={g.to}
            fill="var(--color-offline)"
            fillOpacity={0.22}
            stroke="none"
            ifOverflow="hidden"
          />
        ))}

        {spans.map((s) => (
          <ReferenceArea
            key={s.id}
            x1={s.from}
            x2={s.to}
            fill={SPAN_COLOR[s.classification]}
            fillOpacity={0.11}
            stroke={SPAN_COLOR[s.classification]}
            strokeOpacity={0.32}
            strokeDasharray="2 3"
            ifOverflow="hidden"
          />
        ))}

        <XAxis
          dataKey="t"
          type="number"
          scale="time"
          domain={['dataMin', 'dataMax']}
          tickFormatter={(v: number) => format(v, 'HH:mm')}
          stroke="var(--color-line-strong)"
          tick={{ fill: 'var(--color-ink-3)', fontSize: 10 }}
          tickLine={false}
          axisLine={{ stroke: 'var(--color-line)' }}
          minTickGap={44}
          hide={!showAxis}
        />
        <YAxis
          domain={domain ?? ['auto', 'auto']}
          tickFormatter={tickFormatter}
          stroke="var(--color-line-strong)"
          tick={{ fill: 'var(--color-ink-3)', fontSize: 10 }}
          tickLine={false}
          axisLine={false}
          width={showAxis ? 46 : 30}
          tickCount={4}
        />
        <Tooltip
          isAnimationActive={false}
          cursor={{ stroke: 'var(--color-line-strong)', strokeWidth: 1 }}
          content={(props) => (
            <TooltipCard {...props} sensorType={sensorType} settings={settings} />
          )}
        />

        {traces.map((t) => (
          <Line
            key={t.key}
            type="monotone"
            dataKey={t.key}
            name={t.label}
            stroke={t.color}
            strokeWidth={t.width ?? 1.15}
            strokeDasharray={t.dashed ? '3 3' : undefined}
            dot={false}
            activeDot={{ r: 2.5, strokeWidth: 0 }}
            isAnimationActive={false}
            connectNulls={false}
          />
        ))}
        {/* Keeps recharts' type union happy when no area trace is configured. */}
        <Area dataKey="__none" hide isAnimationActive={false} />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

export function ChartLegend({ traces }: { traces: TraceConfig[] }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {traces.map((t) => (
        <span key={t.key} className="flex items-center gap-1.5 text-[10px] text-ink-3">
          <span
            className="h-[2px] w-3.5 rounded-full"
            style={{
              background: t.dashed
                ? `repeating-linear-gradient(90deg, ${t.color} 0 3px, transparent 3px 6px)`
                : t.color,
            }}
          />
          {t.label}
        </span>
      ))}
    </div>
  );
}
