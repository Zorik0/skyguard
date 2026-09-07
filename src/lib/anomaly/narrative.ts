import type {
  Classification,
  Correction,
  DetectorType,
  EvidenceItem,
  SensorType,
  Station,
} from '@/types';
import { round } from '@/lib/utils';
import { SENSOR_LABELS, SENSOR_UNITS } from '@/lib/simulation/stations';

/**
 * Plain-language explanation.
 *
 * The platform's rule is that an operator should never have to accept a score
 * on trust. Everything written here is assembled from the same evidence the
 * classifier used, so the prose and the numbers can never drift apart.
 */

const SENSOR_NOUN: Record<SensorType, string> = {
  temperature: 'temperature probe',
  humidity: 'humidity probe',
  pressure: 'barometer',
  wind_speed: 'anemometer',
  wind_direction: 'wind vane',
  rainfall: 'rain gauge',
  battery: 'power subsystem',
  comms: 'telemetry modem',
};

export function recommendedAction(
  classification: Classification,
  sensorType: SensorType,
  detectors: DetectorType[],
): string {
  const set = new Set(detectors);

  if (classification === 'communications') {
    return 'Inspect the telemetry modem, antenna and backhaul link. Sensors are most likely healthy — confirm once packets resume.';
  }
  if (classification === 'power') {
    return 'Inspect the battery pack and solar charge controller. Replace the pack if it will not hold charge overnight.';
  }
  if (classification === 'meteorological_event') {
    return 'No maintenance action required. Retain the observations unmodified and continue monitoring the event as it crosses the network.';
  }
  if (classification === 'indeterminate') {
    return `Evidence is balanced. Compare the ${SENSOR_NOUN[sensorType]} against neighbouring stations over the next few hours before scheduling a site visit.`;
  }

  if (set.has('frozen')) {
    return `Power-cycle the logger and inspect the ${SENSOR_NOUN[sensorType]} signal path. Replace the sensor if the channel does not resume responding.`;
  }
  // Ordered by how decisive the finding is: a rate or range violation is a
  // hard failure and outranks the softer noise and drift signatures, which
  // often accompany it.
  if (set.has('range') || set.has('rate_of_change') || set.has('spike') || set.has('drop')) {
    return `Inspect the ${SENSOR_NOUN[sensorType]} and its electrical connection. Sensor replacement is likely required.`;
  }
  if (set.has('drift')) {
    return `Recalibrate the ${SENSOR_NOUN[sensorType]} against a reference standard. Schedule replacement if the offset returns within one calibration cycle.`;
  }
  if (set.has('noise')) {
    return `Inspect wiring, terminal block and enclosure seals for moisture ingress. Re-terminate the ${SENSOR_NOUN[sensorType]} cable.`;
  }
  if (set.has('calibration')) {
    return `Recalibrate the ${SENSOR_NOUN[sensorType]} — it is past its service interval.`;
  }
  return `Inspect the ${SENSOR_NOUN[sensorType]} at the next maintenance visit.`;
}

export interface NarrativeInput {
  station: Station;
  sensorType: SensorType;
  classification: Classification;
  confidence: number;
  delta: number;
  durationMinutes: number;
  evidence: EvidenceItem[];
  correction: Correction | null;
  neighbourCount: number;
  action: string;
}

export function buildNarrative(input: NarrativeInput): string {
  const {
    station, sensorType, classification, confidence, delta,
    durationMinutes, evidence, correction, neighbourCount, action,
  } = input;

  const unit = SENSOR_UNITS[sensorType];
  const noun = SENSOR_NOUN[sensorType];
  const dir = delta > 0 ? 'increased' : 'decreased';
  const mag = round(Math.abs(delta), 2);
  const lines: string[] = [];

  const verdict =
    classification === 'sensor_fault' ? 'a probable sensor fault'
    : classification === 'meteorological_event' ? 'a genuine meteorological event'
    : classification === 'communications' ? 'a communications failure'
    : classification === 'power' ? 'a power subsystem fault'
    : 'an unresolved anomaly requiring review';

  lines.push(`SkyGuard classified this as ${verdict} with ${confidence}% confidence.`);

  if (classification === 'communications') {
    lines.push(
      `${station.id} (${station.name}) stopped delivering packets for ${Math.round(durationMinutes)} minutes. No sensor values were recorded during the gap, so nothing has been corrected — the observations are missing rather than wrong.`,
    );
  } else if (classification === 'power') {
    lines.push(
      `The ${station.id} power subsystem declined over ${Math.round(durationMinutes)} minutes. Once pack voltage falls below the modem's brown-out threshold, packets are lost intermittently even though the sensors themselves remain healthy.`,
    );
  } else {
    const window = durationMinutes <= 2 ? 'within one minute' : `over ${Math.round(durationMinutes)} minutes`;
    lines.push(
      `The ${station.id} ${noun} ${dir} by ${mag} ${unit} ${window}.`,
    );
  }

  // The two or three strongest pieces of evidence, in the classifier's own words.
  const supporting = evidence
    .filter((e) => e.supports === (classification === 'meteorological_event' ? 'weather' : 'fault'))
    .slice(0, 3);
  if (supporting.length) {
    lines.push(supporting.map((e) => e.detail).join(' '));
  }

  const counter = evidence.filter(
    (e) => e.supports !== 'neutral' &&
      e.supports !== (classification === 'meteorological_event' ? 'weather' : 'fault'),
  );
  if (counter.length && classification !== 'communications') {
    lines.push(
      `Evidence pointing the other way was considered and outweighed: ${counter
        .slice(0, 2)
        .map((e) => e.label.toLowerCase())
        .join('; ')}.`,
    );
  }

  if (neighbourCount > 0 && classification === 'sensor_fault') {
    lines.push(
      `${neighbourCount} neighbouring ${neighbourCount === 1 ? 'station was' : 'stations were'} checked for the same signature and none of them showed it.`,
    );
  }

  if (correction && correction.confidence > 0) {
    lines.push(
      `Estimated true ${SENSOR_LABELS[sensorType].toLowerCase()}: ${correction.correctedValue} ${unit} (${correction.interval[0]} to ${correction.interval[1]} ${unit}, ${correction.confidence}% confidence). The raw value of ${correction.rawValue} ${unit} is preserved unchanged in the audit trail.`,
    );
  } else if (classification === 'meteorological_event') {
    lines.push('No correction was applied. These readings are believed to be accurate and are published as measured.');
  }

  lines.push(`Recommended action: ${action}`);
  return lines.join('\n\n');
}

export function anomalyTitle(
  station: Station,
  sensorType: SensorType,
  classification: Classification,
  dominant: DetectorType,
  delta: number,
): string {
  const label = SENSOR_LABELS[sensorType].toLowerCase();
  if (classification === 'communications') return `${station.id} telemetry outage`;
  if (classification === 'power') return `${station.id} power subsystem decline`;

  // A genuine air-mass change is named for the direction it moved. The noise
  // and drift labels describe hardware behaviour and would be misleading here.
  if (classification === 'meteorological_event' && (dominant === 'noise' || dominant === 'drift')) {
    return `${station.id} ${label} ${delta > 0 ? 'rise' : 'fall'}`;
  }

  switch (dominant) {
    case 'range': return `${station.id} ${label} out of range`;
    case 'frozen': return `${station.id} ${label} channel frozen`;
    case 'drift': return `${station.id} ${label} calibration drift`;
    case 'noise': return `${station.id} ${label} excessive noise`;
    case 'calibration': return `${station.id} ${label} calibration overdue`;
    default:
      if (classification === 'meteorological_event') {
        return `${station.id} ${label} ${delta > 0 ? 'rise' : 'fall'}`;
      }
      return `${station.id} ${label} ${delta > 0 ? 'spike' : 'drop'}`;
  }
}
