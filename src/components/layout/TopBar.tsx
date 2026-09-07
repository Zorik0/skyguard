'use client';

import { useState } from 'react';
import Link from 'next/link';
import { format } from 'date-fns';
import {
  Bot,
  CloudOff,
  Maximize2,
  Radio,
  Search,
  Wifi,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useSkyGuard } from '@/store/useSkyGuard';
import { useResolvedWorld } from '@/hooks/useWorld';
import { Button, SegmentedControl } from '@/components/ui/primitives';
import { DemoLauncher } from './DemoLauncher';
import { NotificationCenter } from './NotificationCenter';
import { AssistantPanel } from './AssistantPanel';
import type { DataMode } from '@/types';

/**
 * The persistent control strip.
 *
 * It carries the two switches that change how every screen reads — the data
 * mode and the RAW / QUALITY-CONTROLLED lens — plus an always-visible statement
 * of where the external context currently stands.
 */
export function TopBar() {
  const [assistantOpen, setAssistantOpen] = useState(false);
  const mode = useSkyGuard((s) => s.mode);
  const setMode = useSkyGuard((s) => s.setMode);
  const cleaned = useSkyGuard((s) => s.cleaned);
  const setCleaned = useSkyGuard((s) => s.setCleaned);
  const setPaletteOpen = useSkyGuard((s) => s.setCommandPaletteOpen);
  const externalStatus = useSkyGuard((s) => s.externalStatus);
  const externalMessage = useSkyGuard((s) => s.externalMessage);
  const now = useSkyGuard((s) => s.now);
  const liveUpdates = useSkyGuard((s) => s.settings.liveUpdates);
  const world = useResolvedWorld();

  const externalLabel =
    externalStatus === 'live' ? 'Live weather context'
    : externalStatus === 'loading' ? 'Contacting provider…'
    : mode === 'simulation' ? 'Simulation context'
    : 'External context unavailable';

  return (
    <>
      <header className="flex h-[46px] shrink-0 items-center gap-2 border-b border-line bg-panel px-3">
        <button
          type="button"
          onClick={() => setPaletteOpen(true)}
          className="flex h-7 min-w-0 flex-1 max-w-[300px] items-center gap-2 rounded-[3px] border border-line bg-raised px-2 text-left text-[11.5px] text-ink-3 transition-colors hover:border-line-strong"
        >
          <Search size={12} className="shrink-0" aria-hidden />
          <span className="min-w-0 flex-1 truncate">Search stations, anomalies, incidents…</span>
          <kbd className="shrink-0 rounded-[2px] border border-line px-1 text-[9px]">⌘K</kbd>
        </button>

        <Button size="sm" onClick={() => setAssistantOpen(true)} title="Open the operator assistant">
          <Bot size={12} aria-hidden />
          <span className="hidden lg:inline">Ask</span>
        </Button>

        <div className="ml-auto flex items-center gap-2">
          {/* Provenance switch: the single most consequential control here. */}
          <SegmentedControl
            ariaLabel="Data lens"
            size="sm"
            value={cleaned ? 'qc' : 'raw'}
            onChange={(v) => setCleaned(v === 'qc')}
            options={[
              { value: 'raw', label: 'RAW', title: 'Show values exactly as reported by the stations' },
              { value: 'qc', label: 'QUALITY-CONTROLLED', title: 'Show corrected estimates where a fault was detected' },
            ]}
          />

          <SegmentedControl
            ariaLabel="Data mode"
            size="sm"
            value={mode}
            onChange={(v) => setMode(v as DataMode)}
            options={[
              { value: 'hybrid', label: 'Hybrid', title: 'Simulated station telemetry with live external weather context' },
              { value: 'simulation', label: 'Simulation', title: 'Everything deterministic; no external requests' },
              { value: 'demo', label: 'Demo', title: 'Injected incidents active' },
            ]}
          />

          <span
            className="hidden items-center gap-1.5 rounded-[3px] border border-line bg-raised px-2 py-1 text-[10.5px] xl:inline-flex"
            title={externalMessage ?? externalLabel}
          >
            {externalStatus === 'live' ? (
              <Wifi size={11} className="text-healthy" aria-hidden />
            ) : (
              <CloudOff size={11} className="text-warning" aria-hidden />
            )}
            <span className={externalStatus === 'live' ? 'text-ink-2' : 'text-warning'}>
              {externalLabel}
            </span>
          </span>

          <span className="hidden items-center gap-1.5 border-l border-line pl-2 md:inline-flex">
            <Radio
              size={11}
              className={cn('text-healthy', liveUpdates && 'pulse')}
              aria-hidden
            />
            <span className="tnum text-[11px] text-ink-2" suppressHydrationWarning>
              {now ? format(now, 'HH:mm') : '--:--'}
            </span>
            <span className="tnum text-[10px] text-ink-3">
              {world ? `${world.metrics.rowsPerMinute} rows/min` : ''}
            </span>
          </span>

          <DemoLauncher />

          <Link
            href="/mission-control"
            title="Mission Control (M)"
            className="flex h-7 w-7 items-center justify-center rounded-[3px] border border-line bg-raised text-ink-2 transition-colors hover:border-line-strong hover:text-ink"
          >
            <Maximize2 size={12} aria-hidden />
            <span className="sr-only">Mission Control</span>
          </Link>

          <NotificationCenter />
        </div>
      </header>

      <AssistantPanel open={assistantOpen} onClose={() => setAssistantOpen(false)} />
    </>
  );
}
