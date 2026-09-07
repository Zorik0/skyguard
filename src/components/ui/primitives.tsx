'use client';

import { type ReactNode } from 'react';
import Link from 'next/link';
import { cn } from '@/lib/utils';
import type { DataSource, Severity, StationStatus } from '@/types';
import { SEVERITY_META, SOURCE_META, STATUS_META } from '@/lib/units';

/* ----------------------------------------------------------------- panel -- */

export function Panel({
  title,
  eyebrow,
  actions,
  children,
  className,
  bodyClassName,
  as = 'section',
}: {
  title?: ReactNode;
  eyebrow?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  as?: 'section' | 'div' | 'aside';
}) {
  const Tag = as;
  return (
    <Tag className={cn('panel flex min-h-0 flex-col', className)}>
      {(title || actions || eyebrow) && (
        <header className="panel-header shrink-0">
          <div className="flex min-w-0 items-baseline gap-2">
            {eyebrow && <span className="eyebrow shrink-0">{eyebrow}</span>}
            {title && (
              <h2 className="truncate text-[12.5px] font-semibold text-ink">{title}</h2>
            )}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
        </header>
      )}
      <div className={cn('min-h-0 flex-1', bodyClassName)}>{children}</div>
    </Tag>
  );
}

/* ------------------------------------------------------------ status dot -- */

export function StatusDot({
  status,
  size = 8,
  pulse = false,
  className,
}: {
  status: StationStatus;
  size?: number;
  pulse?: boolean;
  className?: string;
}) {
  const meta = STATUS_META[status];
  return (
    <span
      className={cn('inline-block shrink-0 rounded-full', pulse && 'pulse', className)}
      style={{
        width: size,
        height: size,
        background: meta.color,
        color: meta.color,
        boxShadow: `0 0 0 2px color-mix(in srgb, ${meta.color} 16%, transparent)`,
      }}
      aria-hidden
    />
  );
}

export function StatusLabel({ status }: { status: StationStatus }) {
  const meta = STATUS_META[status];
  return (
    <span className="inline-flex items-center gap-1.5" title={meta.description}>
      <StatusDot status={status} pulse={status === 'critical' || status === 'failed'} />
      <span className="text-[11px] font-medium" style={{ color: meta.color }}>
        {meta.label}
      </span>
    </span>
  );
}

/* --------------------------------------------------------- severity chip -- */

export function SeverityChip({ severity, className }: { severity: Severity; className?: string }) {
  const meta = SEVERITY_META[severity];
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-[2px] border px-1.5 py-px text-[10px] font-semibold uppercase tracking-wider',
        className,
      )}
      style={{
        color: meta.color,
        borderColor: `color-mix(in srgb, ${meta.color} 38%, transparent)`,
        background: `color-mix(in srgb, ${meta.color} 11%, transparent)`,
      }}
    >
      {meta.label}
    </span>
  );
}

/* ---------------------------------------------------------- source badge -- */

/**
 * Provenance marker. Every number that could be mistaken for a live
 * measurement carries one of these, and hovering explains exactly where the
 * value came from. This is the single most important honesty affordance in the
 * interface: simulated hardware telemetry must never read as a real
 * observation.
 */
export function SourceBadge({
  source,
  className,
  compact = false,
}: {
  source: DataSource;
  className?: string;
  compact?: boolean;
}) {
  const meta = SOURCE_META[source] ?? SOURCE_META.SIMULATED;
  return (
    <span
      className={cn(
        'inline-flex cursor-help items-center rounded-[2px] border font-semibold uppercase tracking-[0.08em]',
        compact ? 'px-1 py-px text-[8.5px]' : 'px-1.5 py-px text-[9.5px]',
        className,
      )}
      style={{
        color: meta.color,
        borderColor: `color-mix(in srgb, ${meta.color} 32%, transparent)`,
        background: `color-mix(in srgb, ${meta.color} 9%, transparent)`,
      }}
      title={meta.description}
    >
      {meta.label}
    </span>
  );
}

/* -------------------------------------------------------- confidence bar -- */

export function ConfidenceBar({
  value,
  color = 'var(--color-event)',
  label,
  className,
}: {
  value: number;
  color?: string;
  label?: string;
  className?: string;
}) {
  return (
    <div className={cn('flex items-center gap-2', className)}>
      <div
        className="h-1.5 flex-1 overflow-hidden rounded-full bg-line"
        role="meter"
        aria-valuenow={Math.round(value)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label ?? 'Confidence'}
      >
        <div
          className="h-full rounded-full transition-[width] duration-500"
          style={{ width: `${Math.max(0, Math.min(100, value))}%`, background: color }}
        />
      </div>
      <span className="tnum w-9 shrink-0 text-right text-[11px] text-ink-2">
        {Math.round(value)}%
      </span>
    </div>
  );
}

/* -------------------------------------------------------------- metrics -- */

export function StatTile({
  label,
  value,
  suffix,
  hint,
  tone = 'default',
  href,
  children,
}: {
  label: string;
  value: ReactNode;
  suffix?: string;
  hint?: ReactNode;
  tone?: 'default' | 'healthy' | 'warning' | 'critical' | 'failed' | 'event';
  href?: string;
  children?: ReactNode;
}) {
  const toneColor =
    tone === 'default'
      ? 'var(--color-ink)'
      : `var(--color-${tone === 'event' ? 'event' : tone})`;

  const body = (
    <>
      <div className="eyebrow truncate">{label}</div>
      <div className="mt-1 flex items-baseline gap-1">
        <span className="tnum text-[22px] leading-none font-medium" style={{ color: toneColor }}>
          {value}
        </span>
        {suffix && <span className="text-[11px] text-ink-3">{suffix}</span>}
      </div>
      {hint && <div className="mt-1 truncate text-[10.5px] text-ink-3">{hint}</div>}
      {children}
    </>
  );

  const className = cn(
    'panel min-w-0 px-3 py-2.5 transition-colors',
    href && 'hover:border-line-strong hover:bg-raised',
  );

  return href ? (
    <Link href={href} className={cn(className, 'block')}>
      {body}
    </Link>
  ) : (
    <div className={className}>{body}</div>
  );
}

/* ---------------------------------------------------------- empty state -- */

export function EmptyState({
  title,
  detail,
  icon,
  className,
}: {
  title: string;
  detail?: string;
  icon?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-2 px-6 py-10 text-center',
        className,
      )}
    >
      {icon && <div className="text-ink-3">{icon}</div>}
      <p className="text-[12.5px] font-medium text-ink-2">{title}</p>
      {detail && <p className="max-w-md text-[11.5px] leading-relaxed text-ink-3">{detail}</p>}
    </div>
  );
}

/* ------------------------------------------------------------- controls -- */

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  className,
  size = 'md',
}: {
  options: { value: T; label: string; title?: string }[];
  value: T;
  onChange: (value: T) => void;
  ariaLabel: string;
  className?: string;
  size?: 'sm' | 'md';
}) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn(
        'inline-flex shrink-0 items-center gap-px rounded-[3px] border border-line bg-panel p-px',
        className,
      )}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            title={opt.title}
            onClick={() => onChange(opt.value)}
            className={cn(
              'rounded-[2px] font-medium whitespace-nowrap transition-colors',
              size === 'sm' ? 'px-1.5 py-0.5 text-[10.5px]' : 'px-2 py-1 text-[11px]',
              active
                ? 'bg-raised text-ink'
                : 'text-ink-3 hover:bg-hover hover:text-ink-2',
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

export function Button({
  children,
  onClick,
  variant = 'default',
  size = 'md',
  className,
  disabled,
  type = 'button',
  title,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: 'default' | 'primary' | 'ghost' | 'danger';
  size?: 'sm' | 'md';
  className?: string;
  disabled?: boolean;
  type?: 'button' | 'submit';
  title?: string;
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        'inline-flex shrink-0 items-center justify-center gap-1.5 rounded-[3px] border font-medium whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-40',
        size === 'sm' ? 'px-2 py-1 text-[11px]' : 'px-2.5 py-1.5 text-[12px]',
        variant === 'default' && 'border-line bg-raised text-ink-2 hover:border-line-strong hover:text-ink',
        variant === 'primary' && 'border-event/45 bg-event/12 text-event hover:bg-event/20',
        variant === 'danger' && 'border-failed/45 bg-failed/12 text-failed hover:bg-failed/20',
        variant === 'ghost' && 'border-transparent text-ink-3 hover:bg-hover hover:text-ink',
        className,
      )}
    >
      {children}
    </button>
  );
}

/** Progress-style meter used for health scores and score bars. */
export function ScoreBar({ score, color }: { score: number; color: string }) {
  return (
    <div className="h-1 w-full overflow-hidden rounded-full bg-line">
      <div
        className="h-full rounded-full"
        style={{ width: `${Math.max(2, Math.min(100, score))}%`, background: color }}
      />
    </div>
  );
}
