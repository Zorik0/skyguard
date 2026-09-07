'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { format } from 'date-fns';
import { Bell, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useSkyGuard } from '@/store/useSkyGuard';
import { useResolvedWorld } from '@/hooks/useWorld';
import { SEVERITY_META } from '@/lib/units';
import { Button, EmptyState } from '@/components/ui/primitives';

/**
 * Notification centre.
 *
 * Notifications are raised from incidents, not from raw anomalies, which is
 * what keeps a single front from producing twenty-six separate pings.
 */
export function NotificationCenter() {
  const [open, setOpen] = useState(false);
  const notifications = useSkyGuard((s) => s.notifications);
  const pushNotification = useSkyGuard((s) => s.pushNotification);
  const markRead = useSkyGuard((s) => s.markNotificationsRead);
  const dismiss = useSkyGuard((s) => s.dismissNotification);
  const world = useResolvedWorld();
  const seeded = useRef(false);
  const ref = useRef<HTMLDivElement>(null);

  // Seed once from the incidents already open when the console is first loaded.
  useEffect(() => {
    if (seeded.current || !world) return;
    seeded.current = true;
    const open3 = world.incidents
      .filter((i) => i.status !== 'resolved' && i.severity !== 'info')
      .slice(0, 4);
    for (const incident of open3) {
      pushNotification({
        title: incident.title,
        body: `${incident.stationIds.length} station${incident.stationIds.length === 1 ? '' : 's'} affected · ${incident.confidence}% confidence`,
        t: incident.startedAt,
        severity: incident.severity,
        href: `/incidents/${incident.id}`,
      });
    }
  }, [world, pushNotification]);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  const unread = notifications.filter((n) => !n.read).length;

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => {
          setOpen((o) => !o);
          if (!open) markRead();
        }}
        aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`}
        aria-expanded={open}
        className="relative flex h-7 w-7 items-center justify-center rounded-[3px] border border-line bg-raised text-ink-2 transition-colors hover:border-line-strong hover:text-ink"
      >
        <Bell size={13} aria-hidden />
        {unread > 0 && (
          <span
            className="tnum absolute -top-1 -right-1 min-w-[14px] rounded-full bg-failed px-[3px] text-center text-[8.5px] leading-[14px] font-semibold text-bg"
            aria-hidden
          >
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="panel absolute right-0 z-50 mt-1.5 max-h-[70vh] w-[340px] overflow-hidden shadow-2xl">
          <header className="panel-header">
            <h2 className="text-[12px] font-semibold">Notifications</h2>
            <span className="text-[10px] text-ink-3">{notifications.length}</span>
          </header>
          <div className="max-h-[60vh] overflow-y-auto">
            {notifications.length === 0 ? (
              <EmptyState title="Nothing to report" detail="Incidents raised while you are away will appear here." />
            ) : (
              <ul className="divide-y divide-line">
                {notifications.map((n) => (
                  <li key={n.id} className="group flex items-start gap-2 px-2.5 py-2 hover:bg-hover">
                    <span
                      className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full"
                      style={{ background: SEVERITY_META[n.severity].color }}
                      aria-hidden
                    />
                    <div className="min-w-0 flex-1">
                      {n.href ? (
                        <Link
                          href={n.href}
                          onClick={() => setOpen(false)}
                          className="block truncate text-[11.5px] font-medium text-ink hover:underline"
                        >
                          {n.title}
                        </Link>
                      ) : (
                        <div className="truncate text-[11.5px] font-medium text-ink">{n.title}</div>
                      )}
                      <p className="mt-0.5 text-[10.5px] leading-snug text-ink-3">{n.body}</p>
                      <time className="tnum mt-0.5 block text-[9.5px] text-ink-3">
                        {format(n.t, 'dd MMM HH:mm:ss')}
                      </time>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      className={cn('opacity-0 transition-opacity group-hover:opacity-100')}
                      onClick={() => dismiss(n.id)}
                    >
                      <X size={11} aria-hidden />
                      <span className="sr-only">Dismiss</span>
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
