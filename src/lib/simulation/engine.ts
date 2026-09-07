import type { RawReading, Station, TwinReading } from '@/types';
import { fbm, gaussian, hashSeed, makeRng } from '@/lib/rng';
import {
  clamp,
  dewPoint,
  fromSeaLevel,
  haversineKm,
  HOUR,
  MINUTE,
  rhFromDewPoint,
  round,
} from '@/lib/utils';
import { isMeteorological, type SimEvent } from './events';

/**
 * The simulation is a two-stage pipeline.
 *
 *   1. A regional atmosphere is evaluated at each timestamp. Every station
 *      samples the *same* field, adjusted for its elevation, terrain and
 *      distance from the ocean. Meteorological events perturb this stage, so
 *      they show up coherently at every affected station — which is exactly
 *      what makes them distinguishable from hardware faults.
 *
 *   2. Each station's hardware then reports that truth imperfectly. Faults are
 *      applied here only, so a spike at one station leaves the regional field
 *      untouched and every neighbour disagrees with it.
 *
 * Nothing calls Math.random(); every perturbation is a pure function of the
 * seed and the timestamp.
 */

/** Local solar time offset for the Pacific Northwest network. */
const UTC_OFFSET_HOURS = -8;
/** Environmental lapse rate, °C per metre. */
const LAPSE_RATE = 0.0065;

export const SIM_STEP_MS = MINUTE;
/** Timing error baked into the digital twin, in milliseconds. */
const TWIN_LAG_MS = 6 * MINUTE;
export const SIM_WINDOW_MS = 24 * HOUR;

interface RegionalField {
  /** Reference near-surface temperature reduced to sea level. */
  seaLevelTemp: number;
  /**
   * Regional dew-point depression (T - Td) in °C. Modelling the *depression*
   * rather than the dew point itself keeps humidity physically sane across a
   * 1400 m elevation range: saturation is a floor you approach, not a value
   * you accidentally cross.
   */
  depressionBase: number;
  /** 0..1 moistening from precipitation and synoptic lift. */
  moistening: number;
  mslp: number;
  windBase: number;
  windDir: number;
  rainRate: number;
  cloud: number;
}

function localHour(t: number) {
  const h = t / HOUR + UTC_OFFSET_HOURS;
  return ((h % 24) + 24) % 24;
}

/** Smooth 0→1→0 bell, used for gust and rain envelopes. */
function bell(x: number) {
  if (x <= 0 || x >= 1) return 0;
  return Math.sin(Math.PI * x) ** 2;
}

/** Smooth 0→1 ramp. */
function ramp(x: number) {
  const c = clamp(x, 0, 1);
  return c * c * (3 - 2 * c);
}

/**
 * Front geometry: the origin sits off the north-west corner of the network and
 * the system travels south-east, so arrival time is a projection of the
 * station onto the direction of travel.
 */
const FRONT_ORIGIN: [number, number] = [46.9, -124.9];
const FRONT_BEARING_DEG = 128;
const FRONT_SPEED_KMH = 46;

export function frontArrivalOffset(station: Station): number {
  const bearing = (FRONT_BEARING_DEG * Math.PI) / 180;
  // Local flat-earth projection is plenty accurate over a few hundred km.
  const kmPerDegLat = 111.32;
  const kmPerDegLon = 111.32 * Math.cos((station.latitude * Math.PI) / 180);
  const dy = (station.latitude - FRONT_ORIGIN[0]) * kmPerDegLat;
  const dx = (station.longitude - FRONT_ORIGIN[1]) * kmPerDegLon;
  // Unit vector pointing along the direction of travel.
  const uy = Math.cos(bearing);
  const ux = Math.sin(bearing);
  const projKm = dx * ux + dy * uy;
  return (Math.max(projKm, 0) / FRONT_SPEED_KMH) * HOUR;
}

/** Distance from the front line at a given time, negative = not yet arrived. */
export function frontProgress(station: Station, event: SimEvent, t: number) {
  const arrival = event.startAt + frontArrivalOffset(station);
  return (t - arrival) / event.duration;
}

function regionalField(t: number, seed: number, events: SimEvent[]): RegionalField {
  const lh = localHour(t);
  const days = t / (24 * HOUR);

  // Diurnal cycle peaks mid-afternoon, bottoms just before dawn.
  const diurnal = Math.cos(((lh - 15.5) / 24) * 2 * Math.PI);
  const synoptic = fbm(seed, days * 3.1, 4);
  const slow = fbm(seed + 991, days * 1.3, 3);

  const field: RegionalField = {
    seaLevelTemp: 15.2 + 5.4 * diurnal + 2.8 * synoptic,
    // Air dries out through the afternoon and re-saturates toward dawn.
    depressionBase: 2.5 + 3.4 * Math.max(0, diurnal) - 1.1 * slow,
    moistening: 0,
    mslp: 1014.5 + 4.2 * slow - 1.6 * synoptic,
    windBase: 3.6 + 1.9 * fbm(seed + 313, days * 6.4, 3) + 1.2 * Math.max(0, diurnal),
    windDir: 248 + 34 * fbm(seed + 77, days * 2.2, 2),
    rainRate: 0,
    cloud: clamp(0.42 + 0.34 * slow, 0, 1),
  };

  // Network-scale meteorology. Applied to the regional field only.
  for (const ev of events) {
    if (!isMeteorological(ev.kind) || ev.scope !== 'network') continue;
    if (t < ev.startAt) continue;

    if (ev.kind === 'heat_wave') {
      const p = ramp((t - ev.startAt) / (ev.duration * 0.45));
      const decay = t > ev.startAt + ev.duration ? Math.max(0, 1 - (t - ev.startAt - ev.duration) / (2 * HOUR)) : 1;
      field.seaLevelTemp += ev.magnitude * p * decay;
      field.depressionBase += 3.1 * p * decay;
      field.mslp += 2.4 * p * decay;
      field.cloud = clamp(field.cloud - 0.3 * p * decay, 0, 1);
    }

    if (ev.kind === 'pressure_drop') {
      const p = ramp((t - ev.startAt) / ev.duration);
      field.mslp -= ev.magnitude * p;
      field.windBase += 4.5 * p;
      field.moistening += 0.32 * p;
      field.cloud = clamp(field.cloud + 0.4 * p, 0, 1);
    }

    if (ev.kind === 'rain_event') {
      const x = (t - ev.startAt) / ev.duration;
      const env = bell(x) * ev.magnitude;
      field.rainRate += env * 0.09;
      field.moistening += env;
      field.seaLevelTemp -= 1.4 * env;
      field.cloud = clamp(field.cloud + 0.5 * env, 0, 1);
    }
  }

  return field;
}

/**
 * Truth for one station at one instant: what a perfectly calibrated station
 * would measure. This is the quantity the digital twin tries to reproduce and
 * the corrected-value engine tries to recover.
 */
export function stationTruth(
  station: Station,
  t: number,
  seed: number,
  events: SimEvent[],
): TwinReading {
  const field = regionalField(t, seed, events);
  const sSeed = hashSeed(`${station.id}:${seed}`);
  const days = t / (24 * HOUR);

  // Maritime air damps the diurnal swing and holds temperature near the
  // regional mean; continental sites east of the crest swing much harder.
  const regionalMean = 15.2;
  const damped =
    regionalMean +
    (field.seaLevelTemp - regionalMean) * (1 - 0.5 * station.maritimeInfluence) *
      (1 + 0.35 * (1 - station.maritimeInfluence));

  let temperature =
    damped -
    LAPSE_RATE * station.elevation +
    1.1 * fbm(sSeed, days * 5.3, 3) +
    (station.terrain === 'valley' ? -0.8 * Math.max(0, Math.cos(((localHour(t) - 5) / 24) * 2 * Math.PI)) : 0);

  // Continental sites east of the crest run a much larger dew-point
  // depression than the marine layer on the coast.
  const continental = 1 - station.maritimeInfluence;
  let depression =
    field.depressionBase * (0.5 + 0.95 * continental) +
    1.8 * continental +
    0.4 * (station.elevation / 1000) +
    0.45 * fbm(sSeed + 4231, days * 4.1, 2) -
    3.0 * field.moistening;

  let windSpeed =
    field.windBase *
      (0.7 + 0.9 * (station.elevation / 900) + 0.5 * station.maritimeInfluence) +
    0.8 * fbm(sSeed + 1717, days * 22, 3);

  let mslp = field.mslp + 0.6 * fbm(sSeed + 8081, days * 3.7, 2);
  let rainRate = field.rainRate * (0.6 + 0.9 * station.maritimeInfluence);

  // Frontal passage — the signature that must read as *genuine weather*:
  // temperature falls, dew point rises toward the temperature, pressure digs a
  // trough then recovers, wind gusts and veers, and every station in the path
  // does the same thing in geographic order.
  for (const ev of events) {
    if (ev.kind !== 'cold_front') continue;
    const arrival = ev.startAt + frontArrivalOffset(station);
    if (t < arrival - 90 * MINUTE) continue;
    const since = t - arrival;
    const passage = 40 * MINUTE;
    const p = ramp(since / passage);

    temperature -= ev.magnitude * p;
    // Moist maritime air behind the front closes the dew-point depression —
    // the humidity rise that makes this read as weather rather than hardware.
    depression -= ev.magnitude * 0.34 * p;

    // Pre-frontal trough: pressure falls into the arrival, rises behind it.
    const pre = clamp((t - (arrival - 90 * MINUTE)) / (90 * MINUTE), 0, 1);
    mslp -= 5.2 * bell(pre) * 0.9;
    mslp += 3.1 * ramp(since / (2.5 * HOUR));

    windSpeed += 6.4 * bell(clamp((since + 25 * MINUTE) / (110 * MINUTE), 0, 1));
    rainRate += 0.075 * bell(clamp((since + 20 * MINUTE) / (95 * MINUTE), 0, 1)) * (0.5 + station.maritimeInfluence);
  }

  // Saturation is a floor the depression approaches, never crosses.
  const td = temperature - clamp(depression, 0.25, 24);
  const humidity = clamp(rhFromDewPoint(temperature, td), 3, 100);
  const pressure = fromSeaLevel(mslp, station.elevation, temperature);

  windSpeed = Math.max(0.1, windSpeed);
  rainRate = Math.max(0, rainRate);

  return {
    t,
    temperature,
    humidity,
    pressure,
    dewPoint: td,
    windSpeed,
    rainfall: rainRate,
  };
}

/** Wind direction is derived separately so a front can veer it. */
export function stationWindDirection(
  station: Station,
  t: number,
  seed: number,
  events: SimEvent[],
): number {
  const field = regionalField(t, seed, events);
  const sSeed = hashSeed(`${station.id}:dir:${seed}`);
  let dir = field.windDir + 18 * fbm(sSeed, (t / (24 * HOUR)) * 9, 2);
  for (const ev of events) {
    if (ev.kind !== 'cold_front') continue;
    const arrival = ev.startAt + frontArrivalOffset(station);
    if (t < arrival) continue;
    // Classic veer to the north-west behind a cold front.
    dir += 62 * ramp((t - arrival) / (35 * MINUTE));
  }
  return ((dir % 360) + 360) % 360;
}

interface PowerState {
  battery: number;
  solar: number;
  signal: number;
  packetLoss: number;
  received: boolean;
}

function powerAndComms(
  station: Station,
  t: number,
  seed: number,
  truth: TwinReading,
  events: SimEvent[],
): PowerState {
  const sSeed = hashSeed(`${station.id}:pwr:${seed}`);
  const lh = localHour(t);
  const daylight = Math.max(0, Math.cos(((lh - 13) / 24) * 2 * Math.PI * (24 / 14)));
  const cloudFactor = clamp(1 - truth.rainfall * 3.2, 0.25, 1);

  const solar = round(daylight > 0 ? 0.4 + 17.8 * daylight * cloudFactor : 0.2, 2);
  // Charge through the day, discharge overnight — a shallow, repeatable cycle.
  let battery = 12.62 + 0.72 * (daylight * cloudFactor) - 0.34 * (1 - daylight);
  battery += 0.05 * fbm(sSeed, (t / (24 * HOUR)) * 7, 2);

  let signal = -68 - 16 * (station.elevation / 1500) + 9 * fbm(sSeed + 55, (t / (24 * HOUR)) * 14, 3);
  // Rain fade on the telemetry link.
  signal -= truth.rainfall * 135;

  let packetLoss = clamp(0.4 + Math.max(0, (-signal - 88) * 0.9) + 1.4 * Math.max(0, fbm(sSeed + 9, (t / (24 * HOUR)) * 30, 2)), 0, 100);
  let received = true;

  for (const ev of events) {
    if (ev.scope !== 'station' || ev.stationId !== station.id) continue;
    if (t < ev.startAt || t > ev.startAt + ev.duration) continue;
    const elapsedH = (t - ev.startAt) / HOUR;

    if (ev.kind === 'battery_failure') {
      // Steep discharge; solar can no longer hold the pack up.
      const drop = Math.min(3.6, 0.55 * elapsedH * ev.magnitude);
      battery -= drop;
      if (battery < 11.4) {
        // Brown-out: the modem starts dropping packets before the logger dies.
        packetLoss = clamp(packetLoss + (11.4 - battery) * 34, 0, 100);
        signal -= (11.4 - battery) * 12;
      }
      if (battery < 10.6) {
        const r = makeRng(`brownout:${station.id}:${Math.floor(t / MINUTE)}`);
        received = r() > 0.55;
      }
    }

    if (ev.kind === 'comms_outage') {
      // A short taper either side of the hard outage looks like a real modem.
      const inCore = t > ev.startAt + 2 * MINUTE && t < ev.startAt + ev.duration - 2 * MINUTE;
      packetLoss = 100;
      signal = -117;
      received = !inCore ? makeRng(`taper:${station.id}:${Math.floor(t / MINUTE)}`)() > 0.6 : false;
    }
  }

  return {
    battery: round(clamp(battery, 8.2, 14.6), 2),
    solar,
    signal: round(clamp(signal, -120, -48), 1),
    packetLoss: round(packetLoss, 1),
    received,
  };
}

/**
 * Apply hardware behaviour to the truth to produce the raw packet. Every fault
 * lives here — the regional field never sees them, which is precisely why
 * neighbour and cross-sensor checks can catch them.
 */
export function rawReading(
  station: Station,
  t: number,
  seed: number,
  events: SimEvent[],
): RawReading {
  const truth = stationTruth(station, t, seed, events);
  const minuteIdx = Math.floor(t / MINUTE);
  const jitter = makeRng(`${station.id}:${seed}:${minuteIdx}`);

  // Baseline instrument noise — every real sensor has some.
  let temperature = truth.temperature + gaussian(jitter, 0, 0.07);
  let humidity = truth.humidity + gaussian(jitter, 0, 0.35);
  let pressure = truth.pressure + gaussian(jitter, 0, 0.05);
  let windSpeed = Math.max(0, truth.windSpeed + gaussian(jitter, 0, 0.28));
  // No fault kind perturbs these two, so they carry instrument noise only.
  const rainfall = Math.max(0, truth.rainfall + (truth.rainfall > 0 ? gaussian(jitter, 0, 0.004) : 0));
  const windDirection = stationWindDirection(station, t, seed, events) + gaussian(jitter, 0, 2.4);

  const power = powerAndComms(station, t, seed, truth, events);
  const received = power.received;

  for (const ev of events) {
    if (ev.scope !== 'station' || ev.stationId !== station.id) continue;
    if (t < ev.startAt) continue;
    const end = ev.startAt + ev.duration;
    if (t > end) continue;
    const since = t - ev.startAt;

    if (ev.kind === 'temp_spike') {
      // Reaches its full value inside one sample interval — the defining
      // property of the fault, and physically impossible for real air.
      const onset = clamp(since / MINUTE, 0, 1);
      if (ev.targetValue !== undefined) {
        // A shorted probe pins near the top of its range rather than adding a
        // fixed offset to the true temperature.
        const target = ev.targetValue + gaussian(jitter, 0, 0.35);
        temperature += (target - temperature) * onset;
      } else {
        temperature += ev.magnitude * onset + gaussian(jitter, 0, 0.9) * onset;
      }
    }

    if (ev.kind === 'humidity_drift') {
      // Calibration drift expressed in %RH per day.
      humidity += ev.magnitude * (since / (24 * HOUR));
    }

    if (ev.kind === 'sensor_noise') {
      const target = ev.sensorType ?? 'temperature';
      const n = gaussian(jitter, 0, ev.magnitude);
      if (target === 'temperature') temperature += n;
      else if (target === 'humidity') humidity += n * 4;
      else if (target === 'pressure') pressure += n * 0.7;
      else if (target === 'wind_speed') windSpeed = Math.max(0, windSpeed + n);
    }

    if (ev.kind === 'frozen_sensor') {
      // Latch on the value observed at the moment of failure.
      const latch = stationTruth(station, ev.startAt, seed, events);
      const target = ev.sensorType ?? 'temperature';
      if (target === 'temperature') temperature = latch.temperature;
      else if (target === 'humidity') humidity = latch.humidity;
      else if (target === 'pressure') pressure = latch.pressure;
      else if (target === 'wind_speed') windSpeed = latch.windSpeed;
    }
  }

  humidity = clamp(humidity, 0, 100);

  if (!received) {
    return {
      t,
      temperature: null,
      humidity: null,
      pressure: null,
      dewPoint: null,
      windSpeed: null,
      windDirection: null,
      rainfall: null,
      battery: null,
      solarVoltage: null,
      signal: null,
      packetLoss: null,
      received: false,
    };
  }

  return {
    t,
    temperature: round(temperature, 2),
    humidity: round(humidity, 1),
    pressure: round(pressure, 2),
    // Dew point is *reported* by the logger, derived from its own two probes —
    // so a faulty temperature or humidity channel corrupts it too.
    dewPoint: round(dewPoint(temperature, clamp(humidity, 1, 100)), 2),
    windSpeed: round(windSpeed, 2),
    windDirection: round(((windDirection % 360) + 360) % 360, 1),
    rainfall: round(rainfall, 3),
    battery: power.battery,
    solarVoltage: power.solar,
    signal: power.signal,
    packetLoss: power.packetLoss,
    received: true,
  };
}

/**
 * The digital twin: an independent expectation of what the station *should*
 * report, built from the regional field rather than the station's own probes.
 * It carries its own modelling error, so agreement is meaningful evidence
 * rather than a tautology.
 */
export function twinReading(
  station: Station,
  t: number,
  seed: number,
  events: SimEvent[],
): TwinReading {
  // The twin is a forecast, not an oracle: it carries a few minutes of timing
  // error, so a fast-moving front shows a small, honest disagreement while a
  // probe fault shows a large one.
  const truth = stationTruth(station, t - TWIN_LAG_MS, seed, events);
  const mSeed = hashSeed(`${station.id}:twin:${seed}`);
  const days = t / (24 * HOUR);
  const err = fbm(mSeed, days * 2.6, 3);
  return {
    t,
    temperature: round(truth.temperature + 0.55 * err, 2),
    humidity: round(clamp(truth.humidity + 2.1 * err, 0, 100), 1),
    pressure: round(truth.pressure + 0.35 * err, 2),
    dewPoint: round(truth.dewPoint + 0.48 * err, 2),
    windSpeed: round(Math.max(0, truth.windSpeed + 0.75 * err), 2),
    rainfall: round(Math.max(0, truth.rainfall * (1 + 0.3 * err)), 3),
  };
}

/** Generate a contiguous minute-resolution series for one station. */
export function generateSeries(
  station: Station,
  from: number,
  to: number,
  seed: number,
  events: SimEvent[],
): { raw: RawReading[]; twin: TwinReading[] } {
  const raw: RawReading[] = [];
  const twin: TwinReading[] = [];
  for (let t = from; t <= to; t += SIM_STEP_MS) {
    raw.push(rawReading(station, t, seed, events));
    twin.push(twinReading(station, t, seed, events));
  }
  return { raw, twin };
}

/** Km between two stations — used for neighbour relevance and propagation. */
export function stationDistanceKm(a: Station, b: Station) {
  return haversineKm(a.latitude, a.longitude, b.latitude, b.longitude);
}
