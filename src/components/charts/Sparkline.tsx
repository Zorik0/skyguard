'use client';

import { useId } from 'react';
import { cn } from '@/lib/utils';

/**
 * Inline sparkline.
 *
 * Hand-drawn SVG rather than a charting library: these appear dozens of times
 * on a single screen and each one only needs a path, so a library instance per
 * row would cost far more than it delivers.
 */
export function Sparkline({
  values,
  color = 'var(--color-ink-2)',
  width = 68,
  height = 20,
  className,
  fill = true,
  ariaLabel,
}: {
  values: number[];
  color?: string;
  width?: number;
  height?: number;
  className?: string;
  fill?: boolean;
  ariaLabel?: string;
}) {
  const gradientId = useId();

  if (values.length < 2) {
    return (
      <div
        className={cn('shrink-0', className)}
        style={{ width, height }}
        aria-hidden
      />
    );
  }

  const min = Math.min(...values);
  const max = Math.max(...values);
  // A perfectly flat series still deserves a visible line, centred.
  const range = max - min || 1;
  const pad = 1.5;
  const usable = height - pad * 2;

  const toX = (i: number) => (i / (values.length - 1)) * width;
  const toY = (v: number) => pad + usable - ((v - min) / range) * usable;

  const line = values.map((v, i) => `${i === 0 ? 'M' : 'L'}${toX(i).toFixed(2)},${toY(v).toFixed(2)}`).join(' ');
  const area = `${line} L${width},${height} L0,${height} Z`;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={cn('shrink-0 overflow-visible', className)}
      role={ariaLabel ? 'img' : undefined}
      aria-label={ariaLabel}
      aria-hidden={ariaLabel ? undefined : true}
      preserveAspectRatio="none"
    >
      {fill && (
        <>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.22} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <path d={area} fill={`url(#${gradientId})`} />
        </>
      )}
      <path
        d={line}
        fill="none"
        stroke={color}
        strokeWidth={1.25}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
      <circle cx={toX(values.length - 1)} cy={toY(values[values.length - 1])} r={1.6} fill={color} />
    </svg>
  );
}
