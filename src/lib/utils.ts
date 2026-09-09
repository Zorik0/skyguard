import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Shared maths and formatting helpers.
 *
 * If you are reading the codebase for the first time, start here. Almost
 * every analysis file in `src/lib` is built out of these few functions, so
 * understanding them makes the rest much shorter.
 */

/**
 * Join CSS class names, letting later Tailwind classes win.
 *
 * `clsx` drops falsy values so you can write conditions inline; `twMerge`
 * resolves conflicts, so `cn('p-2', 'p-4')` gives `'p-4'` rather than both.
 * Without it, "override the padding on this one instance" would depend on
 * stylesheet ordering, which is not something you want to reason about.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Time constants in milliseconds — the unit JavaScript's `Date` uses.
 *
 * Named constants rather than raw numbers: `6 * HOUR` says what it means,
 * `21600000` does not. The underscore in `60_000` is just a digit separator
 * that JavaScript ignores; it exists so your eye can find the thousands.
 */
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/**
 * Force a value into the range min..max.
 *
 *   clamp(105, 0, 100) → 100      relative humidity cannot exceed 100%
 *   clamp(-3,  0, 100) → 0
 *   clamp(42,  0, 100) → 42       already in range, untouched
 */
export function clamp(v: number, min: number, max: number) {
  return Math.min(max, Math.max(min, v));
}

/**
 * Round to `dp` decimal places.
 *
 * `Math.round` only does whole numbers, so we scale up, round, scale back:
 * `round(3.14159, 2)` → 314.159 → 314 → 3.14. Used at display time only;
 * calculations keep full precision.
 */
export function round(v: number, dp = 1) {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}

/** The average. Empty input returns 0 rather than NaN, so charts never break. */
export function mean(values: number[]) {
  if (!values.length) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * Standard deviation — the typical distance of a value from the mean.
 *
 * This is the single most important statistic in the codebase, because "how
 * unusual is this reading?" is measured in standard deviations (written σ,
 * "sigma"). Both of these have a mean of 20 °C:
 *
 *   [19.8, 20.1, 19.9, 20.2]   σ ≈ 0.18   a calm, steady channel
 *   [12.0, 28.0, 15.0, 25.0]   σ ≈ 7.53   a wild one
 *
 * A 21 °C reading is alarming in the first channel and unremarkable in the
 * second. σ is what lets one threshold serve both.
 *
 * Dividing by `n - 1` rather than `n` is Bessel's correction. A sample
 * slightly understates the spread of the population it was drawn from,
 * because the sample mean sits closer to the sample than the true mean does;
 * the smaller divisor compensates.
 */
export function stdev(values: number[]) {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(
    values.reduce((a, b) => a + (b - m) ** 2, 0) / (values.length - 1),
  );
}

/**
 * The middle value once sorted.
 *
 * Preferred over `mean` whenever a broken sensor might be in the input: one
 * reading of 61 °C drags the mean of a dozen normal readings several degrees
 * upward, but moves the median barely at all. That property is called
 * robustness, and it is why the neighbour consensus code reaches for medians.
 */
export function median(values: number[]) {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Ordinary least squares slope of y against index, in units per sample.
 *
 * "Fit a straight line through these points and tell me how steep it is."
 * That slope is the trend: positive means rising, negative means falling,
 * near zero means flat. We use it to spot a battery discharging or a probe
 * drifting out of calibration.
 *
 * The formula is Σ(x−x̄)(y−ȳ) ÷ Σ(x−x̄)², which is exactly what the loop
 * accumulates in `num` and `den`. Because our x-axis is just the array index
 * 0,1,2,…, the mean of x is simply (n−1)/2 — no summing required.
 */
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
 *
 * This is an important idea and easy to miss. `slope()` above will happily
 * return a number for pure noise — fit a line to random dots and you still
 * get *some* gradient. The standard error `se` says how much of that slope
 * could be luck.
 *
 * The rule the codebase applies is `|slope| > 2 * se`: the trend has to be at
 * least twice its own uncertainty before we are willing to call it real.
 * That is roughly a 95% confidence test, and it is the difference between
 * "this sensor is drifting" and "this sensor is noisy and I got excited".
 *
 * Reading the code: `b` is the slope, `a` the intercept, `sse` the total
 * squared error left over after the fit. A line that hugs its points has a
 * small `sse` and therefore a small `se` — a confident slope.
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

/**
 * Pearson correlation, used for neighbour relevance.
 *
 * Answers "do these two series move together?" on a scale of -1 to +1:
 *
 *   +1  perfectly in step — when one rises, so does the other
 *    0  unrelated
 *   -1  perfect opposites
 *
 * Crucially it ignores scale and offset. A coastal station at 12 °C and an
 * alpine one at 3 °C can still correlate at 0.95, because both warm and cool
 * on the same schedule. That is precisely what makes a good reference
 * station, and it is why proximity alone is a poor guide.
 */
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

/**
 * Great-circle distance in kilometres (the haversine formula).
 *
 * Latitude and longitude are angles on a sphere, so you cannot use Pythagoras
 * on them — a degree of longitude is 111 km at the equator and 0 km at the
 * pole. Haversine walks the shortest path *over the surface* instead.
 *
 * `R` is the Earth's mean radius. `toRad` converts degrees to radians because
 * every JavaScript trig function expects radians.
 */
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

/**
 * Magnus formula — dew point from temperature and relative humidity.
 *
 * Dew point is the temperature you would have to cool the air to before it
 * started condensing. Unlike relative humidity, it is a direct measure of how
 * much water the air actually contains, and it does not change when the air
 * merely warms up.
 *
 * That distinction matters enormously here. A station reporting 80% RH at
 * 5 °C and one reporting 40% RH at 20 °C hold almost the same moisture — so
 * comparing their RH figures directly would be meaningless. The neighbour
 * code converts to dew point, compares, and converts back.
 *
 * `a` and `b` are empirical constants fitted to laboratory measurements of
 * water-vapour saturation pressure; they are not derived from theory.
 */
export function dewPoint(tempC: number, rh: number) {
  const h = clamp(rh, 1, 100);
  const a = 17.62;
  const b = 243.12;
  const g = Math.log(h / 100) + (a * tempC) / (b + tempC);
  return (b * g) / (a - g);
}

/**
 * Relative humidity implied by a temperature and dew point — the inverse of
 * `dewPoint` above. Take a neighbour's moisture content, ask what RH that
 * would read at *our* temperature.
 */
export function rhFromDewPoint(tempC: number, td: number) {
  const a = 17.62;
  const b = 243.12;
  return (
    100 *
    Math.exp((a * td) / (b + td) - (a * tempC) / (b + tempC))
  );
}

/**
 * Reduce station pressure to mean sea level so stations compare fairly.
 *
 * Air has weight, so pressure falls with altitude — roughly 1 hPa per 8.5 m
 * near the surface. A mountain station at 1450 m reads about 150 hPa lower
 * than a coastal one *on a perfectly ordinary day*. Compare the raw numbers
 * and every alpine station looks like a permanent hurricane.
 *
 * The fix is to compute what each station would read if it were at sea level.
 * This is the barometric formula: 9.80665 is gravity, 287.05 the specific gas
 * constant for dry air, and +273.15 converts °C to kelvin.
 *
 * Every pressure comparison in this codebase happens at sea level.
 */
export function toSeaLevel(pressureHpa: number, elevationM: number, tempC: number) {
  return pressureHpa * Math.exp((elevationM * 9.80665) / (287.05 * (tempC + 273.15)));
}

export function fromSeaLevel(mslpHpa: number, elevationM: number, tempC: number) {
  return mslpHpa / Math.exp((elevationM * 9.80665) / (287.05 * (tempC + 273.15)));
}

/** The p-th percentile: `pctl(xs, 95)` is the value 95% of the data sits below. */
export function pctl(values: number[], p: number) {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const idx = clamp(Math.round((p / 100) * (s.length - 1)), 0, s.length - 1);
  return s[idx];
}

/**
 * Evenly thin a series down to at most `max` points for charting.
 *
 * 24 hours of minute-resolution data is 1440 points per channel. An 800-pixel
 * chart cannot show that — you would be drawing several points per pixel, and
 * the browser would do a lot of work nobody can see. Taking every n-th sample
 * looks identical and renders far faster.
 *
 * The last line forces the final point to be kept, so the chart always ends
 * at "now" rather than up to n samples short of it.
 */
export function downsample<T>(items: T[], max: number): T[] {
  if (items.length <= max) return items;
  const step = items.length / max;
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(items[Math.floor(i * step)]);
  const last = items[items.length - 1];
  if (out[out.length - 1] !== last) out[out.length - 1] = last;
  return out;
}

/** 0–360° → a compass label. 360° ÷ 16 points = one point every 22.5°. */
export function compassPoint(deg: number) {
  const points = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
  return points[Math.round(((deg % 360) / 22.5)) % 16];
}
