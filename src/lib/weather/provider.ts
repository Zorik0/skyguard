import type { EnsembleBand, ExternalCurrent, ExternalHourly, RadarMeta } from '@/types';

/**
 * The external-context boundary.
 *
 * Nothing in the UI talks to a weather API directly. Everything goes through
 * this interface, so the provider can be swapped, mocked, or removed entirely
 * without any screen noticing — which is also what makes the "external context
 * unavailable" path a first-class state rather than an error.
 */
export interface WeatherPoint {
  latitude: number;
  longitude: number;
}

export interface WeatherBundle {
  current: ExternalCurrent | null;
  hourly: ExternalHourly[];
  elevation: number | null;
}

export interface WeatherProvider {
  readonly name: string;
  readonly attribution: string;
  getCurrentWeather(point: WeatherPoint): Promise<ExternalCurrent | null>;
  getHourlyForecast(point: WeatherPoint): Promise<ExternalHourly[]>;
  getHistoricalWeather(point: WeatherPoint, days: number): Promise<ExternalHourly[]>;
  getElevation(point: WeatherPoint): Promise<number | null>;
  getEnsembleForecast(point: WeatherPoint): Promise<EnsembleBand[]>;
  /** One round trip for a whole network of stations. */
  getBundles(points: WeatherPoint[]): Promise<WeatherBundle[]>;
}

export interface RadarProvider {
  readonly name: string;
  readonly attribution: string;
  getRadarMeta(): Promise<RadarMeta>;
}

/** Every external call is bounded; a slow provider must not stall a dashboard. */
export const EXTERNAL_TIMEOUT_MS = 8000;

export async function fetchJson<T>(
  url: string,
  revalidateSeconds: number,
): Promise<T> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(EXTERNAL_TIMEOUT_MS),
    next: { revalidate: revalidateSeconds },
    headers: { accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(
      res.status === 429
        ? 'Rate limited by the weather provider'
        : `Weather provider returned ${res.status}`,
    );
  }
  return (await res.json()) as T;
}
