import { z } from 'zod';
import type { EnsembleBand, ExternalCurrent, ExternalHourly } from '@/types';
import { HOUR, round } from '@/lib/utils';
import { fetchJson, type WeatherBundle, type WeatherPoint, type WeatherProvider } from './provider';

/**
 * Open-Meteo provider.
 *
 * No API key, generous free tier, and — importantly for a station network —
 * it accepts many coordinates in a single request, so twelve stations cost one
 * round trip rather than twelve.
 *
 * Every response is validated before it reaches the rest of the application.
 * A provider that changes its schema, truncates an array, or returns nulls
 * mid-series should degrade the external context to "unavailable", never
 * corrupt the analysis.
 */

const FORECAST_HOST = 'https://api.open-meteo.com/v1/forecast';
const ENSEMBLE_HOST = 'https://ensemble-api.open-meteo.com/v1/ensemble';

/** Cache windows, matched to how fast each product actually changes. */
export const CACHE_SECONDS = {
  current: 300,
  forecast: 1800,
  ensemble: 3600,
  /** Terrain does not move. */
  elevation: 31_536_000,
};

const numberOrNull = z.union([z.number(), z.null()]).optional();

const currentSchema = z.object({
  time: z.string(),
  temperature_2m: numberOrNull,
  relative_humidity_2m: numberOrNull,
  surface_pressure: numberOrNull,
  dew_point_2m: numberOrNull,
  wind_speed_10m: numberOrNull,
  wind_direction_10m: numberOrNull,
  precipitation: numberOrNull,
  weather_code: numberOrNull,
});

const hourlySchema = z.object({
  time: z.array(z.string()),
  temperature_2m: z.array(numberOrNull).optional(),
  relative_humidity_2m: z.array(numberOrNull).optional(),
  surface_pressure: z.array(numberOrNull).optional(),
  dew_point_2m: z.array(numberOrNull).optional(),
  wind_speed_10m: z.array(numberOrNull).optional(),
  precipitation: z.array(numberOrNull).optional(),
  precipitation_probability: z.array(numberOrNull).optional(),
});

const locationSchema = z.object({
  latitude: z.number(),
  longitude: z.number(),
  elevation: z.number().nullable().optional(),
  current: currentSchema.optional(),
  hourly: hourlySchema.optional(),
});

/** A single coordinate returns an object; several return an array. */
const forecastResponse = z.union([locationSchema, z.array(locationSchema)]);

const ensembleResponse = z.object({
  hourly: z.record(z.string(), z.union([z.array(z.string()), z.array(numberOrNull)])),
});

const HOURLY_FIELDS = [
  'temperature_2m',
  'relative_humidity_2m',
  'surface_pressure',
  'dew_point_2m',
  'wind_speed_10m',
  'precipitation',
  'precipitation_probability',
].join(',');

const CURRENT_FIELDS = [
  'temperature_2m',
  'relative_humidity_2m',
  'surface_pressure',
  'dew_point_2m',
  'wind_speed_10m',
  'wind_direction_10m',
  'precipitation',
  'weather_code',
].join(',');

function toMs(iso: string): number {
  // Open-Meteo returns naive local-to-timezone strings; we always ask for UTC.
  return Date.parse(iso.endsWith('Z') ? iso : `${iso}Z`);
}

function mapCurrent(loc: z.infer<typeof locationSchema>): ExternalCurrent | null {
  const c = loc.current;
  if (!c || c.temperature_2m == null) return null;
  return {
    t: toMs(c.time),
    temperature: c.temperature_2m,
    humidity: c.relative_humidity_2m ?? 0,
    pressure: c.surface_pressure ?? 0,
    dewPoint: c.dew_point_2m ?? 0,
    windSpeed: c.wind_speed_10m ?? 0,
    windDirection: c.wind_direction_10m ?? 0,
    precipitation: c.precipitation ?? 0,
    weatherCode: c.weather_code ?? 0,
    elevation: loc.elevation ?? null,
  };
}

function mapHourly(loc: z.infer<typeof locationSchema>): ExternalHourly[] {
  const h = loc.hourly;
  if (!h?.time?.length) return [];
  const out: ExternalHourly[] = [];
  for (let i = 0; i < h.time.length; i++) {
    const temperature = h.temperature_2m?.[i];
    // A row with no temperature carries no usable context; drop it rather than
    // substituting a zero that would later look like a real observation.
    if (temperature == null) continue;
    out.push({
      t: toMs(h.time[i]),
      temperature,
      humidity: h.relative_humidity_2m?.[i] ?? 0,
      pressure: h.surface_pressure?.[i] ?? 0,
      dewPoint: h.dew_point_2m?.[i] ?? 0,
      windSpeed: h.wind_speed_10m?.[i] ?? 0,
      precipitation: h.precipitation?.[i] ?? 0,
      precipitationProbability: h.precipitation_probability?.[i] ?? 0,
    });
  }
  return out;
}

function buildUrl(points: WeatherPoint[], pastDays: number, forecastDays: number): string {
  const params = new URLSearchParams({
    latitude: points.map((p) => p.latitude.toFixed(4)).join(','),
    longitude: points.map((p) => p.longitude.toFixed(4)).join(','),
    current: CURRENT_FIELDS,
    hourly: HOURLY_FIELDS,
    timezone: 'UTC',
    wind_speed_unit: 'ms',
    past_days: String(pastDays),
    forecast_days: String(forecastDays),
  });
  return `${FORECAST_HOST}?${params.toString()}`;
}

export class OpenMeteoProvider implements WeatherProvider {
  readonly name = 'Open-Meteo';
  readonly attribution = 'Weather data by Open-Meteo.com (CC BY 4.0)';

  async getBundles(points: WeatherPoint[]): Promise<WeatherBundle[]> {
    if (!points.length) return [];
    const raw = await fetchJson<unknown>(buildUrl(points, 1, 2), CACHE_SECONDS.current);
    const parsed = forecastResponse.parse(raw);
    const locations = Array.isArray(parsed) ? parsed : [parsed];

    // The provider returns results positionally. If the counts disagree we
    // cannot safely match a forecast to a station, so we take none of them.
    if (locations.length !== points.length) {
      throw new Error(
        `Provider returned ${locations.length} locations for ${points.length} stations`,
      );
    }

    return locations.map((loc) => ({
      current: mapCurrent(loc),
      hourly: mapHourly(loc),
      elevation: loc.elevation ?? null,
    }));
  }

  async getCurrentWeather(point: WeatherPoint) {
    const [bundle] = await this.getBundles([point]);
    return bundle?.current ?? null;
  }

  async getHourlyForecast(point: WeatherPoint) {
    const [bundle] = await this.getBundles([point]);
    return bundle?.hourly ?? [];
  }

  async getHistoricalWeather(point: WeatherPoint, days: number) {
    const raw = await fetchJson<unknown>(buildUrl([point], days, 1), CACHE_SECONDS.forecast);
    const parsed = forecastResponse.parse(raw);
    const loc = Array.isArray(parsed) ? parsed[0] : parsed;
    return loc ? mapHourly(loc) : [];
  }

  async getElevation(point: WeatherPoint) {
    const [bundle] = await this.getBundles([point]);
    return bundle?.elevation ?? null;
  }

  /**
   * Ensemble spread, used to express forecast uncertainty as a range rather
   * than a single deceptively precise number.
   */
  async getEnsembleForecast(point: WeatherPoint): Promise<EnsembleBand[]> {
    const params = new URLSearchParams({
      latitude: point.latitude.toFixed(4),
      longitude: point.longitude.toFixed(4),
      hourly: 'temperature_2m',
      models: 'icon_seamless',
      timezone: 'UTC',
      forecast_days: '3',
    });
    const raw = await fetchJson<unknown>(
      `${ENSEMBLE_HOST}?${params.toString()}`,
      CACHE_SECONDS.ensemble,
    );
    const parsed = ensembleResponse.parse(raw);
    const times = parsed.hourly.time as string[] | undefined;
    if (!times?.length) return [];

    const members = Object.entries(parsed.hourly)
      .filter(([key]) => key.startsWith('temperature_2m'))
      .map(([, values]) => values as (number | null)[]);
    if (!members.length) return [];

    const bands: EnsembleBand[] = [];
    for (let i = 0; i < times.length; i++) {
      const vals = members
        .map((m) => m[i])
        .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
      if (!vals.length) continue;
      bands.push({
        t: toMs(times[i]),
        mean: round(vals.reduce((a, b) => a + b, 0) / vals.length, 2),
        min: round(Math.min(...vals), 2),
        max: round(Math.max(...vals), 2),
      });
    }
    return bands;
  }
}

export const openMeteo = new OpenMeteoProvider();
export { HOUR };
