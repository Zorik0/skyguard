'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ChevronLeft, Radar } from 'lucide-react';
import { cn } from '@/lib/utils';
import { NAV_GROUPS, NAV_ITEMS } from '@/lib/navigation';
import { useResolvedWorld } from '@/hooks/useWorld';

/**
 * Primary navigation.
 *
 * Grouped by what an operator is trying to do — monitor, investigate, act —
 * rather than by data type, and annotated with live counts so the sidebar
 * itself reports network state.
 */
export function Sidebar() {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const world = useResolvedWorld();

  const counts: Record<string, number> = {
    '/anomalies': world?.anomalies.filter((a) => a.endedAt === null).length ?? 0,
    '/incidents': world?.incidents.filter((i) => i.status !== 'resolved').length ?? 0,
    '/alerts': world?.alerts.filter((a) => a.state === 'new').length ?? 0,
    '/maintenance': world?.maintenance.filter((m) => m.status !== 'completed').length ?? 0,
  };

  const criticalPaths = new Set<string>();
  if ((world?.metrics.criticalAlerts ?? 0) > 0) criticalPaths.add('/alerts');
  if (world?.anomalies.some((a) => a.severity === 'critical' && a.endedAt === null)) {
    criticalPaths.add('/anomalies');
  }

  return (
    <nav
      aria-label="Main navigation"
      className={cn(
        'flex shrink-0 flex-col border-r border-line bg-panel transition-[width] duration-200',
        collapsed ? 'w-[52px]' : 'w-[196px]',
      )}
    >
      <div className="flex h-[46px] shrink-0 items-center gap-2 border-b border-line px-3">
        <Radar size={17} className="shrink-0 text-healthy" aria-hidden />
        {!collapsed && (
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] leading-none font-semibold tracking-tight">
              SkyGuard
            </div>
            <div className="mt-0.5 truncate text-[9.5px] tracking-wide text-ink-3 uppercase">
              AWS Operations
            </div>
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto py-2">
        {NAV_GROUPS.map((group) => {
          const items = NAV_ITEMS.filter((i) => i.group === group.id);
          if (!items.length) return null;
          return (
            <div key={group.id} className="mb-2">
              {!collapsed && <div className="eyebrow px-3 py-1">{group.label}</div>}
              <ul>
                {items.map((item) => {
                  const active =
                    item.href === '/'
                      ? pathname === '/'
                      : pathname.startsWith(item.href);
                  const count = counts[item.href] ?? 0;
                  const Icon = item.icon;
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        title={collapsed ? `${item.label} (${item.shortcut})` : item.description}
                        aria-current={active ? 'page' : undefined}
                        className={cn(
                          'group relative flex items-center gap-2.5 px-3 py-[5px] text-[12px] transition-colors',
                          active
                            ? 'bg-raised font-medium text-ink'
                            : 'text-ink-2 hover:bg-hover hover:text-ink',
                        )}
                      >
                        {active && (
                          <span
                            className="absolute inset-y-0 left-0 w-[2px] bg-healthy"
                            aria-hidden
                          />
                        )}
                        <Icon size={14} className="shrink-0" aria-hidden />
                        {!collapsed && (
                          <>
                            <span className="min-w-0 flex-1 truncate">{item.label}</span>
                            {count > 0 && (
                              <span
                                className={cn(
                                  'tnum shrink-0 rounded-[2px] px-1 text-[9.5px] leading-[14px]',
                                  criticalPaths.has(item.href)
                                    ? 'bg-failed/18 text-failed'
                                    : 'bg-line text-ink-3',
                                )}
                              >
                                {count}
                              </span>
                            )}
                            <kbd className="shrink-0 text-[9px] text-ink-3 opacity-0 transition-opacity group-hover:opacity-100">
                              {item.shortcut.toUpperCase()}
                            </kbd>
                          </>
                        )}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </div>

      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        aria-expanded={!collapsed}
        className="flex h-8 shrink-0 items-center gap-2 border-t border-line px-3 text-[11px] text-ink-3 transition-colors hover:bg-hover hover:text-ink"
      >
        <ChevronLeft
          size={13}
          className={cn('shrink-0 transition-transform', collapsed && 'rotate-180')}
          aria-hidden
        />
        {!collapsed && <span>Collapse</span>}
      </button>
    </nav>
  );
}
