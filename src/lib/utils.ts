import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export function clamp(v: number, min: number, max: number) {
  return Math.min(max, Math.max(min, v));
}

export function round(v: number, dp = 1) {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}

export function mean(values: number[]) {
  if (!values.length) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function stdev(values: number[]) {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(
    values.reduce((a, b) => a + (b - m) ** 2, 0) / (values.length - 1),
  );
}

export function median(values: number[]) {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Ordinary least squares slope of y against index, in units per sample. */
export function slope(values: number[]) {
  const n = values.length;
  if (n < 2) return 0;
  const mx = (n - 1) / 2;
  const my = mean(values);
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - mx) * (values[i] - my);
    den += (i - mx) ** 2;
  }
  return den === 0 ? 0 : num / den;
}

/**
 * OLS slope together with its standard error, so a trend can be tested for
 * significance instead of being reported whether or not it is real.
 */
export function slopeWithError(values: number[]): { slope: number; se: number } {
  const n = values.length;
  if (n < 4) return { slope: 0, se: Infinity };
  const mx = (n - 1) / 2;
  const my = mean(values);
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (i - mx) * (values[i] - my);
    sxx += (i - mx) ** 2;
  }
  if (sxx === 0) return { slope: 0, se: Infinity };
  const b = sxy / sxx;
  const a = my - b * mx;
  let sse = 0;
  for (let i = 0; i < n; i++) sse += (values[i] - (a + b * i)) ** 2;
  return { slope: b, se: Math.sqrt(sse / (n - 2) / sxx) };
}

/** Pearson correlation, used for neighbour relevance. */
export function correlation(a: number[], b: number[]) {
  const n = Math.min(a.length, b.length);
  if (n < 3) return 0;
  const ma = mean(a.slice(0, n));
  const mb = mean(b.slice(0, n));
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma;
    const y = b[i] - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  if (da === 0 || db === 0) return 0;
  return num / Math.sqrt(da * db);
}

/** Great-circle distance in kilometres. */
export function haversineKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
) {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** Magnus formula — dew point from temperature and relative humidity. */
export function dewPoint(tempC: number, rh: number) {
  const h = clamp(rh, 1, 100);
  const a = 17.62;
  const b = 243.12;
  const g = Math.log(h / 100) + (a * tempC) / (b + tempC);
  return (b * g) / (a - g);
}

/** Relative humidity implied by a temperature and dew point. */
export function rhFromDewPoint(tempC: number, td: number) {
  const a = 17.62;
  const b = 243.12;
  return (
    100 *
    Math.exp((a * td) / (b + td) - (a * tempC) / (b + tempC))
  );
}

/** Reduce station pressure to mean sea level so stations compare fairly. */
export function toSeaLevel(pressureHpa: number, elevationM: number, tempC: number) {
  return pressureHpa * Math.exp((elevationM * 9.80665) / (287.05 * (tempC + 273.15)));
}

export function fromSeaLevel(mslpHpa: number, elevationM: number, tempC: number) {
  return mslpHpa / Math.exp((elevationM * 9.80665) / (287.05 * (tempC + 273.15)));
}

export function pctl(values: number[], p: number) {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const idx = clamp(Math.round((p / 100) * (s.length - 1)), 0, s.length - 1);
  return s[idx];
}

/** Evenly thin a series down to at most `max` points for charting. */
export function downsample<T>(items: T[], max: number): T[] {
  if (items.length <= max) return items;
  const step = items.length / max;
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(items[Math.floor(i * step)]);
  const last = items[items.length - 1];
  if (out[out.length - 1] !== last) out[out.length - 1] = last;
  return out;
}

export function compassPoint(deg: number) {
  const points = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
  return points[Math.round(((deg % 360) / 22.5)) % 16];
}
