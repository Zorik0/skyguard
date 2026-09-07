'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Play, RotateCcw, X, Zap } from 'lucide-react';
import { useSkyGuard } from '@/store/useSkyGuard';
import { useResolvedWorld } from '@/hooks/useWorld';
import { INJECTABLE_SCENARIOS, FEATURED_SCENARIOS } from '@/lib/simulation/events';
import { Button } from '@/components/ui/primitives';
import { cn } from '@/lib/utils';

/**
 * Demo incident launcher.
 *
 * Injecting a scenario adds an event to the simulation inputs, which causes
 * the entire world to be rebuilt — so a single click propagates through
 * telemetry, detection, classification, correction, health, alerts, incidents,
 * maintenance and the audit log at once. Nothing is scripted per screen.
 */
export function DemoLauncher() {
  const [open, setOpen] = useState(false);
  const [station, setStation] = useState<string>('');
  const injectScenario = useSkyGuard((s) => s.injectScenario);
  const clearInjected = useSkyGuard((s) => s.clearInjected);
  const restoreStation = useSkyGuard((s) => s.restoreStation);
  const injected = useSkyGuard((s) => s.injectedEvents);
  const selectedStationId = useSkyGuard((s) => s.selectedStationId);
  const pushNotification = useSkyGuard((s) => s.pushNotification);
  const now = useSkyGuard((s) => s.now);
  const world = useResolvedWorld();
  const router = useRouter();

  const target = station || selectedStationId;

  const launch = (kind: (typeof INJECTABLE_SCENARIOS)[number]) => {
    injectScenario(kind.kind, kind.scope === 'station' ? target : undefined);
    pushNotification({
      title: kind.featured ?? kind.label,
      body:
        kind.scope === 'station'
          ? `Scenario injected at ${target}. Detection, correction and maintenance have been recalculated.`
          : 'Network-wide scenario injected. Watch it propagate across the map.',
      t: now,
      severity: kind.scope === 'station' ? 'critical' : 'warning',
      href: kind.scope === 'network' ? '/map' : '/anomalies',
    });
    setOpen(false);
    router.push(kind.scope === 'network' ? '/events' : '/anomalies');
  };

  return (
    <>
      <Button
        variant="primary"
        size="sm"
        onClick={() => setOpen(true)}
        title="Inject a demo incident into the live simulation"
      >
        <Zap size={12} aria-hidden />
        <span className="hidden sm:inline">Run demo incident</span>
        {injected.length > 0 && (
          <span className="tnum rounded-[2px] bg-event/25 px-1 text-[9.5px]">
            {injected.length}
          </span>
        )}
      </Button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-bg/72 px-4 backdrop-blur-[2px]"
          role="dialog"
          aria-modal="true"
          aria-label="Run demo incident"
          onClick={() => setOpen(false)}
        >
          <div
            className="panel max-h-[84vh] w-full max-w-[660px] overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="panel-header">
              <div>
                <h2 className="text-[13px] font-semibold">Run demo incident</h2>
                <p className="mt-0.5 text-[10.5px] text-ink-3">
                  Injects a real event into the simulation — every screen recalculates from it
                </p>
              </div>
              <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
                <X size={14} aria-hidden />
                <span className="sr-only">Close</span>
              </Button>
            </header>

            <div className="max-h-[62vh] overflow-y-auto p-3">
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <label htmlFor="demo-station" className="eyebrow">
                  Target station
                </label>
                <select
                  id="demo-station"
                  value={target}
                  onChange={(e) => setStation(e.target.value)}
                  className="rounded-[3px] border border-line bg-raised px-2 py-1 text-[11.5px] text-ink"
                >
                  {world?.snapshots.map((s) => (
                    <option key={s.station.id} value={s.station.id}>
                      {s.station.id} · {s.station.name}
                    </option>
                  ))}
                </select>
                <span className="text-[10.5px] text-ink-3">
                  Network-wide scenarios ignore this and affect every station in the path.
                </span>
              </div>

              <div className="eyebrow mb-1.5">Headline scenarios</div>
              <div className="mb-4 grid gap-1.5 sm:grid-cols-2">
                {FEATURED_SCENARIOS.map((s) => (
                  <button
                    key={s.kind}
                    type="button"
                    onClick={() => launch(s)}
                    className="group panel px-2.5 py-2 text-left transition-colors hover:border-event/50 hover:bg-raised"
                  >
                    <div className="flex items-center gap-1.5">
                      <Play size={11} className="shrink-0 text-event" aria-hidden />
                      <span className="text-[12px] font-medium text-ink">{s.featured}</span>
                    </div>
                    <p className="mt-1 text-[10.5px] leading-relaxed text-ink-3">
                      {s.description}
                    </p>
                  </button>
                ))}
              </div>

              <div className="eyebrow mb-1.5">All injections</div>
              <div className="grid gap-1 sm:grid-cols-2">
                {INJECTABLE_SCENARIOS.map((s) => (
                  <button
                    key={`all-${s.kind}`}
                    type="button"
                    onClick={() => launch(s)}
                    className={cn(
                      'flex items-center justify-between gap-2 rounded-[3px] border border-line px-2.5 py-1.5 text-left text-[11.5px] transition-colors hover:border-line-strong hover:bg-raised',
                    )}
                  >
                    <span className="min-w-0 truncate text-ink-2">{s.label}</span>
                    <span className="shrink-0 text-[9.5px] tracking-wider text-ink-3 uppercase">
                      {s.scope}
                    </span>
                  </button>
                ))}
              </div>
            </div>

            <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-3 py-2">
              <span className="text-[10.5px] text-ink-3">
                {injected.length
                  ? `${injected.length} injected scenario${injected.length === 1 ? '' : 's'} active`
                  : 'No injected scenarios — the network is running its baseline story'}
              </span>
              <div className="flex gap-1.5">
                <Button size="sm" onClick={() => restoreStation(target)}>
                  <RotateCcw size={11} aria-hidden />
                  Restore {target}
                </Button>
                <Button size="sm" variant="danger" onClick={() => { clearInjected(); setOpen(false); }}>
                  Clear all
                </Button>
              </div>
            </footer>
          </div>
        </div>
      )}
    </>
  );
}
