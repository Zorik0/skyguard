'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowRight,
  CornerDownLeft,
  Search,
  Sparkles,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useResolvedWorld } from '@/hooks/useWorld';
import { useSkyGuard } from '@/store/useSkyGuard';
import { groupResults, KIND_LABELS, searchWorld, type SearchResult } from '@/lib/search';
import { NAV_ITEMS } from '@/lib/navigation';
import { FEATURED_SCENARIOS } from '@/lib/simulation/events';

interface Command {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
  group: string;
}

/**
 * Command palette (⌘K).
 *
 * One surface for both navigation and global search: typing filters commands
 * and searches every entity in the world at the same time, because an operator
 * chasing "AWS-007" does not care whether the answer is a page or a record.
 */
export function CommandPalette() {
  const open = useSkyGuard((s) => s.commandPaletteOpen);
  // The dialog is mounted only while it is open, so its query and selection
  // start fresh every time without an effect resetting them afterwards.
  return open ? <CommandPaletteDialog /> : null;
}

function CommandPaletteDialog() {
  const setOpen = useSkyGuard((s) => s.setCommandPaletteOpen);
  const setMode = useSkyGuard((s) => s.setMode);
  const setCleaned = useSkyGuard((s) => s.setCleaned);
  const cleaned = useSkyGuard((s) => s.cleaned);
  const injectScenario = useSkyGuard((s) => s.injectScenario);
  const clearInjected = useSkyGuard((s) => s.clearInjected);
  const world = useResolvedWorld();
  const router = useRouter();

  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Focus after the dialog paints so the caret lands reliably. This touches
  // the DOM rather than React state, which is what effects are for.
  useEffect(() => {
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);

  const commands = useMemo<Command[]>(() => {
    const nav: Command[] = NAV_ITEMS.map((item) => ({
      id: `nav:${item.href}`,
      label: `Go to ${item.label}`,
      hint: item.shortcut.toUpperCase(),
      group: 'Navigate',
      run: () => router.push(item.href),
    }));

    const actions: Command[] = [
      {
        id: 'mission',
        label: 'Enter Mission Control',
        hint: 'M',
        group: 'Actions',
        run: () => router.push('/mission-control'),
      },
      {
        id: 'toggle-lens',
        label: cleaned ? 'Switch to raw data' : 'Switch to quality-controlled data',
        group: 'Actions',
        run: () => setCleaned(!cleaned),
      },
      {
        id: 'mode-hybrid',
        label: 'Switch data mode: Hybrid',
        group: 'Actions',
        run: () => setMode('hybrid'),
      },
      {
        id: 'mode-sim',
        label: 'Switch data mode: Simulation',
        group: 'Actions',
        run: () => setMode('simulation'),
      },
      {
        id: 'export',
        label: 'Export a report',
        group: 'Actions',
        run: () => router.push('/reports'),
      },
      {
        id: 'restore-all',
        label: 'Clear all injected demo incidents',
        group: 'Actions',
        run: () => clearInjected(),
      },
      ...FEATURED_SCENARIOS.map<Command>((s) => ({
        id: `demo:${s.kind}`,
        label: `Start demo incident: ${s.featured}`,
        group: 'Demo incidents',
        run: () => {
          injectScenario(s.kind);
          router.push('/anomalies');
        },
      })),
    ];

    return [...nav, ...actions];
  }, [router, cleaned, setCleaned, setMode, injectScenario, clearInjected]);

  const filteredCommands = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands.slice(0, 8);
    return commands.filter((c) => c.label.toLowerCase().includes(q)).slice(0, 8);
  }, [commands, query]);

  const results = useMemo<SearchResult[]>(
    () => (world && query.trim().length >= 1 ? searchWorld(world, query, 14) : []),
    [world, query],
  );

  const flat = useMemo(
    () => [
      ...filteredCommands.map((c) => ({ type: 'command' as const, command: c })),
      ...results.map((r) => ({ type: 'result' as const, result: r })),
    ],
    [filteredCommands, results],
  );

  useEffect(() => {
    const el = listRef.current?.querySelector('[data-active="true"]');
    el?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const run = (index: number) => {
    const item = flat[index];
    if (!item) return;
    if (item.type === 'command') item.command.run();
    else router.push(item.result.href);
    setOpen(false);
  };

  const grouped = groupResults(results);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-bg/72 px-4 pt-[12vh] backdrop-blur-[2px]"
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
      onClick={() => setOpen(false)}
    >
      <div
        className="panel w-full max-w-[620px] overflow-hidden shadow-2xl"
        style={{ background: 'var(--color-panel)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 border-b border-line px-3 py-2.5">
          <Search size={15} className="shrink-0 text-ink-3" aria-hidden />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive((a) => Math.min(a + 1, flat.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((a) => Math.max(a - 1, 0));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                run(active);
              } else if (e.key === 'Escape') {
                setOpen(false);
              }
            }}
            placeholder="Search stations, anomalies, incidents — or run a command"
            aria-label="Search or run a command"
            className="w-full bg-transparent text-[13px] text-ink placeholder:text-ink-3 focus:outline-none"
          />
          <kbd className="shrink-0 rounded-[2px] border border-line px-1 py-px text-[9.5px] text-ink-3">
            ESC
          </kbd>
        </div>

        <div ref={listRef} className="max-h-[52vh] overflow-y-auto py-1">
          {flat.length === 0 && (
            <p className="px-3 py-6 text-center text-[12px] text-ink-3">
              Nothing matched “{query}”.
            </p>
          )}

          {filteredCommands.length > 0 && (
            <div className="mb-1">
              <div className="eyebrow px-3 py-1">Commands</div>
              {filteredCommands.map((c, i) => (
                <button
                  key={c.id}
                  type="button"
                  data-active={active === i}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => run(i)}
                  className={cn(
                    'flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[12px] transition-colors',
                    active === i ? 'bg-raised text-ink' : 'text-ink-2 hover:bg-hover',
                  )}
                >
                  <ArrowRight size={12} className="shrink-0 text-ink-3" aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{c.label}</span>
                  {c.hint && (
                    <kbd className="shrink-0 rounded-[2px] border border-line px-1 text-[9px] text-ink-3">
                      {c.hint}
                    </kbd>
                  )}
                </button>
              ))}
            </div>
          )}

          {grouped.map(([kind, items]) => (
            <div key={kind} className="mb-1">
              <div className="eyebrow px-3 py-1">{KIND_LABELS[kind]}</div>
              {items.map((r) => {
                const index = flat.findIndex(
                  (f) => f.type === 'result' && f.result.id === r.id && f.result.kind === r.kind,
                );
                return (
                  <button
                    key={`${r.kind}:${r.id}`}
                    type="button"
                    data-active={active === index}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => run(index)}
                    className={cn(
                      'flex w-full items-start gap-2.5 px-3 py-1.5 text-left transition-colors',
                      active === index ? 'bg-raised' : 'hover:bg-hover',
                    )}
                  >
                    <Sparkles size={12} className="mt-0.5 shrink-0 text-ink-3" aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12px] text-ink">{r.title}</span>
                      <span className="block truncate text-[10.5px] text-ink-3">{r.subtitle}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>

        <div className="flex items-center justify-between border-t border-line px-3 py-1.5 text-[10px] text-ink-3">
          <span className="flex items-center gap-1">
            <CornerDownLeft size={10} aria-hidden /> to select · ↑↓ to navigate
          </span>
          <span>{flat.length} result{flat.length === 1 ? '' : 's'}</span>
        </div>
      </div>
    </div>
  );
}
