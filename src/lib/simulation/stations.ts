import type { SensorSpec, SensorType, Station } from '@/types';
import { DAY, HOUR } from '@/lib/utils';
import { makeRng } from '@/lib/rng';

/**
 * A fictional twelve-station AWS network laid across a coherent slice of the
 * Pacific Northwest: coast, Coast Range, Willamette Valley, Cascades and the
 * high desert plateau east of the crest.
 *
 * The geography is doing real work here. Elevation spans 8 m to 1450 m so the
 * lapse-rate physics matter, and the west-to-east transect means a front
 * genuinely arrives at the coastal stations before the plateau ones.
 */

interface StationSeed {
  id: string;
  name: string;
  region: string;
  latitude: number;
  longitude: number;
  elevation: number;
  maritimeInfluence: number;
  terrain: Station['terrain'];
  hardwareModel: string;
  firmware: string;
  installedDaysAgo: number;
}

const STATION_SEEDS: StationSeed[] = [
  { id: 'AWS-001', name: 'Astoria Point',        region: 'North Coast',     latitude: 46.188, longitude: -123.874, elevation: 12,   maritimeInfluence: 0.96, terrain: 'coastal',  hardwareModel: 'SG-Node 4C', firmware: '4.2.1', installedDaysAgo: 1180 },
  { id: 'AWS-002', name: 'Tillamook Bay',        region: 'North Coast',     latitude: 45.456, longitude: -123.844, elevation: 8,    maritimeInfluence: 0.94, terrain: 'coastal',  hardwareModel: 'SG-Node 4C', firmware: '4.1.8', installedDaysAgo: 1402 },
  { id: 'AWS-007', name: 'Marion Ridge',         region: 'Cascade Foothills', latitude: 44.884, longitude: -122.318, elevation: 420, maritimeInfluence: 0.34, terrain: 'foothill', hardwareModel: 'SG-Node 4V', firmware: '4.2.1', installedDaysAgo: 968 },
  { id: 'AWS-011', name: 'Willamette Flats',     region: 'Willamette Valley', latitude: 45.062, longitude: -123.031, elevation: 65, maritimeInfluence: 0.55, terrain: 'valley',   hardwareModel: 'SG-Node 4V', firmware: '4.2.1', installedDaysAgo: 742 },
  { id: 'AWS-014', name: 'Silverton Foothills',  region: 'Cascade Foothills', latitude: 44.996, longitude: -122.585, elevation: 240, maritimeInfluence: 0.41, terrain: 'foothill', hardwareModel: 'SG-Node 4V', firmware: '4.2.1', installedDaysAgo: 655 },
  { id: 'AWS-019', name: 'Coast Range Summit',   region: 'Coast Range',     latitude: 45.612, longitude: -123.421, elevation: 780,  maritimeInfluence: 0.78, terrain: 'foothill', hardwareModel: 'SG-Node 4A', firmware: '4.2.0', installedDaysAgo: 1094 },
  { id: 'AWS-021', name: 'Corvallis Research',   region: 'Willamette Valley', latitude: 44.564, longitude: -123.262, elevation: 78, maritimeInfluence: 0.58, terrain: 'valley',   hardwareModel: 'SG-Node 4V', firmware: '4.1.8', installedDaysAgo: 1611 },
  { id: 'AWS-026', name: 'Santiam Pass',         region: 'Cascade Crest',   latitude: 44.423, longitude: -121.861, elevation: 1450, maritimeInfluence: 0.20, terrain: 'alpine',   hardwareModel: 'SG-Node 4A', firmware: '4.2.1', installedDaysAgo: 512 },
  { id: 'AWS-029', name: 'Deschutes Plateau',    region: 'High Desert',     latitude: 44.281, longitude: -121.198, elevation: 980,  maritimeInfluence: 0.08, terrain: 'plateau',  hardwareModel: 'SG-Node 4P', firmware: '4.0.9', installedDaysAgo: 1855 },
  { id: 'AWS-033', name: 'Newport Headland',     region: 'Central Coast',   latitude: 44.638, longitude: -124.053, elevation: 45,   maritimeInfluence: 0.98, terrain: 'coastal',  hardwareModel: 'SG-Node 4C', firmware: '4.2.1', installedDaysAgo: 823 },
  { id: 'AWS-038', name: 'McKenzie Valley',      region: 'Cascade Foothills', latitude: 44.163, longitude: -122.462, elevation: 320, maritimeInfluence: 0.36, terrain: 'valley',   hardwareModel: 'SG-Node 4V', firmware: '4.2.1', installedDaysAgo: 430 },
  { id: 'AWS-041', name: 'Bend Highlands',       region: 'High Desert',     latitude: 43.996, longitude: -121.316, elevation: 1120, maritimeInfluence: 0.06, terrain: 'plateau',  hardwareModel: 'SG-Node 4P', firmware: '4.2.0', installedDaysAgo: 287 },
];

interface SensorTemplate {
  type: SensorType;
  label: string;
  unit: string;
  manufacturer: string;
  model: string;
  calibrationIntervalDays: number;
}

/** Fictional hardware vendors — this network is not real equipment. */
const SENSOR_TEMPLATES: SensorTemplate[] = [
  { type: 'temperature', label: 'Temperature probe', unit: '°C',   manufacturer: 'Aerodyne Instruments', model: 'PT1000-A2', calibrationIntervalDays: 180 },
  { type: 'humidity',    label: 'Humidity probe',    unit: '%',    manufacturer: 'NordMet Systems',      model: 'HYG-220',   calibrationIntervalDays: 120 },
  { type: 'pressure',    label: 'Barometer',         unit: 'hPa',  manufacturer: 'Calibra Metrology',    model: 'BAR-9',     calibrationIntervalDays: 365 },
  { type: 'wind_speed',  label: 'Anemometer',        unit: 'm/s',  manufacturer: 'Tempest Dynamics',     model: 'SONIC-3',   calibrationIntervalDays: 270 },
  { type: 'rainfall',    label: 'Tipping-bucket gauge', unit: 'mm', manufacturer: 'Helios Sensing',      model: 'TB-04',     calibrationIntervalDays: 180 },
  { type: 'battery',     label: 'Power subsystem',   unit: 'V',    manufacturer: 'Helios Sensing',       model: 'PWR-12S',   calibrationIntervalDays: 730 },
  { type: 'comms',       label: 'Telemetry modem',   unit: 'dBm',  manufacturer: 'NordMet Systems',      model: 'LTE-M2',    calibrationIntervalDays: 730 },
];

export const SENSOR_ORDER: SensorType[] = SENSOR_TEMPLATES.map((s) => s.type);

export const SENSOR_LABELS: Record<SensorType, string> = {
  temperature: 'Temperature',
  humidity: 'Humidity',
  pressure: 'Pressure',
  wind_speed: 'Wind',
  wind_direction: 'Wind direction',
  rainfall: 'Rainfall',
  battery: 'Battery',
  comms: 'Communications',
};

export const SENSOR_SHORT: Record<SensorType, string> = {
  temperature: 'TEMP',
  humidity: 'RH',
  pressure: 'PRESS',
  wind_speed: 'WIND',
  wind_direction: 'DIR',
  rainfall: 'RAIN',
  battery: 'BATT',
  comms: 'COMMS',
};

export const SENSOR_UNITS: Record<SensorType, string> = {
  temperature: '°C',
  humidity: '%',
  pressure: 'hPa',
  wind_speed: 'm/s',
  wind_direction: '°',
  rainfall: 'mm',
  battery: 'V',
  comms: 'dBm',
};

/**
 * Stations are built once at module load. Calibration ages are seeded from the
 * station id so "AWS-021 humidity is 142 days out of calibration" stays true
 * on every reload rather than drifting between renders.
 */
function buildStation(seed: StationSeed, nowAnchor: number): Station {
  const rng = makeRng(`station:${seed.id}`);
  const installedAt = nowAnchor - seed.installedDaysAgo * DAY;

  const sensors: SensorSpec[] = SENSOR_TEMPLATES.map((tpl, i) => {
    // Calibration age is a fraction of the interval, occasionally overdue.
    const ageFactor = 0.25 + rng() * 1.15;
    const ageDays = Math.round(tpl.calibrationIntervalDays * ageFactor);
    return {
      id: `${seed.id}-${tpl.type.toUpperCase()}`,
      stationId: seed.id,
      type: tpl.type,
      label: tpl.label,
      unit: tpl.unit,
      manufacturer: tpl.manufacturer,
      model: tpl.model,
      serial: `${tpl.model.split('-')[0]}-${seed.id.slice(4)}${String(1000 + Math.floor(rng() * 8999)).slice(0, 4)}`,
      installedAt: installedAt + Math.floor(rng() * 30) * DAY * (i > 0 ? 1 : 0),
      lastCalibratedAt: nowAnchor - ageDays * DAY,
      calibrationIntervalDays: tpl.calibrationIntervalDays,
    };
  });

  return { ...seed, installedAt, sensors };
}

/**
 * Anchor for slow-moving station metadata. Rounded to the day so server and
 * client agree and calibration ages do not shift mid-session.
 */
export function metadataAnchor(now: number) {
  return Math.floor(now / DAY) * DAY;
}

export function buildStations(now: number): Station[] {
  const anchor = metadataAnchor(now);
  return STATION_SEEDS.map((s) => buildStation(s, anchor));
}

/** Centre of the network, used as the default map view. */
export const NETWORK_CENTRE: [number, number] = [45.05, -122.6];

export const NETWORK_NAME = 'Cascadia Regional AWS Network';

export { STATION_SEEDS, SENSOR_TEMPLATES, HOUR };
