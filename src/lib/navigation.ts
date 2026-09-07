import {
  Activity,
  AlertTriangle,
  Bell,
  CloudSun,
  FileText,
  FlaskConical,
  Gauge,
  HeartPulse,
  History,
  LayoutDashboard,
  Map as MapIcon,
  ScrollText,
  Settings as SettingsIcon,
  ShieldAlert,
  Wrench,
  type LucideIcon,
} from 'lucide-react';

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Single-key shortcut, active when focus is not in a text field. */
  shortcut: string;
  description: string;
  group: 'monitor' | 'investigate' | 'act' | 'system';
}

export const NAV_ITEMS: NavItem[] = [
  { href: '/',            label: 'Overview',        icon: LayoutDashboard, shortcut: '1', group: 'monitor',     description: 'Network health at a glance' },
  { href: '/map',         label: 'Network Map',     icon: MapIcon,         shortcut: '2', group: 'monitor',     description: 'Geographic view with radar and incident layers' },
  { href: '/monitoring',  label: 'Live Monitoring', icon: Activity,        shortcut: '3', group: 'monitor',     description: 'Synchronised channel charts for one station' },
  { href: '/anomalies',   label: 'Anomalies',       icon: AlertTriangle,   shortcut: '4', group: 'investigate', description: 'Every detection with its evidence' },
  { href: '/incidents',   label: 'Incidents',       icon: ShieldAlert,     shortcut: '5', group: 'investigate', description: 'Correlated anomalies grouped into events' },
  { href: '/events',      label: 'Weather Events',  icon: CloudSun,        shortcut: '6', group: 'investigate', description: 'Meteorological analysis and propagation' },
  { href: '/corrections', label: 'Corrected Values',icon: Gauge,           shortcut: '7', group: 'investigate', description: 'Raw against quality-controlled estimates' },
  { href: '/health',      label: 'Sensor Health',   icon: HeartPulse,      shortcut: '8', group: 'act',         description: 'Per-sensor scores across the network' },
  { href: '/maintenance', label: 'Maintenance',     icon: Wrench,          shortcut: '9', group: 'act',         description: 'Predictive maintenance queue' },
  { href: '/history',     label: 'Historical',      icon: History,         shortcut: '0', group: 'investigate', description: 'Search past anomalies and find similar events' },
  { href: '/models',      label: 'Model Lab',       icon: FlaskConical,    shortcut: 'l', group: 'system',      description: 'Compare detectors and shadow models' },
  { href: '/alerts',      label: 'Alerts',          icon: Bell,            shortcut: 'a', group: 'act',         description: 'Grouped operator alerts' },
  { href: '/reports',     label: 'Reports',         icon: FileText,        shortcut: 'r', group: 'system',      description: 'Export datasets and operational reports' },
  { href: '/audit',       label: 'Audit Log',       icon: ScrollText,      shortcut: 'u', group: 'system',      description: 'Complete provenance for every value' },
  { href: '/settings',    label: 'Settings',        icon: SettingsIcon,    shortcut: 's', group: 'system',      description: 'Units, thresholds and providers' },
];

export const NAV_GROUPS: { id: NavItem['group']; label: string }[] = [
  { id: 'monitor', label: 'Monitor' },
  { id: 'investigate', label: 'Investigate' },
  { id: 'act', label: 'Act' },
  { id: 'system', label: 'System' },
];

export const SHORTCUT_MAP = new Map(NAV_ITEMS.map((i) => [i.shortcut, i.href]));

/** True when a keystroke should be treated as text entry, not a shortcut. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    target.isContentEditable
  );
}
