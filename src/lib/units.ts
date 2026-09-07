import type { SensorType, Severity, StationStatus } from '@/types';
import type { Settings } from '@/store/useSkyGuard';
import { round } from '@/lib/utils';

/**
 * Unit presentation.
 *
 * The simulation and every engine work exclusively in SI. Conversion happens
 * once, at the edge, when a value is formatted for display — so an operator
 * switching to Fahrenheit changes what they read, never what the physics
 * engine computed.
 */

export function convertTemperature(celsius: number, unit: Settings['temperatureUnit']) {
  return unit === 'F' ? celsius * 1.8 + 32 : celsius;
}

export function temperatureSuffix(unit: Settings['temperatureUnit']) {
  return unit === 'F' ? '°F' : '°C';
}

const WIND_FACTORS: Record<Settings['windUnit'], number> = {
  ms: 1,
  kmh: 3.6,
  kt: 1.943844,
  mph: 2.236936,
};

const WIND_SUFFIX: Record<Settings['windUnit'], string> = {
  ms: 'm/s',
  kmh: 'km/h',
  kt: 'kt',
  mph: 'mph',
};

export function convertWind(ms: number, unit: Settings['windUnit']) {
  return ms * WIND_FACTORS[unit];
}

export function windSuffix(unit: Settings['windUnit']) {
  return WIND_SUFFIX[unit];
}

export function convertPressure(hPa: number, unit: Settings['pressureUnit']) {
  return unit === 'inHg' ? hPa * 0.0295299830714 : hPa;
}

export function pressureSuffix(unit: Settings['pressureUnit']) {
  return unit === 'inHg' ? 'inHg' : 'hPa';
}

export interface FormattedValue {
  value: string;
  suffix: string;
}

/** Format a channel value in the operator's preferred units. */
export function formatSensorValue(
  sensorType: SensorType,
  value: number | null | undefined,
  settings: Settings,
): FormattedValue {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return { value: '—', suffix: '' };
  }
  switch (sensorType) {
    case 'temperature':
      return {
        value: round(convertTemperature(value, settings.temperatureUnit), 1).toFixed(1),
        suffix: temperatureSuffix(settings.temperatureUnit),
      };
    case 'humidity':
      return { value: round(value, 1).toFixed(1), suffix: '%' };
    case 'pressure':
      return {
        value: settings.pressureUnit === 'inHg'
          ? convertPressure(value, 'inHg').toFixed(2)
          : round(value, 1).toFixed(1),
        suffix: pressureSuffix(settings.pressureUnit),
      };
    case 'wind_speed':
      return {
        value: round(convertWind(value, settings.windUnit), 1).toFixed(1),
        suffix: windSuffix(settings.windUnit),
      };
    case 'wind_direction':
      return { value: Math.round(value).toString(), suffix: '°' };
    case 'rainfall':
      return { value: round(value, 2).toFixed(2), suffix: 'mm' };
    case 'battery':
      return { value: round(value, 2).toFixed(2), suffix: 'V' };
    case 'comms':
      return { value: Math.round(value).toString(), suffix: 'dBm' };
    default:
      return { value: round(value, 2).toString(), suffix: '' };
  }
}

/** Convert a *difference* — no additive offset for temperature. */
export function formatDelta(
  sensorType: SensorType,
  delta: number,
  settings: Settings,
): string {
  let v = delta;
  let suffix = '';
  switch (sensorType) {
    case 'temperature':
      v = settings.temperatureUnit === 'F' ? delta * 1.8 : delta;
      suffix = settings.temperatureUnit === 'F' ? '°F' : '°C';
      break;
    case 'humidity': suffix = '%'; break;
    case 'pressure':
      v = convertPressure(delta, settings.pressureUnit);
      suffix = pressureSuffix(settings.pressureUnit);
      break;
    case 'wind_speed':
      v = convertWind(delta, settings.windUnit);
      suffix = windSuffix(settings.windUnit);
      break;
    case 'rainfall': suffix = 'mm'; break;
    case 'battery': suffix = 'V'; break;
    case 'comms': suffix = 'dBm'; break;
    default: break;
  }
  const dp = Math.abs(v) < 1 ? 2 : 1;
  return `${v >= 0 ? '+' : ''}${v.toFixed(dp)}${suffix}`;
}

/* ------------------------------------------------------------- statuses -- */

export const STATUS_META: Record<
  StationStatus,
  { label: string; color: string; text: string; bg: string; description: string }
> = {
  healthy:  { label: 'Healthy',  color: 'var(--color-healthy)',  text: 'text-healthy',  bg: 'bg-healthy',  description: 'All channels within specification' },
  event:    { label: 'Weather',  color: 'var(--color-event)',    text: 'text-event',    bg: 'bg-event',    description: 'Genuine meteorological event in progress' },
  warning:  { label: 'Warning',  color: 'var(--color-warning)',  text: 'text-warning',  bg: 'bg-warning',  description: 'Degradation detected on one or more channels' },
  critical: { label: 'Critical', color: 'var(--color-critical)', text: 'text-critical', bg: 'bg-critical', description: 'A channel is producing unusable data' },
  failed:   { label: 'Failed',   color: 'var(--color-failed)',   text: 'text-failed',   bg: 'bg-failed',   description: 'Station is unreliable and needs intervention' },
  offline:  { label: 'Offline',  color: 'var(--color-offline)',  text: 'text-offline',  bg: 'bg-offline',  description: 'No packets received recently' },
};

export const SEVERITY_META: Record<
  Severity,
  { label: string; color: string; text: string; rank: number }
> = {
  critical: { label: 'Critical',    color: 'var(--color-failed)',   text: 'text-failed',   rank: 0 },
  high:     { label: 'High',        color: 'var(--color-critical)', text: 'text-critical', rank: 1 },
  warning:  { label: 'Warning',     color: 'var(--color-warning)',  text: 'text-warning',  rank: 2 },
  info:     { label: 'Information', color: 'var(--color-event)',    text: 'text-event',    rank: 3 },
};

export const HEALTH_BAND_COLOR: Record<string, string> = {
  healthy: 'var(--color-healthy)',
  minor: '#7fd6a8',
  warning: 'var(--color-warning)',
  critical: 'var(--color-critical)',
  failed: 'var(--color-failed)',
};

export function healthColor(score: number) {
  if (score >= 80) return 'var(--color-healthy)';
  if (score >= 60) return '#7fd6a8';
  if (score >= 40) return 'var(--color-warning)';
  if (score >= 20) return 'var(--color-critical)';
  return 'var(--color-failed)';
}

/* --------------------------------------------------------- data sources -- */

export const SOURCE_META: Record<
  string,
  { label: string; description: string; color: string }
> = {
  LIVE: {
    label: 'LIVE',
    description: 'Observed by the station and received in the current packet.',
    color: 'var(--color-healthy)',
  },
  SIMULATED: {
    label: 'SIMULATED',
    description:
      'Generated by the deterministic station simulator. Public weather APIs cannot report the internal state of this network’s hardware, so all station telemetry is simulated.',
    color: 'var(--color-event)',
  },
  EXTERNAL_MODEL: {
    label: 'EXTERNAL',
    description: 'Retrieved live from the Open-Meteo numerical weather model.',
    color: '#a78bfa',
  },
  CORRECTED: {
    label: 'CORRECTED',
    description:
      'A quality-controlled estimate produced by the correction ensemble. The raw value is preserved unchanged in the audit trail.',
    color: 'var(--color-warning)',
  },
  ESTIMATED: {
    label: 'ESTIMATED',
    description: 'Derived by a model rather than measured. Treat as an estimate.',
    color: 'var(--color-warning)',
  },
  MODELLED: {
    label: 'MODELLED',
    description: 'Computed by the physics and digital-twin models from other observations.',
    color: '#a78bfa',
  },
};
