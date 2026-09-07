import type { RawReading, RuleTrigger, SensorType, Station, TwinReading } from '@/types';
import { dewPoint, round, toSeaLevel } from '@/lib/utils';

/**
 * Transparent atmospheric consistency rules.
 *
 * Every threshold is configurable and every rule reports both what it observed
 * and the limit it compared against, so an operator can always see *why* a
 * reading was questioned. Nothing here is hidden behind an opaque score.
 */
export interface PhysicsConfig {
  /** Maximum plausible air-temperature change between one-minute samples. */
  maxTempRateCPerMin: number;
  maxPressureRateHpaPerMin: number;
  maxHumidityRatePctPerMin: number;
  maxWindRateMsPerMin: number;
  tempRange: [number, number];
  humidityRange: [number, number];
  /** Compared after reduction to mean sea level so elevation is not penalised. */
  pressureRangeMsl: [number, number];
  windRange: [number, number];
  maxRainfallPerMin: number;
  /** How far the reported dew point may sit above the air temperature. */
  dewPointToleranceC: number;
  /** Neighbour disagreement threshold, in robust standard deviations. */
  neighbourSigma: number;
  /** Digital-twin disagreement threshold, in native units. */
  twinTolerance: Partial<Record<SensorType, number>>;
}

export const DEFAULT_PHYSICS_CONFIG: PhysicsConfig = {
  maxTempRateCPerMin: 0.8,
  maxPressureRateHpaPerMin: 0.35,
  maxHumidityRatePctPerMin: 7,
  maxWindRateMsPerMin: 9,
  tempRange: [-48, 56],
  humidityRange: [0, 100],
  pressureRangeMsl: [870, 1085],
  windRange: [0, 113],
  maxRainfallPerMin: 4,
  dewPointToleranceC: 0.6,
  neighbourSigma: 3.5,
  twinTolerance: {
    temperature: 3.2,
    humidity: 12,
    pressure: 2.6,
    wind_speed: 5.5,
    rainfall: 0.4,
  },
};

/**
 * Anomaly sensitivity scales the rule thresholds as a single operator-facing
 * dial. Higher sensitivity narrows every limit proportionally.
 */
export function scaleConfig(base: PhysicsConfig, sensitivity: number): PhysicsConfig {
  // sensitivity 0..100, 50 = as configured.
  const k = 1 + (50 - sensitivity) / 100;
  return {
    ...base,
    maxTempRateCPerMin: base.maxTempRateCPerMin * k,
    maxPressureRateHpaPerMin: base.maxPressureRateHpaPerMin * k,
    maxHumidityRatePctPerMin: base.maxHumidityRatePctPerMin * k,
    maxWindRateMsPerMin: base.maxWindRateMsPerMin * k,
    neighbourSigma: base.neighbourSigma * k,
    twinTolerance: Object.fromEntries(
      Object.entries(base.twinTolerance).map(([key, v]) => [key, (v as number) * k]),
    ) as PhysicsConfig['twinTolerance'],
  };
}

export interface PhysicsContext {
  station: Station;
  sensorType: SensorType;
  current: RawReading;
  previous: RawReading | null;
  /** Recent history, oldest first, ending at `current`. */
  window: RawReading[];
  twin: TwinReading;
  /** Relevance-weighted consensus from neighbouring stations, if any. */
  neighbourConsensus: number | null;
  neighbourSpread: number | null;
  config: PhysicsConfig;
}

function valueOf(r: RawReading | null, s: SensorType): number | null {
  if (!r) return null;
  switch (s) {
    case 'temperature': return r.temperature;
    case 'humidity': return r.humidity;
    case 'pressure': return r.pressure;
    case 'wind_speed': return r.windSpeed;
    case 'wind_direction': return r.windDirection;
    case 'rainfall': return r.rainfall;
    case 'battery': return r.battery;
    case 'comms': return r.signal;
    default: return null;
  }
}

export function readingValue(r: RawReading | null, s: SensorType) {
  return valueOf(r, s);
}

export function twinValue(twin: TwinReading, s: SensorType): number | null {
  switch (s) {
    case 'temperature': return twin.temperature;
    case 'humidity': return twin.humidity;
    case 'pressure': return twin.pressure;
    case 'wind_speed': return twin.windSpeed;
    case 'rainfall': return twin.rainfall;
    default: return null;
  }
}

const rule = (
  id: string,
  name: string,
  description: string,
  fired: boolean,
  observed: string,
  limit: string,
): RuleTrigger => ({ id, name, description, fired, observed, limit });

/**
 * Evaluate every applicable rule for one sensor at one instant.
 * Returns all rules — fired or not — so the UI can show the full checklist.
 */
export function evaluatePhysics(ctx: PhysicsContext): RuleTrigger[] {
  const { current, previous, window, twin, config, sensorType, station } = ctx;
  const out: RuleTrigger[] = [];
  const v = valueOf(current, sensorType);
  const pv = valueOf(previous, sensorType);

  // --- Rate-of-change ------------------------------------------------------
  const rateLimits: Partial<Record<SensorType, { limit: number; unit: string }>> = {
    temperature: { limit: config.maxTempRateCPerMin, unit: '°C/min' },
    pressure: { limit: config.maxPressureRateHpaPerMin, unit: 'hPa/min' },
    humidity: { limit: config.maxHumidityRatePctPerMin, unit: '%/min' },
    wind_speed: { limit: config.maxWindRateMsPerMin, unit: 'm/s per min' },
  };
  const rl = rateLimits[sensorType];
  if (rl && v !== null && pv !== null) {
    const dtMin = Math.max(1, (current.t - (previous as RawReading).t) / 60000);
    const rate = Math.abs(v - pv) / dtMin;
    out.push(
      rule(
        'rate_of_change',
        'Rate-of-change violation',
        'The atmosphere cannot change this quickly at the surface.',
        rate > rl.limit,
        `${round(rate, 2)} ${rl.unit}`,
        `≤ ${round(rl.limit, 2)} ${rl.unit}`,
      ),
    );
  }

  // --- Absolute range ------------------------------------------------------
  const ranges: Partial<Record<SensorType, { r: [number, number]; unit: string; transform?: (n: number) => number }>> = {
    temperature: { r: config.tempRange, unit: '°C' },
    humidity: { r: config.humidityRange, unit: '%' },
    pressure: {
      r: config.pressureRangeMsl,
      unit: 'hPa MSL',
      transform: (n) => toSeaLevel(n, station.elevation, current.temperature ?? 10),
    },
    wind_speed: { r: config.windRange, unit: 'm/s' },
  };
  const rg = ranges[sensorType];
  if (rg && v !== null) {
    const tv = rg.transform ? rg.transform(v) : v;
    out.push(
      rule(
        'range',
        'Range violation',
        'The value falls outside the physically possible measurement range.',
        tv < rg.r[0] || tv > rg.r[1],
        `${round(tv, 2)} ${rg.unit}`,
        `${rg.r[0]} to ${rg.r[1]} ${rg.unit}`,
      ),
    );
  }

  if (sensorType === 'rainfall' && v !== null) {
    out.push(
      rule(
        'rainfall_rate',
        'Unreasonable rainfall transition',
        'Accumulation exceeds the maximum credible intensity for one minute.',
        v > config.maxRainfallPerMin,
        `${round(v, 3)} mm/min`,
        `≤ ${config.maxRainfallPerMin} mm/min`,
      ),
    );
  }

  // --- Dew-point relationship ---------------------------------------------
  if (
    (sensorType === 'temperature' || sensorType === 'humidity') &&
    current.temperature !== null &&
    current.humidity !== null
  ) {
    const td = dewPoint(current.temperature, Math.max(1, current.humidity));
    const excess = td - current.temperature;
    out.push(
      rule(
        'dewpoint_consistency',
        'Dew-point relationship',
        'Dew point must remain at or below the air temperature.',
        excess > config.dewPointToleranceC,
        `Td ${round(td, 2)}°C vs T ${round(current.temperature, 2)}°C`,
        `Td ≤ T + ${config.dewPointToleranceC}°C`,
      ),
    );
  }

  // --- Cross-sensor coherence ---------------------------------------------
  // A real air-mass change moves several variables at once. A probe fault
  // moves exactly one.
  if (sensorType === 'temperature' && previous && v !== null && pv !== null) {
    const dT = Math.abs(v - pv);
    const dRH =
      current.humidity !== null && previous.humidity !== null
        ? Math.abs(current.humidity - previous.humidity)
        : 0;
    const dP =
      current.pressure !== null && previous.pressure !== null
        ? Math.abs(current.pressure - previous.pressure)
        : 0;
    // A ≥2 °C step with essentially no humidity or pressure response is not air.
    const incoherent = dT > 2 && dRH < dT * 0.6 && dP < 0.12;
    out.push(
      rule(
        'cross_sensor',
        'Cross-sensor inconsistency',
        'Temperature moved sharply while humidity and pressure stayed flat.',
        incoherent,
        `ΔT ${round(dT, 2)}°C, ΔRH ${round(dRH, 2)}%, ΔP ${round(dP, 3)} hPa`,
        `ΔT > 2°C should accompany ΔRH ≥ ${round(dT * 0.6, 2)}%`,
      ),
    );
  }

  // --- Neighbour agreement -------------------------------------------------
  if (ctx.neighbourConsensus !== null && v !== null) {
    const spread = Math.max(ctx.neighbourSpread ?? 0, 0.35);
    const z = Math.abs(v - ctx.neighbourConsensus) / spread;
    out.push(
      rule(
        'neighbour',
        'Neighbour disagreement',
        'The reading is inconsistent with relevance-weighted nearby stations.',
        z > config.neighbourSigma,
        `${round(z, 1)}σ from consensus ${round(ctx.neighbourConsensus, 2)}`,
        `≤ ${config.neighbourSigma}σ`,
      ),
    );
  }

  // --- Digital-twin agreement ---------------------------------------------
  const tv = twinValue(twin, sensorType);
  const tol = config.twinTolerance[sensorType];
  if (tv !== null && tol !== undefined && v !== null) {
    const diff = Math.abs(v - tv);
    out.push(
      rule(
        'twin',
        'Physics model disagreement',
        'The station disagrees with its digital twin beyond the expected modelling error.',
        diff > tol,
        `Δ ${round(diff, 2)} vs twin ${round(tv, 2)}`,
        `≤ ${round(tol, 2)}`,
      ),
    );
  }

  // --- Stationarity --------------------------------------------------------
  if (window.length >= 20 && v !== null) {
    const vals = window.map((w) => valueOf(w, sensorType)).filter((n): n is number => n !== null);
    const tail = vals.slice(-20);
    // Exact equality, not a variance threshold — see the note in the frozen
    // detector on why a computed σ cannot be trusted near zero.
    const identical = tail.length >= 20 && tail.every((x) => x === tail[0]);
    const isDiscrete = sensorType === 'rainfall';
    out.push(
      rule(
        'stationarity',
        'Sensor responsiveness',
        'A live sensor always carries some measurement noise; a flat line means it has stopped responding.',
        !isDiscrete && identical,
        identical
          ? `${round(tail[0], 2)} repeated across all 20 samples`
          : `${new Set(tail).size} distinct values across 20 samples`,
        'at least 2 distinct values',
      ),
    );
  }

  return out;
}

export function firedRules(rules: RuleTrigger[]) {
  return rules.filter((r) => r.fired);
}
